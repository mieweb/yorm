/**
 * SQLite adapter tests: runs the shared adapter conformance suite against
 * `createSqliteAdapter(":memory:")`, plus `resolveBackend` plumbing tests.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AdapterFactory } from "../src/conformance.js";
import { adapterConformanceTests } from "../src/conformance.js";
import { createSqliteAdapter, resolveBackend, YORM_SQLITE_DDL } from "../src/sqlite.js";

const factory: AdapterFactory = {
  name: "sqlite (better-sqlite3, :memory:)",
  async create() {
    const adapter = createSqliteAdapter();
    adapter.migrate();
    const sqlite = adapter.db.$client;
    return {
      documents: adapter.documents,
      projections: adapter.projections,
      async queryRows(table: string) {
        return sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
      },
      async setup(statements: string[]) {
        for (const statement of statements) sqlite.exec(statement);
      },
      async close() {
        adapter.close();
      },
    };
  },
};

adapterConformanceTests(factory, { describe, it, expect, beforeEach });

describe("createSqliteAdapter", () => {
  it("migrate() is idempotent and creates the yorm_* tables", () => {
    const adapter = createSqliteAdapter();
    adapter.migrate();
    adapter.migrate();
    const tables = adapter.db.$client
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'yorm_%'`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual([
      "yorm_document",
      "yorm_projection_state",
      "yorm_update",
    ]);
    adapter.close();
  });

  it("exports the system-table DDL", () => {
    expect(YORM_SQLITE_DDL).toHaveLength(3);
    expect(YORM_SQLITE_DDL.every((ddl) => ddl.includes("CREATE TABLE IF NOT EXISTS"))).toBe(true);
  });
});

describe("drizzleProjectionStore.listFailures", () => {
  it("lists only status-'error' states; a later successful plan clears them", async () => {
    const adapter = createSqliteAdapter();
    adapter.migrate();
    const checkpoint = {
      documentId: "c1",
      documentType: "Contact",
      mappingName: "contacts.Contact",
      mappingVersion: 1,
      sourceDocumentVersion: 3,
    };

    await adapter.projections.recordFailure(checkpoint, "kaboom");
    const failures = await adapter.projections.listFailures!();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      documentId: "c1",
      mappingName: "contacts.Contact",
      mappingVersion: 1,
      sourceDocumentVersion: 3,
      status: "error",
      error: "kaboom",
    });

    // A successful projection of the same (document, mapping) leaves quarantine.
    await adapter.projections.applyPlan({
      mapping: "contacts.Contact@1",
      documentId: "c1",
      documentType: "Contact",
      documentVersion: 4,
      origin: "replay",
      operations: [],
      checkpoint: { ...checkpoint, sourceDocumentVersion: 4 },
    });
    expect(await adapter.projections.listFailures!()).toEqual([]);
    adapter.close();
  });
});

describe("resolveBackend", () => {
  it("defaults to sqlite", () => {
    expect(resolveBackend()).toBe("sqlite");
    expect(resolveBackend("sqlite")).toBe("sqlite");
    expect(resolveBackend("SQLite")).toBe("sqlite");
  });

  it("names Milestone 9 for planned backends", () => {
    for (const backend of ["pglite", "postgres", "mariadb", "mongodb"]) {
      expect(() => resolveBackend(backend)).toThrow(/Milestone 9/);
    }
  });

  it("rejects unknown backends with the supported list", () => {
    expect(() => resolveBackend("oracle")).toThrow(/Unknown YORM_DB value "oracle"/);
  });
});
