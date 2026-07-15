import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { defineMapping, one } from "@yorm/core";
import { createYorm, memoryRuntime } from "@yorm/yjs";

import { createHonoYorm } from "../src/index.js";
import type { FakeDocumentStore, FakeProjectionStore } from "./fakes.js";
import { fakeDocumentStore, fakeProjectionStore, until } from "./fakes.js";

/**
 * Minimal y-protocols client on Node 22's global WebSocket (no extra client
 * dependency needed): sends SyncStep1 on open, answers sync messages, and
 * forwards local doc updates to the server.
 */
class MiniClient {
  readonly doc = new Y.Doc();
  readonly ws: WebSocket;
  closed: { code: number } | null = null;
  synced = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.ws.send(encoding.toUint8Array(encoder));
    });
    this.ws.addEventListener("message", (evt: MessageEvent) => {
      const data = new Uint8Array(evt.data as ArrayBuffer);
      const decoder = decoding.createDecoder(data);
      if (decoding.readVarUint(decoder) !== 0) {
        return; // awareness — not exercised by these tests
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      const messageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (messageType === syncProtocol.messageYjsSyncStep2) {
        this.synced = true;
      }
      if (encoding.length(encoder) > 1) {
        this.ws.send(encoding.toUint8Array(encoder));
      }
    });
    this.ws.addEventListener("close", (evt: CloseEvent) => {
      this.closed = { code: evt.code };
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) {
        return; // came from the server; don't echo back
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeUpdate(encoder, update);
      this.ws.send(encoding.toUint8Array(encoder));
    });
  }

  close(): void {
    this.ws.close();
  }
}

const patientMapping = defineMapping<{ name?: string }>({
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

describe("@yorm/hono WebSocket route", () => {
  let app: Hono;
  let server: ServerType;
  let port: number;
  let documents: FakeDocumentStore;
  let projections: FakeProjectionStore;
  const clients: MiniClient[] = [];

  const connect = (path: string): MiniClient => {
    const client = new MiniClient(`ws://127.0.0.1:${port}${path}`);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    documents = fakeDocumentStore();
    projections = fakeProjectionStore();
    const yorm = createYorm({
      runtime: memoryRuntime(),
      documents,
      projections,
      mappings: [patientMapping],
    });
    app = new Hono();
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
    app.route(
      "/yorm",
      createHonoYorm(yorm, {
        upgradeWebSocket,
        onAuthorize: (ctx) => ctx.req.query("token") !== "bad",
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

  it("two clients converge and the server projects the edit", async () => {
    const a = connect("/yorm/ws/Patient/p1");
    const b = connect("/yorm/ws/Patient/p1");
    await until(() => a.synced && b.synced, "both clients synced");

    a.doc.getMap("resource").set("name", "Ada");
    await until(() => b.doc.getMap("resource").get("name") === "Ada", "edit converged to client B");

    // Default policy is every-change: the projection store received a plan
    // reflecting the edit.
    await until(
      () =>
        projections.plans.some(
          (plan) =>
            plan.documentId === "p1" &&
            plan.operations.some((op) => op.kind === "upsert" && op.values["name"] === "Ada"),
        ),
      "server projected the edit",
    );
    // …and the document itself was persisted.
    await until(() => documents.snapshots.has("Patient/p1"), "document persisted");
  });

  it("a late joiner receives existing state via sync", async () => {
    const late = connect("/yorm/ws/Patient/p1");
    await until(() => late.doc.getMap("resource").get("name") === "Ada", "late joiner caught up");
  });

  it("unauthorized sockets are closed with 1008", async () => {
    const denied = connect("/yorm/ws/Patient/p1?token=bad");
    await until(() => denied.closed !== null, "unauthorized socket closed");
    expect(denied.closed).toEqual({ code: 1008 });
  });

  it("?policy=explicit defers projection until an HTTP flush", async () => {
    const client = connect("/yorm/ws/Patient/p2?policy=explicit");
    await until(() => client.synced, "client synced");

    client.doc.getMap("resource").set("name", "Grace");
    await until(
      () => documents.updates.some((update) => update.documentId === "p2"),
      "update persisted",
    );
    await new Promise((resolve) => setTimeout(resolve, 100)); // bounded settle
    expect(projections.plans.filter((plan) => plan.documentId === "p2")).toHaveLength(0);

    const flush = await app.request("/yorm/docs/Patient/p2/flush", { method: "POST" });
    expect(flush.status).toBe(200);
    expect(projections.plans.filter((plan) => plan.documentId === "p2")).toHaveLength(1);
  });
});
