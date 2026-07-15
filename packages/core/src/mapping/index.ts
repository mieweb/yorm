/**
 * Mapping DSL — declares how a canonical document projects into relational rows.
 *
 * Mappings are pure declarations: `key` / `values` / `rows` functions read a
 * materialized object and return plain scalar records. They perform no I/O.
 */

/** A relational cell value. Mappings must emit `null` for absent values, never `undefined`. */
export type Scalar = string | number | boolean | null;

/** A partial row: only the columns the mapping owns. */
export type Row = Record<string, Scalar>;

/** The logical key identifying a row (stable identity — never array position). */
export type RowKey = Record<string, Scalar>;

/**
 * Reference to a projection table. Core only needs a name; adapters (e.g.
 * Drizzle) may pass richer objects that carry a `name` property.
 */
export type TableRef = string | { readonly name: string };

/** Resolves a {@link TableRef} to its table name. */
export function tableName(table: TableRef): string {
  return typeof table === "string" ? table : table.name;
}

/** Input handed to every mapping projection function. */
export interface MappingContext<T> {
  /** The materialized domain object being projected. */
  object: T;
  /** Identity of the canonical document. */
  documentId: string;
}

/** Projects the document onto exactly one row of `table`. */
export interface OneProjection<T> {
  kind: "one";
  table: TableRef;
  /** Logical key of the single row. */
  key: (ctx: MappingContext<T>) => RowKey;
  /** Owned columns and their values. Never a whole-row replacement. */
  values: (ctx: MappingContext<T>) => Row;
}

/**
 * Projects a repeated element onto a row set of `table`. The mapping owns the
 * row set: rows no longer emitted are deleted during reconciliation.
 */
export interface ManyProjection<T> {
  kind: "many";
  table: TableRef;
  /** Current rows, each with a stable logical key. */
  rows: (ctx: MappingContext<T>) => Array<{ key: RowKey; values: Row }>;
  /**
   * Optional explicit reconcile scope (the key columns identifying this
   * document's row set). Required when `rows` can be empty; otherwise the
   * planner derives the scope from key columns shared by every row.
   */
  scope?: (ctx: MappingContext<T>) => RowKey;
}

/** Any projection accepted by {@link defineMapping}. */
export type Projection<T> = OneProjection<T> | ManyProjection<T>;

/** Creates a single-row projection. See {@link OneProjection}. */
export function one<T>(
  table: TableRef,
  cfg: {
    key: (ctx: MappingContext<T>) => RowKey;
    values: (ctx: MappingContext<T>) => Row;
  },
): OneProjection<T> {
  return { kind: "one", table, key: cfg.key, values: cfg.values };
}

/** Creates a row-set projection. See {@link ManyProjection}. */
export function many<T>(
  table: TableRef,
  cfg: {
    rows: (ctx: MappingContext<T>) => Array<{ key: RowKey; values: Row }>;
    scope?: (ctx: MappingContext<T>) => RowKey;
  },
): ManyProjection<T> {
  const projection: ManyProjection<T> = { kind: "many", table, rows: cfg.rows };
  if (cfg.scope) {
    projection.scope = cfg.scope;
  }
  return projection;
}

/**
 * How data flows through the mapping:
 * - `forward` — document → rows only (default)
 * - `bidirectional` — rows may flow back via the outbox
 * - `computed` — derived values, never written back
 * - `external` — another system owns the table
 */
export type MappingDirection = "forward" | "bidirectional" | "computed" | "external";

/**
 * A versioned, immutable projection contract for one document type.
 * Produced by {@link defineMapping}; instances are deeply frozen.
 */
export interface Mapping<T = unknown> {
  /** Stable mapping name, e.g. `"fhir.Patient"`. */
  name: string;
  /** Integer version, `>= 1`. Bump when projection semantics change. */
  version: number;
  /** The canonical document type this mapping projects. */
  documentType: string;
  /** Data-flow direction. Defaults to `"forward"`. */
  direction: MappingDirection;
  /** Projections evaluated in declaration order. */
  projections: Array<OneProjection<T> | ManyProjection<T>>;
}

/**
 * Validates and freezes a {@link Mapping}.
 *
 * @throws if `name` is empty, `version` is not an integer `>= 1`,
 * `projections` is empty, or two `one()` projections target the same table.
 */
export function defineMapping<T>(cfg: {
  name: string;
  version: number;
  documentType: string;
  direction?: MappingDirection;
  projections: Array<OneProjection<T> | ManyProjection<T>>;
}): Mapping<T> {
  if (typeof cfg.name !== "string" || cfg.name.length === 0) {
    throw new Error("defineMapping: name must be a non-empty string");
  }
  if (!Number.isInteger(cfg.version) || cfg.version < 1) {
    throw new Error(
      `defineMapping "${cfg.name}": version must be an integer >= 1, got ${cfg.version}`,
    );
  }
  if (cfg.projections.length === 0) {
    throw new Error(`defineMapping "${cfg.name}": at least one projection is required`);
  }
  const oneTables = new Set<string>();
  for (const projection of cfg.projections) {
    if (projection.kind === "one") {
      const table = tableName(projection.table);
      if (oneTables.has(table)) {
        throw new Error(
          `defineMapping "${cfg.name}": multiple one() projections target table "${table}"; a table can have at most one one() projection per mapping`,
        );
      }
      oneTables.add(table);
    }
  }
  const projections = Object.freeze(
    cfg.projections.map((projection) => Object.freeze({ ...projection })),
  ) as unknown as Array<OneProjection<T> | ManyProjection<T>>;
  return Object.freeze({
    name: cfg.name,
    version: cfg.version,
    documentType: cfg.documentType,
    direction: cfg.direction ?? "forward",
    projections,
  });
}

/** Canonical mapping identifier, e.g. `"fhir.Patient@1"`. */
export function mappingId<T>(mapping: Mapping<T>): string {
  return `${mapping.name}@${mapping.version}`;
}
