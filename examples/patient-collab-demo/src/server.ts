/**
 * Demo server (PLAN.md Milestone 6): the Contacts⇄Patient POC stack from
 * `example-fhir-patient-contacts` (SQLite + contacts DDL + `fhir.Patient@1`
 * mapping + `createHonoYorm` at `/yorm` with y-protocols WebSockets), plus:
 *
 * - one seeded Patient `p-demo` (from the contacts fixture),
 * - `GET /api/rows` — the live contact-table rows for the projection panel,
 * - static serving of the built client (`dist/`) in prod mode.
 *
 * In dev the Vite server (port 5173) proxies `/yorm` + `/api` here.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  createPocServer,
  loadContactsFixture,
  seedContacts,
} from "example-fhir-patient-contacts/setup";
import { CONTACT_TABLES } from "example-fhir-patient-contacts/schema";

const PATIENT_ID = "p-demo";
const port = Number(process.env.PORT ?? 5178);

const poc = createPocServer();
const template = loadContactsFixture()[0];
if (!template) {
  throw new Error("contacts fixture is empty");
}
await seedContacts(poc.yorm, [{ ...template, id: PATIENT_ID }]);

/** Deterministic ordering per table so the rows panel is stable. */
const ORDER_BY: Record<(typeof CONTACT_TABLES)[number], string> = {
  contact: "contact_id",
  contact_multivalue: "contact_id, element_id",
  contact_multivalue_entry: "contact_id, element_id, entry_key",
  contact_raw_property: "contact_id, property",
};

// drizzle's `drizzle()` return carries `$client` (the better-sqlite3 handle),
// but the POC's `PocServer.db` is typed as the plain drizzle interface — a
// structural cast keeps this example free of its own drizzle-orm instance.
const sqlite = (poc.db as unknown as { $client: SqliteClient }).$client;

interface SqliteClient {
  prepare(source: string): { all(): unknown[] };
}

poc.app.get("/api/rows", (c) => {
  const rows: Record<string, unknown[]> = {};
  for (const table of CONTACT_TABLES) {
    // Table/column names come from the trusted CONTACT_TABLES/ORDER_BY constants.
    rows[table] = sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${ORDER_BY[table]}`).all();
  }
  return c.json(rows);
});

// Prod mode: serve the built client. `serveStatic` roots are cwd-relative,
// so scripts must run from this example's directory (pnpm --filter does).
if (existsSync(fileURLToPath(new URL("../dist", import.meta.url)))) {
  poc.app.use("/*", serveStatic({ root: "./dist" }));
}

const server = serve({ fetch: poc.app.fetch, port }, (info) => {
  console.log(`patient-collab-demo server on http://localhost:${info.port}`);
  console.log(`  doc   /yorm/docs/Patient/${PATIENT_ID}`);
  console.log(`  ws    /yorm/ws/Patient/${PATIENT_ID}`);
  console.log(`  rows  /api/rows`);
});
poc.injectWebSocket(server);
