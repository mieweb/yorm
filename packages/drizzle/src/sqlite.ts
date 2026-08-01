/**
 * SQLite wire-up — the default backend for the vertical slice (PLAN M4b).
 *
 * `createSqliteAdapter` bundles a better-sqlite3 connection, both stores, and
 * a `migrate()` that creates the `yorm_*` system tables. `resolveBackend`
 * implements the `YORM_DB` plumbing so M9 backends slot in without touching
 * example code.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { DocumentStore, ProjectionStore } from "@yorm/core";
import { drizzleDocumentStore } from "./document-store/index.js";
import { drizzleProjectionStore } from "./projection-store/index.js";
import type { DrizzleProjectionStoreOptions } from "./projection-store/index.js";

/** DDL for the YORM system tables (idempotent; exported for reuse in tests and tooling). */
export const YORM_SQLITE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS yorm_document (
    document_id TEXT NOT NULL,
    document_type TEXT NOT NULL,
    encoded_state BLOB NOT NULL,
    document_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (document_type, document_id)
  )`,
  `CREATE TABLE IF NOT EXISTS yorm_update (
    update_id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL,
    document_type TEXT,
    document_version INTEGER NOT NULL,
    encoded_update BLOB NOT NULL,
    actor TEXT,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS yorm_projection_state (
    document_id TEXT NOT NULL,
    mapping_name TEXT NOT NULL,
    mapping_version INTEGER NOT NULL,
    source_document_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    projected_at INTEGER NOT NULL,
    error TEXT,
    PRIMARY KEY (document_id, mapping_name)
  )`,
];

export interface SqliteAdapterOptions {
  /** Database file path. Defaults to `":memory:"`. */
  file?: string;
  /** Forwarded to {@link drizzleProjectionStore}. */
  projections?: DrizzleProjectionStoreOptions;
  /**
   * Called with every statement the driver executes, parameters already
   * expanded. Intended for demos and debugging — it fires on every read too.
   */
  onStatement?: (sql: string) => void;
}

export interface SqliteAdapter {
  db: BetterSQLite3Database;
  documents: DocumentStore;
  projections: ProjectionStore;
  /** Creates the `yorm_*` system tables (CREATE TABLE IF NOT EXISTS). */
  migrate(): void;
  close(): void;
}

/** Creates a ready-to-use SQLite adapter (call `migrate()` before first use). */
export function createSqliteAdapter(options?: SqliteAdapterOptions): SqliteAdapter {
  const onStatement = options?.onStatement;
  const sqlite = new Database(
    options?.file ?? ":memory:",
    onStatement ? { verbose: (message?: unknown) => onStatement(String(message)) } : {},
  );
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  return {
    db,
    documents: drizzleDocumentStore(db),
    projections: drizzleProjectionStore(db, options?.projections),
    migrate() {
      for (const ddl of YORM_SQLITE_DDL) sqlite.exec(ddl);
    },
    close() {
      sqlite.close();
    },
  };
}

const PLANNED_BACKENDS = new Set(["pglite", "postgres", "mariadb", "mongodb"]);

/**
 * Resolves the `YORM_DB` environment value to a backend name.
 * Only `"sqlite"` is wired up in the vertical slice; the M9 backends throw a
 * helpful error until they land.
 */
export function resolveBackend(env?: string): "sqlite" {
  const value = (env ?? "sqlite").toLowerCase();
  if (value === "sqlite") return "sqlite";
  if (PLANNED_BACKENDS.has(value)) {
    throw new Error(
      `YORM_DB="${value}" is planned in Milestone 9 and not yet supported; use YORM_DB=sqlite`,
    );
  }
  throw new Error(
    `Unknown YORM_DB value "${value}"; supported: sqlite (pglite, postgres, mariadb, mongodb planned in M9)`,
  );
}
