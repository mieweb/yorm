/**
 * Projection planner — turns (mapping, object) into a deterministic
 * {@link ProjectionPlan}. Pure function, no I/O: adapters apply plans.
 */
import type {
  ManyProjection,
  Mapping,
  MappingContext,
  OneProjection,
  Row,
  RowKey,
  Scalar,
} from "../mapping/index.js";
import { mappingId, tableName } from "../mapping/index.js";
import type { Origin } from "../provenance/index.js";

/** Upsert the owned columns of one row. Columns outside `ownedColumns` are untouched. */
export interface UpsertOperation {
  kind: "upsert";
  table: string;
  /** Logical key identifying the row. */
  key: RowKey;
  /** Owned column values to write. */
  values: Row;
  /** Columns this mapping owns on the row — the only columns the upsert may write. */
  ownedColumns: string[];
}

/**
 * Reconcile a `many()` row set: delete rows matching `scope` whose key is not
 * in `keepKeys`. Never an unconstrained delete.
 */
export interface ReconcileOperation {
  kind: "reconcile";
  table: string;
  /** Columns that make up the logical row key. */
  keyColumns: string[];
  /** Keys of every row the current document still contains. */
  keepKeys: RowKey[];
  /** Key columns (and values) that select this document's row set. */
  scope: RowKey;
}

/** A single step of a {@link ProjectionPlan}. */
export type PlanOperation = UpsertOperation | ReconcileOperation;

/** Records which document version a mapping has been projected up to. */
export interface ProjectionCheckpoint {
  documentId: string;
  documentType: string;
  mappingName: string;
  mappingVersion: number;
  sourceDocumentVersion: number;
}

/**
 * A deterministic, explicit description of the relational writes required to
 * bring projection tables in line with one document version. The same input
 * always produces a deeply-equal plan.
 */
export interface ProjectionPlan {
  /** Canonical mapping identifier, e.g. `"fhir.Patient@1"`. */
  mapping: string;
  documentId: string;
  documentType: string;
  documentVersion: number;
  origin: Origin;
  /** Operations in execution order: per projection, upserts then its reconcile. */
  operations: PlanOperation[];
  /** Checkpoint to persist atomically with the operations. */
  checkpoint: ProjectionCheckpoint;
}

function isScalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Validates that every column of a key/values record holds a scalar (and never `undefined`). */
function validateColumns(record: Record<string, unknown>, what: string, table: string): void {
  for (const [column, value] of Object.entries(record)) {
    if (value === undefined) {
      throw new Error(
        `planProjection: ${what} column "${column}" of table "${table}" is undefined; mappings must emit null explicitly for absent values`,
      );
    }
    if (!isScalar(value)) {
      throw new Error(
        `planProjection: ${what} column "${column}" of table "${table}" must be a scalar (string | number | boolean | null), got ${typeof value}`,
      );
    }
  }
}

function validateKeyAndValues(key: RowKey, values: Row, table: string): void {
  validateColumns(key, "key", table);
  validateColumns(values, "values", table);
  if (Object.keys(key).length === 0) {
    throw new Error(`planProjection: key for table "${table}" must contain at least one column`);
  }
  for (const column of Object.keys(values)) {
    if (column in key) {
      throw new Error(
        `planProjection: column "${column}" of table "${table}" appears in both key and values; key columns must not be listed as owned values`,
      );
    }
  }
}

/** Canonical, column-order-independent string form of a key, used for deterministic sorting. */
function stableKeyString(key: RowKey): string {
  return JSON.stringify(
    Object.keys(key)
      .sort()
      .map((column) => [column, key[column]]),
  );
}

/**
 * Derives the reconcile scope: key columns present in every row whose value is
 * identical across all rows.
 */
function deriveScope(rows: Array<{ key: RowKey }>, table: string): RowKey {
  const first = rows[0];
  if (!first) {
    throw new Error(
      `planProjection: many() projection for table "${table}" produced no rows and declares no scope(); the reconcile scope cannot be derived from zero rows — add an explicit scope() to the projection`,
    );
  }
  const scope: RowKey = {};
  for (const [column, value] of Object.entries(first.key)) {
    if (rows.every((row) => column in row.key && row.key[column] === value)) {
      scope[column] = value;
    }
  }
  if (Object.keys(scope).length === 0) {
    throw new Error(
      `planProjection: cannot derive reconcile scope for table "${table}": no key column has an identical value across all rows — add an explicit scope() to the many() projection`,
    );
  }
  return scope;
}

function planOne<T>(projection: OneProjection<T>, ctx: MappingContext<T>): UpsertOperation {
  const table = tableName(projection.table);
  const key = projection.key(ctx);
  const values = projection.values(ctx);
  validateKeyAndValues(key, values, table);
  return { kind: "upsert", table, key, values, ownedColumns: Object.keys(values) };
}

function planMany<T>(projection: ManyProjection<T>, ctx: MappingContext<T>): PlanOperation[] {
  const table = tableName(projection.table);
  const rows = projection.rows(ctx);
  for (const row of rows) {
    validateKeyAndValues(row.key, row.values, table);
  }

  const sorted = [...rows].sort((a, b) =>
    stableKeyString(a.key) < stableKeyString(b.key) ? -1 : 1,
  );

  let keyColumns: string[];
  if (sorted.length > 0) {
    keyColumns = Object.keys(sorted[0]!.key).sort();
    const signature = keyColumns.join(",");
    for (const row of sorted) {
      if (Object.keys(row.key).sort().join(",") !== signature) {
        throw new Error(
          `planProjection: rows of many() projection for table "${table}" use inconsistent key columns; every row must share the same key columns`,
        );
      }
    }
  } else {
    keyColumns = [];
  }

  let scope: RowKey;
  if (projection.scope) {
    scope = projection.scope(ctx);
    validateColumns(scope, "scope", table);
    if (Object.keys(scope).length === 0) {
      throw new Error(
        `planProjection: scope() for table "${table}" must return at least one column`,
      );
    }
  } else {
    scope = deriveScope(sorted, table);
  }
  if (keyColumns.length === 0) {
    keyColumns = Object.keys(scope).sort();
  }

  const operations: PlanOperation[] = sorted.map((row) => ({
    kind: "upsert",
    table,
    key: row.key,
    values: row.values,
    ownedColumns: Object.keys(row.values),
  }));
  operations.push({
    kind: "reconcile",
    table,
    keyColumns,
    keepKeys: sorted.map((row) => row.key),
    scope,
  });
  return operations;
}

/**
 * Plans the relational writes for one document version.
 *
 * Deterministic: projections run in declaration order, `many()` rows are
 * sorted by a canonical string form of their key, and the same input always
 * yields a deeply-equal plan.
 *
 * @throws on non-scalar or `undefined` cell values, key/values column
 * overlap, empty keys, or an underivable reconcile scope.
 */
export function planProjection<T>(
  mapping: Mapping<T>,
  input: { object: T; documentId: string; documentVersion: number; origin: Origin },
): ProjectionPlan {
  const ctx: MappingContext<T> = { object: input.object, documentId: input.documentId };
  const operations: PlanOperation[] = [];
  for (const projection of mapping.projections) {
    if (projection.kind === "one") {
      operations.push(planOne(projection, ctx));
    } else {
      operations.push(...planMany(projection, ctx));
    }
  }
  return {
    mapping: mappingId(mapping),
    documentId: input.documentId,
    documentType: mapping.documentType,
    documentVersion: input.documentVersion,
    origin: input.origin,
    operations,
    checkpoint: {
      documentId: input.documentId,
      documentType: mapping.documentType,
      mappingName: mapping.name,
      mappingVersion: mapping.version,
      sourceDocumentVersion: input.documentVersion,
    },
  };
}
