import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { defineMapping, one } from "@yorm/core";
import { createYorm, memoryRuntime } from "@yorm/yjs";

import type { HonoYormOptions } from "../src/index.js";
import { createHonoYorm } from "../src/index.js";
import { fakeDocumentStore, fakeProjectionStore, until } from "./fakes.js";

interface PatientDoc {
  name?: string;
  gender?: string;
}

const patientMapping = defineMapping<PatientDoc>({
  name: "test.Patient",
  version: 1,
  documentType: "Patient",
  projections: [
    one("patient", {
      key: ({ documentId }) => ({ id: documentId }),
      values: ({ object }) => ({ name: object.name ?? null, gender: object.gender ?? null }),
    }),
  ],
});

function makeApp(options?: HonoYormOptions) {
  const documents = fakeDocumentStore();
  const projections = fakeProjectionStore();
  const yorm = createYorm({
    runtime: memoryRuntime(),
    documents,
    projections,
    mappings: [patientMapping],
  });
  const app = new Hono();
  app.route("/yorm", createHonoYorm(yorm, options));
  return { app, documents, projections, yorm };
}

const json = (body: unknown, method = "POST") => ({
  method,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

describe("@yorm/hono HTTP routes", () => {
  it("PUT then GET round-trips the document", async () => {
    const { app } = makeApp();
    const put = await app.request(
      "/yorm/docs/Patient/p1",
      json({ name: "Ada", gender: "female" }, "PUT"),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ version: 1 });

    const get = await app.request("/yorm/docs/Patient/p1");
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ object: { name: "Ada", gender: "female" }, version: 1 });
  });

  it("GET of a never-written document is 404", async () => {
    const { app } = makeApp();
    const res = await app.request("/yorm/docs/Patient/missing");
    expect(res.status).toBe(404);
    // A failed GET must not create the document.
    expect((await app.request("/yorm/docs/Patient/missing")).status).toBe(404);
  });

  it("PATCH sets and removes values (single op and array of ops)", async () => {
    const { app } = makeApp();
    await app.request("/yorm/docs/Patient/p1", json({ name: "Ada" }, "PUT"));

    const set = await app.request(
      "/yorm/docs/Patient/p1",
      json({ path: ["gender"], value: "female" }, "PATCH"),
    );
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ version: 2 });
    expect((await (await app.request("/yorm/docs/Patient/p1")).json()).object).toEqual({
      name: "Ada",
      gender: "female",
    });

    // Array form: remove gender (no value) and rename in one request.
    const multi = await app.request(
      "/yorm/docs/Patient/p1",
      json([{ path: ["gender"] }, { path: ["name"], value: "Grace" }], "PATCH"),
    );
    expect(multi.status).toBe(200);
    expect((await (await app.request("/yorm/docs/Patient/p1")).json()).object).toEqual({
      name: "Grace",
    });
  });

  it("projection-state shows pending changes under the explicit policy", async () => {
    const { app } = makeApp();
    expect(
      (await app.request("/yorm/docs/Patient/p1/policy", json({ kind: "explicit" }))).status,
    ).toBe(204);
    await app.request("/yorm/docs/Patient/p1", json({ name: "Ada" }, "PUT"));

    const res = await app.request("/yorm/docs/Patient/p1/projection-state");
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.pending).toEqual({ from: 1, to: 1 });
    expect(state.version).toBe(1);
    expect(state.checkpoints).toEqual([
      { mappingName: "test.Patient", mappingVersion: 1, state: null },
    ]);
  });

  it("flush projects pending changes and clears pending", async () => {
    const { app, projections } = makeApp();
    await app.request("/yorm/docs/Patient/p1/policy", json({ kind: "explicit" }));
    await app.request("/yorm/docs/Patient/p1", json({ name: "Ada" }, "PUT"));
    expect(projections.plans).toHaveLength(0);

    const flush = await app.request("/yorm/docs/Patient/p1/flush", { method: "POST" });
    expect(flush.status).toBe(200);
    expect(await flush.json()).toEqual({ version: 1, pending: null });

    expect(projections.plans).toHaveLength(1);
    expect(projections.plans[0]!.operations).toEqual([
      {
        kind: "upsert",
        table: "patient",
        key: { id: "p1" },
        values: { name: "Ada", gender: null },
        ownedColumns: ["name", "gender"],
      },
    ]);

    const state = await (await app.request("/yorm/docs/Patient/p1/projection-state")).json();
    expect(state.pending).toBeNull();
    expect(state.checkpoints[0].state.sourceDocumentVersion).toBe(1);
  });

  it("signal endpoint delivers blur under the on-blur policy", async () => {
    const { app, projections } = makeApp();
    await app.request("/yorm/docs/Patient/p1/policy", json({ kind: "on-blur" }));
    await app.request("/yorm/docs/Patient/p1", json({ name: "Ada" }, "PUT"));
    expect(projections.plans).toHaveLength(0);

    const res = await app.request("/yorm/docs/Patient/p1/signal", json({ kind: "blur" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 1, pending: null });
    expect(projections.plans).toHaveLength(1);

    const bad = await app.request("/yorm/docs/Patient/p1/signal", json({ kind: "focus" }));
    expect(bad.status).toBe(400);
  });

  it("policy endpoint switches projection behavior", async () => {
    const { app, projections } = makeApp();
    await app.request("/yorm/docs/Patient/p1/policy", json({ kind: "explicit" }));
    await app.request("/yorm/docs/Patient/p1", json({ name: "Ada" }, "PUT"));
    expect(projections.plans).toHaveLength(0);

    // Switching back to every-change projects the pending backlog…
    await app.request("/yorm/docs/Patient/p1/policy", json({ kind: "every-change" }));
    await until(() => projections.plans.length === 1, "backlog projected");
    // …and subsequent writes project inline.
    await app.request("/yorm/docs/Patient/p1", json({ name: "Grace" }, "PUT"));
    expect(projections.plans).toHaveLength(2);

    const invalid = await app.request("/yorm/docs/Patient/p1/policy", json({ kind: "sometimes" }));
    expect(invalid.status).toBe(400);
  });

  it("onAuthorize false yields 403 on every route", async () => {
    const { app, projections } = makeApp({
      onAuthorize: (ctx, docRef) =>
        ctx.req.header("authorization") === "Bearer ok" && docRef.type === "Patient",
    });
    for (const [path, init] of [
      ["/yorm/docs/Patient/p1", undefined],
      ["/yorm/docs/Patient/p1", json({ name: "x" }, "PUT")],
      ["/yorm/docs/Patient/p1", json({ path: ["a"], value: 1 }, "PATCH")],
      ["/yorm/docs/Patient/p1/projection-state", undefined],
      ["/yorm/docs/Patient/p1/flush", { method: "POST" }],
      ["/yorm/docs/Patient/p1/signal", json({ kind: "blur" })],
      ["/yorm/docs/Patient/p1/policy", json({ kind: "explicit" })],
    ] as const) {
      expect((await app.request(path, init)).status).toBe(403);
    }
    expect(projections.plans).toHaveLength(0);

    const authed = await app.request("/yorm/docs/Patient/p1", {
      ...json({ name: "Ada" }, "PUT"),
      headers: { "content-type": "application/json", authorization: "Bearer ok" },
    });
    expect(authed.status).toBe(200);
  });

  it("malformed bodies yield 400", async () => {
    const { app } = makeApp();
    // Invalid JSON.
    expect(
      (
        await app.request("/yorm/docs/Patient/p1", {
          method: "PATCH",
          body: "not json",
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(400);
    // PATCH without a valid path.
    expect((await app.request("/yorm/docs/Patient/p1", json({ value: 1 }, "PATCH"))).status).toBe(
      400,
    );
    expect(
      (await app.request("/yorm/docs/Patient/p1", json({ path: [], value: 1 }, "PATCH"))).status,
    ).toBe(400);
    expect(
      (await app.request("/yorm/docs/Patient/p1", json({ path: [true] }, "PATCH"))).status,
    ).toBe(400);
    // PUT of a non-object document.
    expect((await app.request("/yorm/docs/Patient/p1", json([1, 2], "PUT"))).status).toBe(400);
  });

  it("a type without mappings still stores the document and plans nothing", async () => {
    const { app, documents, projections } = makeApp();
    const put = await app.request("/yorm/docs/Widget/w1", json({ label: "hi" }, "PUT"));
    expect(put.status).toBe(200);

    const get = await app.request("/yorm/docs/Widget/w1");
    expect(await get.json()).toEqual({ object: { label: "hi" }, version: 1 });

    await until(() => documents.snapshots.has("Widget/w1"), "snapshot persisted");
    expect(projections.plans).toHaveLength(0);

    const state = await (await app.request("/yorm/docs/Widget/w1/projection-state")).json();
    expect(state.checkpoints).toEqual([]);
  });
});

describe("@yorm/hono proposal routes (PLAN.md M7)", () => {
  /** mode from `?mode=`; proposers may only write the proposals subtree. */
  const modeOptions: HonoYormOptions = {
    onAuthorizeWrite: (ctx, _docRef, scope) =>
      (ctx.req.query("mode") ?? "editor") === "proposer" ? scope === "proposals" : true,
  };

  const propose = (app: Hono, body: unknown, query = "?mode=proposer") =>
    app.request(`/yorm/docs/Patient/p1/proposals${query}`, json(body));

  async function seeded(options: HonoYormOptions = modeOptions) {
    const made = makeApp(options);
    await made.app.request("/yorm/docs/Patient/p1", json({ name: "Ada" }, "PUT"));
    return made;
  }

  it("a proposer can POST proposals but direct canonical writes are 403", async () => {
    const { app } = await seeded();
    const created = await propose(app, {
      path: ["name"],
      op: "set",
      proposedValue: "Grace",
      actor: "bob",
    });
    expect(created.status).toBe(201);
    const { proposal } = await created.json();
    expect(proposal).toMatchObject({
      path: ["name"],
      op: "set",
      proposedValue: "Grace",
      baseValue: "Ada",
      actor: "bob",
      status: "proposed",
    });

    // Canonical writes from the proposer role are refused…
    expect(
      (await app.request("/yorm/docs/Patient/p1?mode=proposer", json({ name: "x" }, "PUT"))).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          "/yorm/docs/Patient/p1?mode=proposer",
          json({ path: ["name"], value: "x" }, "PATCH"),
        )
      ).status,
    ).toBe(403);
    // …including accepting (accept writes canonical state).
    expect(
      (
        await app.request(`/yorm/docs/Patient/p1/proposals/${proposal.id}/accept?mode=proposer`, {
          method: "POST",
        })
      ).status,
    ).toBe(403);
    // The document is unchanged.
    expect((await (await app.request("/yorm/docs/Patient/p1")).json()).object).toEqual({
      name: "Ada",
    });
  });

  it("an editor accepts via REST: canonical updates and the proposal resolves", async () => {
    const { app, projections } = await seeded();
    const { proposal } = await (
      await propose(app, { path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" })
    ).json();

    const accept = await app.request(
      `/yorm/docs/Patient/p1/proposals/${proposal.id}/accept`,
      json({ resolvedBy: "alice" }),
    );
    expect(accept.status).toBe(200);
    expect(await accept.json()).toMatchObject({ conflict: false });

    expect((await (await app.request("/yorm/docs/Patient/p1")).json()).object).toEqual({
      name: "Grace",
    });
    const list = await (await app.request("/yorm/docs/Patient/p1/proposals")).json();
    expect(list.proposals[0]).toMatchObject({ status: "accepted", resolvedBy: "alice" });
    await until(
      () =>
        projections.plans.some((plan) =>
          plan.operations.some((op) => op.kind === "upsert" && op.values["name"] === "Grace"),
        ),
      "accepted value projected",
    );
  });

  it("a stale accept yields 409 with the current value", async () => {
    const { app } = await seeded();
    const { proposal } = await (
      await propose(app, { path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" })
    ).json();
    // Canonical moves after the proposal was made.
    await app.request("/yorm/docs/Patient/p1", json({ path: ["name"], value: "Hedy" }, "PATCH"));

    const stale = await app.request(`/yorm/docs/Patient/p1/proposals/${proposal.id}/accept`, {
      method: "POST",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ conflict: true, currentValue: "Hedy" });
    // Still proposed; accept-anyway forces it.
    const anyway = await app.request(
      `/yorm/docs/Patient/p1/proposals/${proposal.id}/accept-anyway`,
      json({ resolvedBy: "alice" }),
    );
    expect(anyway.status).toBe(200);
    expect((await (await app.request("/yorm/docs/Patient/p1")).json()).object).toEqual({
      name: "Grace",
    });
  });

  it("reject and withdraw round-trip; resolved/missing proposals map to 409/404", async () => {
    const { app } = await seeded();
    const { proposal } = await (
      await propose(app, { path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" })
    ).json();

    const reject = await app.request(
      `/yorm/docs/Patient/p1/proposals/${proposal.id}/reject`,
      json({ resolvedBy: "alice" }),
    );
    expect(reject.status).toBe(200);
    expect((await (await app.request("/yorm/docs/Patient/p1")).json()).object).toEqual({
      name: "Ada",
    });
    const rejected = await (
      await app.request("/yorm/docs/Patient/p1/proposals?status=rejected")
    ).json();
    expect(rejected.proposals).toHaveLength(1);

    // Withdrawing a resolved proposal is a state conflict.
    expect(
      (
        await app.request(`/yorm/docs/Patient/p1/proposals/${proposal.id}?mode=proposer`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(409);
    // Unknown proposal ids are 404.
    expect(
      (await app.request("/yorm/docs/Patient/p1/proposals/nope/accept", { method: "POST" })).status,
    ).toBe(404);

    // A fresh proposal withdraws cleanly.
    const { proposal: second } = await (
      await propose(app, { path: ["name"], op: "set", proposedValue: "Hedy", actor: "bob" })
    ).json();
    expect(
      (
        await app.request(`/yorm/docs/Patient/p1/proposals/${second.id}?mode=proposer`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    const remaining = await (await app.request("/yorm/docs/Patient/p1/proposals")).json();
    expect(remaining.proposals.map((p: { id: string }) => p.id)).not.toContain(second.id);
  });

  it("clear-resolved deletes resolved history only and needs canonical scope", async () => {
    const { app } = await seeded();
    const { proposal: first } = await (
      await propose(app, { path: ["name"], op: "set", proposedValue: "Grace", actor: "bob" })
    ).json();
    await app.request(
      `/yorm/docs/Patient/p1/proposals/${first.id}/reject`,
      json({ resolvedBy: "alice" }),
    );
    const { proposal: open } = await (
      await propose(app, { path: ["name"], op: "set", proposedValue: "Hedy", actor: "bob" })
    ).json();

    // Proposers may not rewrite shared history.
    expect(
      (
        await app.request("/yorm/docs/Patient/p1/proposals/clear-resolved?mode=proposer", {
          method: "POST",
        })
      ).status,
    ).toBe(403);

    const cleared = await app.request("/yorm/docs/Patient/p1/proposals/clear-resolved", {
      method: "POST",
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ cleared: 1 });
    const remainingAfterClear = await (await app.request("/yorm/docs/Patient/p1/proposals")).json();
    expect(remainingAfterClear.proposals.map((p: { id: string }) => p.id)).toEqual([open.id]);
  });

  it("malformed proposal bodies yield 400", async () => {
    const { app } = await seeded();
    for (const body of [
      { op: "set", proposedValue: 1, actor: "bob" }, // missing path
      { path: ["name"], op: "rename", proposedValue: 1, actor: "bob" }, // bad op
      { path: ["name"], op: "set", proposedValue: 1 }, // missing actor
      { path: ["name"], op: "set", actor: "bob" }, // set without value
    ]) {
      expect((await propose(app, body)).status).toBe(400);
    }
    expect((await app.request("/yorm/docs/Patient/p1/proposals?status=weird")).status).toBe(400);
  });
});
