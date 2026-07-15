/**
 * Proposed changes (suggestion mode) — PLAN.md M7a/7b engine tests.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { defineMapping, one } from "@yorm/core";
import type { UpsertOperation } from "@yorm/core";

import { jsonCodec } from "../src/codecs/json.js";
import { createYorm } from "../src/createYorm.js";
import {
  PROPOSALS_KEY,
  ProposalNotFoundError,
  ProposalStateError,
  isProposalTrackingMapping,
  proposalTrackingMapping,
  proposalsApi,
  readProposals,
} from "../src/proposals/index.js";
import { memoryRuntime } from "../src/runtime/memory.js";
import { fakeDocumentStore, fakeProjectionStore } from "./fakes.js";

/** Deterministic api: ids p1, p2, …; timestamps t1, t2, … */
function makeApi(doc: Y.Doc, version?: () => number) {
  let ids = 0;
  let ticks = 0;
  return proposalsApi(doc, {
    genId: () => `p${++ids}`,
    now: () => `t${++ticks}`,
    ...(version ? { version } : {}),
  });
}

function seed(doc: Y.Doc, value: Record<string, unknown>): void {
  jsonCodec().write(doc, value);
}

describe("proposalsApi", () => {
  it("propose records an intent with baseValue; the canonical subtree is untouched", () => {
    const doc = new Y.Doc();
    seed(doc, { name: "Ada", telecom: [{ value: "555-1" }] });
    const api = makeApi(doc, () => 7);

    const intent = api.propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });
    expect(intent).toEqual({
      id: "p1",
      path: ["name"],
      op: "set",
      proposedValue: "Grace",
      baseValue: "Ada",
      baseDocumentVersion: 7,
      actor: "bob",
      status: "proposed",
      createdAt: "t1",
    });
    expect(jsonCodec().read(doc)).toEqual({ name: "Ada", telecom: [{ value: "555-1" }] });
    expect(api.list()).toEqual([intent]);
    expect(api.list({ status: "accepted" })).toEqual([]);
  });

  it("propose omits baseValue when the path is currently absent", () => {
    const doc = new Y.Doc();
    seed(doc, { name: "Ada" });
    const api = makeApi(doc);
    const intent = api.propose({
      path: ["gender"],
      op: "set",
      proposedValue: "female",
      actor: "bob",
    });
    expect("baseValue" in intent).toBe(false);
  });

  it("proposing over the same path supersedes older proposed intents", () => {
    const doc = new Y.Doc();
    seed(doc, { name: "Ada" });
    const api = makeApi(doc);
    api.propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });
    api.propose({ path: ["other"], op: "set", proposedValue: 1, actor: "bob" });
    api.propose({ path: ["name"], op: "set", proposedValue: "Hedy", actor: "carol" });

    const byId = new Map(api.list().map((intent) => [intent.id, intent]));
    expect(byId.get("p1")?.status).toBe("superseded");
    expect(byId.get("p1")?.resolvedBy).toBe("carol");
    expect(byId.get("p1")?.resolvedAt).toBeDefined();
    expect(byId.get("p2")?.status).toBe("proposed"); // different path untouched
    expect(byId.get("p3")?.status).toBe("proposed");
  });

  it("subscribe fires on proposals-subtree changes; unsubscribe stops it", () => {
    const doc = new Y.Doc();
    seed(doc, { name: "Ada" });
    const api = makeApi(doc);
    let calls = 0;
    const unsubscribe = api.subscribe(() => {
      calls += 1;
    });
    api.propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });
    expect(calls).toBe(1);
    api.reject("p1", "alice");
    expect(calls).toBe(2);
    unsubscribe();
    api.propose({ path: ["name"], op: "set", proposedValue: "Hedy", actor: "bob" });
    expect(calls).toBe(2);
  });

  it("accept applies the intent and marks it accepted in ONE transaction", () => {
    const doc = new Y.Doc();
    seed(doc, { name: "Ada" });
    const api = makeApi(doc);
    api.propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });

    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });
    expect(api.accept("p1", "alice")).toEqual({ conflict: false });
    expect(updates).toBe(1); // canonical write + status flip are atomic

    expect(jsonCodec().read(doc)).toEqual({ name: "Grace" });
    const [intent] = api.list();
    expect(intent).toMatchObject({ status: "accepted", resolvedBy: "alice" });
    expect(intent!.resolvedAt).toBeDefined();
  });

  it("accept supports remove and insert ops", () => {
    const doc = new Y.Doc();
    seed(doc, { name: "Ada", telecom: [{ value: "555-1" }, { value: "555-3" }] });
    const api = makeApi(doc);

    api.propose({ path: ["name"], op: "remove", actor: "bob" });
    expect(api.accept("p1", "alice")).toEqual({ conflict: false });

    // Insert between the two entries: path's last segment is the index.
    api.propose({
      path: ["telecom", 1],
      op: "insert",
      proposedValue: { value: "555-2" },
      actor: "bob",
    });
    expect(api.accept("p2", "alice")).toEqual({ conflict: false });

    expect(jsonCodec().read(doc)).toEqual({
      telecom: [{ value: "555-1" }, { value: "555-2" }, { value: "555-3" }],
    });
  });

  it("reject marks the intent rejected and leaves the canonical subtree alone", () => {
    const doc = new Y.Doc();
    seed(doc, { name: "Ada" });
    const api = makeApi(doc);
    api.propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });
    api.reject("p1", "alice");
    expect(jsonCodec().read(doc)).toEqual({ name: "Ada" });
    expect(api.list()[0]).toMatchObject({ status: "rejected", resolvedBy: "alice" });
    expect(() => api.reject("p1", "alice")).toThrow(ProposalStateError);
  });

  it("withdraw deletes a still-proposed intent; resolved/missing ids throw", () => {
    const doc = new Y.Doc();
    seed(doc, { name: "Ada" });
    const api = makeApi(doc);
    api.propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });
    api.withdraw("p1");
    expect(api.list()).toEqual([]);
    expect(() => api.withdraw("p1")).toThrow(ProposalNotFoundError);

    api.propose({ path: ["name"], op: "set", proposedValue: "Hedy", actor: "bob" });
    api.accept("p2", "alice");
    expect(() => api.withdraw("p2")).toThrow(ProposalStateError);
  });

  it("clearResolved deletes resolved intents only, in one transaction, and syncs", () => {
    const doc = new Y.Doc();
    seed(doc, { name: "Ada", city: "Kew" });
    const api = makeApi(doc);
    api.propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });
    api.propose({ path: ["city"], op: "set", proposedValue: "Bath", actor: "bob" });
    api.propose({ path: ["name"], op: "set", proposedValue: "Hedy", actor: "bob" }); // supersedes p1
    api.accept("p2", "alice");

    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });
    // p1 superseded + p2 accepted are cleared; p3 stays open.
    expect(api.clearResolved()).toBe(2);
    expect(updates).toBe(1);
    expect(api.list().map((intent) => intent.id)).toEqual(["p3"]);
    expect(api.clearResolved()).toBe(0);

    // The deletion is CRDT state: a doc holding the old history converges.
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    expect(readProposals(replica).map((intent) => intent.id)).toEqual(["p3"]);
  });

  it("updateProposal amends the proposedValue of a still-proposed intent only", () => {
    const doc = new Y.Doc();
    seed(doc, { name: "Ada" });
    const api = makeApi(doc);
    api.propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });
    api.updateProposal("p1", { proposedValue: "Hedy" });
    expect(api.list()[0]!.proposedValue).toBe("Hedy");

    api.accept("p1", "alice");
    expect(jsonCodec().read(doc)).toEqual({ name: "Hedy" });
    expect(() => api.updateProposal("p1", { proposedValue: "x" })).toThrow(ProposalStateError);
  });

  it("stale accept returns the conflict without applying; acceptAnyway forces it", () => {
    const doc = new Y.Doc();
    seed(doc, { name: "Ada" });
    const api = makeApi(doc);
    api.propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });

    // Canonical moved after the proposal was made.
    doc.transact(() => doc.getMap("resource").set("name", "Hedy"));

    expect(api.accept("p1", "alice")).toEqual({ conflict: true, currentValue: "Hedy" });
    expect(jsonCodec().read(doc)).toEqual({ name: "Hedy" }); // untouched
    expect(api.list()[0]!.status).toBe("proposed"); // unresolved

    api.acceptAnyway("p1", "alice");
    expect(jsonCodec().read(doc)).toEqual({ name: "Grace" });
    expect(api.list()[0]!.status).toBe("accepted");
  });

  it("stale check for insert compares the element currently at the index", () => {
    const doc = new Y.Doc();
    seed(doc, { telecom: [{ value: "555-1" }] });
    const api = makeApi(doc);
    // baseValue = element currently at index 0 (the one being displaced).
    api.propose({
      path: ["telecom", 0],
      op: "insert",
      proposedValue: { value: "555-0" },
      actor: "bob",
    });

    doc.transact(() => {
      (doc.getMap("resource").get("telecom") as Y.Array<Y.Map<unknown>>)
        .get(0)
        .set("value", "555-9");
    });
    const result = api.accept("p1", "alice");
    expect(result).toEqual({ conflict: true, currentValue: { value: "555-9" } });
  });

  it("proposals sync between two docs like any CRDT state", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seed(a, { name: "Ada" });
    const sync = (): void => {
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    };
    sync();

    const apiA = makeApi(a);
    const apiB = makeApi(b);
    apiA.propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });
    sync();
    expect(apiB.list()).toEqual(apiA.list());

    apiB.accept("p1", "alice");
    sync();
    expect(apiA.list()[0]!.status).toBe("accepted");
    expect(jsonCodec().read(a)).toEqual({ name: "Grace" });
  });

  it("codec isolation: the codec reads only the canonical subtree", () => {
    const doc = new Y.Doc();
    const codec = jsonCodec();
    seed(doc, { name: "Ada" });
    const api = makeApi(doc);
    api.propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });

    // read never sees the proposals subtree…
    expect(codec.read(doc)).toEqual({ name: "Ada" });
    // …and write (clear + rebuild of the root map) never clears it.
    codec.write(doc, { name: "Hedy" });
    expect(readProposals(doc)).toHaveLength(1);
    expect(doc.getMap(PROPOSALS_KEY).size).toBe(1);
  });
});

// --- Session-level integration (createYorm) -------------------------------

interface PatientDoc {
  name?: string;
}

const patientMapping = defineMapping<PatientDoc>({
  name: "test.Patient",
  version: 1,
  documentType: "Patient",
  projections: [
    one("patient", {
      key: ({ documentId }) => ({ id: documentId }),
      values: ({ object }) => ({ name: object.name ?? null }),
    }),
  ],
});

function makeYorm(mappings = [patientMapping, proposalTrackingMapping("Patient")]) {
  const projections = fakeProjectionStore();
  const yorm = createYorm({
    runtime: memoryRuntime(),
    documents: fakeDocumentStore(),
    projections,
    mappings,
  });
  return { yorm, projections };
}

describe("proposals through DocumentSession", () => {
  it("a pending proposal never reaches projection plans; accepting does", async () => {
    const { yorm, projections } = makeYorm([patientMapping]);
    const session = await yorm.open("Patient", "p1");
    await session.write({ name: "Ada" });

    session.proposals().propose({
      path: ["name"],
      op: "set",
      proposedValue: "PROPOSED-SENTINEL",
      actor: "bob",
    });
    await session.signal("flush");
    expect(JSON.stringify(projections.plans)).not.toContain("PROPOSED-SENTINEL");
    session.close();
  });

  it("accept then flush projects the accepted value", async () => {
    const { yorm, projections } = makeYorm([patientMapping]);
    const session = await yorm.open("Patient", "p1");
    await session.write({ name: "Ada" });

    const intent = session
      .proposals()
      .propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });
    expect(session.proposals().accept(intent.id, "alice")).toEqual({ conflict: false });
    await session.signal("flush");

    const last = projections.plans.at(-1)!;
    const upsert = last.operations.find((op): op is UpsertOperation => op.kind === "upsert")!;
    expect(upsert.values["name"]).toBe("Grace");
    session.close();
  });

  it("proposals capture the session's document version as baseDocumentVersion", async () => {
    const { yorm } = makeYorm([patientMapping]);
    const session = await yorm.open("Patient", "p1");
    await session.write({ name: "Ada" }); // version 1
    const intent = session
      .proposals()
      .propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });
    expect(intent.baseDocumentVersion).toBe(1);
    session.close();
  });

  it("tracking mapping projects proposals into yorm_proposal rows only", async () => {
    const { yorm, projections } = makeYorm();
    const session = await yorm.open("Patient", "p1");
    await session.write({ name: "Ada" });

    const intent = session
      .proposals()
      .propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });
    await session.signal("flush");

    const trackingPlans = projections.plans.filter((plan) => plan.mapping === "yorm.proposals@1");
    const rows = trackingPlans
      .at(-1)!
      .operations.filter((op): op is UpsertOperation => op.kind === "upsert");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      table: "yorm_proposal",
      key: { document_id: "p1", proposal_id: intent.id },
      values: {
        path: JSON.stringify(["name"]),
        op: "set",
        status: "proposed",
        actor: "bob",
        resolved_by: null,
        resolved_at: null,
      },
    });
    // The pending proposal appears in yorm_proposal rows but NEVER in
    // canonical-mapping rows.
    const canonicalPlans = projections.plans.filter((plan) => plan.mapping === "test.Patient@1");
    expect(JSON.stringify(canonicalPlans)).not.toContain("Grace");

    // Accept → tracking row resolves AND the canonical row updates.
    session.proposals().accept(intent.id, "alice");
    await session.signal("flush");
    const resolvedRow = projections.plans
      .filter((plan) => plan.mapping === "yorm.proposals@1")
      .at(-1)!
      .operations.find((op): op is UpsertOperation => op.kind === "upsert")!;
    expect(resolvedRow.values).toMatchObject({ status: "accepted", resolved_by: "alice" });
    const canonicalRow = projections.plans
      .filter((plan) => plan.mapping === "test.Patient@1")
      .at(-1)!
      .operations.find((op): op is UpsertOperation => op.kind === "upsert")!;
    expect(canonicalRow.values["name"]).toBe("Grace");
    session.close();
  });

  it("withdrawing reconciles the tracking row away (scoped delete)", async () => {
    const { yorm, projections } = makeYorm();
    const session = await yorm.open("Patient", "p1");
    await session.write({ name: "Ada" });
    const intent = session
      .proposals()
      .propose({ path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" });
    session.proposals().withdraw(intent.id);
    await session.signal("flush");

    const last = projections.plans.filter((plan) => plan.mapping === "yorm.proposals@1").at(-1)!;
    expect(last.operations).toEqual([
      {
        kind: "reconcile",
        table: "yorm_proposal",
        // Zero rows → the planner derives key columns from the scope.
        keyColumns: ["document_id"],
        keepKeys: [],
        scope: { document_id: "p1" },
      },
    ]);
    session.close();
  });
});

describe("proposalTrackingMapping", () => {
  it("is recognized by isProposalTrackingMapping; ordinary mappings are not", () => {
    expect(isProposalTrackingMapping(proposalTrackingMapping("Patient"))).toBe(true);
    expect(isProposalTrackingMapping(patientMapping)).toBe(false);
  });
});
