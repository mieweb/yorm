/**
 * Extension preservation helpers (README "FHIR-specific patterns →
 * Preserve extensions").
 *
 * Unmapped contact fields ride along on the canonical resource as FHIR
 * extensions under the YORM URL namespace, so nothing is lost when data
 * enters through the contacts side. All setters are immutable: they return
 * a copy and never mutate their input.
 */
import type { Extension } from "./types.js";

/** Base URL for YORM-assigned extensions (unmapped source fields). */
export const YORM_EXTENSION_BASE = "https://yorm.dev/fhir/StructureDefinition";

/** Builds a YORM extension URL: `` `${YORM_EXTENSION_BASE}/${name}` ``. */
export function extensionUrl(name: string): string {
  return `${YORM_EXTENSION_BASE}/${name}`;
}

/** Element that may carry FHIR extensions. */
export interface Extendable {
  extension?: Extension[];
}

/** Supported `value[x]` variants for {@link setExtension}. */
export interface ExtensionValue {
  valueString?: string;
  valueCode?: string;
  valueUrl?: string;
}

/** Returns the first extension with the given `url`, if any. */
export function getExtension(element: Extendable, url: string): Extension | undefined {
  return element.extension?.find((ext) => ext.url === url);
}

/** Convenience: the `valueString` of the extension with the given `url`. */
export function getExtensionValue(element: Extendable, url: string): string | undefined {
  return getExtension(element, url)?.valueString;
}

/**
 * Returns a copy of `element` with the extension at `url` set to `value`
 * (replace-by-url: an existing extension with the same url is replaced in
 * place, otherwise the new extension is appended).
 */
export function setExtension<T extends Extendable>(
  element: T,
  url: string,
  value: ExtensionValue,
): T {
  const next: Extension = { url, ...value };
  const existing = element.extension ?? [];
  const index = existing.findIndex((ext) => ext.url === url);
  const extension =
    index >= 0 ? existing.map((ext, i) => (i === index ? next : ext)) : [...existing, next];
  return { ...element, extension } as T;
}

/**
 * Returns a copy of `element` without any extension at `url`. When the last
 * extension is removed, the `extension` property is dropped entirely (FHIR
 * forbids empty arrays).
 */
export function removeExtension<T extends Extendable>(element: T, url: string): T {
  const existing = element.extension;
  if (existing === undefined || !existing.some((ext) => ext.url === url)) {
    return element;
  }
  const extension = existing.filter((ext) => ext.url !== url);
  if (extension.length === 0) {
    const { extension: _removed, ...rest } = element;
    return rest as unknown as T;
  }
  return { ...element, extension } as T;
}

/** Lists the extensions on `element` that live under {@link YORM_EXTENSION_BASE}. */
export function listYormExtensions(element: Extendable): Extension[] {
  return element.extension?.filter((ext) => ext.url.startsWith(`${YORM_EXTENSION_BASE}/`)) ?? [];
}
