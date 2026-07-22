/**
 * Dense-editor field specs (generated per Patient snapshot) — the
 * generalization of `patientFields.ts` for the custom dense editor: every
 * element of the Patient object gets a spec with a unique i18n'd label, a
 * `read` from the materialized JSON, a `write` into the Y.Doc root, and the
 * proposal path / value conversion the proposer mode needs. Array-backed
 * sections (identifier, name, telecom, address) emit one spec group per
 * entry, so the whole object is editable — while `unmappedExtras` collects
 * everything the editor does NOT cover as read-only JSON chips ("keep the
 * object": unmapped fields live only in the canonical document).
 */
import * as Y from "yjs";
import type { Patient } from "@yorm/fhir";
import { extensionUrl } from "@yorm/fhir";

import { t } from "./i18n";
import type { StringKey } from "./i18n";
import {
  ensureArray,
  samePath,
  setGivenNames,
  setOrDelete,
  splitGivenNames,
} from "./patientFields";
import type { FieldWriteSpec } from "./patientFields";

/** How the dense editor renders a field. */
export type DenseControl = "text" | "date" | "checkbox" | "select";

export interface DenseOption {
  value: string;
  label: string;
}

export interface DenseFieldSpec extends FieldWriteSpec {
  /** Unique, fully i18n'd accessible label (entries > 1 get an index suffix). */
  label: string;
  control: DenseControl;
  /** Select options (`control === "select"`), starting with the unset option. */
  options?: readonly DenseOption[];
  /** Reads the field's current value ("true"/"false" for checkboxes). */
  read(patient: Patient): string;
}

export interface DenseSection {
  id: string;
  label: string;
  fields: DenseFieldSpec[];
}

// Extension URLs mirroring the POC mapping's vocabulary (mapping.ts exports
// them, but the example package only exposes ./setup and ./schema).
const ORGANIZATION_URL = extensionUrl("contact-organization");
const NOTE_URL = extensionUrl("contact-note");

const NAME_USES = ["official", "usual", "nickname", "maiden", "anonymous", "temp", "old"] as const;
const TELECOM_SYSTEMS = ["phone", "fax", "email", "pager", "url", "sms", "other"] as const;
const TELECOM_USES = ["home", "work", "temp", "old", "mobile"] as const;
const ADDRESS_USES = ["home", "work", "temp", "old", "billing"] as const;
const GENDERS = ["male", "female", "other", "unknown"] as const;

/** Builds select options from FHIR codes, prefixed with the unset option. */
function codeOptions(codes: readonly string[]): DenseOption[] {
  return [
    { value: "", label: t("opt.unset") },
    ...codes.map((code) => ({ value: code, label: t(`opt.${code}` as StringKey) })),
  ];
}

/** Suffixes a label with the 1-based entry number when there are duplicates. */
function nth(label: string, n: number): string {
  return n === 1 ? label : t("editor.nth", { label, n });
}

/** "{base} system" / "{base} use" sub-field labels. */
function subLabel(base: string, part: "system" | "use"): string {
  return t("editor.subfield", { base, part: t(`editor.subfield.${part}`) });
}

/** Ensures a Y.Map exists at `key[index]`, creating array and entries. */
function ensureMapAt(root: Y.Map<unknown>, key: string, index: number): Y.Map<unknown> {
  const array = ensureArray(root, key);
  while (array.length <= index) {
    array.push([new Y.Map<unknown>()]);
  }
  const entry = array.get(index);
  if (entry instanceof Y.Map) {
    return entry;
  }
  const created = new Y.Map<unknown>();
  array.delete(index, 1);
  array.insert(index, [created]);
  return created;
}

/** Index of the extension entry with `url`, or -1. */
function extensionIndex(patient: Patient, url: string): number {
  return patient.extension?.findIndex((ext) => ext.url === url) ?? -1;
}

/** Writes a string extension: set `valueString`, drop the entry when empty. */
function writeExtension(root: Y.Map<unknown>, url: string, value: string): void {
  const extensions = ensureArray(root, "extension");
  let index = -1;
  for (let i = 0; i < extensions.length; i += 1) {
    const entry = extensions.get(i);
    if (entry instanceof Y.Map && entry.get("url") === url) {
      index = i;
      break;
    }
  }
  if (value === "") {
    if (index >= 0) {
      extensions.delete(index, 1);
    }
    return;
  }
  if (index >= 0) {
    (extensions.get(index) as Y.Map<unknown>).set("valueString", value);
    return;
  }
  const created = new Y.Map<unknown>();
  created.set("url", url);
  created.set("valueString", value);
  extensions.push([created]);
}

const identity = (value: string): unknown => value;

/** A plain string sub-field of the array entry at `key[index]`. */
function entryStringField(
  id: string,
  label: string,
  key: "identifier" | "name" | "telecom" | "address",
  index: number,
  part: string,
  exists: boolean,
  control: DenseControl = "text",
  options?: readonly DenseOption[],
): DenseFieldSpec {
  const spec: DenseFieldSpec = {
    id,
    label,
    control,
    read: (patient) => {
      const entry = patient[key]?.[index] as Record<string, unknown> | undefined;
      const value = entry?.[part];
      return typeof value === "string" ? value : "";
    },
    write: (root, value) => setOrDelete(ensureMapAt(root, key, index), part, value),
    proposalPath: () => (exists ? [key, index, part] : null),
    toProposedValue: identity,
  };
  if (options) {
    spec.options = options;
  }
  return spec;
}

const SECTION_LABELS = {
  identity: "editor.section.identity",
  identifiers: "editor.section.identifiers",
  names: "editor.section.names",
  telecom: "editor.section.telecom",
  addresses: "editor.section.addresses",
  extensions: "editor.section.extensions",
} as const satisfies Record<string, StringKey>;

function section(id: keyof typeof SECTION_LABELS, fields: DenseFieldSpec[]): DenseSection {
  return { id, label: t(SECTION_LABELS[id]), fields };
}

/**
 * All dense sections for the given Patient snapshot. The first name entry's
 * given/family and the first phone/email telecom values reuse the eSheet
 * field ids and labels (`given`, `family`, `phone`, `email`, `birthDate`),
 * so awareness presence and the Playwright locators are view-independent.
 */
export function buildDenseSections(patient: Patient): DenseSection[] {
  return [
    section("identity", [
      {
        id: "active",
        label: t("editor.active"),
        control: "checkbox",
        read: (p) => (p.active === true ? "true" : "false"),
        write: (root, value) => root.set("active", value === "true"),
        proposalPath: () => ["active"],
        toProposedValue: (value) => value === "true",
      },
      {
        id: "gender",
        label: t("editor.gender"),
        control: "select",
        options: codeOptions(GENDERS),
        read: (p) => p.gender ?? "",
        write: (root, value) => setOrDelete(root, "gender", value),
        proposalPath: () => ["gender"],
        toProposedValue: identity,
      },
      {
        id: "birthDate",
        label: t("form.birthDate"),
        control: "date",
        read: (p) => p.birthDate ?? "",
        write: (root, value) => setOrDelete(root, "birthDate", value),
        proposalPath: () => ["birthDate"],
        toProposedValue: identity,
      },
      {
        id: "photo",
        label: t("editor.photo"),
        control: "text",
        read: (p) => {
          const photo = p["photo"];
          const first = Array.isArray(photo) ? (photo[0] as { url?: unknown }) : undefined;
          return typeof first?.url === "string" ? first.url : "";
        },
        write: (root, value) => {
          if (value === "") {
            root.delete("photo");
          } else {
            ensureMapAt(root, "photo", 0).set("url", value);
          }
        },
        proposalPath: (p) =>
          Array.isArray(p["photo"]) && p["photo"][0] ? ["photo", 0, "url"] : null,
        toProposedValue: identity,
      },
    ]),
    section("identifiers", identifierFields(patient)),
    section("names", nameFields(patient)),
    section("telecom", telecomFields(patient)),
    section("addresses", addressFields(patient)),
    section("extensions", [
      extensionField("ext.organization", t("editor.organization"), ORGANIZATION_URL, patient),
      extensionField("ext.note", t("editor.note"), NOTE_URL, patient),
    ]),
  ];
}

/** One system/value pair per identifier entry; a blank first entry when none. */
function identifierFields(patient: Patient): DenseFieldSpec[] {
  const count = Math.max(patient.identifier?.length ?? 0, 1);
  const fields: DenseFieldSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const exists = patient.identifier?.[i] !== undefined;
    fields.push(
      entryStringField(
        `identifier.${i}.system`,
        nth(t("editor.identifierSystem"), i + 1),
        "identifier",
        i,
        "system",
        exists,
      ),
      entryStringField(
        `identifier.${i}.value`,
        nth(t("editor.identifierValue"), i + 1),
        "identifier",
        i,
        "value",
        exists,
      ),
    );
  }
  return fields;
}

/** given / family / use per name entry (the official entry reuses eSheet ids). */
function nameFields(patient: Patient): DenseFieldSpec[] {
  const names = patient.name ?? [];
  const fields: DenseFieldSpec[] = [];
  for (let i = 0; i < Math.max(names.length, 1); i += 1) {
    const n = i + 1;
    const exists = names[i] !== undefined;
    fields.push(
      {
        id: i === 0 ? "given" : `name.${i}.given`,
        label: nth(t("form.given"), n),
        control: "text",
        read: (p) => p.name?.[i]?.given?.join(" ") ?? "",
        write: (root, value) => setGivenNames(ensureMapAt(root, "name", i), value),
        proposalPath: () => (exists ? ["name", i, "given"] : null),
        toProposedValue: splitGivenNames,
      },
      {
        ...entryStringField(
          `name.${i}.family`,
          nth(t("form.family"), n),
          "name",
          i,
          "family",
          exists,
        ),
        ...(i === 0 ? { id: "family" } : {}),
      },
      entryStringField(
        `name.${i}.use`,
        nth(t("editor.nameUse"), n),
        "name",
        i,
        "use",
        exists,
        "select",
        codeOptions(NAME_USES),
      ),
    );
  }
  return fields;
}

/** system / use / value per telecom entry, labeled by the entry's system. */
function telecomFields(patient: Patient): DenseFieldSpec[] {
  const telecom = patient.telecom ?? [];
  const seen = new Map<string, number>();
  const fields: DenseFieldSpec[] = [];
  for (let i = 0; i < telecom.length; i += 1) {
    const system = telecom[i]?.system;
    const occurrence = (seen.get(system ?? "") ?? 0) + 1;
    seen.set(system ?? "", occurrence);
    const base =
      system === "phone"
        ? nth(t("form.phone"), occurrence)
        : system === "email"
          ? nth(t("form.email"), occurrence)
          : t("editor.telecomN", { n: i + 1 });
    const shortId = system === "phone" || system === "email" ? system : null;
    fields.push(
      entryStringField(
        `telecom.${i}.system`,
        subLabel(base, "system"),
        "telecom",
        i,
        "system",
        true,
        "select",
        codeOptions(TELECOM_SYSTEMS),
      ),
      entryStringField(
        `telecom.${i}.use`,
        subLabel(base, "use"),
        "telecom",
        i,
        "use",
        true,
        "select",
        codeOptions(TELECOM_USES),
      ),
      {
        ...entryStringField(`telecom.${i}.value`, base, "telecom", i, "value", true),
        ...(shortId !== null && occurrence === 1 ? { id: shortId } : {}),
      },
    );
  }
  return fields;
}

/** line / city / state / postalCode / country / use per address entry. */
function addressFields(patient: Patient): DenseFieldSpec[] {
  const addresses = patient.address ?? [];
  const fields: DenseFieldSpec[] = [];
  for (let i = 0; i < addresses.length; i += 1) {
    const n = i + 1;
    fields.push(
      {
        id: `address.${i}.line`,
        label: nth(t("editor.addressLines"), n),
        control: "text",
        // `line` is a string array; the dense input joins/splits on ";".
        read: (p) => p.address?.[i]?.line?.join("; ") ?? "",
        write: (root, value) => {
          const entry = ensureMapAt(root, "address", i);
          const lines = value
            .split(";")
            .map((line) => line.trim())
            .filter(Boolean);
          if (lines.length === 0) {
            entry.delete("line");
            return;
          }
          const array = new Y.Array<unknown>();
          array.push(lines);
          entry.set("line", array);
        },
        proposalPath: () => ["address", i, "line"],
        toProposedValue: (value) =>
          value
            .split(";")
            .map((line) => line.trim())
            .filter(Boolean),
      },
      entryStringField(
        `address.${i}.city`,
        nth(t("editor.addressCity"), n),
        "address",
        i,
        "city",
        true,
      ),
      entryStringField(
        `address.${i}.state`,
        nth(t("editor.addressState"), n),
        "address",
        i,
        "state",
        true,
      ),
      entryStringField(
        `address.${i}.postalCode`,
        nth(t("editor.addressPostalCode"), n),
        "address",
        i,
        "postalCode",
        true,
      ),
      entryStringField(
        `address.${i}.country`,
        nth(t("editor.addressCountry"), n),
        "address",
        i,
        "country",
        true,
      ),
      entryStringField(
        `address.${i}.use`,
        nth(t("editor.addressUse"), n),
        "address",
        i,
        "use",
        true,
        "select",
        codeOptions(ADDRESS_USES),
      ),
    );
  }
  return fields;
}

/** A `valueString` extension field (yorm organization / note). */
function extensionField(id: string, label: string, url: string, patient: Patient): DenseFieldSpec {
  const index = extensionIndex(patient, url);
  return {
    id,
    label,
    control: "text",
    read: (p) => {
      const ext = p.extension?.find((entry) => entry.url === url);
      return typeof ext?.valueString === "string" ? ext.valueString : "";
    },
    write: (root, value) => writeExtension(root, url, value),
    proposalPath: () => (index >= 0 ? ["extension", index, "valueString"] : null),
    toProposedValue: identity,
  };
}

// ---------------------------------------------------------------------------
// Lookups shared with the review panel / presence bar
// ---------------------------------------------------------------------------

/** The dense label for a proposal path, or null when no field addresses it. */
export function denseLabelForPath(
  patient: Patient,
  path: readonly (string | number)[],
): string | null {
  for (const sect of buildDenseSections(patient)) {
    for (const field of sect.fields) {
      const fieldPath = field.proposalPath(patient);
      if (fieldPath && samePath(fieldPath, path)) {
        return field.label;
      }
    }
  }
  return null;
}

/** The dense label for an awareness `focusedField` id, if any. */
export function denseFieldLabel(patient: Patient, fieldId: string): string | null {
  for (const sect of buildDenseSections(patient)) {
    const field = sect.fields.find((candidate) => candidate.id === fieldId);
    if (field) {
      return field.label;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unmapped extras ("keep the object")
// ---------------------------------------------------------------------------

/** Top-level Patient keys the dense editor renders as inputs. */
const EDITED_KEYS = new Set([
  "resourceType",
  "id",
  "identifier",
  "active",
  "name",
  "telecom",
  "gender",
  "birthDate",
  "address",
  "photo",
  "extension",
]);

export interface UnmappedExtra {
  /** Display key — a top-level property name or a shortened extension url. */
  key: string;
  /** The raw value as compact JSON. */
  json: string;
}

/**
 * Everything on the Patient the dense editor has no input for: leftover
 * top-level keys plus extension entries other than organization/note. These
 * live only in the canonical document — no SQL column, no form field.
 */
export function unmappedExtras(patient: Patient): UnmappedExtra[] {
  const extras: UnmappedExtra[] = [];
  for (const [key, value] of Object.entries(patient)) {
    if (!EDITED_KEYS.has(key)) {
      extras.push({ key, json: JSON.stringify(value) });
    }
  }
  for (const ext of patient.extension ?? []) {
    if (ext.url === ORGANIZATION_URL || ext.url === NOTE_URL) {
      continue;
    }
    const { url, ...value } = ext;
    extras.push({ key: url.split("/StructureDefinition/")[1] ?? url, json: JSON.stringify(value) });
  }
  return extras;
}
