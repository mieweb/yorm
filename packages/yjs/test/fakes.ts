/** In-memory fake stores shared by the runtime and orchestrator tests. */
import type {
  DocumentStore,
  DocumentUpdate,
  ProjectionCheckpoint,
  ProjectionPlan,
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
  failNextWith(error: Error): void;
}

export function fakeProjectionStore(): FakeProjectionStore {
  const plans: ProjectionPlan[] = [];
  const failures: Array<{ checkpoint: ProjectionCheckpoint; error: string }> = [];
  let failWith: Error | null = null;
  return {
    plans,
    failures,
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
    },
    async getState() {
      return null;
    },
    async recordFailure(checkpoint, error) {
      failures.push({ checkpoint, error });
    },
  };
}
