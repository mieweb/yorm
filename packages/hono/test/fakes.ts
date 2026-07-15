/**
 * In-memory fake stores for the plugin tests — a local copy of the pattern
 * from packages/yjs/test/fakes.ts (tests must not import across package test
 * directories).
 */
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
  states: Map<string, ProjectionStateRecord>;
}

export function fakeProjectionStore(): FakeProjectionStore {
  const plans: ProjectionPlan[] = [];
  const failures: Array<{ checkpoint: ProjectionCheckpoint; error: string }> = [];
  const states = new Map<string, ProjectionStateRecord>();
  return {
    plans,
    failures,
    states,
    async applyPlan(plan) {
      plans.push(plan);
      states.set(`${plan.documentId}/${plan.mapping}`, {
        documentId: plan.documentId,
        mappingName: plan.checkpoint.mappingName,
        mappingVersion: plan.checkpoint.mappingVersion,
        sourceDocumentVersion: plan.documentVersion,
        status: "ok",
        projectedAt: new Date(),
      });
    },
    async getState(documentId, mappingName) {
      for (const state of states.values()) {
        if (state.documentId === documentId && state.mappingName === mappingName) {
          return state;
        }
      }
      return null;
    },
    async recordFailure(checkpoint, error) {
      failures.push({ checkpoint, error });
    },
  };
}

/** Polls `cond` (sync or async) until it holds or `timeoutMs` elapses (then throws `label`). */
export async function until(
  cond: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
