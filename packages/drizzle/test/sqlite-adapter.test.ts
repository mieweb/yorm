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
