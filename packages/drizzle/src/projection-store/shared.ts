/**
 * Dialect-agnostic parts of the Drizzle projection stores.
 *
 * Application projection tables are dynamic and user-owned, so plan operations
 * are executed as raw SQL built from **validated identifiers**
 * (`/^[A-Za-z_][A-Za-z0-9_]*$/` — anything else throws, guarding against SQL
 * injection) with placeholders for every value. Everything here is shared by
 * the SQLite and MySQL stores; only the upsert and the reconcile `NOT IN`
 * row-list syntax differ between dialects.
 */
import type { Origin, ProjectionStateRecord, Scalar } from "@yorm/core";
import type { SQL, Table } from "drizzle-orm";
import { getTableName, sql } from "drizzle-orm";

/** A projection table registered for trusted name resolution. */
export interface ProjectionTableConfig {
  /** The Drizzle table object backing this projection table. */
  table: Table;
}

/** One statement as sent to the driver: parameterized SQL plus its bindings. */
export interface ProjectionStatement {
  sql: string;
  params: unknown[];
}

/** Every statement one plan wrote, with the document change set that caused it. */
export interface ProjectionCommit {
  mapping: string;
  documentId: string;
  documentType: string;
  documentVersion: number;
  origin: Origin;
  /** Plan operations in execution order, then the checkpoint advance. */
  statements: ProjectionStatement[];
}

export interface DrizzleProjectionStoreOptions {
  /** Optional registry of Drizzle table objects, keyed by plan table name. */
  tables?: Record<string, ProjectionTableConfig>;
  /** Called once per successfully applied plan with the SQL that plan produced. */
  onCommit?: (commit: ProjectionCommit) => void;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validates an identifier before it is embedded into SQL. */
export function assertIdentifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `drizzleProjectionStore: invalid ${what} "${name}"; identifiers must match ${IDENTIFIER}`,
    );
  }
  return name;
}

/** Converts a plan scalar to a driver-bindable value (booleans → 0/1). */
export function bindable(value: Scalar): string | number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export const COMMA = sql.raw(", ");

/** Reads a cell value, rejecting `undefined` (mappings must emit null). */
export function cell(
  record: Record<string, Scalar>,
  column: string,
  what: string,
  table: string,
): Scalar {
  const value = record[column];
  if (value === undefined) {
    throw new Error(
      `drizzleProjectionStore: ${what} column "${column}" of table "${table}" has no value in the upsert operation`,
    );
  }
  return value;
}

export function buildScopeCondition(scope: Record<string, Scalar>): SQL {
  const conditions = Object.entries(scope).map(([column, value]) => {
    assertIdentifier(column, "column");
    return value === null
      ? sql`${sql.identifier(column)} is null`
      : sql`${sql.identifier(column)} = ${bindable(value)}`;
  });
  return sql.join(conditions, sql.raw(" and "));
}

/** The `(key…) NOT IN` row list shared by both reconcile builders. */
export function buildKeepRows(
  keepKeys: ReadonlyArray<Record<string, Scalar>>,
  keyColumns: readonly string[],
  table: string,
): SQL {
  return sql.join(
    keepKeys.map((key) => {
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
}

/** The shape both dialects' `yorm_projection_state` rows share. */
export interface ProjectionStateRow {
  documentId: string;
  mappingName: string;
  mappingVersion: number;
  sourceDocumentVersion: number;
  status: "ok" | "error";
  projectedAt: Date;
  error: string | null;
}

/** Maps a `yorm_projection_state` row to the core record shape. */
export function toStateRecord(row: ProjectionStateRow): ProjectionStateRecord {
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

/** Resolves a plan table name: registered Drizzle tables are trusted, everything else is validated. */
export function tableResolver(
  registry: Record<string, ProjectionTableConfig>,
): (name: string) => string {
  return (name: string) => {
    const registered = registry[name];
    if (registered) return getTableName(registered.table);
    return assertIdentifier(name, "table name");
  };
}
