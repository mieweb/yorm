/**
 * POC end-to-end (PLAN.md 5e): seeding projects concrete rows; session edits
 * update rows; removals delete rows via reconciliation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Patient } from "@yorm/fhir";

import type {
  ContactMultivalueEntryRow,
  ContactMultivalueRow,
  ContactRawPropertyRow,
  ContactRow,
} from "../src/schema.js";
import { createPocServer, loadContactsFixture, seedContacts } from "../src/setup.js";
import type { PocServer } from "../src/setup.js";

describe("contacts POC on SQLite", () => {
  let poc: PocServer;

  beforeEach(async () => {
    poc = createPocServer();
    await seedContacts(poc.yorm, loadContactsFixture());
  });

  afterEach(() => {
    poc.close();
  });

  it("seeding the fixture projects concrete contact rows", () => {
    const contact = poc.db.all<ContactRow>(
      sql`SELECT * FROM contact WHERE contact_id = 'c-100'`,
    )[0];
    expect(contact).toEqual({
      contact_id: "c-100",
      first: "Peter",
      middle: "James",
      last: "Chalmers",
      nickname: "Jim",
      organization: "Acme Health",
      birthday: "1974-12-25",
      note: "Prefers email contact.",
      image_ref: null,
    });

    const multivalues = poc.db.all<ContactMultivalueRow>(
      sql`SELECT * FROM contact_multivalue WHERE contact_id = 'c-100' ORDER BY element_id`,
    );
    expect(multivalues).toEqual([
      {
        contact_id: "c-100",
        element_id: "t1",
        property: "phone",
        label: "work",
        value: "(03) 5555 6473",
      },
      {
        contact_id: "c-100",
        element_id: "t2",
        property: "email",
        label: "home",
        value: "peter.chalmers@example.org",
      },
    ]);

    const entries = poc.db.all<ContactMultivalueEntryRow>(
      sql`SELECT * FROM contact_multivalue_entry WHERE contact_id = 'c-100' ORDER BY entry_key`,
    );
    expect(entries).toEqual(
      [
        { entry_key: "city", entry_value: "PleasantVille" },
        { entry_key: "country", entry_value: "AUS" },
        { entry_key: "state", entry_value: "Vic" },
        { entry_key: "street", entry_value: "534 Erewhon St" },
        { entry_key: "zip", entry_value: "3999" },
      ].map((entry) => ({
        contact_id: "c-100",
        element_id: "a1",
        property: "address",
        label: "home",
        ...entry,
      })),
    );

    const raws = poc.db.all<ContactRawPropertyRow>(
      sql`SELECT * FROM contact_raw_property WHERE contact_id = 'c-100' ORDER BY property`,
    );
    expect(raws).toEqual([
      { contact_id: "c-100", property: "ringtone", value: "Opening" },
      { contact_id: "c-100", property: "socialProfile.twitter", value: "@pchalmers" },
    ]);
  });

  it("editing a telecom value via the session updates its row", async () => {
    const session = await poc.yorm.open("Patient", "c-100");
    const patient = session.read() as Patient;
    const updated: Patient = {
      ...patient,
      telecom: patient.telecom!.map((point) =>
        point.id === "t1" ? { ...point, value: "(03) 5555 9999" } : point,
      ),
    };
    await session.write(updated); // every-change policy: projection settles before resolve
    session.close();

    const row = poc.db.all<ContactMultivalueRow>(
      sql`SELECT * FROM contact_multivalue WHERE contact_id = 'c-100' AND element_id = 't1'`,
    )[0];
    expect(row?.value).toBe("(03) 5555 9999");
  });

  it("removing a telecom deletes its row (reconciliation)", async () => {
    const session = await poc.yorm.open("Patient", "c-100");
    const patient = session.read() as Patient;
    const updated: Patient = {
      ...patient,
      telecom: patient.telecom!.filter((point) => point.id !== "t1"),
    };
    await session.write(updated);
    session.close();

    const rows = poc.db.all<ContactMultivalueRow>(
      sql`SELECT * FROM contact_multivalue WHERE contact_id = 'c-100' ORDER BY element_id`,
    );
    expect(rows.map((row) => row.element_id)).toEqual(["t2"]); // t1 gone, t2 intact
  });
});
