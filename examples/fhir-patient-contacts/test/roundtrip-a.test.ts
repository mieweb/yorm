/**
 * Round-trip A (PLAN.md 5d): contacts record → Patient → fresh contact
 * tables → record. Row equality is compared on canonical record forms; the
 * raw-property sidecar carries everything unmappable.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalContactRecord,
  contactToPatient,
  rowsToContactRecord,
} from "../src/importContacts.js";
import { createPocServer, loadContactsFixture, seedContacts } from "../src/setup.js";
import type { PocServer } from "../src/setup.js";

describe("round-trip A: contacts DB → Patient → contacts DB", () => {
  let poc: PocServer | undefined;

  afterEach(() => {
    poc?.close();
    poc = undefined;
  });

  it("every fixture record survives the full round trip (row equality)", async () => {
    const records = loadContactsFixture();
    expect(records.length).toBeGreaterThan(0);
    poc = createPocServer(); // FRESH contact tables
    await seedContacts(poc.yorm, records);

    for (const original of records) {
      const roundTripped = rowsToContactRecord(poc.db, original.id);
      expect(canonicalContactRecord(roundTripped)).toEqual(canonicalContactRecord(original));
    }
  });

  it("the raw-property sidecar carries fields with no FHIR mapping", async () => {
    const record = loadContactsFixture()[0]!;
    poc = createPocServer();

    // The unmappable fields ride along on the Patient as raw/ extensions…
    const patient = contactToPatient(record);
    const extensionUrls = (patient.extension ?? []).map((ext) => ext.url);
    expect(extensionUrls).toContain("https://yorm.dev/fhir/StructureDefinition/raw/ringtone");
    expect(extensionUrls).toContain(
      "https://yorm.dev/fhir/StructureDefinition/raw/socialProfile.twitter",
    );

    // …and land back in the sidecar table after projection.
    await seedContacts(poc.yorm, [record]);
    const roundTripped = rowsToContactRecord(poc.db, record.id);
    expect(roundTripped.rawProperties).toEqual([
      { property: "ringtone", value: "Opening" },
      { property: "socialProfile.twitter", value: "@pchalmers" },
    ]);
  });

  it("a second projection of the same document is idempotent", async () => {
    const record = loadContactsFixture()[0]!;
    poc = createPocServer();
    await seedContacts(poc.yorm, [record]);
    const first = rowsToContactRecord(poc.db, record.id);

    // Rewrite the identical Patient: reconciliation must not duplicate or drop rows.
    const session = await poc.yorm.open("Patient", record.id);
    await session.write(session.read());
    session.close();

    expect(rowsToContactRecord(poc.db, record.id)).toEqual(first);
  });
});
