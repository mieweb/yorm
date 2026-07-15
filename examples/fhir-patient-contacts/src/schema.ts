/**
 * Contacts schema — a cleaned-up, Apple AddressBook-inspired phone-contacts
 * database (PLAN.md Milestone 5b, Decision #5).
 *
 * Correspondence to Apple's `AddressBook.sqlitedb` (documented, not cloned):
 *
 * | This schema                | Apple AddressBook            | Notes                                          |
 * | -------------------------- | ---------------------------- | ---------------------------------------------- |
 * | `contact`                  | `ABPerson`                   | one row per person; scalar person properties   |
 * | `contact_multivalue`       | `ABMultiValue`               | generic labeled values (phones, emails, URLs)  |
 * | `contact_multivalue_entry` | `ABMultiValueEntry` (+`Key`) | structured multivalues (addresses) as k/v rows |
 * | `contact_raw_property`     | — (lossless sidecar)         | anything with no FHIR mapping (ringtone, …)    |
 *
 * Apple stores multivalue labels via a `ABMultiValueLabel` lookup table and
 * entry keys via `ABMultiValueEntryKey`; this POC inlines both as TEXT
 * columns (`label`, `entry_key`) — same shape, fewer joins.
 *
 * The `contact_raw_property` sidecar is what makes the **contacts side**
 * lossless too: contact fields with no FHIR home ride along as
 * `raw/<property>` YORM extensions on the Patient and project back here.
 */

/** DDL for the contact tables (idempotent; PRIMARY KEYs cover the plan key columns as `@yorm/drizzle` upserts require). */
export const CONTACTS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS contact (
    contact_id TEXT PRIMARY KEY,
    first TEXT,
    last TEXT,
    middle TEXT,
    nickname TEXT,
    organization TEXT,
    birthday TEXT,
    note TEXT,
    image_ref TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS contact_multivalue (
    contact_id TEXT NOT NULL,
    element_id TEXT NOT NULL,
    property TEXT,
    label TEXT,
    value TEXT,
    PRIMARY KEY (contact_id, element_id)
  )`,
  `CREATE TABLE IF NOT EXISTS contact_multivalue_entry (
    contact_id TEXT NOT NULL,
    element_id TEXT NOT NULL,
    property TEXT,
    label TEXT,
    entry_key TEXT NOT NULL,
    entry_value TEXT,
    PRIMARY KEY (contact_id, element_id, entry_key)
  )`,
  `CREATE TABLE IF NOT EXISTS contact_raw_property (
    contact_id TEXT NOT NULL,
    property TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (contact_id, property)
  )`,
];

/** The four contact projection tables, in DDL order. */
export const CONTACT_TABLES = [
  "contact",
  "contact_multivalue",
  "contact_multivalue_entry",
  "contact_raw_property",
] as const;

// ---------------------------------------------------------------------------
// Row shapes (as returned by raw SELECTs)
// ---------------------------------------------------------------------------

export interface ContactRow {
  contact_id: string;
  first: string | null;
  last: string | null;
  middle: string | null;
  nickname: string | null;
  organization: string | null;
  birthday: string | null;
  note: string | null;
  image_ref: string | null;
}

export interface ContactMultivalueRow {
  contact_id: string;
  element_id: string;
  property: string | null;
  label: string | null;
  value: string | null;
}

export interface ContactMultivalueEntryRow {
  contact_id: string;
  element_id: string;
  property: string | null;
  label: string | null;
  entry_key: string;
  entry_value: string | null;
}

export interface ContactRawPropertyRow {
  contact_id: string;
  property: string;
  value: string | null;
}

// ---------------------------------------------------------------------------
// Domain record shape (matches fixtures/contacts/contacts-example.json)
// ---------------------------------------------------------------------------

/** One generic labeled value (phone, email, URL…) ↔ one `contact_multivalue` row. */
export interface ContactMultivalue {
  elementId: string;
  property: string | null;
  label?: string | null;
  value: string | null;
}

/** One structured multivalue (address) ↔ a `contact_multivalue_entry` row group. */
export interface ContactMultivalueEntryGroup {
  elementId: string;
  property: string;
  label?: string | null;
  entries: Record<string, string>;
}

/** One unmapped contact property ↔ one `contact_raw_property` row. */
export interface ContactRawProperty {
  property: string;
  value: string | null;
}

/** A full contact record — the shape of the contacts fixture. */
export interface ContactRecord {
  id: string;
  first?: string | null;
  middle?: string | null;
  last?: string | null;
  nickname?: string | null;
  organization?: string | null;
  birthday?: string | null;
  note?: string | null;
  imageRef?: string | null;
  multivalues?: ContactMultivalue[];
  multivalueEntries?: ContactMultivalueEntryGroup[];
  rawProperties?: ContactRawProperty[];
}
