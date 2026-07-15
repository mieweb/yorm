/**
 * Provenance — where a document update or projection plan originated.
 *
 * Every plan and persisted update carries an {@link Origin} so replays,
 * migrations, and reverse-sync loops can be told apart from live edits.
 */

/**
 * Origin of a change:
 * - `yjs` — a live CRDT edit (browser or service)
 * - `sql` — a reverse-mapped database change (outbox)
 * - `replay` — reprojection of existing documents (e.g. new mapping version)
 * - `projection` — produced by the projection engine itself
 * - `migration` — a schema or mapping migration
 * - `external-import` — bulk ingestion from another system
 * - `repair` — manual or automated consistency repair
 */
export type Origin =
  "yjs" | "sql" | "replay" | "projection" | "migration" | "external-import" | "repair";
