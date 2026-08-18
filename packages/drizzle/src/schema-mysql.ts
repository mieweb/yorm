/**
 * YORM system tables, mysql-core edition — the MySQL twin of `schema.ts`.
 *
 * Column names and semantics are identical to the SQLite schema; only the
 * types change. `varchar(191)` for key columns keeps composite primary keys
 * inside InnoDB's 3072-byte index limit under `utf8mb4`, and `datetime(3)`
 * gives the millisecond precision the store contract round-trips (Drizzle
 * reads MySQL `DATETIME` as UTC, so timestamps survive exactly).
 */
import {
  bigint,
  customType,
  datetime,
  int,
  mysqlTable,
  primaryKey,
  text,
  varchar,
} from "drizzle-orm/mysql-core";

/** mysql-core ships no blob column; encoded Yjs state needs LONGBLOB, not VARBINARY. */
const longblob = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "longblob",
});

/** Widest value that can take part in a composite key under utf8mb4. */
const KEY = 191;

/** Canonical document snapshots. One row per (type, id). */
export const yormDocumentMysql = mysqlTable(
  "yorm_document",
  {
    documentId: varchar("document_id", { length: KEY }).notNull(),
    documentType: varchar("document_type", { length: KEY }).notNull(),
    /** Encoded Yjs document state (opaque bytes). */
    encodedState: longblob("encoded_state").notNull(),
    documentVersion: int("document_version").notNull(),
    createdAt: datetime("created_at", { fsp: 3 }).notNull(),
    updatedAt: datetime("updated_at", { fsp: 3 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.documentType, table.documentId] })],
);

/** Append-only update log, ordered by `document_version` per document. */
export const yormUpdateMysql = mysqlTable("yorm_update", {
  updateId: bigint("update_id", { mode: "number" }).autoincrement().primaryKey(),
  documentId: varchar("document_id", { length: KEY }).notNull(),
  documentType: varchar("document_type", { length: KEY }),
  documentVersion: int("document_version").notNull(),
  encodedUpdate: longblob("encoded_update").notNull(),
  actor: varchar("actor", { length: KEY }),
  origin: varchar("origin", { length: 32 }).notNull(),
  createdAt: datetime("created_at", { fsp: 3 }).notNull(),
});

/** One projection checkpoint per (document, mapping). */
export const yormProjectionStateMysql = mysqlTable(
  "yorm_projection_state",
  {
    documentId: varchar("document_id", { length: KEY }).notNull(),
    mappingName: varchar("mapping_name", { length: KEY }).notNull(),
    mappingVersion: int("mapping_version").notNull(),
    sourceDocumentVersion: int("source_document_version").notNull(),
    status: varchar("status", { length: 8 }).$type<"ok" | "error">().notNull(),
    projectedAt: datetime("projected_at", { fsp: 3 }).notNull(),
    error: text("error"),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.mappingName] })],
);
