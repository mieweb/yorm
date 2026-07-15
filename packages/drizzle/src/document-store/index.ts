/**
 * `DocumentStore` on Drizzle (better-sqlite3 driver).
 *
 * Implements the core contract exactly: snapshot upsert, append-only update
 * log with `sinceVersion` filtering, and document listing for replay.
 */
import type { DocumentStore, DocumentUpdate, Origin, StoredDocument } from "@yorm/core";
import { and, asc, eq, gt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { yormDocument, yormUpdate } from "../schema.js";

/** Copies opaque bytes into a Buffer for better-sqlite3 blob binding. */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

/**
 * Creates a {@link DocumentStore} backed by the `yorm_document` and
 * `yorm_update` tables. Run {@link createSqliteAdapter}'s `migrate()` (or the
 * exported DDL) first so the tables exist.
 */
export function drizzleDocumentStore<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
): DocumentStore {
  return {
    async loadDocument(type: string, id: string): Promise<StoredDocument | null> {
      const rows = await db
        .select()
        .from(yormDocument)
        .where(and(eq(yormDocument.documentType, type), eq(yormDocument.documentId, id)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        documentId: row.documentId,
        documentType: row.documentType,
        encodedState: new Uint8Array(row.encodedState),
        documentVersion: row.documentVersion,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async saveSnapshot(doc: StoredDocument): Promise<void> {
      await db
        .insert(yormDocument)
        .values({
          documentId: doc.documentId,
          documentType: doc.documentType,
          encodedState: toBuffer(doc.encodedState),
          documentVersion: doc.documentVersion,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        })
        .onConflictDoUpdate({
          target: [yormDocument.documentType, yormDocument.documentId],
          set: {
            encodedState: toBuffer(doc.encodedState),
            documentVersion: doc.documentVersion,
            updatedAt: doc.updatedAt,
          },
        });
    },

    async appendUpdate(update: DocumentUpdate): Promise<void> {
      await db.insert(yormUpdate).values({
        documentId: update.documentId,
        documentVersion: update.documentVersion,
        encodedUpdate: toBuffer(update.encodedUpdate),
        actor: update.actor ?? null,
        origin: update.origin,
        createdAt: update.createdAt,
      });
    },

    async listUpdates(_type: string, id: string, sinceVersion?: number): Promise<DocumentUpdate[]> {
      // Core's DocumentUpdate carries no documentType, so updates are keyed
      // by documentId alone (see yorm_update.document_type in schema.ts).
      const condition =
        sinceVersion === undefined
          ? eq(yormUpdate.documentId, id)
          : and(eq(yormUpdate.documentId, id), gt(yormUpdate.documentVersion, sinceVersion));
      const rows = await db
        .select()
        .from(yormUpdate)
        .where(condition)
        .orderBy(asc(yormUpdate.documentVersion));
      return rows.map((row) => {
        const update: DocumentUpdate = {
          documentId: row.documentId,
          documentVersion: row.documentVersion,
          encodedUpdate: new Uint8Array(row.encodedUpdate),
          origin: row.origin as Origin,
          createdAt: row.createdAt,
        };
        if (row.actor !== null) update.actor = row.actor;
        return update;
      });
    },

    async listDocuments(
      type: string,
    ): Promise<Array<{ documentId: string; documentType: string }>> {
      return db
        .select({
          documentId: yormDocument.documentId,
          documentType: yormDocument.documentType,
        })
        .from(yormDocument)
        .where(eq(yormDocument.documentType, type));
    },
  };
}
