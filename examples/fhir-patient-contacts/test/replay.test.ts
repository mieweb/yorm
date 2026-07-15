/**
 * Mapping replay on SQLite (PLAN.md M8): drop and recreate the contact
 * projection tables, then rebuild them from the STORED Patient documents
 * with `replayProjections` — the PLAN's "rebuild the contacts projection
 * from stored documents", proven by row equality with the pre-drop state.
 */
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { replayProjections } from "@yorm/yjs";

import { canonicalContactRecord, rowsToContactRecord } from "../src/importContacts.js";
import { CONTACTS_DDL, CONTACT_TABLES } from "../src/schema.js";
import {
  contactRowCounts,
  createPocServer,
  loadContactsFixture,
  seedContacts,
} from "../src/setup.js";
import type { PocServer } from "../src/setup.js";

describe("replay rebuilds the contacts projection from stored documents", () => {
  let poc: PocServer | undefined;

  afterEach(() => {
    poc?.close();
    poc = undefined;
  });

  it("drop + recreate contact tables → replayProjections → identical rows", async () => {
    const records = loadContactsFixture();
    poc = createPocServer();
    await seedContacts(poc.yorm, records);
    const before = records.map((record) => rowsToContactRecord(poc!.db, record.id));
    const beforeCounts = contactRowCounts(poc.db);
    expect(beforeCounts["contact"]).toBe(records.length);

    // The relational model is disposable: drop every contact table…
    for (const table of CONTACT_TABLES) {
      poc.db.run(sql.raw(`DROP TABLE ${table}`));
    }
    // …recreate it empty…
    for (const ddl of CONTACTS_DDL) {
      poc.db.run(sql.raw(ddl));
    }
    expect(Object.values(contactRowCounts(poc.db)).every((count) => count === 0)).toBe(true);

    // …and rebuild it from the canonical documents alone.
    const result = await replayProjections(poc.yorm);

    expect(result).toEqual({ attempted: records.length, succeeded: records.length, failed: [] });
    expect(contactRowCounts(poc.db)).toEqual(beforeCounts);
    const after = records.map((record) => rowsToContactRecord(poc!.db, record.id));
    expect(after.map(canonicalContactRecord)).toEqual(before.map(canonicalContactRecord));
  });
});
