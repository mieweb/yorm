/**
 * JSON codec — maps plain JSON values ⇄ Yjs shared types.
 *
 * `write` replaces the semantic content of the root map in a single Yjs
 * transaction (clear + rebuild for v1); `read` materializes plain JSON.
 * Partial semantic updates are done by mutating Y types directly or via
 * {@link applyJsonPatchLike}.
 */
import * as Y from "yjs";

/** Reads/writes a materialized domain object from/to a `Y.Doc`. */
export interface DocumentCodec<T> {
  read(doc: Y.Doc): T;
  write(doc: Y.Doc, value: T): void;
}

/** Root map key used when none is given. */
export const DEFAULT_ROOT_KEY = "resource";

type YContainer = Y.Map<unknown> | Y.Array<unknown>;

function isContainer(value: unknown): value is YContainer {
  return value instanceof Y.Map || value instanceof Y.Array;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts a plain JSON value into its Yjs equivalent, recursively:
 * objects → `Y.Map`, arrays → `Y.Array`, scalars as-is. `undefined` object
 * entries are dropped; `undefined` array items become `null` (JSON semantics).
 */
function toYValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = new Y.Array<unknown>();
    arr.push(value.map((item) => (item === undefined ? null : toYValue(item))));
    return arr;
  }
  if (isPlainObject(value)) {
    const map = new Y.Map<unknown>();
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        map.set(key, toYValue(item));
      }
    }
    return map;
  }
  return value;
}

/**
 * JSON document codec rooted at `doc.getMap(rootKey)`.
 *
 * `write` is a merge-style semantic replace: the root map is cleared and
 * rebuilt from `value` inside one transaction, so observers see exactly one
 * update per write.
 */
export function jsonCodec<T = unknown>(rootKey: string = DEFAULT_ROOT_KEY): DocumentCodec<T> {
  return {
    read(doc: Y.Doc): T {
      return doc.getMap(rootKey).toJSON() as T;
    },
    write(doc: Y.Doc, value: T): void {
      if (!isPlainObject(value)) {
        throw new Error("jsonCodec.write: top-level value must be a plain object");
      }
      const root = doc.getMap(rootKey);
      doc.transact(() => {
        root.clear();
        for (const [key, item] of Object.entries(value)) {
          if (item !== undefined) {
            root.set(key, toYValue(item));
          }
        }
      });
    },
  };
}

function assertMapKey(segment: string | number): string {
  if (typeof segment !== "string") {
    throw new Error(`applyJsonPatchLike: expected a string key for a map, got index ${segment}`);
  }
  return segment;
}

function assertArrayIndex(segment: string | number): number {
  if (typeof segment !== "number" || !Number.isInteger(segment) || segment < 0) {
    throw new Error(
      `applyJsonPatchLike: expected a non-negative integer index for an array, got "${segment}"`,
    );
  }
  return segment;
}

/** Steps into (or creates) the container at `segment`. */
function descend(
  container: YContainer,
  segment: string | number,
  nextSegment: string | number,
): YContainer {
  const create = (): YContainer =>
    typeof nextSegment === "number" ? new Y.Array<unknown>() : new Y.Map<unknown>();
  if (container instanceof Y.Map) {
    const key = assertMapKey(segment);
    const existing = container.get(key);
    if (isContainer(existing)) {
      return existing;
    }
    const created = create();
    container.set(key, created);
    return created;
  }
  const index = assertArrayIndex(segment);
  const existing = index < container.length ? container.get(index) : undefined;
  if (isContainer(existing)) {
    return existing;
  }
  if (index === container.length) {
    const created = create();
    container.insert(index, [created]);
    return created;
  }
  throw new Error(`applyJsonPatchLike: array index ${index} does not hold a container`);
}

function setOrRemove(container: YContainer, segment: string | number, value: unknown): void {
  if (container instanceof Y.Map) {
    const key = assertMapKey(segment);
    if (value === undefined) {
      container.delete(key);
    } else {
      container.set(key, toYValue(value));
    }
    return;
  }
  const index = assertArrayIndex(segment);
  if (value === undefined) {
    if (index < container.length) {
      container.delete(index, 1);
    }
    return;
  }
  if (index < container.length) {
    container.delete(index, 1);
    container.insert(index, [toYValue(value)]);
  } else if (index === container.length) {
    container.insert(index, [toYValue(value)]);
  } else {
    throw new Error(
      `applyJsonPatchLike: array index ${index} is out of bounds (length ${container.length})`,
    );
  }
}

/**
 * Sets (or removes, when `value === undefined`) a nested value semantically:
 * navigates `Y.Map` / `Y.Array` along `path`, creating intermediate
 * containers as needed, in one transaction. String segments address map keys,
 * number segments address array indices.
 */
export function applyJsonPatchLike(
  doc: Y.Doc,
  rootKey: string,
  path: Array<string | number>,
  value: unknown,
): void {
  if (path.length === 0) {
    throw new Error("applyJsonPatchLike: path must contain at least one segment");
  }
  doc.transact(() => {
    let container: YContainer = doc.getMap(rootKey);
    for (let i = 0; i < path.length - 1; i++) {
      container = descend(container, path[i]!, path[i + 1]!);
    }
    setOrRemove(container, path[path.length - 1]!, value);
  });
}
