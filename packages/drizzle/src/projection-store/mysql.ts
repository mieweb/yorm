/**
 * `ProjectionStore` on Drizzle (mysql2 driver; MySQL 8 and MariaDB).
 *
 * The dialect-agnostic parts live in `./shared.js`; what differs here is the
 * upsert (`INSERT … ON DUPLICATE KEY UPDATE`), the reconcile row list (MySQL
 * takes a bare row-constructor list after `NOT IN`, with no `VALUES` keyword),
 * and the transaction, which is asynchronous.
 */
import type {
  ProjectionCheckpoint,
  ProjectionPlan,
  ProjectionStateRecord,
  ProjectionStore,
  ReconcileOperation,
  UpsertOperation,
} from "@yorm/core";
import type { SQL } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { yormProjectionStateMysql } from "../schema-mysql.js";
import type { DrizzleProjectionStoreOptions, ProjectionStatement } from "./shared.js";
import {
  COMMA,
  assertIdentifier,
  bindable,
  buildKeepRows,
  buildScopeCondition,
  cell,
  tableResolver,
  toStateRecord,
} from "./shared.js";

function buildUpsert(op: UpsertOperation, table: string): SQL {
  const keyColumns = Object.keys(op.key);
  const ownedColumns = op.ownedColumns.map((column) => assertIdentifier(column, "column"));
  for (const column of keyColumns) assertIdentifier(column, "column");

  const insertColumns = [...keyColumns, ...ownedColumns];
  const columnList = sql.join(
    insertColumns.map((column) => sql.identifier(column)),
    COMMA,
  );
  const valueList = sql.join(
    insertColumns.map((column) =>
      column in op.key
        ? sql`${bindable(cell(op.key, column, "key", table))}`
        : sql`${bindable(cell(op.values, column, "owned", table))}`,
    ),
    COMMA,
  );

  // `VALUES(col)` rather than MySQL 8.0.19's `AS new` row alias: MariaDB has no
  // row alias, and the deprecated function still works on every MySQL 8.
  // MySQL has no "do nothing" clause either; assigning a key column to itself is
  // the conflict-free equivalent, and unlike INSERT IGNORE it swallows no errors.
  const setList =
    ownedColumns.length === 0
      ? sql.join(
          keyColumns.map((column) => sql`${sql.identifier(column)} = ${sql.identifier(column)}`),
          COMMA,
        )
      : sql.join(
          ownedColumns.map(
            (column) => sql`${sql.identifier(column)} = values(${sql.identifier(column)})`,
          ),
          COMMA,
        );
  return sql`insert into ${sql.identifier(table)} (${columnList}) values (${valueList}) on duplicate key update ${setList}`;
}

function buildReconcile(op: ReconcileOperation, table: string): SQL {
  if (Object.keys(op.scope).length === 0) {
    throw new Error(
      `drizzleProjectionStore: reconcile for table "${table}" has an empty scope; refusing an unconstrained delete`,
    );
  }
  const scopeCondition = buildScopeCondition(op.scope);
  if (op.keepKeys.length === 0) {
    return sql`delete from ${sql.identifier(table)} where ${scopeCondition}`;
  }

  const keyColumns = op.keyColumns.map((column) => assertIdentifier(column, "column"));
  const keyTuple = sql.join(
    keyColumns.map((column) => sql.identifier(column)),
    COMMA,
  );
  const keepRows = buildKeepRows(op.keepKeys, keyColumns, table);
  return sql`delete from ${sql.identifier(table)} where ${scopeCondition} and (${keyTuple}) not in (${keepRows})`;
}

/**
 * Creates a {@link ProjectionStore} that applies plans to MySQL projection
 * tables and tracks checkpoints in `yorm_projection_state`.
 *
 * Requirements on projection tables: the plan's key columns must be covered by
 * a `PRIMARY KEY` or `UNIQUE` constraint — and by *only* that constraint, since
 * `ON DUPLICATE KEY UPDATE` fires on any unique-key collision.
 */
export function drizzleMysqlProjectionStore<TSchema extends Record<string, unknown>>(
  db: MySql2Database<TSchema>,
  options?: DrizzleProjectionStoreOptions,
): ProjectionStore {
  const resolveTable = tableResolver(options?.tables ?? {});
  const onCommit = options?.onCommit;
  const dialect = new MySqlDialect();

  return {
    async applyPlan(plan: ProjectionPlan): Promise<void> {
      const statements: ProjectionStatement[] = [];
      await db.transaction(async (tx) => {
        for (const op of plan.operations) {
          const table = resolveTable(op.table);
          const statement =
            op.kind === "upsert" ? buildUpsert(op, table) : buildReconcile(op, table);
          if (onCommit) statements.push(dialect.sqlToQuery(statement));
          await tx.execute(statement);
        }
        const checkpoint = plan.checkpoint;
        const advance = tx
          .insert(yormProjectionStateMysql)
          .values({
            documentId: checkpoint.documentId,
            mappingName: checkpoint.mappingName,
            mappingVersion: checkpoint.mappingVersion,
            sourceDocumentVersion: checkpoint.sourceDocumentVersion,
            status: "ok",
            projectedAt: new Date(),
            error: null,
          })
          .onDuplicateKeyUpdate({
            set: {
              mappingVersion: checkpoint.mappingVersion,
              sourceDocumentVersion: checkpoint.sourceDocumentVersion,
              status: "ok",
              projectedAt: new Date(),
              error: null,
            },
          });
        if (onCommit) statements.push(advance.toSQL());
        await advance;
      });
      // After the transaction, so a rollback reports no statements.
      onCommit?.({
        mapping: plan.mapping,
        documentId: plan.documentId,
        documentType: plan.documentType,
        documentVersion: plan.documentVersion,
        origin: plan.origin,
        statements,
      });
    },

    async getState(documentId: string, mappingName: string): Promise<ProjectionStateRecord | null> {
      const rows = await db
        .select()
        .from(yormProjectionStateMysql)
        .where(
          and(
            eq(yormProjectionStateMysql.documentId, documentId),
            eq(yormProjectionStateMysql.mappingName, mappingName),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? toStateRecord(row) : null;
    },

    async listFailures(): Promise<ProjectionStateRecord[]> {
      const rows = await db
        .select()
        .from(yormProjectionStateMysql)
        .where(eq(yormProjectionStateMysql.status, "error"));
      return rows.map(toStateRecord);
    },

    async recordFailure(checkpoint: ProjectionCheckpoint, error: string): Promise<void> {
      await db
        .insert(yormProjectionStateMysql)
        .values({
          documentId: checkpoint.documentId,
          mappingName: checkpoint.mappingName,
          mappingVersion: checkpoint.mappingVersion,
          sourceDocumentVersion: checkpoint.sourceDocumentVersion,
          status: "error",
          projectedAt: new Date(),
          error,
        })
        .onDuplicateKeyUpdate({
          set: {
            mappingVersion: checkpoint.mappingVersion,
            sourceDocumentVersion: checkpoint.sourceDocumentVersion,
            status: "error",
            projectedAt: new Date(),
            error,
          },
        });
    },
  };
}
