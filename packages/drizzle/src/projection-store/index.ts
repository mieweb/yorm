/**
 * `ProjectionStore` on Drizzle (better-sqlite3 driver).
 *
 * Application projection tables are dynamic and user-owned, so plan
 * operations are executed as raw SQL built from **validated identifiers**
 * (`/^[A-Za-z_][A-Za-z0-9_]*$/` — anything else throws, guarding against SQL
 * injection) with placeholders for every value. Callers may optionally
 * register Drizzle table objects via `options.tables`; a registered table
 * contributes its real (trusted) table name, while columns are always
 * validated. All operations of a plan plus its checkpoint advance run in one
 * synchronous better-sqlite3 transaction.
 */
import type {
  ProjectionCheckpoint,
  ProjectionPlan,
  ProjectionStateRecord,
  ProjectionStore,
  ReconcileOperation,
  Scalar,
  UpsertOperation,
} from "@yorm/core";
import type { SQL, Table } from "drizzle-orm";
import { and, eq, getTableName, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { yormProjectionState } from "../schema.js";

/** A projection table registered for trusted name resolution. */
export interface ProjectionTableConfig {
  /** The Drizzle table object backing this projection table. */
  table: Table;
}

export interface DrizzleProjectionStoreOptions {
  /** Optional registry of Drizzle table objects, keyed by plan table name. */
  tables?: Record<string, ProjectionTableConfig>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validates an identifier before it is embedded into SQL. */
function assertIdentifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `drizzleProjectionStore: invalid ${what} "${name}"; identifiers must match ${IDENTIFIER}`,
    );
  }
  return name;
}

/** Converts a plan scalar to a better-sqlite3-bindable value (booleans → 0/1). */
function bindable(value: Scalar): string | number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

const COMMA = sql.raw(", ");

function buildUpsert(op: UpsertOperation, table: string): SQL {
  const keyColumns = Object.keys(op.key);
  const ownedColumns = op.ownedColumns.map((column) => assertIdentifier(column, "column"));
  for (const column of keyColumns) assertIdentifier(column, "column");

  /** Reads a cell value, rejecting `undefined` (mappings must emit null). */
  function cell(record: Record<string, Scalar>, column: string, what: string): Scalar {
    const value = record[column];
    if (value === undefined) {
      throw new Error(
        `drizzleProjectionStore: ${what} column "${column}" of table "${table}" has no value in the upsert operation`,
      );
    }
    return value;
  }

  const insertColumns = [...keyColumns, ...ownedColumns];
  const columnList = sql.join(
    insertColumns.map((column) => sql.identifier(column)),
    COMMA,
  );
  const valueList = sql.join(
    insertColumns.map((column) =>
      column in op.key
        ? sql`${bindable(cell(op.key, column, "key"))}`
        : sql`${bindable(cell(op.values, column, "owned"))}`,
    ),
    COMMA,
  );
  const conflictTarget = sql.join(
    keyColumns.map((column) => sql.identifier(column)),
    COMMA,
  );

  if (ownedColumns.length === 0) {
    return sql`insert into ${sql.identifier(table)} (${columnList}) values (${valueList}) on conflict (${conflictTarget}) do nothing`;
  }
  const setList = sql.join(
    ownedColumns.map(
      (column) => sql`${sql.identifier(column)} = excluded.${sql.identifier(column)}`,
    ),
    COMMA,
  );
  return sql`insert into ${sql.identifier(table)} (${columnList}) values (${valueList}) on conflict (${conflictTarget}) do update set ${setList}`;
}

function buildScopeCondition(scope: Record<string, Scalar>): SQL {
  const conditions = Object.entries(scope).map(([column, value]) => {
    assertIdentifier(column, "column");
    return value === null
      ? sql`${sql.identifier(column)} is null`
      : sql`${sql.identifier(column)} = ${bindable(value)}`;
  });
  return sql.join(conditions, sql.raw(" and "));
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
  const keepRows = sql.join(
    op.keepKeys.map((key) => {
      const cells = keyColumns.map((column) => {
        const value = key[column];
        if (value === undefined) {
          throw new Error(
            `drizzleProjectionStore: keepKey for table "${table}" is missing key column "${column}"`,
          );
        }
        return sql`${bindable(value)}`;
      });
      return sql`(${sql.join(cells, COMMA)})`;
    }),
    COMMA,
  );
  return sql`delete from ${sql.identifier(table)} where ${scopeCondition} and (${keyTuple}) not in (values ${keepRows})`;
}

/** Maps a `yorm_projection_state` row to the core record shape. */
function toStateRecord(row: typeof yormProjectionState.$inferSelect): ProjectionStateRecord {
  return {
    documentId: row.documentId,
    mappingName: row.mappingName,
    mappingVersion: row.mappingVersion,
    sourceDocumentVersion: row.sourceDocumentVersion,
    status: row.status,
    projectedAt: row.projectedAt,
    error: row.error,
  };
}

/**
 * Creates a {@link ProjectionStore} that applies plans to SQLite projection
 * tables and tracks checkpoints in `yorm_projection_state`.
 *
 * Requirements on projection tables: the plan's key columns must be covered
 * by a `PRIMARY KEY` or `UNIQUE` constraint (upserts use
 * `ON CONFLICT (key columns)`).
 */
export function drizzleProjectionStore<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  options?: DrizzleProjectionStoreOptions,
): ProjectionStore {
  const registry = options?.tables ?? {};

  /** Resolves a plan table name: registered Drizzle tables are trusted, everything else is validated. */
  function resolveTable(name: string): string {
    const registered = registry[name];
    if (registered) return getTableName(registered.table);
    return assertIdentifier(name, "table name");
  }

  return {
    async applyPlan(plan: ProjectionPlan): Promise<void> {
      db.transaction((tx) => {
        for (const op of plan.operations) {
          const table = resolveTable(op.table);
          tx.run(op.kind === "upsert" ? buildUpsert(op, table) : buildReconcile(op, table));
        }
        const checkpoint = plan.checkpoint;
        tx.insert(yormProjectionState)
          .values({
            documentId: checkpoint.documentId,
            mappingName: checkpoint.mappingName,
            mappingVersion: checkpoint.mappingVersion,
            sourceDocumentVersion: checkpoint.sourceDocumentVersion,
            status: "ok",
            projectedAt: new Date(),
            error: null,
          })
          .onConflictDoUpdate({
            target: [yormProjectionState.documentId, yormProjectionState.mappingName],
            set: {
              mappingVersion: checkpoint.mappingVersion,
              sourceDocumentVersion: checkpoint.sourceDocumentVersion,
              status: "ok",
              projectedAt: new Date(),
              error: null,
            },
          })
          .run();
      });
    },

    async getState(documentId: string, mappingName: string): Promise<ProjectionStateRecord | null> {
      const rows = await db
        .select()
        .from(yormProjectionState)
        .where(
          and(
            eq(yormProjectionState.documentId, documentId),
            eq(yormProjectionState.mappingName, mappingName),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? toStateRecord(row) : null;
    },

    async listFailures(): Promise<ProjectionStateRecord[]> {
      const rows = await db
        .select()
        .from(yormProjectionState)
        .where(eq(yormProjectionState.status, "error"));
      return rows.map(toStateRecord);
    },

    async recordFailure(checkpoint: ProjectionCheckpoint, error: string): Promise<void> {
      await db
        .insert(yormProjectionState)
        .values({
          documentId: checkpoint.documentId,
          mappingName: checkpoint.mappingName,
          mappingVersion: checkpoint.mappingVersion,
          sourceDocumentVersion: checkpoint.sourceDocumentVersion,
          status: "error",
          projectedAt: new Date(),
          error,
        })
        .onConflictDoUpdate({
          target: [yormProjectionState.documentId, yormProjectionState.mappingName],
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
