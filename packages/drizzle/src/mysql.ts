/**
 * MySQL wire-up — the twin of `sqlite.ts` for deployments that project into
 * MySQL 8 or MariaDB (eCase, PLAN M9).
 *
 * `createMysqlAdapter` bundles an mysql2 pool, both stores, and a `migrate()`
 * that creates the `yorm_*` system tables. Unlike SQLite's, `migrate()` and
 * `close()` are asynchronous because the driver is.
 */
import { drizzle } from "drizzle-orm/mysql2";
import type { MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import type { DocumentStore, ProjectionStore } from "@yorm/core";
import { drizzleMysqlDocumentStore } from "./document-store/mysql.js";
import { drizzleMysqlProjectionStore } from "./projection-store/mysql.js";
import type { DrizzleProjectionStoreOptions } from "./projection-store/shared.js";

/** DDL for the YORM system tables (idempotent; exported for reuse in tests and tooling). */
export const YORM_MYSQL_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS yorm_document (
    document_id VARCHAR(191) NOT NULL,
    document_type VARCHAR(191) NOT NULL,
    encoded_state LONGBLOB NOT NULL,
    document_version INT NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (document_type, document_id)
  )`,
  `CREATE TABLE IF NOT EXISTS yorm_update (
    update_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    document_id VARCHAR(191) NOT NULL,
    document_type VARCHAR(191),
    document_version INT NOT NULL,
    encoded_update LONGBLOB NOT NULL,
    actor VARCHAR(191),
    origin VARCHAR(32) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    INDEX yorm_update_document (document_id, document_version)
  )`,
  `CREATE TABLE IF NOT EXISTS yorm_projection_state (
    document_id VARCHAR(191) NOT NULL,
    mapping_name VARCHAR(191) NOT NULL,
    mapping_version INT NOT NULL,
    source_document_version INT NOT NULL,
    status VARCHAR(8) NOT NULL,
    projected_at DATETIME(3) NOT NULL,
    error TEXT,
    PRIMARY KEY (document_id, mapping_name)
  )`,
];

export interface MysqlAdapterOptions {
  /** `mysql://user:pass@host:port/db`. Takes precedence over the discrete fields. */
  url?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** Forwarded to {@link drizzleMysqlProjectionStore}. */
  projections?: DrizzleProjectionStoreOptions;
}

export interface MysqlAdapter {
  db: MySql2Database;
  pool: mysql.Pool;
  documents: DocumentStore;
  projections: ProjectionStore;
  /** Creates the `yorm_*` system tables (CREATE TABLE IF NOT EXISTS). */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/** Creates a ready-to-use MySQL adapter (await `migrate()` before first use). */
export function createMysqlAdapter(options: MysqlAdapterOptions): MysqlAdapter {
  // Dates are stored as DATETIME(3) and read back as UTC strings by Drizzle, so
  // the pool must not re-interpret them in the server's local zone.
  const connection = options.url
    ? { uri: options.url, timezone: "Z" }
    : {
        host: options.host ?? "127.0.0.1",
        port: options.port ?? 3306,
        user: options.user ?? "root",
        password: options.password ?? "",
        database: options.database ?? "yorm",
        timezone: "Z",
      };
  const pool = mysql.createPool({ ...connection, multipleStatements: false });
  const db = drizzle(pool);
  return {
    db,
    pool,
    documents: drizzleMysqlDocumentStore(db),
    projections: drizzleMysqlProjectionStore(db, options.projections),
    async migrate() {
      for (const ddl of YORM_MYSQL_DDL) await pool.query(ddl);
    },
    async close() {
      await pool.end();
    },
  };
}
