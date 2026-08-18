/**
 * The adapter conformance suite against MySQL 8.
 *
 * MySQL needs a live server, so the suite runs only when `YORM_MYSQL_URL`
 * points at one:
 *
 *   YORM_MYSQL_URL=mysql://user:pass@127.0.0.1:3306/mysql pnpm test:adapters
 *
 * The account needs CREATE/DROP DATABASE: each test gets a fresh schema
 * (`yorm_conf_<pid>_<n>`) so runs never share state.
 */
import { beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import type { AdapterFactory } from "../src/conformance.js";
import { adapterConformanceTests } from "../src/conformance.js";
import { createMysqlAdapter, YORM_MYSQL_DDL } from "../src/mysql.js";

const url = process.env.YORM_MYSQL_URL;

/** The SQLite sample DDL retyped for MySQL: TEXT cannot carry a primary key. */
const MYSQL_SAMPLE_DDL = [
  `CREATE TABLE IF NOT EXISTS sample_root (
    document_id VARCHAR(191) PRIMARY KEY,
    full_name TEXT,
    nickname TEXT,
    note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sample_child (
    document_id VARCHAR(191) NOT NULL,
    element_id VARCHAR(191) NOT NULL,
    property TEXT,
    value TEXT,
    PRIMARY KEY (document_id, element_id)
  )`,
];

let schemaCounter = 0;

const factory: AdapterFactory = {
  name: "mysql (mysql2)",
  sampleDdl: MYSQL_SAMPLE_DDL,
  async create() {
    const schema = `yorm_conf_${process.pid}_${schemaCounter++}`;
    const admin = await mysql.createConnection(url!);
    await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    await admin.query(`CREATE DATABASE \`${schema}\``);
    await admin.end();

    const adapter = createMysqlAdapter({ url: new URL(`/${schema}`, url!).toString() });
    await adapter.migrate();
    return {
      documents: adapter.documents,
      projections: adapter.projections,
      async queryRows(table: string) {
        const [rows] = await adapter.pool.query(`SELECT * FROM \`${table}\``);
        return rows as Record<string, unknown>[];
      },
      async setup(statements: string[]) {
        for (const statement of statements) await adapter.pool.query(statement);
      },
      async close() {
        await adapter.close();
        const cleanup = await mysql.createConnection(url!);
        await cleanup.query(`DROP DATABASE IF EXISTS \`${schema}\``);
        await cleanup.end();
      },
    };
  },
};

if (url) {
  adapterConformanceTests(factory, { describe, it, expect, beforeEach });
} else {
  describe.skip("adapter conformance: mysql (mysql2) — set YORM_MYSQL_URL to run", () => {
    it("is skipped", () => {});
  });
}

describe("YORM_MYSQL_DDL", () => {
  it("creates the three system tables", () => {
    expect(YORM_MYSQL_DDL).toHaveLength(3);
  });
});
