/**
 * Contacts import codec and row readers (PLAN.md Milestone 5c/5d).
 *
 * - {@link contactToPatient} — ingestion: a contact record becomes a
 *   canonical FHIR Patient (this is import, **not** live reverse sync —
 *   Decision #3 defers the outbox).
 * - {@link rowsToContactRecord} — reads the four contact tables back into the
 *   fixture record shape (round-trip A).
 * - {@link rowsToPatient} — reconstructs a Patient from projected rows +
 *   extensions (round-trip B).
 * - {@link canonicalizePatientForMapping} / {@link canonicalContactRecord} —
 *   the documented canonical forms the round-trip tests compare against.
 *
 * ## Canonicalization rules
 *
 * Both directions rebuild through one shared builder, so the rules live in a
 * single place ({@link buildPatientCore}):
 *
 * - `telecom` and `address` are ordered by **element id** (array position is
 *   not identity);
 * - raw properties are ordered by property name; extensions appear as
 *   organization → note → raw/*;
 * - `null` / absent values are dropped (a missing column and an absent FHIR
 *   field are the same thing);
 * - `name` element ids are **not** part of the mapped content (the `contact`
 *   table stores name parts in scalar columns), so canonical Patients carry
 *   names without ids; `telecom`/`address` ids **are** mapped (they are the
 *   `element_id` key column) and round-trip exactly.
 */
import { sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Address, ContactPoint, HumanName, Patient } from "@yorm/fhir";
import { ensureElementIds, setExtension } from "@yorm/fhir";

import {
  NOTE_EXTENSION_URL,
  ORGANIZATION_EXTENSION_URL,
  entriesToAddressFields,
  patientToContactRecord,
  rawPropertyExtensionUrl,
} from "./mapping.js";
import type {
  ContactMultivalueEntryGroup,
  ContactMultivalueEntryRow,
  ContactMultivalueRow,
  ContactRawPropertyRow,
  ContactRecord,
  ContactRow,
} from "./schema.js";

const byElementId = <T extends { elementId: string }>(a: T, b: T): number =>
  a.elementId.localeCompare(b.elementId);

/**
 * Builds the canonical Patient a contact record can express. Shared by
 * ingestion ({@link contactToPatient}), row reconstruction
 * ({@link rowsToPatient}), and canonicalization
 * ({@link canonicalizePatientForMapping}) — one definition of the canonical
 * shape. Applies the canonical ordering documented above; assigns no ids.
 */
function buildPatientCore(record: ContactRecord): Patient {
  const names: HumanName[] = [];
  const official: HumanName = { use: "official" };
  const given = [record.first, record.middle].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  if (given.length > 0) official.given = given;
  if (record.last != null) official.family = record.last;
  if (official.given !== undefined || official.family !== undefined) names.push(official);
  if (record.nickname != null) names.push({ use: "usual", given: [record.nickname] });

  let patient: Patient = { resourceType: "Patient", id: record.id };
  if (names.length > 0) patient.name = names;
  if (record.birthday != null) patient.birthDate = record.birthday;

  const telecom = [...(record.multivalues ?? [])].sort(byElementId).map((mv) => {
    const point: ContactPoint = { id: mv.elementId };
    if (mv.property != null) point.system = mv.property as ContactPoint["system"];
    if (mv.value != null) point.value = mv.value;
    if (mv.label != null) point.use = mv.label as ContactPoint["use"];
    return point;
  });
  if (telecom.length > 0) patient.telecom = telecom;

  const address = [...(record.multivalueEntries ?? [])]
    .filter((group) => group.property === "address")
    .sort(byElementId)
    .map((group) => {
      const entry: Address = { id: group.elementId };
      if (group.label != null) entry.use = group.label as Address["use"];
      Object.assign(entry, entriesToAddressFields(group.entries));
      return entry;
    });
  if (address.length > 0) patient.address = address;

  if (record.imageRef != null) patient["photo"] = [{ url: record.imageRef }];
  if (record.organization != null) {
    patient = setExtension(patient, ORGANIZATION_EXTENSION_URL, {
      valueString: record.organization,
    });
  }
  if (record.note != null) {
    patient = setExtension(patient, NOTE_EXTENSION_URL, { valueString: record.note });
  }
  const raws = [...(record.rawProperties ?? [])].sort((a, b) =>
    a.property.localeCompare(b.property),
  );
  for (const raw of raws) {
    if (raw.value != null) {
      patient = setExtension(patient, rawPropertyExtensionUrl(raw.property), {
        valueString: raw.value,
      });
    }
  }
  return patient;
}

/**
 * Ingestion codec: contact record → canonical FHIR Patient.
 * `ensureElementIds` gives every repeating element a stable id — `telecom` /
 * `address` keep the record's element ids, names get deterministic
 * ingestion-assigned ids (`gen-1`, `gen-2`, …).
 */
export function contactToPatient(record: ContactRecord): Patient {
  let counter = 0;
  return ensureElementIds(buildPatientCore(record), [["name"], ["telecom"], ["address"]], {
    assign: () => `gen-${(counter += 1)}`,
  });
}

/**
 * The canonical form of a Patient's **mapped content** — what a projection to
 * the contact tables preserves. Round-trip B compares
 * `rowsToPatient(db, id)` against this.
 */
export function canonicalizePatientForMapping(patient: Patient, documentId?: string): Patient {
  return buildPatientCore(patientToContactRecord(patient, documentId ?? patient.id ?? ""));
}

/**
 * Canonical form of a contact record for row-equality comparisons:
 * multivalues/entry groups sorted by element id, raw properties sorted by
 * property, `null`/absent fields dropped.
 */
export function canonicalContactRecord(record: ContactRecord): ContactRecord {
  const result: ContactRecord = { id: record.id };
  const scalars = [
    "first",
    "middle",
    "last",
    "nickname",
    "organization",
    "birthday",
    "note",
    "imageRef",
  ] as const;
  for (const key of scalars) {
    const value = record[key];
    if (value != null) result[key] = value;
  }
  const multivalues = [...(record.multivalues ?? [])].sort(byElementId).map((mv) => ({
    elementId: mv.elementId,
    ...(mv.property != null ? { property: mv.property } : {}),
    ...(mv.label != null ? { label: mv.label } : {}),
    ...(mv.value != null ? { value: mv.value } : {}),
  }));
  if (multivalues.length > 0) result.multivalues = multivalues as ContactRecord["multivalues"];
  const groups = [...(record.multivalueEntries ?? [])].sort(byElementId).map((group) => ({
    elementId: group.elementId,
    property: group.property,
    ...(group.label != null ? { label: group.label } : {}),
    entries: { ...group.entries },
  }));
  if (groups.length > 0) result.multivalueEntries = groups;
  const raws = [...(record.rawProperties ?? [])]
    .filter((raw) => raw.value != null)
    .sort((a, b) => a.property.localeCompare(b.property))
    .map((raw) => ({ property: raw.property, value: raw.value }));
  if (raws.length > 0) result.rawProperties = raws;
  return result;
}

/**
 * Reads the four contact tables back into the fixture record shape (rows are
 * read in canonical order — see the module doc).
 */
export function rowsToContactRecord(db: BetterSQLite3Database, contactId: string): ContactRecord {
  const contact = db.all<ContactRow>(sql`SELECT * FROM contact WHERE contact_id = ${contactId}`)[0];
  if (contact === undefined) {
    throw new Error(`rowsToContactRecord: no contact row for "${contactId}"`);
  }
  const multivalueRows = db.all<ContactMultivalueRow>(
    sql`SELECT * FROM contact_multivalue WHERE contact_id = ${contactId} ORDER BY element_id`,
  );
  const entryRows = db.all<ContactMultivalueEntryRow>(
    sql`SELECT * FROM contact_multivalue_entry WHERE contact_id = ${contactId} ORDER BY element_id, entry_key`,
  );
  const rawRows = db.all<ContactRawPropertyRow>(
    sql`SELECT * FROM contact_raw_property WHERE contact_id = ${contactId} ORDER BY property`,
  );

  const groups = new Map<string, ContactMultivalueEntryGroup>();
  for (const row of entryRows) {
    let group = groups.get(row.element_id);
    if (group === undefined) {
      group = {
        elementId: row.element_id,
        property: row.property ?? "address",
        label: row.label,
        entries: {},
      };
      groups.set(row.element_id, group);
    }
    if (row.entry_value != null) group.entries[row.entry_key] = row.entry_value;
  }

  return {
    id: contact.contact_id,
    first: contact.first,
    middle: contact.middle,
    last: contact.last,
    nickname: contact.nickname,
    organization: contact.organization,
    birthday: contact.birthday,
    note: contact.note,
    imageRef: contact.image_ref,
    multivalues: multivalueRows.map((row) => ({
      elementId: row.element_id,
      property: row.property,
      label: row.label,
      value: row.value,
    })),
    multivalueEntries: [...groups.values()],
    rawProperties: rawRows.map((row) => ({ property: row.property, value: row.value })),
  };
}

/**
 * Round-trip B reader: reconstructs the Patient's mapped content from
 * projected rows + extensions. Equals
 * {@link canonicalizePatientForMapping}(original) for every field the mapping
 * covers.
 */
export function rowsToPatient(db: BetterSQLite3Database, contactId: string): Patient {
  return buildPatientCore(rowsToContactRecord(db, contactId));
}
