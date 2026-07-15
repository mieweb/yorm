/**
 * POC wiring (PLAN.md Milestone 5e): SQLite adapter + contacts DDL + YORM
 * orchestrator + Hono server with the Node WebSocket upgrader — everything
 * the seed/demo/server scripts and the tests share.
 */
import { readFileSync } from "node:fs";
import { createNodeWebSocket } from "@hono/node-ws";
import type { NodeWebSocket } from "@hono/node-ws";
import { sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { createSqliteAdapter } from "@yorm/drizzle";
import type { SqliteAdapter } from "@yorm/drizzle";
import { fhirResource } from "@yorm/fhir";
import type { Patient } from "@yorm/fhir";
import { createHonoYorm } from "@yorm/hono";
import type { HonoYormOptions } from "@yorm/hono";
import { createYorm, memoryRuntime } from "@yorm/yjs";
import type { AnyMapping, Yorm } from "@yorm/yjs";

import { contactToPatient } from "./importContacts.js";
import { patientContactsMapping } from "./mapping.js";
import { CONTACTS_DDL, CONTACT_TABLES } from "./schema.js";
import type { ContactRecord } from "./schema.js";

export interface PocServer {
  /** Hono app with the YORM plugin mounted at `/yorm`. */
  app: Hono;
  yorm: Yorm;
  adapter: SqliteAdapter;
  db: BetterSQLite3Database;
  /** Wire the WebSocket upgrader into a `@hono/node-server` instance. */
  injectWebSocket: NodeWebSocket["injectWebSocket"];
  close(): void;
}

export interface PocServerOptions {
  /** SQLite file path (in-memory when absent). */
  file?: string;
  /** Extra mappings registered alongside `fhir.Patient@1` (e.g. the M7 proposal tracking mapping). */
  mappings?: AnyMapping[];
  /** Extra plugin options (e.g. `onAuthorizeWrite`); the WebSocket upgrader is always wired. */
  honoOptions?: Omit<HonoYormOptions, "upgradeWebSocket">;
}

/**
 * Creates the full POC stack on SQLite (in-memory by default, or a file via
 * `options.file`): migrates the `yorm_*` system tables, creates the contact
 * tables, and mounts `createHonoYorm` at `/yorm` with y-protocols WebSockets.
 */
export function createPocServer(options: PocServerOptions = {}): PocServer {
  const adapter = createSqliteAdapter(options.file !== undefined ? { file: options.file } : {});
  adapter.migrate();
  for (const ddl of CONTACTS_DDL) {
    adapter.db.run(sql.raw(ddl));
  }
  const yorm = createYorm({
    runtime: memoryRuntime(),
    documents: adapter.documents,
    projections: adapter.projections,
    mappings: [patientContactsMapping, ...(options.mappings ?? [])],
    codecs: { Patient: fhirResource<Patient>("Patient") },
  });
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
  app.route("/yorm", createHonoYorm(yorm, { ...options.honoOptions, upgradeWebSocket }));
  return {
    app,
    yorm,
    adapter,
    db: adapter.db,
    injectWebSocket,
    close() {
      adapter.close();
    },
  };
}

/**
 * Imports contact records as canonical Patient documents: write via the FHIR
 * codec, projection flushes before each write resolves (`every-change`
 * policy). Returns the ingested Patients.
 */
export async function seedContacts(yorm: Yorm, records: ContactRecord[]): Promise<Patient[]> {
  const patients: Patient[] = [];
  for (const record of records) {
    const patient = contactToPatient(record);
    const session = await yorm.open("Patient", record.id);
    await session.write(patient);
    session.close();
    patients.push(patient);
  }
  return patients;
}

/** Loads the contact records from `fixtures/contacts/contacts-example.json`. */
export function loadContactsFixture(): ContactRecord[] {
  const url = new URL("../../../fixtures/contacts/contacts-example.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(url, "utf8")) as { contacts: ContactRecord[] };
  return parsed.contacts;
}

/** Loads `fixtures/fhir-r4/patient/patient-example.json`. */
export function loadPatientFixture(): Patient {
  const url = new URL("../../../fixtures/fhir-r4/patient/patient-example.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Patient;
}

/** Row counts of the four contact tables (table names come from the trusted constant). */
export function contactRowCounts(db: BetterSQLite3Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of CONTACT_TABLES) {
    const row = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ${sql.raw(table)}`)[0];
    counts[table] = row?.n ?? 0;
  }
  return counts;
}
