import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { defineMapping, many, one } from "@yorm/core";
import { applyJsonPatchLike, createYorm, memoryRuntime, type YormOptions } from "../src/index.js";
import { fakeDocumentStore, fakeProjectionStore } from "./fakes.js";

interface Contact {
  id: string;
  firstName?: string;
  lastName?: string;
  phones?: Array<{ elementId: string; label?: string; value?: string }>;
}

const contactMapping = defineMapping<Contact>({
  name: "contacts.Contact",
  version: 1,
  documentType: "Contact",
  projections: [
    one("contact", {
      key: ({ object }) => ({ id: object.id }),
      values: ({ object }) => ({
        first_name: object.firstName ?? null,
        last_name: object.lastName ?? null,
      }),
    }),
    many("contact_phone", {
      rows: ({ object }) =>
        (object.phones ?? []).map((phone) => ({
          key: { contact_id: object.id, element_id: phone.elementId },
          values: { label: phone.label ?? null, value: phone.value ?? null },
        })),
      scope: ({ object }) => ({ contact_id: object.id }),
    }),
  ],
});

const ada: Contact = {
  id: "c1",
  firstName: "Ada",
  lastName: "Lovelace",
  phones: [
    { elementId: "ph-a", label: "home", value: "111" },
    { elementId: "ph-b", label: "work", value: "222" },
  ],
};

function setup(overrides: Partial<YormOptions> = {}) {
  const documents = fakeDocumentStore();
  const projections = fakeProjectionStore();
  const yorm = createYorm({
    runtime: memoryRuntime(),
    documents,
    projections,
    mappings: [contactMapping],
    ...overrides,
  });
  return { yorm, documents, projections };
}

describe("createYorm (end-to-end, no DB)", () => {
  it("write projects one plan with table operations in order", async () => {
    const { yorm, projections } = setup();
    const session = await yorm.open("Contact", "c1");
    await session.write(ada);

    expect(projections.plans).toHaveLength(1);
    const plan = projections.plans[0]!;
    expect(plan.mapping).toBe("contacts.Contact@1");
    expect(plan.documentId).toBe("c1");
    expect(plan.documentVersion).toBe(1);
    expect(plan.origin).toBe("yjs");
    expect(plan.operations).toEqual([
      {
        kind: "upsert",
        table: "contact",
        key: { id: "c1" },
        values: { first_name: "Ada", last_name: "Lovelace" },
        ownedColumns: ["first_name", "last_name"],
      },
      {
        kind: "upsert",
        table: "contact_phone",
        key: { contact_id: "c1", element_id: "ph-a" },
        values: { label: "home", value: "111" },
        ownedColumns: ["label", "value"],
      },
      {
        kind: "upsert",
        table: "contact_phone",
        key: { contact_id: "c1", element_id: "ph-b" },
        values: { label: "work", value: "222" },
        ownedColumns: ["label", "value"],
      },
      {
        kind: "reconcile",
        table: "contact_phone",
        keyColumns: ["contact_id", "element_id"],
        keepKeys: [
          { contact_id: "c1", element_id: "ph-a" },
          { contact_id: "c1", element_id: "ph-b" },
        ],
        scope: { contact_id: "c1" },
      },
    ]);
    expect(session.projectionState()).toEqual({ pending: null, version: 1, lastError: undefined });
    session.close();
  });

  it("direct Y.Doc mutation triggers projection with the updated values", async () => {
    const { yorm, projections } = setup();
    const session = await yorm.open("Contact", "c1");
    await session.write(ada);

    session.doc.transact(() => {
      const root = session.doc.getMap("resource");
      root.set("firstName", "Augusta");
    });
    await session.signal("flush");

    expect(projections.plans).toHaveLength(2);
    const upsert = projections.plans[1]!.operations[0];
    expect(upsert).toMatchObject({
      table: "contact",
      values: { first_name: "Augusta", last_name: "Lovelace" },
    });
    session.close();
  });

  it("applyJsonPatchLike on the session doc projects semantically", async () => {
    const { yorm, projections } = setup();
    const session = await yorm.open("Contact", "c1");
    await session.write(ada);

    applyJsonPatchLike(session.doc, "resource", ["phones", 0, "value"], "999");
    await session.signal("flush");

    const phoneUpsert = projections.plans[1]!.operations.find(
      (op) => op.kind === "upsert" && op.table === "contact_phone",
    );
    expect(phoneUpsert).toMatchObject({ values: { label: "home", value: "999" } });
    session.close();
  });

  it("explicit policy defers projection until flush; pending is observable", async () => {
    const { yorm, projections } = setup({ projectionPolicy: { default: { kind: "explicit" } } });
    const session = await yorm.open("Contact", "c1");
    await session.write(ada);
    session.doc.transact(() => {
      session.doc.getMap("resource").set("firstName", "Augusta");
    });

    expect(projections.plans).toHaveLength(0);
    expect(session.projectionState().pending).toEqual({ from: 1, to: 2 });

    await session.signal("flush");
    expect(projections.plans).toHaveLength(1);
    expect(projections.plans[0]!.documentVersion).toBe(2);
    expect(session.projectionState().pending).toBeNull();
    session.close();
  });

  it("applyPlan rejection records the failure, keeps pending, and retries on flush", async () => {
    const { yorm, projections } = setup();
    const session = await yorm.open("Contact", "c1");
    projections.failNextWith(new Error("kaboom"));
    await session.write(ada);

    expect(projections.plans).toHaveLength(0);
    expect(projections.failures).toEqual([
      {
        checkpoint: {
          documentId: "c1",
          documentType: "Contact",
          mappingName: "contacts.Contact",
          mappingVersion: 1,
          sourceDocumentVersion: 1,
        },
        error: "kaboom",
      },
    ]);
    expect(session.projectionState()).toMatchObject({
      pending: { from: 1, to: 1 },
      lastError: "kaboom",
    });

    await session.signal("flush");
    expect(projections.plans).toHaveLength(1);
    expect(session.projectionState()).toEqual({ pending: null, version: 1, lastError: undefined });
    session.close();
  });

  it("passes the origin of the triggering update through to the plan", async () => {
    const { yorm, projections } = setup({ projectionPolicy: { default: { kind: "explicit" } } });
    const session = await yorm.open("Contact", "c1");
    await session.write(ada);
    await session.signal("flush");

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(session.doc));
    const before = Y.encodeStateVector(session.doc);
    remote.getMap("resource").set("firstName", "Zed");
    session.applyUpdate(Y.encodeStateAsUpdate(remote, before), "external-import", "importer");
    await session.signal("flush");

    expect(projections.plans).toHaveLength(2);
    expect(projections.plans[0]!.origin).toBe("yjs");
    expect(projections.plans[1]!.origin).toBe("external-import");
    session.close();
  });

  it("version increments once per update and is visible in projectionState", async () => {
    const { yorm } = setup({ projectionPolicy: { default: { kind: "explicit" } } });
    const session = await yorm.open("Contact", "c1");
    await session.write(ada); // one transaction → one update
    expect(session.projectionState().version).toBe(1);
    session.doc.transact(() => {
      session.doc.getMap("resource").set("firstName", "A");
    });
    session.doc.transact(() => {
      session.doc.getMap("resource").set("firstName", "Au");
    });
    expect(session.projectionState().version).toBe(3);
    session.close();
  });

  it("only mappings matching the documentType run; session fan-out reaches subscribers", async () => {
    const otherMapping = defineMapping<{ id: string }>({
      name: "other.Thing",
      version: 1,
      documentType: "Thing",
      projections: [
        one("thing", {
          key: ({ object }) => ({ id: object.id }),
          values: () => ({ seen: true }),
        }),
      ],
    });
    const { yorm, projections } = setup({ mappings: [contactMapping, otherMapping] });
    const session = await yorm.open("Contact", "c1");
    const received: Uint8Array[] = [];
    const unsubscribe = session.subscribe((update) => received.push(update));
    await session.write(ada);

    expect(projections.plans).toHaveLength(1);
    expect(projections.plans[0]!.mapping).toBe("contacts.Contact@1");
    expect(received).toHaveLength(1);
    unsubscribe();
    session.close();
  });
});
