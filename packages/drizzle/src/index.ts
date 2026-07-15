/**
 * @yorm/drizzle — Drizzle document and projection stores (Milestone 4).
 *
 * SQLite (better-sqlite3) is the vertical-slice backend; the adapter
 * conformance suite ships here so M9 backends only add wire-up.
 * See packages/drizzle/README.md.
 */
export const YORM_DRIZZLE_VERSION = "0.1.0";

export * from "./schema.js";
export * from "./document-store/index.js";
export * from "./projection-store/index.js";
export * from "./conformance.js";
export * from "./sqlite.js";
