/**
 * Stable FHIR element identity (README "Stable identity").
 *
 * Array position is not identity: every repeating element that becomes a row
 * needs a stable id. Precedence:
 *
 * 1. explicit element `id`;
 * 2. configured business key;
 * 3. ingestion-assigned id ({@link ensureElementIds} only — {@link fhirElementId}
 *    throws instead, because assigning at read time would not be stable).
 */
import type { FhirResource } from "../types.js";

/** Options for deriving element identity. */
export interface ElementIdOptions {
  /** Derives a stable business key from an element (e.g. `identifier.system|value`). */
  businessKey?: (element: Record<string, unknown>) => string | undefined;
  /** Generates a fresh id on ingestion. Defaults to a short random id; inject for determinism in tests. */
  assign?: () => string;
}

function explicitId(element: Record<string, unknown>): string | undefined {
  const id = element["id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function defaultAssign(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Returns the stable identity of a repeating element: explicit `id`, else
 * `options.businessKey(element)`, else throws — the caller should have run
 * {@link ensureElementIds} during ingestion.
 */
export function fhirElementId(
  element: Record<string, unknown>,
  options?: ElementIdOptions,
): string {
  const id = explicitId(element) ?? options?.businessKey?.(element);
  if (id === undefined || id === "") {
    throw new Error(
      "fhirElementId: element has no explicit id and no business key; " +
        "run ensureElementIds(...) during ingestion to assign stable ids",
    );
  }
  return id;
}

function withId(
  element: Record<string, unknown>,
  options: ElementIdOptions | undefined,
): Record<string, unknown> {
  if (explicitId(element) !== undefined) {
    return element;
  }
  const businessKey = options?.businessKey?.(element);
  const id =
    businessKey !== undefined && businessKey !== ""
      ? businessKey
      : (options?.assign ?? defaultAssign)();
  return { ...element, id };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ensures every element of the array at `path` has an `id`, structurally
 * sharing everything unchanged. Intermediate array segments fan out over
 * each element (e.g. `["contact", "telecom"]`).
 */
function ensureAtPath(
  node: unknown,
  path: string[],
  options: ElementIdOptions | undefined,
): unknown {
  if (Array.isArray(node)) {
    const next = node.map((item) => ensureAtPath(item, path, options));
    return next.some((item, i) => item !== node[i]) ? next : node;
  }
  if (!isPlainObject(node) || path.length === 0) {
    return node;
  }
  const [head, ...rest] = path as [string, ...string[]];
  const child = node[head];
  if (rest.length === 0) {
    if (!Array.isArray(child)) {
      return node;
    }
    const next = child.map((item) => (isPlainObject(item) ? withId(item, options) : item));
    return next.some((item, i) => item !== child[i]) ? { ...node, [head]: next } : node;
  }
  const nextChild = ensureAtPath(child, rest, options);
  return nextChild === child ? node : { ...node, [head]: nextChild };
}

/**
 * Returns a structurally-shared copy of `resource` where every element of the
 * listed repeating arrays has an `id`: explicit id → kept; else
 * `options.businessKey` → set as id; else `options.assign()` → set
 * ("ingestion-assigned id"). The input is never mutated; untouched subtrees
 * keep their original references.
 *
 * @param arrayPaths key paths to repeating arrays, e.g. `[["name"], ["telecom"], ["address"]]`.
 */
export function ensureElementIds<T extends FhirResource>(
  resource: T,
  arrayPaths: string[][],
  options?: ElementIdOptions,
): T {
  let result: unknown = resource;
  for (const path of arrayPaths) {
    result = ensureAtPath(result, path, options);
  }
  return result as T;
}
