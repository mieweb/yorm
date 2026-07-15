/**
 * YORM system tables (Drizzle sqlite-core definitions).
 *
 * Dialect-specific by nature; the store implementations keep their logic
 * dialect-agnostic by only depending on these table objects and on raw SQL
 * built from validated identifiers. (Outbox table deferred — PLAN Decision #3.)
 */
import { blob, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Canonical document snapshots. One row per (type, id). */
export const yormDocument = sqliteTable(
  "yorm_document",
  {
    documentId: text("document_id").notNull(),
    documentType: text("document_type").notNull(),
    /** Encoded Yjs document state (opaque bytes). */
    encodedState: blob("encoded_state", { mode: "buffer" }).notNull(),
    documentVersion: integer("document_version").notNull(),
    /** Milliseconds since epoch. */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.documentType, table.documentId] }),
  }),
);

/** Append-only incremental document update log. */
export const yormUpdate = sqliteTable("yorm_update", {
  updateId: integer("update_id").primaryKey({ autoIncrement: true }),
  documentId: text("document_id").notNull(),
  /**
   * Nullable: core's `DocumentUpdate` carries no `documentType`, so
   * `appendUpdate` cannot populate it. Reserved for future use; updates are
   * addressed by `document_id` alone.
   */
  documentType: text("document_type"),
  documentVersion: integer("document_version").notNull(),
  encodedUpdate: blob("encoded_update", { mode: "buffer" }).notNull(),
  actor: text("actor"),
  origin: text("origin").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** Per-document, per-mapping projection checkpoint / status. */
export const yormProjectionState = sqliteTable(
  "yorm_projection_state",
  {
    documentId: text("document_id").notNull(),
    mappingName: text("mapping_name").notNull(),
    mappingVersion: integer("mapping_version").notNull(),
    sourceDocumentVersion: integer("source_document_version").notNull(),
    status: text("status", { enum: ["ok", "error"] }).notNull(),
    projectedAt: integer("projected_at", { mode: "timestamp_ms" }).notNull(),
    error: text("error"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.documentId, table.mappingName] }),
  }),
);
