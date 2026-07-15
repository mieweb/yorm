/**
 * Concurrent Yjs edit test (PLAN.md 5d): two WebSocket clients edit
 * different fields of the same Patient; both converge and the projected
 * rows contain both edits.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { sql } from "drizzle-orm";
import type * as Y from "yjs";

import { MiniClient, findYElement, until } from "../src/miniClient.js";
import type { ContactMultivalueRow, ContactRow } from "../src/schema.js";
import { createPocServer, loadContactsFixture, seedContacts } from "../src/setup.js";
import type { PocServer } from "../src/setup.js";

const NEW_BIRTHDAY = "1975-01-01";
const NEW_EMAIL = "jim@example.net";

describe("concurrent edits over WebSocket", () => {
  let poc: PocServer;
  let server: ServerType;
  let port: number;
  const clients: MiniClient[] = [];

  const connect = (path: string): MiniClient => {
    const client = new MiniClient(`ws://127.0.0.1:${port}${path}`);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    poc = createPocServer();
    await seedContacts(poc.yorm, loadContactsFixture());
    await new Promise<void>((resolve) => {
      server = serve({ fetch: poc.app.fetch, port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
    });
    poc.injectWebSocket(server);
  });

  afterAll(async () => {
    for (const client of clients) {
      client.close();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    poc.close();
  });

  it("two clients edit different fields; both converge; rows contain both edits", async () => {
    const a = connect("/yorm/ws/Patient/c-100");
    const b = connect("/yorm/ws/Patient/c-100");
    await until(() => a.synced && b.synced, "both clients synced");
    await until(
      () =>
        a.doc.getMap("resource").get("birthDate") !== undefined &&
        b.doc.getMap("resource").get("telecom") !== undefined,
      "both clients received the seeded state",
    );

    // Client A edits the birth date…
    a.doc.getMap("resource").set("birthDate", NEW_BIRTHDAY);
    // …while client B edits the home email (a different field).
    const telecom = b.doc.getMap("resource").get("telecom") as Y.Array<unknown>;
    findYElement(telecom, "t2")!.set("value", NEW_EMAIL);

    // Both clients converge on both edits.
    await until(() => {
      const telecomOnA = a.doc.getMap("resource").get("telecom") as Y.Array<unknown>;
      return findYElement(telecomOnA, "t2")?.get("value") === NEW_EMAIL;
    }, "client A sees B's telecom edit");
    await until(
      () => b.doc.getMap("resource").get("birthDate") === NEW_BIRTHDAY,
      "client B sees A's birthDate edit",
    );

    // Explicit flush (a no-op under every-change, but proves the endpoint) …
    const flush = await poc.app.request("/yorm/docs/Patient/c-100/flush", { method: "POST" });
    expect(flush.status).toBe(200);

    // …then the projected rows contain both edits, without losing either.
    await until(() => {
      const contact = poc.db.all<ContactRow>(
        sql`SELECT * FROM contact WHERE contact_id = 'c-100'`,
      )[0];
      const email = poc.db.all<ContactMultivalueRow>(
        sql`SELECT * FROM contact_multivalue WHERE contact_id = 'c-100' AND element_id = 't2'`,
      )[0];
      return contact?.birthday === NEW_BIRTHDAY && email?.value === NEW_EMAIL;
    }, "rows contain both edits");
  });
});
