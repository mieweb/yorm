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
  },
  {
    id: "family",
    labelKey: "form.family",
    inputType: "string",
    read: (patient) => patient.name?.[0]?.family ?? "",
    write: (root, value) => setOrDelete(ensureName(root), "family", value),
  },
  {
    id: "birthDate",
    labelKey: "form.birthDate",
    inputType: "date",
    read: (patient) => patient.birthDate ?? "",
    write: (root, value) => setOrDelete(root, "birthDate", value),
  },
  {
    id: "phone",
    labelKey: "form.phone",
    // Deliberately "string", not "tel": eSheet's tel input applies a US
    // phone mask that corrupts international numbers (the fixture is AUS).
    inputType: "string",
    read: (patient) => readTelecom(patient, "phone"),
    write: (root, value) => setOrDelete(ensureTelecom(root, "phone", "t-phone"), "value", value),
  },
  {
    id: "email",
    labelKey: "form.email",
    inputType: "email",
    read: (patient) => readTelecom(patient, "email"),
    write: (root, value) => setOrDelete(ensureTelecom(root, "email", "t-email"), "value", value),
  },
];

export function getFieldSpec(id: string): PatientFieldSpec | undefined {
  return PATIENT_FIELDS.find((spec) => spec.id === id);
}
