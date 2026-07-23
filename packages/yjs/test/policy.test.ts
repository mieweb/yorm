import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  createPolicyLens,
  createYorm,
  defineRolePolicy,
  memoryRuntime,
  policyFor,
  type DocumentSession,
  type RolePolicy,
} from "../src/index.js";
import { fakeDocumentStore, fakeProjectionStore } from "./fakes.js";

/** A clinical-visit-shaped document for the role-security POC. */
interface Visit {
  demographics?: { name?: string; dob?: string };
  allergies?: string[];
  orders?: Array<{ id: string; description?: string; status?: string }>;
}

const initialVisit: Visit = {
  demographics: { name: "Ada Lovelace", dob: "1815-12-10" },
  allergies: ["penicillin"],
  orders: [{ id: "o1", description: "CBC panel", status: "open" }],
};

/** Receptionist: sees and may edit demographics only. */
const receptionistPolicy = defineRolePolicy<Visit>({
  role: "receptionist",
  documentType: "Visit",
  view: (visit) => ({ demographics: visit.demographics ?? {} }),
  canWrite: ({ before, after }) =>
    Object.keys(after).every((key) => key === "demographics") &&
    Object.keys(before).every((key) => key === "demographics"),
});

/** Nurse: sees everything, may complete orders but not add/remove them. */
const nursePolicy = defineRolePolicy<Visit>({
  role: "nurse",
  documentType: "Visit",
  canWrite: ({ before, after }) => {
    const ordersBefore = (before as Visit).orders ?? [];
    const ordersAfter = (after as Visit).orders ?? [];
    if (ordersAfter.length !== ordersBefore.length) {
      return false; // no adding or removing orders
    }
    return ordersAfter.every((order, i) => {
      const prev = ordersBefore[i]!;
      // Only `status` may change on an existing order.
      return order.id === prev.id && order.description === prev.description;
    });
  },
});

/** Auditor: full view, no `canWrite` — read-only by default. */
const auditorPolicy = defineRolePolicy<Visit>({
  role: "auditor",
  documentType: "Visit",
});

async function setup(policy: RolePolicy<Visit>) {
  const yorm = createYorm({
    runtime: memoryRuntime(),
    documents: fakeDocumentStore(),
    projections: fakeProjectionStore(),
    mappings: [],
  });
  const session: DocumentSession = await yorm.open("Visit", "v1");
  await session.write(initialVisit);
  const lens = createPolicyLens(session, policy as RolePolicy, {
    role: policy.role,
    documentType: "Visit",
    documentId: "v1",
  });
  return { session, lens };
}

/**
 * Simulates a synced client of the lens: clones the lens doc, applies
 * `edit`, and returns the update the client would send over the wire.
 */
function clientEdit(lens: { doc: Y.Doc }, edit: (root: Y.Map<unknown>) => void): Uint8Array {
  const client = new Y.Doc();
  try {
    Y.applyUpdate(client, Y.encodeStateAsUpdate(lens.doc));
    const captured: Uint8Array[] = [];
    client.on("update", (update: Uint8Array) => captured.push(update));
    client.transact(() => edit(client.getMap("resource")));
    return Y.mergeUpdates(captured);
  } finally {
    client.destroy();
  }
}

describe("policyFor", () => {
  it("matches on (documentType, role) and returns null otherwise", () => {
    const policies = [receptionistPolicy as RolePolicy, nursePolicy as RolePolicy];
    expect(policyFor(policies, "Visit", "nurse")).toBe(nursePolicy);
    expect(policyFor(policies, "Visit", "physician")).toBeNull();
    expect(policyFor(policies, "Patient", "nurse")).toBeNull();
    expect(policyFor(policies, "Visit", undefined)).toBeNull();
    expect(policyFor(undefined, "Visit", "nurse")).toBeNull();
  });
});

describe("createPolicyLens — read redaction", () => {
  it("the lens doc holds only the role's view", async () => {
    const { lens } = await setup(receptionistPolicy);
    expect(lens.doc.getMap("resource").toJSON()).toEqual({
      demographics: { name: "Ada Lovelace", dob: "1815-12-10" },
    });
    lens.close();
  });

  it("canonical changes propagate into the lens view", async () => {
    const { session, lens } = await setup(receptionistPolicy);
    await session.write({ ...initialVisit, demographics: { name: "Grace Hopper" } });
    expect(lens.doc.getMap("resource").toJSON()).toEqual({
      demographics: { name: "Grace Hopper" },
    });
    lens.close();
  });

  it("hidden-section canonical changes do not disturb the lens", async () => {
    const { session, lens } = await setup(receptionistPolicy);
    const stateBefore = Y.encodeStateAsUpdate(lens.doc);
    await session.write({ ...initialVisit, allergies: ["penicillin", "latex"] });
    // The visible JSON did not change, so the lens doc was not rebuilt.
    expect(Y.encodeStateAsUpdate(lens.doc)).toEqual(stateBefore);
    lens.close();
  });
});

describe("createPolicyLens — write protection", () => {
  it("allows a permitted edit and writes it back to the canonical doc", async () => {
    const { session, lens } = await setup(receptionistPolicy);
    const update = clientEdit(lens, (root) => {
      (root.get("demographics") as Y.Map<unknown>).set("name", "Ada King");
    });
    const result = lens.applyClientUpdate(update);
    expect(result.allowed).toBe(true);
    await lens.settle();
    const visit = session.read() as Visit;
    expect(visit.demographics?.name).toBe("Ada King");
    // Hidden sections survive the write-back untouched.
    expect(visit.allergies).toEqual(["penicillin"]);
    expect(visit.orders).toEqual(initialVisit.orders);
    lens.close();
  });

  it("denies an edit outside the policy and leaves all docs untouched", async () => {
    const { session, lens } = await setup(receptionistPolicy);
    const update = clientEdit(lens, (root) => {
      root.set("orders", "sneaky");
    });
    const result = lens.applyClientUpdate(update);
    expect(result).toEqual({
      allowed: false,
      reason: 'role "receptionist": change not permitted by policy',
    });
    await lens.settle();
    expect(lens.doc.getMap("resource").toJSON()).toEqual({
      demographics: { name: "Ada Lovelace", dob: "1815-12-10" },
    });
    expect(session.read()).toEqual(initialVisit);
    lens.close();
  });

  it("a policy without canWrite is read-only", async () => {
    const { lens } = await setup(auditorPolicy);
    const update = clientEdit(lens, (root) => {
      (root.get("demographics") as Y.Map<unknown>).set("name", "X");
    });
    expect(lens.applyClientUpdate(update).allowed).toBe(false);
    lens.close();
  });

  it("semantic no-op updates are applied without consulting canWrite", async () => {
    const { lens } = await setup(auditorPolicy);
    // A state exchange with no semantic change (e.g. SyncStep2 echo).
    const update = Y.encodeStateAsUpdate(lens.doc);
    expect(lens.applyClientUpdate(update).allowed).toBe(true);
    lens.close();
  });

  it("nurse may complete an order but not add one", async () => {
    const { session, lens } = await setup(nursePolicy);

    const complete = clientEdit(lens, (root) => {
      const orders = root.get("orders") as Y.Array<unknown>;
      (orders.get(0) as Y.Map<unknown>).set("status", "completed");
    });
    expect(lens.applyClientUpdate(complete).allowed).toBe(true);
    await lens.settle();
    expect((session.read() as Visit).orders?.[0]?.status).toBe("completed");

    const add = clientEdit(lens, (root) => {
      const orders = root.get("orders") as Y.Array<unknown>;
      const order = new Y.Map<unknown>();
      order.set("id", "o2");
      order.set("description", "MRI");
      orders.push([order]);
    });
    expect(lens.applyClientUpdate(add).allowed).toBe(false);
    await lens.settle();
    expect((session.read() as Visit).orders).toHaveLength(1);
    lens.close();
  });

  it("removing a visible top-level key deletes it from the canonical doc", async () => {
    const { session, lens } = await setup(nursePolicy);
    const update = clientEdit(lens, (root) => {
      root.delete("allergies");
    });
    expect(lens.applyClientUpdate(update).allowed).toBe(true);
    await lens.settle();
    const visit = session.read() as Visit;
    expect(visit.allergies).toBeUndefined();
    expect(visit.demographics).toEqual(initialVisit.demographics);
    lens.close();
  });
});
