/**
 * Mapping replay + failed-projection retry (PLAN.md M8): rebuild projections
 * from stored documents with origin "replay"; a failing document is recorded
 * and does not stop the run; retry re-runs only the quarantine set.
 */
import { describe, expect, it } from "vitest";

import { defineMapping, one } from "@yorm/core";
import type { ProjectionStore } from "@yorm/core";
import {
  createYorm,
  memoryRuntime,
  proposalTrackingMapping,
  replayProjections,
  retryFailedProjections,
} from "../src/index.js";
import type { Yorm } from "../src/index.js";
import { fakeDocumentStore, fakeProjectionStore } from "./fakes.js";

interface Contact {
  id: string;
  firstName?: string;
}

const contactMapping = defineMapping<Contact>({
  name: "contacts.Contact",
  version: 1,
  documentType: "Contact",
  projections: [
    one("contact", {
      key: ({ object }) => ({ id: object.id }),
      values: ({ object }) => ({ first_name: object.firstName ?? null }),
    }),
  ],
});

const CONTACTS: Contact[] = [
  { id: "c1", firstName: "Ada" },
  { id: "c2", firstName: "Grace" },
  { id: "c3", firstName: "Edsger" },
];

async function seededYorm(extraMappings: Parameters<typeof createYorm>[0]["mappings"] = []) {
  const documents = fakeDocumentStore();
  const projections = fakeProjectionStore();
  const yorm = createYorm({
    runtime: memoryRuntime(),
    documents,
    projections,
    mappings: [contactMapping, ...extraMappings],
  });
  for (const contact of CONTACTS) {
    const session = await yorm.open("Contact", contact.id);
    await session.write(contact);
    session.close();
  }
  // Replay must read STORED documents, not live runtime state: wipe the
  // instrumented projection store so only replay output remains observable.
  projections.plans.length = 0;
  projections.states.clear();
  return { yorm, documents, projections };
}

describe("replayProjections", () => {
  it("rebuilds every stored document with origin 'replay'", async () => {
    const { yorm, projections } = await seededYorm();

    const result = await replayProjections(yorm);

    expect(result).toEqual({ attempted: 3, succeeded: 3, failed: [] });
    expect(projections.plans).toHaveLength(3);
    expect(projections.plans.map((plan) => plan.documentId).sort()).toEqual(["c1", "c2", "c3"]);
    for (const plan of projections.plans) {
      expect(plan.origin).toBe("replay");
      expect(plan.mapping).toBe("contacts.Contact@1");
    }
    const c2 = projections.plans.find((plan) => plan.documentId === "c2")!;
    expect(c2.operations[0]).toMatchObject({
      kind: "upsert",
      table: "contact",
      values: { first_name: "Grace" },
    });
  });

  it("records a failing document and continues with the rest (default policy)", async () => {
    const { yorm, projections } = await seededYorm();
    projections.failNextWith(new Error("disk full"));

    const result = await replayProjections(yorm);

    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toEqual([{ documentId: "c1", error: "disk full" }]);
    // The failure was recorded against the right checkpoint…
    expect(projections.failures).toEqual([
      {
        checkpoint: {
          documentId: "c1",
          documentType: "Contact",
          mappingName: "contacts.Contact",
          mappingVersion: 1,
          sourceDocumentVersion: 1,
        },
        error: "disk full",
      },
    ]);
    // …and the other documents were still replayed.
    expect(projections.plans.map((plan) => plan.documentId)).toEqual(["c2", "c3"]);
  });

  it("onError 'throw' records the failure and aborts the run", async () => {
    const { yorm, projections } = await seededYorm();
    projections.failNextWith(new Error("boom"));

    await expect(replayProjections(yorm, { onError: "throw" })).rejects.toThrow("boom");
    expect(projections.failures).toHaveLength(1);
    expect(projections.plans).toHaveLength(0);
  });

  it("documentType filter skips unmapped/unrequested types", async () => {
    const { yorm, projections } = await seededYorm();

    const result = await replayProjections(yorm, { documentType: "Encounter" });

    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: [] });
    expect(projections.plans).toHaveLength(0);
  });

  it("replays proposal tracking mappings from the proposals subtree", async () => {
    const { yorm, projections } = await seededYorm([proposalTrackingMapping("Contact")]);
    const session = await yorm.open("Contact", "c1");
    session
      .proposals()
      .propose({ path: ["firstName"], op: "set", proposedValue: "Augusta", actor: "reviewer" });
    await session.signal("flush");
    session.close();
    projections.plans.length = 0;

    const result = await replayProjections(yorm);

    expect(result).toEqual({ attempted: 3, succeeded: 3, failed: [] });
    const trackingPlans = projections.plans.filter((plan) =>
      plan.mapping.startsWith("yorm.proposals@"),
    );
    expect(trackingPlans).toHaveLength(3); // one per Contact document
    const c1Tracking = trackingPlans.find((plan) => plan.documentId === "c1")!;
    expect(c1Tracking.origin).toBe("replay");
    expect(c1Tracking.operations.filter((op) => op.kind === "upsert")).toHaveLength(1);
    expect(c1Tracking.operations[0]).toMatchObject({
      table: "yorm_proposal",
      values: { status: "proposed", actor: "reviewer" },
    });
  });
});

describe("retryFailedProjections", () => {
  it("re-runs only documents whose projection state is 'error'", async () => {
    const { yorm, projections } = await seededYorm();
    // Quarantine c1: a failed replay records status "error" for it.
    projections.failNextWith(new Error("transient"));
    await replayProjections(yorm);
    projections.plans.length = 0;
    expect(await projections.listFailures()).toHaveLength(1);

    const result = await retryFailedProjections(yorm);

    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: [] });
    expect(projections.plans.map((plan) => plan.documentId)).toEqual(["c1"]);
    expect(projections.plans[0]!.origin).toBe("replay");
    // The successful retry clears the quarantine.
    expect(await projections.listFailures()).toEqual([]);
  });

  it("records failures of unregistered mappings without touching stores", async () => {
    const { yorm, projections } = await seededYorm();
    await projections.recordFailure(
      {
        documentId: "c9",
        documentType: "Contact",
        mappingName: "retired.Mapping",
        mappingVersion: 1,
        sourceDocumentVersion: 1,
      },
      "old failure",
    );

    const result = await retryFailedProjections(yorm);

    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toEqual([
      { documentId: "c9", error: 'mapping "retired.Mapping" is not registered with this Yorm' },
    ]);
  });

  it("throws a clear error when the store lacks listFailures()", async () => {
    const documents = fakeDocumentStore();
    const base = fakeProjectionStore();
    // A minimal store implementing only the REQUIRED ProjectionStore members.
    const minimal: ProjectionStore = {
      applyPlan: (plan) => base.applyPlan(plan),
      getState: (documentId, mappingName) => base.getState(documentId, mappingName),
      recordFailure: (checkpoint, error) => base.recordFailure(checkpoint, error),
    };
    const yorm: Yorm = createYorm({
      runtime: memoryRuntime(),
      documents,
      projections: minimal,
      mappings: [contactMapping],
    });

    await expect(retryFailedProjections(yorm)).rejects.toThrow(/listFailures/);
  });
});
