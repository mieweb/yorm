/**
 * Demo script (PLAN.md M5e): import the contacts fixture → the canonical
 * FHIR Patient appears; then edit the Patient over a real y-protocols
 * WebSocket → watch the projected contact row update.
 * Run with `pnpm --filter example-fhir-patient-contacts demo`.
 */
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { sql } from "drizzle-orm";
import type * as Y from "yjs";

import { MiniClient, findYElement, until } from "./miniClient.js";
import type { ContactMultivalueRow } from "./schema.js";
import { contactRowCounts, createPocServer, loadContactsFixture, seedContacts } from "./setup.js";

const NEW_PHONE = "(03) 5555 0000";

console.log("=== YORM demo: contacts ⇄ FHIR Patient (SQLite) ===\n");

const poc = createPocServer();
const record = loadContactsFixture()[0];
if (record === undefined) {
  throw new Error("contacts fixture is empty");
}

console.log(`1) Import contact "${record.first} ${record.last}" → canonical FHIR Patient`);
const [patient] = await seedContacts(poc.yorm, [record]);
console.log(JSON.stringify(patient, null, 2));

console.log("\n2) Forward projection → contact tables");
console.log("   row counts:", contactRowCounts(poc.db));
const phoneRow = (): ContactMultivalueRow | undefined =>
  poc.db.all<ContactMultivalueRow>(
    sql`SELECT * FROM contact_multivalue WHERE contact_id = ${record.id} AND element_id = 't1'`,
  )[0];
console.log("   work phone row before edit:", phoneRow());

console.log("\n3) Edit the Patient over WebSocket (y-protocols client)");
let port = 0;
const server: ServerType = await new Promise((resolve) => {
  const s = serve({ fetch: poc.app.fetch, port: 0 }, (info) => {
    port = info.port;
    resolve(s);
  });
});
poc.injectWebSocket(server);

const client = new MiniClient(`ws://127.0.0.1:${port}/yorm/ws/Patient/${record.id}`);
await until(() => client.synced, "client synced");
const telecom = client.doc.getMap("resource").get("telecom") as Y.Array<unknown>;
const workPhone = findYElement(telecom, "t1");
if (workPhone === undefined) {
  throw new Error("telecom element t1 not found in the synced document");
}
console.log(`   client sets telecom[t1].value = "${NEW_PHONE}"`);
workPhone.set("value", NEW_PHONE);
await until(() => phoneRow()?.value === NEW_PHONE, "projected row updated");
console.log("   work phone row after edit: ", phoneRow());

client.close();
await new Promise<void>((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
});
poc.close();
console.log("\nDone: the WebSocket edit landed in SQLite via forward projection.");
