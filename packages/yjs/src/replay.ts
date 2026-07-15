/**
 * Mapping replay — rebuild projections from stored documents (PLAN.md M8).
 *
 * `replayProjections` walks `DocumentStore.listDocuments` per mapping
 * document type, loads each stored snapshot into a **fresh** `Y.Doc`,
 * materializes it via the document's codec (or the proposals subtree for
 * tracking mappings), plans with origin `"replay"`, and applies the plan via
 * `ProjectionStore.applyPlan`. Failures are recorded with `recordFailure`
 * and collected in the result; by default a failing document does not stop
 * the run.
 *
 * `retryFailedProjections` is the targeted variant: it re-runs only the
 * documents/mappings whose projection state is `status: "error"`, using the
 * store's optional `listFailures()`.
 */
import * as Y from "yjs";
import { planProjection } from "@yorm/core";
import type { ProjectionCheckpoint } from "@yorm/core";

import type { AnyMapping, Yorm } from "./createYorm.js";
import { isProposalTrackingMapping, readProposals } from "./proposals/index.js";

export interface ReplayOptions {
  /** Restrict the replay to one document type (default: every mapped type). */
  documentType?: string;
  /**
   * Failure policy. `"record-and-continue"` (default) records the failure
   * (result + `recordFailure`) and moves to the next document; `"throw"`
   * records it and then rethrows, aborting the run.
   */
  onError?: "record-and-continue" | "throw";
}

export interface ReplayResult {
  /** Documents processed (per document, not per mapping). */
  attempted: number;
  /** Documents whose every mapping plan applied successfully. */
  succeeded: number;
  failed: Array<{ documentId: string; error: string }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Replays one stored document through `mappings`, updating `result`.
 * Skips to the next document on failure unless `onError` is `"throw"`.
 */
async function replayDocument(
  yorm: Yorm,
  documentType: string,
  documentId: string,
  mappings: AnyMapping[],
  result: ReplayResult,
  onError: "record-and-continue" | "throw",
): Promise<void> {
  result.attempted += 1;
  const { documents, projections } = yorm.stores;
  let doc: Y.Doc | undefined;
  try {
    const stored = await documents.loadDocument(documentType, documentId);
    if (!stored) {
      throw new Error(`document not found: ${documentType}/${documentId}`);
    }
    const fresh = new Y.Doc();
    doc = fresh;
    Y.applyUpdate(fresh, stored.encodedState);
    const codec = yorm.codecFor(documentType);
    // The canonical object is materialized at most once per document.
    let canonical: unknown;
    let hasCanonical = false;
    const canonicalObject = (): unknown => {
      if (!hasCanonical) {
        canonical = codec.read(fresh);
        hasCanonical = true;
      }
      return canonical;
    };
    for (const mapping of mappings) {
      const checkpoint: ProjectionCheckpoint = {
        documentId,
        documentType,
        mappingName: mapping.name,
        mappingVersion: mapping.version,
        sourceDocumentVersion: stored.documentVersion,
      };
      try {
        // Tracking mappings project the proposals subtree, never the codec
        // output — mirrors the orchestrator's onProject branch.
        const object = isProposalTrackingMapping(mapping)
          ? readProposals(fresh)
          : canonicalObject();
        const plan = planProjection(mapping, {
          object,
          documentId,
          documentVersion: stored.documentVersion,
          origin: "replay",
        });
        await projections.applyPlan(plan);
      } catch (error) {
        await projections.recordFailure(checkpoint, errorMessage(error));
        throw error;
      }
    }
    result.succeeded += 1;
  } catch (error) {
    result.failed.push({ documentId, error: errorMessage(error) });
    if (onError === "throw") {
      throw error;
    }
  } finally {
    doc?.destroy();
  }
}

/**
 * Rebuilds projections for every stored document covered by the Yorm's
 * mappings (README "replay and repair": new table / new mapping version /
 * repair / disaster recovery). Plans carry origin `"replay"`.
 */
export async function replayProjections(
  yorm: Yorm,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const onError = opts.onError ?? "record-and-continue";
  const result: ReplayResult = { attempted: 0, succeeded: 0, failed: [] };
  const byType = new Map<string, AnyMapping[]>();
  for (const mapping of yorm.mappings) {
    if (opts.documentType !== undefined && mapping.documentType !== opts.documentType) {
      continue;
    }
    const list = byType.get(mapping.documentType) ?? [];
    list.push(mapping);
    byType.set(mapping.documentType, list);
  }
  for (const [documentType, mappings] of byType) {
    const docs = await yorm.stores.documents.listDocuments(documentType);
    for (const { documentId } of docs) {
      await replayDocument(yorm, documentType, documentId, mappings, result, onError);
    }
  }
  return result;
}

/**
 * Re-runs only the projections whose state is `status: "error"` — the
 * quarantine set. Requires the ProjectionStore's optional `listFailures()`
 * (implemented by `@yorm/drizzle`); throws a clear error otherwise.
 */
export async function retryFailedProjections(
  yorm: Yorm,
  opts: Pick<ReplayOptions, "onError"> = {},
): Promise<ReplayResult> {
  const { projections } = yorm.stores;
  if (typeof projections.listFailures !== "function") {
    throw new Error(
      "retryFailedProjections: this ProjectionStore does not implement the optional listFailures(); " +
        "cannot enumerate failed projections (use replayProjections for a full rebuild)",
    );
  }
  const onError = opts.onError ?? "record-and-continue";
  const result: ReplayResult = { attempted: 0, succeeded: 0, failed: [] };
  const failures = await projections.listFailures();
  for (const failure of failures) {
    const mapping = yorm.mappings.find((candidate) => candidate.name === failure.mappingName);
    if (!mapping) {
      result.attempted += 1;
      const error = `mapping "${failure.mappingName}" is not registered with this Yorm`;
      result.failed.push({ documentId: failure.documentId, error });
      if (onError === "throw") {
        throw new Error(error);
      }
      continue;
    }
    await replayDocument(
      yorm,
      mapping.documentType,
      failure.documentId,
      [mapping],
      result,
      onError,
    );
  }
  return result;
}
