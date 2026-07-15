/** In-memory fake stores shared by the runtime and orchestrator tests. */
import type {
  DocumentStore,
  DocumentUpdate,
  ProjectionCheckpoint,
  ProjectionPlan,
  ProjectionStateRecord,
  ProjectionStore,
  StoredDocument,
} from "@yorm/core";

export interface FakeDocumentStore extends DocumentStore {
  snapshots: Map<string, StoredDocument>;
  updates: DocumentUpdate[];
}

export function fakeDocumentStore(): FakeDocumentStore {
  const snapshots = new Map<string, StoredDocument>();
  const updates: DocumentUpdate[] = [];
  return {
    snapshots,
    updates,
    async loadDocument(type, id) {
      return snapshots.get(`${type}/${id}`) ?? null;
    },
    async saveSnapshot(doc) {
      snapshots.set(`${doc.documentType}/${doc.documentId}`, doc);
    },
    async appendUpdate(update) {
      updates.push(update);
    },
    async listUpdates(_type, id, sinceVersion = 0) {
      return updates.filter(
        (update) => update.documentId === id && update.documentVersion > sinceVersion,
      );
    },
    async listDocuments(type) {
      return [...snapshots.values()]
        .filter((doc) => doc.documentType === type)
        .map((doc) => ({ documentId: doc.documentId, documentType: doc.documentType }));
    },
  };
}

export interface FakeProjectionStore extends ProjectionStore {
  plans: ProjectionPlan[];
  failures: Array<{ checkpoint: ProjectionCheckpoint; error: string }>;
  /** Latest state per `${documentId}/${mappingName}` (ok on applyPlan, error on recordFailure). */
  states: Map<string, ProjectionStateRecord>;
  failNextWith(error: Error): void;
  listFailures(): Promise<ProjectionStateRecord[]>;
}

export function fakeProjectionStore(): FakeProjectionStore {
  const plans: ProjectionPlan[] = [];
  const failures: Array<{ checkpoint: ProjectionCheckpoint; error: string }> = [];
  const states = new Map<string, ProjectionStateRecord>();
  let failWith: Error | null = null;
  const stateKey = (documentId: string, mappingName: string): string =>
    `${documentId}/${mappingName}`;
  const record = (
    checkpoint: ProjectionCheckpoint,
    status: "ok" | "error",
    error?: string,
  ): void => {
    states.set(stateKey(checkpoint.documentId, checkpoint.mappingName), {
      documentId: checkpoint.documentId,
      mappingName: checkpoint.mappingName,
      mappingVersion: checkpoint.mappingVersion,
      sourceDocumentVersion: checkpoint.sourceDocumentVersion,
      status,
      projectedAt: new Date(),
      error: error ?? null,
    });
  };
  return {
    plans,
    failures,
    states,
    failNextWith(error) {
      failWith = error;
    },
    async applyPlan(plan) {
      if (failWith) {
        const error = failWith;
        failWith = null;
        throw error;
      }
      plans.push(plan);
      record(plan.checkpoint, "ok");
    },
    async getState(documentId, mappingName) {
      return states.get(stateKey(documentId, mappingName)) ?? null;
    },
    async recordFailure(checkpoint, error) {
      failures.push({ checkpoint, error });
      record(checkpoint, "error", error);
    },
    async listFailures() {
      return [...states.values()].filter((state) => state.status === "error");
    },
  };
}
