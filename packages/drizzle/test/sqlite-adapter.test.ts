/**
 * SQLite adapter tests: runs the shared adapter conformance suite against
 * `createSqliteAdapter(":memory:")`, plus `resolveBackend` plumbing tests.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { AdapterFactory } from "../src/conformance.js";
import { adapterConformanceTests } from "../src/conformance.js";
import type { ProjectionCommit } from "../src/projection-store/index.js";
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

describe("drizzleProjectionStore onCommit", () => {
  it("reports one commit per plan, carrying that plan's statements", async () => {
    const commits: ProjectionCommit[] = [];
    const adapter = createSqliteAdapter({ projections: { onCommit: (c) => commits.push(c) } });
    adapter.migrate();
    adapter.db.run(sql.raw(`CREATE TABLE contact (contact_id TEXT PRIMARY KEY, last TEXT)`));

    await adapter.projections.applyPlan({
      mapping: "contacts.Contact@1",
      documentId: "c1",
      documentType: "Contact",
      documentVersion: 7,
      origin: "yjs",
      operations: [
        {
          kind: "upsert",
          table: "contact",
          key: { contact_id: "c1" },
          values: { contact_id: "c1", last: "Chalmers" },
          ownedColumns: ["last"],
        },
      ],
      checkpoint: {
        documentId: "c1",
        documentType: "Contact",
        mappingName: "contacts.Contact",
        mappingVersion: 1,
        sourceDocumentVersion: 7,
      },
    });

    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ documentId: "c1", documentVersion: 7, origin: "yjs" });
    // The upsert plus the checkpoint advance, both from the one transaction.
    expect(commits[0]!.statements).toHaveLength(2);
    expect(commits[0]!.statements[0]).toMatchObject({
      sql: expect.stringContaining(`insert into "contact"`),
      params: ["c1", "Chalmers"],
    });
    expect(commits[0]!.statements[1]?.sql).toContain("yorm_projection_state");
    adapter.close();
  });

  it("reports nothing when the transaction throws", async () => {
    const commits: ProjectionCommit[] = [];
    const adapter = createSqliteAdapter({ projections: { onCommit: (c) => commits.push(c) } });
    adapter.migrate();

    await expect(
      adapter.projections.applyPlan({
        mapping: "contacts.Contact@1",
        documentId: "c1",
        documentType: "Contact",
        documentVersion: 1,
        origin: "yjs",
        operations: [
          {
            kind: "upsert",
            table: "missing_table",
            key: { contact_id: "c1" },
            values: { contact_id: "c1" },
            ownedColumns: [],
          },
        ],
        checkpoint: {
          documentId: "c1",
          documentType: "Contact",
          mappingName: "contacts.Contact",
          mappingVersion: 1,
          sourceDocumentVersion: 1,
        },
      }),
    ).rejects.toThrow();
    expect(commits).toEqual([]);
    adapter.close();
  });
});

describe("resolveBackend", () => {
  it("defaults to sqlite", () => {
    expect(resolveBackend()).toBe("sqlite");
    expect(resolveBackend("sqlite")).toBe("sqlite");
    expect(resolveBackend("SQLite")).toBe("sqlite");
  });

  it("resolves the mysql backend, mariadb included", () => {
    expect(resolveBackend("mysql")).toBe("mysql");
    expect(resolveBackend("MariaDB")).toBe("mysql");
  });

  it("names Milestone 9 for planned backends", () => {
    for (const backend of ["pglite", "postgres", "mongodb"]) {
      expect(() => resolveBackend(backend)).toThrow(/Milestone 9/);
    }
  });

  it("rejects unknown backends with the supported list", () => {
    expect(() => resolveBackend("oracle")).toThrow(/Unknown YORM_DB value "oracle"/);
  });
});
