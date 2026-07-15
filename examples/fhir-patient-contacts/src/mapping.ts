/**
 * `fhir.Patient@1` — forward mapping from the canonical FHIR Patient document
 * to the contact tables (PLAN.md Milestone 5c).
 *
 * The single extraction function {@link patientToContactRecord} is the source
 * of truth for what the mapping covers: the projections below consume it, and
 * the canonicalization used by the round-trip tests reuses it (DRY — one
 * definition of "mapped content").
 *
 * **Unmapped-on-purpose FHIR fields** (`identifier`, `gender`, `active`,
 * `maritalStatus`, …) have no contact-table column: they stay only in the
 * canonical Yjs document ("keep the object") and survive every round trip
 * because rows are projections, never the system of record.
 *
 * Extension namespace (unmapped **contact** fields riding on the Patient):
 * - `{YORM_EXTENSION_BASE}/contact-organization` — `contact.organization`
 * - `{YORM_EXTENSION_BASE}/contact-note`         — `contact.note`
 * - `{YORM_EXTENSION_BASE}/raw/<property>`       — `contact_raw_property` sidecar
 */
import { defineMapping, many, one } from "@yorm/core";
import type { Mapping } from "@yorm/core";
import type { Address, HumanName, Patient } from "@yorm/fhir";
import { extensionUrl, fhirElementId, getExtensionValue, listYormExtensions } from "@yorm/fhir";

import type { ContactRecord } from "./schema.js";

/** Extension URL carrying `contact.organization`. */
export const ORGANIZATION_EXTENSION_URL = extensionUrl("contact-organization");
/** Extension URL carrying `contact.note`. */
export const NOTE_EXTENSION_URL = extensionUrl("contact-note");
/** URL prefix for the raw-property sidecar: `raw/<property>` → `contact_raw_property`. */
export const RAW_PROPERTY_EXTENSION_PREFIX = extensionUrl("raw/");

/** Builds the extension URL for one raw contact property. */
export function rawPropertyExtensionUrl(property: string): string {
  return `${RAW_PROPERTY_EXTENSION_PREFIX}${property}`;
}

// ---------------------------------------------------------------------------
// Address ⇄ entry key/value vocabulary (single place for both directions)
// ---------------------------------------------------------------------------

/** Flattens a FHIR Address into Apple-style entry key/value pairs. */
export function addressToEntries(address: Address): Record<string, string> {
  const entries: Record<string, string> = {};
  if (address.line !== undefined && address.line.length > 0) {
    entries["street"] = address.line.join("\n");
  }
  if (address.city !== undefined) entries["city"] = address.city;
  if (address.state !== undefined) entries["state"] = address.state;
  if (address.postalCode !== undefined) entries["zip"] = address.postalCode;
  if (address.country !== undefined) entries["country"] = address.country;
  return entries;
}

/** Rebuilds the FHIR Address fields from entry key/value pairs (street splits into `line`). */
export function entriesToAddressFields(entries: Record<string, string>): Partial<Address> {
  const address: Partial<Address> = {};
  const street = entries["street"];
  if (street !== undefined) address.line = street.split("\n");
  if (entries["city"] !== undefined) address.city = entries["city"];
  if (entries["state"] !== undefined) address.state = entries["state"];
  if (entries["zip"] !== undefined) address.postalCode = entries["zip"];
  if (entries["country"] !== undefined) address.country = entries["country"];
  return address;
}

// ---------------------------------------------------------------------------
// Extraction: Patient → contact record (what the mapping covers)
// ---------------------------------------------------------------------------

/** The name projected onto first/middle/last: `use === "official"`, else the first name. */
function officialName(patient: Patient): HumanName | undefined {
  const names = patient.name ?? [];
  return names.find((name) => name.use === "official") ?? names[0];
}

/** The name projected onto nickname: `use === "usual"` or `"nickname"`. */
function nicknameOf(patient: Patient): string | undefined {
  const names = patient.name ?? [];
  return names.find((name) => name.use === "usual" || name.use === "nickname")?.given?.[0];
}

/** `Patient.photo[0].url` (photo is untyped in the POC Patient subset — image refs only, Decision #7). */
function photoRef(patient: Patient): string | null {
  const photo = patient["photo"];
  if (!Array.isArray(photo)) return null;
  const first = photo[0] as { url?: unknown } | undefined;
  return typeof first?.url === "string" ? first.url : null;
}

/**
 * Extracts everything the mapping covers from a Patient as a
 * {@link ContactRecord}. Repeating elements (`telecom`, `address`) must carry
 * stable element ids ({@link fhirElementId} throws otherwise — run
 * `ensureElementIds` during ingestion).
 */
export function patientToContactRecord(patient: Patient, documentId: string): ContactRecord {
  const contactId = patient.id ?? documentId;
  const official = officialName(patient);
  return {
    id: contactId,
    first: official?.given?.[0] ?? null,
    middle: official?.given?.[1] ?? null,
    last: official?.family ?? null,
    nickname: nicknameOf(patient) ?? null,
    organization: getExtensionValue(patient, ORGANIZATION_EXTENSION_URL) ?? null,
    birthday: patient.birthDate ?? null,
    note: getExtensionValue(patient, NOTE_EXTENSION_URL) ?? null,
    imageRef: photoRef(patient),
    multivalues: (patient.telecom ?? []).map((point) => ({
      elementId: fhirElementId(point),
      property: point.system ?? null,
      label: point.use ?? null,
      value: point.value ?? null,
    })),
    multivalueEntries: (patient.address ?? []).map((address) => ({
      elementId: fhirElementId(address),
      property: "address",
      label: address.use ?? null,
      entries: addressToEntries(address),
    })),
    rawProperties: listYormExtensions(patient)
      .filter((ext) => ext.url.startsWith(RAW_PROPERTY_EXTENSION_PREFIX))
      .map((ext) => ({
        property: ext.url.slice(RAW_PROPERTY_EXTENSION_PREFIX.length),
        value: ext.valueString ?? null,
      })),
  };
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

function contactId(patient: Patient, documentId: string): string {
  return patient.id ?? documentId;
}

/** Forward projection `fhir.Patient@1`: Patient document → contact tables. */
export const patientContactsMapping: Mapping<Patient> = defineMapping<Patient>({
  name: "fhir.Patient",
  version: 1,
  documentType: "Patient",
  direction: "forward",
  projections: [
    one("contact", {
      key: ({ object, documentId }) => ({ contact_id: contactId(object, documentId) }),
      values: ({ object, documentId }) => {
        const record = patientToContactRecord(object, documentId);
        return {
          first: record.first ?? null,
          last: record.last ?? null,
          middle: record.middle ?? null,
          nickname: record.nickname ?? null,
          organization: record.organization ?? null,
          birthday: record.birthday ?? null,
          note: record.note ?? null,
          image_ref: record.imageRef ?? null,
        };
      },
    }),
    many("contact_multivalue", {
      rows: ({ object, documentId }) => {
        const record = patientToContactRecord(object, documentId);
        return (record.multivalues ?? []).map((mv) => ({
          key: { contact_id: record.id, element_id: mv.elementId },
          values: { property: mv.property, label: mv.label ?? null, value: mv.value },
        }));
      },
      scope: ({ object, documentId }) => ({ contact_id: contactId(object, documentId) }),
    }),
    many("contact_multivalue_entry", {
      rows: ({ object, documentId }) => {
        const record = patientToContactRecord(object, documentId);
        return (record.multivalueEntries ?? []).flatMap((group) =>
          Object.keys(group.entries)
            .sort()
            .map((entryKey) => ({
              key: {
                contact_id: record.id,
                element_id: group.elementId,
                entry_key: entryKey,
              },
              values: {
                property: group.property,
                label: group.label ?? null,
                entry_value: group.entries[entryKey] ?? null,
              },
            })),
        );
      },
      scope: ({ object, documentId }) => ({ contact_id: contactId(object, documentId) }),
    }),
    many("contact_raw_property", {
      rows: ({ object, documentId }) => {
        const record = patientToContactRecord(object, documentId);
        return (record.rawProperties ?? []).map((raw) => ({
          key: { contact_id: record.id, property: raw.property },
          values: { value: raw.value },
        }));
      },
      scope: ({ object, documentId }) => ({ contact_id: contactId(object, documentId) }),
    }),
  ],
});
