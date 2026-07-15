/**
 * Round-trip B (PLAN.md 5d): FHIR R4 Patient fixture → canonical document →
 * projected rows → reconstructed Patient.
 *
 * What this asserts, precisely:
 * 1. `rowsToPatient(db, id)` — rebuilt from projected rows + extensions —
 *    deep-equals the canonicalized input for **every field the mapping
 *    covers** (names, birthDate, telecom, address, extensions, photo ref).
 * 2. "Keep the object": fields the mapping does **not** cover (`identifier`,
 *    `gender`, `active`) are present in `session.read()` but appear in no
 *    contact row — the canonical document retains everything.
 */
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ensureElementIds } from "@yorm/fhir";
import type { Patient } from "@yorm/fhir";

import { canonicalizePatientForMapping, rowsToPatient } from "../src/importContacts.js";
import { CONTACT_TABLES } from "../src/schema.js";
import { createPocServer, loadPatientFixture } from "../src/setup.js";
import type { PocServer } from "../src/setup.js";

describe("round-trip B: Patient → contact rows → Patient", () => {
  let poc: PocServer | undefined;

  afterEach(() => {
    poc?.close();
    poc = undefined;
  });

  async function writeFixture(server: PocServer): Promise<Patient> {
    const patient = ensureElementIds(loadPatientFixture(), [["name"], ["telecom"], ["address"]]);
    const session = await server.yorm.open("Patient", patient.id!);
    await session.write(patient);
    session.close();
    return patient;
  }

  it("reconstructs every mapped field from rows + extensions", async () => {
    poc = createPocServer();
    const patient = await writeFixture(poc);

    const rebuilt = rowsToPatient(poc.db, patient.id!);
    expect(rebuilt).toEqual(canonicalizePatientForMapping(patient));

    // Concrete spot checks against the fixture content.
    expect(rebuilt.name).toEqual([
      { use: "official", family: "Chalmers", given: ["Peter", "James"] },
      { use: "usual", given: ["Jim"] },
    ]);
    expect(rebuilt.birthDate).toBe("1974-12-25");
    expect(rebuilt.telecom).toEqual([
      { id: "t1", system: "phone", value: "(03) 5555 6473", use: "work" },
      { id: "t2", system: "email", value: "peter.chalmers@example.org", use: "home" },
    ]);
    expect(rebuilt.address).toEqual([
      {
        id: "a1",
        use: "home",
        line: ["534 Erewhon St"],
        city: "PleasantVille",
        state: "Vic",
        postalCode: "3999",
        country: "AUS",
      },
    ]);
  });

  it('"keep the object": unmapped fields stay in the document and never reach rows', async () => {
    poc = createPocServer();
    const patient = await writeFixture(poc);

    // The canonical document retains everything, byte-for-byte (JSON codec is lossless).
    const session = await poc.yorm.open("Patient", patient.id!);
    const stored = session.read() as Patient;
    session.close();
    expect(stored).toEqual(patient);
    expect(stored.identifier).toEqual(patient.identifier);
    expect(stored.gender).toBe("male");
    expect(stored.active).toBe(true);

    // …but the unmapped values appear in no contact row.
    const allRows = CONTACT_TABLES.flatMap((table) =>
      poc!.db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM ${table}`)),
    );
    const rowText = JSON.stringify(allRows);
    expect(rowText).not.toContain("12345"); // identifier.value
    expect(rowText).not.toContain("male"); // gender
    expect(rowText).not.toContain("urn:oid"); // identifier.system

    // …and the reconstructed Patient (mapped content only) omits them.
    const rebuilt = rowsToPatient(poc.db, patient.id!);
    expect(rebuilt.identifier).toBeUndefined();
    expect(rebuilt.gender).toBeUndefined();
    expect(rebuilt.active).toBeUndefined();
  });
});
