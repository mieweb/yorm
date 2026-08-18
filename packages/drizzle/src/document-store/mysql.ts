/**
 * `DocumentStore` on Drizzle (mysql2 driver).
 *
 * Same contract as the SQLite store; the dialect differences are the upsert
 * (`ON DUPLICATE KEY UPDATE` instead of `ON CONFLICT ... DO UPDATE`) and blob
 * binding, which mysql2 does with `Buffer` and reads back as `Buffer`.
 */
import type { DocumentStore, DocumentUpdate, Origin, StoredDocument } from "@yorm/core";
import { and, asc, eq, gt } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { yormDocumentMysql, yormUpdateMysql } from "../schema-mysql.js";

/** Copies opaque bytes into a Buffer for mysql2 blob binding. */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

/**
 * Creates a {@link DocumentStore} backed by the `yorm_document` and
 * `yorm_update` tables. Run {@link createMysqlAdapter}'s `migrate()` (or the
 * exported DDL) first so the tables exist.
 */
export function drizzleMysqlDocumentStore<TSchema extends Record<string, unknown>>(
  db: MySql2Database<TSchema>,
): DocumentStore {
  return {
    async loadDocument(type: string, id: string): Promise<StoredDocument | null> {
      const rows = await db
        .select()
        .from(yormDocumentMysql)
        .where(
          and(eq(yormDocumentMysql.documentType, type), eq(yormDocumentMysql.documentId, id)),
        )
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
        .insert(yormDocumentMysql)
        .values({
          documentId: doc.documentId,
          documentType: doc.documentType,
          encodedState: toBuffer(doc.encodedState),
          documentVersion: doc.documentVersion,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        })
        .onDuplicateKeyUpdate({
          set: {
            encodedState: toBuffer(doc.encodedState),
            documentVersion: doc.documentVersion,
            updatedAt: doc.updatedAt,
          },
        });
    },

    async appendUpdate(update: DocumentUpdate): Promise<void> {
      await db.insert(yormUpdateMysql).values({
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
          ? eq(yormUpdateMysql.documentId, id)
          : and(
              eq(yormUpdateMysql.documentId, id),
              gt(yormUpdateMysql.documentVersion, sinceVersion),
            );
      const rows = await db
        .select()
        .from(yormUpdateMysql)
        .where(condition)
        .orderBy(asc(yormUpdateMysql.documentVersion));
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
          documentId: yormDocumentMysql.documentId,
          documentType: yormDocumentMysql.documentType,
        })
        .from(yormDocumentMysql)
        .where(eq(yormDocumentMysql.documentType, type));
    },
  };
}
