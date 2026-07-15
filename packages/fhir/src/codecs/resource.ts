/**
 * FHIR JSON resource codec — a thin, resource-type-aware layer over the
 * generic `@yorm/yjs` JSON codec (DRY: all Yjs traversal is delegated).
 *
 * The codec uses the default `"resource"` root map so it composes with
 * `@yorm/yjs` document sessions out of the box.
 */
import type * as Y from "yjs";
import { jsonCodec, type DocumentCodec } from "@yorm/yjs";

import type { FhirResource } from "../types.js";

/**
 * Creates a `DocumentCodec` for one FHIR resource type.
 *
 * - `write` validates that `value.resourceType` matches the codec's
 *   `resourceType` and throws a descriptive error otherwise.
 * - `read` returns the materialized resource with `resourceType` guaranteed
 *   (set when absent, validated when present).
 *
 * @param resourceType FHIR resource type this codec accepts, e.g. `"Patient"`.
 */
export function fhirResource<T extends FhirResource = FhirResource>(
  resourceType: string,
): DocumentCodec<T> & { resourceType: string } {
  const json = jsonCodec<T>();
  return {
    resourceType,
    read(doc: Y.Doc): T {
      const value = json.read(doc);
      const actual = (value as Record<string, unknown>).resourceType;
      if (actual !== undefined && actual !== resourceType) {
        throw new Error(
          `fhirResource("${resourceType}").read: document contains resourceType "${String(actual)}"`,
        );
      }
      return actual === resourceType ? value : ({ ...value, resourceType } as T);
    },
    write(doc: Y.Doc, value: T): void {
      if (value.resourceType !== resourceType) {
        throw new Error(
          `fhirResource("${resourceType}").write: value has resourceType "${String(value.resourceType)}", expected "${resourceType}"`,
        );
      }
      json.write(doc, value);
    },
  };
}
