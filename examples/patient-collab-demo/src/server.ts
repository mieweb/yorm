/**
 * Demo server (PLAN.md Milestones 6 + 7c): the Contacts⇄Patient POC stack
 * from `example-fhir-patient-contacts` (SQLite + contacts DDL +
 * `fhir.Patient@1` mapping + `createHonoYorm` at `/yorm` with y-protocols
 * WebSockets), plus:
 *
 * - one seeded Patient `p-demo` (from the contacts fixture),
 * - demo-level write modes (M7c): the mode travels as `?mode=proposer|editor`
 *   on WebSocket upgrades and as an `X-Demo-Mode` header (or `mode` query) on
 *   REST calls; `onAuthorizeWrite` lets proposers write only the proposals
 *   subtree — direct canonical writes (PUT/PATCH/accept/reject) get 403,
 *   and the plugin's `?mode=proposer` WebSocket guard closes any socket
 *   that tries a canonical edit (1008),
 * - policy-lens roles (role-security POC): `?role=receptionist|nurse` on a
 *   WebSocket upgrade syncs a per-role redacted view with server-enforced
 *   write rules ([src/rolePolicies.ts](./rolePolicies.ts)),
 * - the `yorm_proposal` tracking projection (`proposalTrackingMapping`) so
 *   open/resolved proposals are visible as SQL rows,
 * - `GET /api/rows` — the live contact-table + `yorm_proposal` rows for the
 *   projection panel,
 * - `GET /api/sql?since=<seq>` — one entry per projection commit since that
 *   sequence number, each carrying the SQL that commit wrote, so the panel can
 *   attribute statements to the document change set that caused them,
 * - static serving of the built client (`dist/`) in prod mode.
 *
 * In dev the Vite server (port 5173) proxies `/yorm` + `/api` here.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context } from "hono";
import {
  createPocServer,
  loadContactsFixture,
  seedContacts,
} from "example-fhir-patient-contacts/setup";
import type { ProjectionCommit, ProjectionStatement } from "example-fhir-patient-contacts/setup";
import { CONTACT_TABLES } from "example-fhir-patient-contacts/schema";
import { proposalTrackingMapping } from "@yorm/yjs";

import { demoRolePolicies } from "./rolePolicies.js";

const PATIENT_ID = "p-demo";
const port = Number(process.env.PORT ?? 5178);

/**
 * Demo-level authentication: the mode is whatever the client claims via the
 * `X-Demo-Mode` header or `mode` query param (a real deployment would derive
 * it from a verified identity).
 */
function demoMode(c: Context): string {
  return c.req.header("x-demo-mode") ?? c.req.query("mode") ?? "editor";
}

/** Tables shown in the live rows panel, with deterministic ordering. */
const ROWS_TABLES = [...CONTACT_TABLES, "yorm_proposal"] as const;
const ORDER_BY: Record<(typeof ROWS_TABLES)[number], string> = {
  contact: "contact_id",
  contact_multivalue: "contact_id, element_id",
  contact_multivalue_entry: "contact_id, element_id, entry_key",
  contact_raw_property: "contact_id, property",
  yorm_proposal: "created_at, proposal_id",
};

const PROJECTION_TABLES: readonly string[] = ROWS_TABLES;
/** Enough history for a client that missed a poll or two; the panel shows far fewer. */
const COMMIT_LOG_LIMIT = 50;

interface DemoCommit {
  seq: number;
  documentId: string;
  documentVersion: number;
  origin: string;
  statements: string[];
}

let commitSeq = 0;
const commitLog: DemoCommit[] = [];

/**
 * Renders a statement for display only — never executed. The engine binds
 * parameters, so the placeholders are filled in here purely so the panel can
 * show the values that were written.
 */
function displaySql(statement: ProjectionStatement): string {
  let index = 0;
  return statement.sql.replace(/\?/g, () => {
    const value = statement.params[index++];
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return `'${String(value).replace(/'/g, "''")}'`;
  });
}

/**
 * One entry per projection commit, so the panel can attribute statements to the
 * document change set that caused them. The checkpoint advance and other
 * `yorm_*` bookkeeping are dropped — the panel only shows the row tables.
 */
function recordCommit(commit: ProjectionCommit): void {
  const statements = commit.statements
    .filter((statement) => PROJECTION_TABLES.some((table) => statement.sql.includes(table)))
    .map(displaySql);
  if (statements.length === 0) return;
  commitLog.push({
    seq: ++commitSeq,
    documentId: commit.documentId,
    documentVersion: commit.documentVersion,
    origin: commit.origin,
    statements,
  });
  if (commitLog.length > COMMIT_LOG_LIMIT) {
    commitLog.splice(0, commitLog.length - COMMIT_LOG_LIMIT);
  }
}

const poc = createPocServer({
  mappings: [proposalTrackingMapping("Patient")],
  onCommit: recordCommit,
  honoOptions: {
    // Proposers may write the proposals subtree but never canonical state;
    // editors may write both.
    onAuthorizeWrite: (c, _docRef, scope) => scope === "proposals" || demoMode(c) !== "proposer",
    // Policy-lens roles (role-security POC): `?role=receptionist|nurse` on a
    // WebSocket upgrade syncs a derived, redacted Y.Doc instead of the
    // canonical one — see src/rolePolicies.ts. No `?role=` (or physician)
    // means full canonical access.
    rolePolicies: demoRolePolicies,
  },
});

// drizzle's `drizzle()` return carries `$client` (the better-sqlite3 handle),
// but the POC's `PocServer.db` is typed as the plain drizzle interface — a
// structural cast keeps this example free of its own drizzle-orm instance.
const sqlite = (poc.db as unknown as { $client: SqliteClient }).$client;

interface SqliteClient {
  exec(source: string): unknown;
  prepare(source: string): { all(): unknown[] };
}

// The proposal tracking projection table (PLAN.md 7b) — created before the
// seed because every projection run reconciles it.
sqlite.exec(`CREATE TABLE IF NOT EXISTS yorm_proposal (
  document_id TEXT,
  proposal_id TEXT,
  path TEXT,
  op TEXT,
  status TEXT,
  actor TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT,
  PRIMARY KEY (document_id, proposal_id)
)`);

const template = loadContactsFixture()[0];
if (!template) {
  throw new Error("contacts fixture is empty");
}
await seedContacts(poc.yorm, [{ ...template, id: PATIENT_ID }]);

poc.app.get("/api/rows", (c) => {
  const rows: Record<string, unknown[]> = {};
  for (const table of ROWS_TABLES) {
    // Table/column names come from the trusted ROWS_TABLES/ORDER_BY constants.
    rows[table] = sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${ORDER_BY[table]}`).all();
  }
  return c.json(rows);
});

poc.app.get("/api/sql", (c) => {
  const since = Number(c.req.query("since") ?? 0);
  const commits = Number.isFinite(since)
    ? commitLog.filter((entry) => entry.seq > since)
    : commitLog;
  return c.json({ seq: commitSeq, commits });
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
  console.log(`  sql   /api/sql`);
});
poc.injectWebSocket(server);
