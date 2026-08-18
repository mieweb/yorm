/**
 * @yorm/drizzle — Drizzle document and projection stores (Milestone 4).
 *
 * SQLite (better-sqlite3) is the vertical-slice backend and MySQL 8 (mysql2)
 * is the first M9 backend; the adapter conformance suite ships here so further
 * backends only add wire-up. See packages/drizzle/README.md.
 */
export const YORM_DRIZZLE_VERSION = "0.1.0";

export * from "./schema.js";
export * from "./schema-mysql.js";
export * from "./document-store/index.js";
export * from "./document-store/mysql.js";
export * from "./projection-store/index.js";
export * from "./projection-store/mysql.js";
export * from "./conformance.js";
export * from "./sqlite.js";
export * from "./mysql.js";
