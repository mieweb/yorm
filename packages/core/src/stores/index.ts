/**
 * Store contracts — the persistence interfaces the rest of YORM programs
 * against. Core defines the contracts only; adapters (e.g. `@yorm/drizzle`)
 * implement them.
 */
import type { ProjectionCheckpoint, ProjectionPlan } from "../planner/index.js";
import type { Origin } from "../provenance/index.js";

/** A persisted canonical document snapshot (encoded Yjs state). */
export interface StoredDocument {
  documentId: string;
  documentType: string;
  /** Encoded Yjs document state (opaque to core). */
  encodedState: Uint8Array;
  /** Monotonically increasing version, bumped per persisted update. */
  documentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One persisted incremental document update. */
export interface DocumentUpdate {
  documentId: string;
  /** The document version this update produced. */
  documentVersion: number;
  /** Encoded incremental Yjs update (opaque to core). */
  encodedUpdate: Uint8Array;
  /** Where the change came from. */
  origin: Origin;
  /** Optional actor (user/service) responsible for the change. */
  actor?: string;
  createdAt: Date;
}

/** Persistence for canonical documents: snapshots plus an update log. */
export interface DocumentStore {
  /** Loads the latest snapshot, or `null` if the document does not exist. */
  loadDocument(type: string, id: string): Promise<StoredDocument | null>;
  /** Persists (creates or replaces) a document snapshot. */
  saveSnapshot(doc: StoredDocument): Promise<void>;
  /** Appends one incremental update to the document's log. */
  appendUpdate(update: DocumentUpdate): Promise<void>;
  /** Lists updates for a document, optionally only those after `sinceVersion`. */
  listUpdates(type: string, id: string, sinceVersion?: number): Promise<DocumentUpdate[]>;
  /** Lists all documents of a type (for replay and migration). */
  listDocuments(type: string): Promise<Array<{ documentId: string; documentType: string }>>;
}

/** Per-document, per-mapping projection status. */
export interface ProjectionStateRecord {
  documentId: string;
  mappingName: string;
  mappingVersion: number;
  /** The document version the projection tables currently reflect. */
  sourceDocumentVersion: number;
  status: "ok" | "error";
  projectedAt: Date;
  error?: string | null;
}

/** Applies projection plans to relational tables and tracks checkpoints. */
export interface ProjectionStore {
  /**
   * Applies every operation of the plan and advances the plan's checkpoint.
   *
   * MUST be transactional: either all upserts, reconciliation deletes, and
   * the checkpoint advance commit together, or none do. A partially applied
   * plan must never be observable.
   */
  applyPlan(plan: ProjectionPlan): Promise<void>;
  /** Reads the current projection state, or `null` if never projected. */
  getState(documentId: string, mappingName: string): Promise<ProjectionStateRecord | null>;
  /** Records a failed projection attempt without touching projection tables. */
  recordFailure(checkpoint: ProjectionCheckpoint, error: string): Promise<void>;
  /**
   * OPTIONAL: lists every projection state with `status: "error"` (the
   * quarantine set that `retryFailedProjections` in `@yorm/yjs` re-runs).
   * Backwards-compatible optional member — adapters that predate it keep
   * working; helpers that need it must check for support.
   */
  listFailures?(): Promise<ProjectionStateRecord[]>;
}

/**
 * Owns live documents (e.g. active `Y.Doc` instances). Opaque to core: the
 * concrete runtime (see `@yorm/yjs`) defines what an open document is.
 */
export interface Runtime {
  openDocument(type: string, id: string): Promise<unknown>;
}
