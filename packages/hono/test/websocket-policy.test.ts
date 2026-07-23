/**
 * Role-security POC e2e: WebSocket connections whose `?role=` matches a
 * policy sync a server-held lens doc (redacted view) and have every write
 * validated by the policy; roles without a policy keep full canonical sync.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import * as Y from "yjs";
import { createYorm, defineRolePolicy, memoryRuntime } from "@yorm/yjs";
import type { DocumentSession, RolePolicy } from "@yorm/yjs";

import { createHonoYorm } from "../src/index.js";
import { fakeDocumentStore, fakeProjectionStore, until } from "./fakes.js";
import { MiniClient } from "./miniClient.js";

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
    [...Object.keys(before), ...Object.keys(after)].every((key) => key === "demographics"),
});

/** Nurse: sees everything, may complete orders but not add/remove them. */
const nursePolicy = defineRolePolicy<Visit>({
  role: "nurse",
  documentType: "Visit",
  canWrite: ({ before, after }) => {
    const ordersBefore = (before as Visit).orders ?? [];
    const ordersAfter = (after as Visit).orders ?? [];
    return (
      ordersAfter.length === ordersBefore.length &&
      ordersAfter.every((order, i) => {
        const prev = ordersBefore[i]!;
        return order.id === prev.id && order.description === prev.description;
      })
    );
  },
});

describe("@yorm/hono WebSocket role policies", () => {
  let server: ServerType;
  let port: number;
  let session: DocumentSession;
  const clients: MiniClient[] = [];

  const connect = (query = ""): MiniClient => {
    const client = new MiniClient(`ws://127.0.0.1:${port}/yorm/ws/Visit/v1${query}`);
    clients.push(client);
    return client;
  };

  const resource = (client: MiniClient): Record<string, unknown> =>
    client.doc.getMap("resource").toJSON();

  beforeAll(async () => {
    const yorm = createYorm({
      runtime: memoryRuntime(),
      documents: fakeDocumentStore(),
      projections: fakeProjectionStore(),
      mappings: [],
    });
    session = await yorm.open("Visit", "v1");
    await session.write(initialVisit);

    const app = new Hono();
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    app.route(
      "/yorm",
      createHonoYorm(yorm, {
        upgradeWebSocket,
        rolePolicies: [receptionistPolicy as RolePolicy, nursePolicy as RolePolicy],
      }),
    );
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
    });
    injectWebSocket(server);
  });

  afterAll(async () => {
    for (const client of clients) {
      client.close();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("a receptionist syncs only the redacted view", async () => {
    const receptionist = connect("?role=receptionist");
    await until(() => receptionist.synced, "receptionist synced");
    expect(resource(receptionist)).toEqual({
      demographics: { name: "Ada Lovelace", dob: "1815-12-10" },
    });
    receptionist.close();
  });

  it("a connection without a policy role syncs the full canonical doc", async () => {
    const physician = connect();
    await until(() => physician.synced, "physician synced");
    expect(resource(physician)).toEqual(initialVisit);
    physician.close();
  });

  it("an allowed lens edit reaches the canonical doc and other roles", async () => {
    const receptionist = connect("?role=receptionist");
    const physician = connect();
    await until(() => receptionist.synced && physician.synced, "both synced");

    const demographics = receptionist.doc
      .getMap("resource")
      .get("demographics") as Y.Map<unknown>;
    demographics.set("name", "Ada King");

    await until(
      () => (session.read() as Visit).demographics?.name === "Ada King",
      "canonical updated through the lens",
    );
    // Hidden sections survive the write-back.
    expect((session.read() as Visit).orders).toEqual(initialVisit.orders);
    await until(
      () =>
        ((resource(physician) as Visit).demographics?.name ?? "") === "Ada King",
      "physician saw the receptionist's edit",
    );
    receptionist.close();
    physician.close();
  });

  it("a forbidden lens edit closes the socket with 1008 and changes nothing", async () => {
    const receptionist = connect("?role=receptionist");
    await until(() => receptionist.synced, "receptionist synced");

    receptionist.doc.getMap("resource").set("orders", "sneaky");
    await until(() => receptionist.closed !== null, "socket closed");
    expect(receptionist.closed).toEqual({ code: 1008 });
    expect((session.read() as Visit).orders).toEqual(initialVisit.orders);
  });

  it("a nurse may complete an order but is cut off for adding one", async () => {
    const nurse = connect("?role=nurse");
    await until(() => nurse.synced, "nurse synced");
    // Full visibility: the nurse lens has no `view`.
    expect(Object.keys(resource(nurse)).sort()).toEqual([
      "allergies",
      "demographics",
      "orders",
    ]);

    const orders = nurse.doc.getMap("resource").get("orders") as Y.Array<unknown>;
    (orders.get(0) as Y.Map<unknown>).set("status", "completed");
    await until(
      () => (session.read() as Visit).orders?.[0]?.status === "completed",
      "order completed through the lens",
    );

    const added = new Y.Map<unknown>();
    added.set("id", "o2");
    orders.push([added]);
    await until(() => nurse.closed !== null, "nurse socket closed");
    expect(nurse.closed).toEqual({ code: 1008 });
    expect((session.read() as Visit).orders).toHaveLength(1);
  });

  it("canonical edits propagate into an open lens", async () => {
    const receptionist = connect("?role=receptionist");
    await until(() => receptionist.synced, "receptionist synced");

    const current = session.read() as Visit;
    await session.write({
      ...current,
      demographics: { ...current.demographics, name: "Grace Hopper" },
    });
    await until(
      () =>
        ((resource(receptionist) as Visit).demographics?.name ?? "") === "Grace Hopper",
      "lens picked up the canonical edit",
    );
    // Still redacted.
    expect(Object.keys(resource(receptionist))).toEqual(["demographics"]);
    receptionist.close();
  });
});
