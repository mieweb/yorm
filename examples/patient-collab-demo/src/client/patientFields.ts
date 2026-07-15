/**
 * The demo's Patient field mapping — the single source of truth for which
 * FHIR Patient elements the eSheet form edits (PLAN.md 6b).
 *
 * Each spec knows how to `read` its value from the materialized Patient JSON
 * and how to `write` it into the Y.Doc's `resource` root map (mirroring the
 * structural conventions of `@yorm/yjs`'s jsonCodec: objects → Y.Map,
 * arrays → Y.Array), so the form, the Zustand bridge, and the Yjs writes all
 * share one definition.
 */
import * as Y from "yjs";
import type { Patient } from "@yorm/fhir";

import type { StringKey } from "./i18n";

export type PatientFieldId = "given" | "family" | "birthDate" | "phone" | "email";

export interface PatientFieldSpec {
  id: PatientFieldId;
  labelKey: StringKey;
  /** eSheet text-field input type. */
  inputType: "string" | "date" | "email";
  /** Reads the field's current value from the materialized Patient. */
  read(patient: Patient): string;
  /** Mutates the `resource` root map (call inside `doc.transact`). */
  write(root: Y.Map<unknown>, value: string): void;
  /**
   * Path into the canonical Patient for a `set` proposal (M7c), or `null`
   * when the structure the path addresses does not exist yet (the demo only
   * proposes over existing elements; creating them needs the editor role).
   */
  proposalPath(patient: Patient): (string | number)[] | null;
  /** Converts the form input string into the proposed JSON value. */
  toProposedValue(value: string): unknown;
}

function ensureArray(root: Y.Map<unknown>, key: string): Y.Array<unknown> {
  const existing = root.get(key);
  if (existing instanceof Y.Array) {
    return existing;
  }
  const created = new Y.Array<unknown>();
  root.set(key, created);
  return created;
}

/** First `name` entry, created as `{ use: "official" }` when missing. */
function ensureName(root: Y.Map<unknown>): Y.Map<unknown> {
  const names = ensureArray(root, "name");
  const first = names.length > 0 ? names.get(0) : undefined;
  if (first instanceof Y.Map) {
    return first;
  }
  const created = new Y.Map<unknown>();
  created.set("use", "official");
  names.insert(0, [created]);
  return created;
}

/** First `telecom` entry for `system`, created with a stable element id. */
function ensureTelecom(root: Y.Map<unknown>, system: string, newId: string): Y.Map<unknown> {
  const telecom = ensureArray(root, "telecom");
  for (let i = 0; i < telecom.length; i += 1) {
    const entry = telecom.get(i);
    if (entry instanceof Y.Map && entry.get("system") === system) {
      return entry;
    }
  }
  const created = new Y.Map<unknown>();
  created.set("id", newId);
  created.set("system", system);
  telecom.push([created]);
  return created;
}

/** Sets a string entry, deleting the key when the value is empty. */
function setOrDelete(map: Y.Map<unknown>, key: string, value: string): void {
  if (value === "") {
    map.delete(key);
  } else {
    map.set(key, value);
  }
}

function readTelecom(patient: Patient, system: string): string {
  return patient.telecom?.find((point) => point.system === system)?.value ?? "";
}

/** Proposal path for the first name entry's `part`, when a name exists. */
function namePath(patient: Patient, part: string): (string | number)[] | null {
  return patient.name?.[0] ? ["name", 0, part] : null;
}

/** Proposal path for the `value` of the telecom entry with `system`. */
function telecomPath(patient: Patient, system: string): (string | number)[] | null {
  const index = patient.telecom?.findIndex((point) => point.system === system) ?? -1;
  return index >= 0 ? ["telecom", index, "value"] : null;
}

const identity = (value: string): unknown => value;

/** Two proposal paths address the same element. */
export function samePath(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/** Renders a proposed/base JSON value for display (given names are arrays). */
export function formatFieldValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return Array.isArray(value) ? value.map(String).join(" ") : String(value);
}

export const PATIENT_FIELDS: readonly PatientFieldSpec[] = [
  {
    id: "given",
    labelKey: "form.given",
    inputType: "string",
    read: (patient) => patient.name?.[0]?.given?.join(" ") ?? "",
    write(root, value) {
      const name = ensureName(root);
      const parts = value.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        name.delete("given");
        return;
      }
      const given = new Y.Array<unknown>();
      given.push(parts);
      name.set("given", given);
    },
    proposalPath: (patient) => namePath(patient, "given"),
    toProposedValue: (value) => value.trim().split(/\s+/).filter(Boolean),
  },
  {
    id: "family",
    labelKey: "form.family",
    inputType: "string",
    read: (patient) => patient.name?.[0]?.family ?? "",
    write: (root, value) => setOrDelete(ensureName(root), "family", value),
    proposalPath: (patient) => namePath(patient, "family"),
    toProposedValue: identity,
  },
  {
    id: "birthDate",
    labelKey: "form.birthDate",
    inputType: "date",
    read: (patient) => patient.birthDate ?? "",
    write: (root, value) => setOrDelete(root, "birthDate", value),
    proposalPath: () => ["birthDate"],
    toProposedValue: identity,
  },
  {
    id: "phone",
    labelKey: "form.phone",
    // Deliberately "string", not "tel": eSheet's tel input applies a US
    // phone mask that corrupts international numbers (the fixture is AUS).
    inputType: "string",
    read: (patient) => readTelecom(patient, "phone"),
    write: (root, value) => setOrDelete(ensureTelecom(root, "phone", "t-phone"), "value", value),
    proposalPath: (patient) => telecomPath(patient, "phone"),
    toProposedValue: identity,
  },
  {
    id: "email",
    labelKey: "form.email",
    inputType: "email",
    read: (patient) => readTelecom(patient, "email"),
    write: (root, value) => setOrDelete(ensureTelecom(root, "email", "t-email"), "value", value),
    proposalPath: (patient) => telecomPath(patient, "email"),
    toProposedValue: identity,
  },
];

export function getFieldSpec(id: string): PatientFieldSpec | undefined {
  return PATIENT_FIELDS.find((spec) => spec.id === id);
}
