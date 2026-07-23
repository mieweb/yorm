/**
 * Role policies ("policy lens", role-security POC) — developer-defined,
 * per-role protections over a canonical document, analogous to how a
 * `Mapping` projects a document into SQL rows:
 *
 * - **read redaction**: `view` projects the canonical object into what the
 *   role may see. The lens maintains a *derived* `Y.Doc` holding only that
 *   view; clients sync the derived doc with a plain Yjs provider and never
 *   receive hidden data. (Filtering the raw update stream of the canonical
 *   doc is impossible — CRDT updates reference each other by clock position,
 *   so a redacted view cannot share CRDT identity with the canonical doc.)
 * - **write protection**: `canWrite` validates every semantic change a
 *   client attempts through the lens (before/after of the *view*). Allowed
 *   changes are merged back onto the canonical object via `mergeWrite` and
 *   written through the normal session path (projections, persistence and
 *   other lenses all see the change). Denied changes never touch any doc.
 *
 * v1 tradeoffs (documented, same family as `guardCanonicalWrites`):
 * - every client update pays an encode + double-apply on a scratch doc for
 *   validation, and the lens view is rebuilt (clear + rebuild, the v1 JSON
 *   codec semantics) when the visible JSON changes;
 * - write-back is JSON-level, so concurrent canonical edits to the *same
 *   visible section* resolve last-writer-wins at the section level;
 * - a denied update is refused as a whole.
 */
import * as Y from "yjs";

import type { DocumentCodec } from "../codecs/json.js";
import { DEFAULT_ROOT_KEY, jsonCodec } from "../codecs/json.js";

/** Identifies the document (and role) a lens instance serves. */
export interface RolePolicyContext {
  role: string;
  documentType: string;
  documentId: string;
}

/** Semantic before/after of the role's *view* (plain JSON). */
export interface ViewChange {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * A developer-defined protection for one role over one document type.
 * Secure by default: a role **with** a policy can only see what `view`
 * returns and only write what `canWrite` allows (absent `canWrite` means
 * the lens is read-only). Roles **without** a policy are untouched by the
 * lens layer entirely.
 */
export interface RolePolicy<T = unknown> {
  role: string;
  documentType: string;
  /**
   * Outbound redaction: canonical object → what the role may see. Must be
   * deterministic and return a plain object. Absent means full visibility.
   */
  view?: (object: T, ctx: RolePolicyContext) => Record<string, unknown>;
  /**
   * Inbound guard: may this role turn the view `before` into `after`?
   * Absent means the lens is read-only.
   */
  canWrite?: (change: ViewChange, ctx: RolePolicyContext) => boolean;
  /**
   * Translates an allowed view change back onto the canonical object.
   * Defaults to a top-level key merge: keys present in `after` overwrite
   * the canonical keys, keys removed from the view are deleted.
   */
  mergeWrite?: (canonical: T, change: ViewChange, ctx: RolePolicyContext) => T;
}

/** Identity helper so policy literals get `T` inference and doc comments. */
export function defineRolePolicy<T>(policy: RolePolicy<T>): RolePolicy<T> {
  return policy;
}

/** Finds the policy for a (documentType, role) pair; `null` means no lens. */
export function policyFor(
  policies: readonly RolePolicy[] | undefined,
  documentType: string,
  role: string | undefined,
): RolePolicy | null {
  if (!policies || role === undefined) {
    return null;
  }
  return policies.find((p) => p.documentType === documentType && p.role === role) ?? null;
}

/** The slice of a `DocumentSession` the lens needs (structural subset). */
export interface PolicyLensSession {
  read(): unknown;
  write(value: unknown): Promise<void>;
  subscribe(listener: (update: Uint8Array) => void): () => void;
}

export type LensWriteResult = { allowed: true } | { allowed: false; reason: string };

/** A server-held derived doc for one (document, role) pair. */
export interface PolicyLens {
  /** The derived doc clients of this role sync against. */
  doc: Y.Doc;
  /**
   * Validates and applies one client update. Allowed updates are applied to
   * the lens doc synchronously (so same-role fan-out can exclude the origin
   * socket) and queued for canonical write-back; denied updates touch
   * nothing. Semantic no-ops are applied without consulting `canWrite`.
   */
  applyClientUpdate(update: Uint8Array): LensWriteResult;
  /** Fan-out of every lens-doc update (fires synchronously on apply). */
  subscribe(listener: (update: Uint8Array) => void): () => void;
  /** Resolves when all queued canonical write-backs have settled. */
  settle(): Promise<void>;
  /** Last canonical write-back error, if any (the lens keeps serving). */
  lastError: string | undefined;
  close(): void;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Default `mergeWrite`: top-level key merge of the view change. */
function defaultMergeWrite(
  canonical: unknown,
  change: ViewChange,
): Record<string, unknown> {
  const result = { ...(canonical as Record<string, unknown>) };
  for (const key of Object.keys(change.before)) {
    if (!(key in change.after)) {
      delete result[key];
    }
  }
  return Object.assign(result, change.after);
}

/**
 * Creates the policy lens for one (document, role): a derived `Y.Doc` kept
 * in sync with `view(canonical)` plus the validated write-back path.
 */
export function createPolicyLens(
  session: PolicyLensSession,
  policy: RolePolicy,
  ctx: RolePolicyContext,
  rootKey: string = DEFAULT_ROOT_KEY,
): PolicyLens {
  const codec: DocumentCodec<Record<string, unknown>> = jsonCodec(rootKey);
  const doc = new Y.Doc();
  let writeQueue: Promise<void> = Promise.resolve();
  let lastError: string | undefined;

  const viewOf = (): Record<string, unknown> => {
    const object = session.read();
    return policy.view ? policy.view(object, ctx) : (object as Record<string, unknown>);
  };

  /** Rebuilds the lens doc when the visible JSON changed (loop-safe). */
  const refresh = (): void => {
    const next = viewOf();
    if (json(next) !== json(codec.read(doc))) {
      codec.write(doc, next);
    }
  };
  refresh();
  const unsubscribe = session.subscribe(() => refresh());

  return {
    doc,
    applyClientUpdate(update: Uint8Array): LensWriteResult {
      const before = codec.read(doc);
      // Validate on a scratch doc so a denied update never touches the lens
      // (same tradeoff as guardCanonicalWrites: encode + double-apply).
      const scratch = new Y.Doc();
      let after: Record<string, unknown>;
      try {
        Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
        Y.applyUpdate(scratch, update);
        after = scratch.getMap(rootKey).toJSON();
      } finally {
        scratch.destroy();
      }
      const change: ViewChange = { before, after };
      if (json(before) !== json(after)) {
        if (!policy.canWrite || !policy.canWrite(change, ctx)) {
          return {
            allowed: false,
            reason: `role "${ctx.role}": change not permitted by policy`,
          };
        }
        // Queue the canonical write-back; the canonical object is read at
        // write time so queued writes compose sequentially.
        writeQueue = writeQueue.then(async () => {
          const merge = policy.mergeWrite ?? defaultMergeWrite;
          await session.write(merge(session.read(), change, ctx));
        });
        writeQueue = writeQueue.catch((error: unknown) => {
          lastError = error instanceof Error ? error.message : String(error);
        });
      }
      Y.applyUpdate(doc, update);
      return { allowed: true };
    },
    subscribe(listener: (update: Uint8Array) => void): () => void {
      const handler = (update: Uint8Array): void => listener(update);
      doc.on("update", handler);
      return () => doc.off("update", handler);
    },
    settle(): Promise<void> {
      return writeQueue;
    },
    get lastError(): string | undefined {
      return lastError;
    },
    close(): void {
      unsubscribe();
      doc.destroy();
    },
  };
}
