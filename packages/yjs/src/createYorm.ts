/**
 * Orchestrator — wires the runtime, stores, codecs, mappings, and the
 * projection scheduler into document sessions.
 *
 * Inline projection mode only: when the scheduler fires, the document is
 * materialized via its codec, `planProjection` runs for every mapping of the
 * document type, and each plan is applied to the {@link ProjectionStore}.
 */
import { planProjection } from "@yorm/core";
import type { DocumentStore, Mapping, Origin, ProjectionStore } from "@yorm/core";
import type * as Y from "yjs";

import type { DocumentCodec } from "./codecs/json.js";
import { jsonCodec } from "./codecs/json.js";
import type { ChangeIntent, ProposalsApi } from "./proposals/index.js";
import { isProposalTrackingMapping, proposalsApi, readProposals } from "./proposals/index.js";
import type { ManagedDocument, MemoryRuntime } from "./runtime/memory.js";
import type { ProjectionTriggerPolicy } from "./scheduler/policy.js";
import { ProjectionScheduler } from "./scheduler/policy.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mappings for heterogeneous document types cannot share one object type
export type AnyMapping = Mapping<any>;

export interface YormOptions {
  runtime: MemoryRuntime;
  documents: DocumentStore;
  projections: ProjectionStore;
  /** Matched to documents by `documentType`. */
  mappings: AnyMapping[];
  /** Per-documentType codec; defaults to `jsonCodec()`. */
  codecs?: Record<string, DocumentCodec<unknown>>;
  projectionPolicy?: { default?: ProjectionTriggerPolicy; maxLagMs?: number };
}

/** A handle on one open canonical document. */
export interface DocumentSession {
  doc: Y.Doc;
  type: string;
  id: string;
  /** Materializes the current object via the codec. */
  read(): unknown;
  /** Semantic replace via the codec; resolves after any triggered projection settles. */
  write(value: unknown): Promise<void>;
  setPolicy(p: ProjectionTriggerPolicy): void;
  signal(kind: "blur" | "flush"): Promise<void>;
  projectionState(): {
    pending: { from: number; to: number } | null;
    version: number;
    lastError?: string;
  };
  /** Applies a remote update. Origin defaults to `"yjs"`. */
  applyUpdate(update: Uint8Array, origin?: Origin, actor?: string): void;
  /** Fan-out of every persisted update (transport hook). */
  subscribe(listener: (update: Uint8Array) => void): () => void;
  /**
   * Suggestion-mode API over the document's `yorm:proposals` subtree
   * (PLAN.md M7). Shared per document, wired with the session's version.
   * The codec/projection path is untouched: proposals never reach canonical
   * projections until accepted.
   */
  proposals(): ProposalsApi;
  close(): void;
}

export interface Yorm {
  open(type: string, id: string): Promise<DocumentSession>;
  mappings: AnyMapping[];
  codecFor(type: string): DocumentCodec<unknown>;
  stores: { documents: DocumentStore; projections: ProjectionStore };
}

/** Shared per-document state behind one or more sessions. */
interface DocumentChannel {
  managed: ManagedDocument;
  scheduler: ProjectionScheduler;
  proposals: ProposalsApi;
  unsubscribe: () => void;
  sessions: number;
}

/**
 * Creates a {@link Yorm} orchestrator.
 *
 * v1 simplification (documented per PLAN.md M2): the scheduler is
 * **per document**, shared by all sessions on that document — `setPolicy`
 * from any session switches the document's policy. True per-session policies
 * arrive with the transport layer.
 */
export function createYorm(opts: YormOptions): Yorm {
  opts.runtime.setDocumentStore(opts.documents);
  const defaultCodec = jsonCodec();
  const channels = new Map<string, Promise<DocumentChannel>>();

  const codecFor = (type: string): DocumentCodec<unknown> => opts.codecs?.[type] ?? defaultCodec;

  async function createChannel(type: string, id: string): Promise<DocumentChannel> {
    const managed = await opts.runtime.openDocument(type, id);
    const mappings = opts.mappings.filter((mapping) => mapping.documentType === type);
    const codec = codecFor(type);
    /** Origin of the latest triggering update, passed through to plans. */
    const provenance = { lastOrigin: "yjs" as Origin };
    const scheduler = new ProjectionScheduler({
      ...(opts.projectionPolicy?.default !== undefined
        ? { defaultPolicy: opts.projectionPolicy.default }
        : {}),
      ...(opts.projectionPolicy?.maxLagMs !== undefined
        ? { maxLagMs: opts.projectionPolicy.maxLagMs }
        : {}),
      onProject: async (latestVersion: number): Promise<void> => {
        const object = codec.read(managed.doc);
        /** Lazily materialized proposals subtree for tracking mappings (7b). */
        let proposalIntents: ChangeIntent[] | undefined;
        for (const mapping of mappings) {
          // The tracking mapping projects the proposals subtree, not the
          // codec output — the codec only ever reads the canonical subtree.
          const mappingObject = isProposalTrackingMapping(mapping)
            ? (proposalIntents ??= readProposals(managed.doc))
            : object;
          const plan = planProjection(mapping, {
            object: mappingObject,
            documentId: id,
            documentVersion: latestVersion,
            origin: provenance.lastOrigin,
          });
          try {
            await opts.projections.applyPlan(plan);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await opts.projections.recordFailure(plan.checkpoint, message);
            throw error; // scheduler keeps the pending range and exposes lastError
          }
        }
      },
    });
    const unsubscribe = managed.subscribe((_update, meta) => {
      provenance.lastOrigin = meta.origin;
      scheduler.notifyChange(meta.version);
    });
    const proposals = proposalsApi(managed.doc, { version: () => managed.version });
    return { managed, scheduler, proposals, unsubscribe, sessions: 0 };
  }

  function getChannel(type: string, id: string): Promise<DocumentChannel> {
    const key = `${type}/${id}`;
    let pending = channels.get(key);
    if (!pending) {
      pending = createChannel(type, id);
      channels.set(key, pending);
    }
    return pending;
  }

  return {
    mappings: opts.mappings,
    codecFor,
    stores: { documents: opts.documents, projections: opts.projections },
    async open(type: string, id: string): Promise<DocumentSession> {
      const key = `${type}/${id}`;
      const channel = await getChannel(type, id);
      const codec = codecFor(type);
      channel.sessions += 1;
      let closed = false;
      return {
        doc: channel.managed.doc,
        type,
        id,
        read: () => codec.read(channel.managed.doc),
        async write(value: unknown): Promise<void> {
          codec.write(channel.managed.doc, value);
          await channel.scheduler.settle();
        },
        setPolicy: (p) => channel.scheduler.setPolicy(p),
        signal: (kind) => channel.scheduler.signal(kind),
        projectionState: () => ({
          pending: channel.scheduler.pendingVersions(),
          version: channel.managed.version,
          lastError: channel.scheduler.lastError,
        }),
        applyUpdate: (update, origin = "yjs", actor) =>
          channel.managed.applyUpdate(update, origin, actor),
        subscribe: (listener) => channel.managed.subscribe((update) => listener(update)),
        proposals: () => channel.proposals,
        close(): void {
          if (closed) {
            return;
          }
          closed = true;
          channel.sessions -= 1;
          if (channel.sessions === 0) {
            channel.unsubscribe();
            channel.scheduler.dispose();
            channels.delete(key);
          }
        },
      };
    },
  };
}
