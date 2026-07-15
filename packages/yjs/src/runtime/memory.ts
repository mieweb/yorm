/**
 * Memory runtime — owns active `Y.Doc` instances, persists every update,
 * and fans updates out to subscribers (the transport hook `@yorm/hono`
 * builds on).
 */
import * as Y from "yjs";
import type { DocumentStore, DocumentUpdate, Origin, Runtime, StoredDocument } from "@yorm/core";

/** Metadata delivered with every fanned-out update. */
export interface UpdateMeta {
  origin: Origin;
  actor?: string;
  /** The document version this update produced. */
  version: number;
}

export type ManagedDocumentListener = (update: Uint8Array, meta: UpdateMeta) => void;

/** A live document owned by the runtime. */
export interface ManagedDocument {
  readonly doc: Y.Doc;
  readonly type: string;
  readonly id: string;
  /** Monotonic version, bumped once per persisted update. */
  readonly version: number;
  /** Applies a remote update (e.g. from a transport) with provenance. */
  applyUpdate(update: Uint8Array, origin: Origin, actor?: string): void;
  /** Full encoded document state. */
  encodeState(): Uint8Array;
  /** Fan-out: every persisted update (local or remote) reaches listeners. */
  subscribe(listener: ManagedDocumentListener): () => void;
  /** Resolves once all persistence writes issued so far have settled. */
  whenPersisted(): Promise<void>;
}

/** In-memory {@link Runtime} implementation. */
export interface MemoryRuntime extends Runtime {
  openDocument(type: string, id: string): Promise<ManagedDocument>;
  /** Wires the store used to load/persist documents (set by `createYorm`). */
  setDocumentStore(store: DocumentStore): void;
  /** Destroys the live doc and drops it from the cache. */
  closeDocument(type: string, id: string): void;
  /** Closes every open document. */
  dispose(): void;
}

export interface MemoryRuntimeOptions {
  documents?: DocumentStore;
}

/** Transaction-origin marker carrying provenance through Yjs. */
interface YormTxOrigin {
  yormOrigin: Origin;
  actor?: string;
}

function isYormTxOrigin(value: unknown): value is YormTxOrigin {
  return typeof value === "object" && value !== null && "yormOrigin" in value;
}

/** Transaction origin used when replaying stored state — no version bump, no persist. */
const LOAD_ORIGIN = Symbol("yorm-load");

class ManagedDoc implements ManagedDocument {
  readonly doc = new Y.Doc();
  private _version = 0;
  private readonly listeners = new Set<ManagedDocumentListener>();
  private persistence: Promise<void> = Promise.resolve();
  /** Message of the most recent failed persistence write, if any. */
  lastPersistError: string | undefined;

  constructor(
    readonly type: string,
    readonly id: string,
    private readonly getStore: () => DocumentStore | undefined,
  ) {
    this.doc.on("update", (update: Uint8Array, txOrigin: unknown) => {
      this.handleUpdate(update, txOrigin);
    });
  }

  get version(): number {
    return this._version;
  }

  /** Replays the latest stored snapshot, if the document exists. */
  async load(): Promise<void> {
    const store = this.getStore();
    if (!store) {
      return;
    }
    const stored = await store.loadDocument(this.type, this.id);
    if (!stored) {
      return;
    }
    Y.applyUpdate(this.doc, stored.encodedState, LOAD_ORIGIN);
    this._version = stored.documentVersion;
  }

  applyUpdate(update: Uint8Array, origin: Origin, actor?: string): void {
    const txOrigin: YormTxOrigin = { yormOrigin: origin };
    if (actor !== undefined) {
      txOrigin.actor = actor;
    }
    Y.applyUpdate(this.doc, update, txOrigin);
  }

  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  subscribe(listener: ManagedDocumentListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  whenPersisted(): Promise<void> {
    return this.persistence;
  }

  /** Local transactions and remote applyUpdate land here identically. */
  private handleUpdate(update: Uint8Array, txOrigin: unknown): void {
    if (txOrigin === LOAD_ORIGIN) {
      return;
    }
    const meta: UpdateMeta = isYormTxOrigin(txOrigin)
      ? {
          origin: txOrigin.yormOrigin,
          ...(txOrigin.actor !== undefined ? { actor: txOrigin.actor } : {}),
          version: 0,
        }
      : { origin: "yjs", version: 0 };
    this._version += 1;
    meta.version = this._version;
    this.persist(update, meta);
    for (const listener of [...this.listeners]) {
      listener(update, meta);
    }
  }

  private persist(update: Uint8Array, meta: UpdateMeta): void {
    const store = this.getStore();
    if (!store) {
      return;
    }
    const now = new Date();
    const documentUpdate: DocumentUpdate = {
      documentId: this.id,
      documentVersion: meta.version,
      encodedUpdate: update,
      origin: meta.origin,
      ...(meta.actor !== undefined ? { actor: meta.actor } : {}),
      createdAt: now,
    };
    const snapshot: StoredDocument = {
      documentId: this.id,
      documentType: this.type,
      encodedState: Y.encodeStateAsUpdate(this.doc),
      documentVersion: meta.version,
      createdAt: now,
      updatedAt: now,
    };
    this.persistence = this.persistence
      .then(() => store.appendUpdate(documentUpdate))
      .then(() => store.saveSnapshot(snapshot))
      .catch((error: unknown) => {
        this.lastPersistError = error instanceof Error ? error.message : String(error);
      });
  }
}

/**
 * Creates an in-memory runtime. Documents are cached per `${type}/${id}`;
 * opening the same document twice returns the same instance. When a
 * {@link DocumentStore} is configured, existing state is loaded on open and
 * every update is persisted (append + snapshot).
 */
export function memoryRuntime(options: MemoryRuntimeOptions = {}): MemoryRuntime {
  let store = options.documents;
  const docs = new Map<string, Promise<ManagedDoc>>();
  const key = (type: string, id: string): string => `${type}/${id}`;
  return {
    setDocumentStore(next: DocumentStore): void {
      store = next;
    },
    openDocument(type: string, id: string): Promise<ManagedDocument> {
      const k = key(type, id);
      let pending = docs.get(k);
      if (!pending) {
        const managed = new ManagedDoc(type, id, () => store);
        pending = managed.load().then(() => managed);
        docs.set(k, pending);
      }
      return pending;
    },
    closeDocument(type: string, id: string): void {
      const k = key(type, id);
      const pending = docs.get(k);
      docs.delete(k);
      void pending?.then((managed) => managed.doc.destroy());
    },
    dispose(): void {
      for (const pending of docs.values()) {
        void pending.then((managed) => managed.doc.destroy());
      }
      docs.clear();
    },
  };
}
