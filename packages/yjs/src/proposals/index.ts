/**
 * Proposed changes ("suggestion mode") — PLAN.md Milestone 7a/7b, decision #11.
 *
 * Proposals are semantic change intents stored in the **same `Y.Doc`** under
 * a **separate subtree**: `doc.getMap(PROPOSALS_KEY)` maps proposal id →
 * proposal record (a `Y.Map`). They sync, merge, and survive offline like any
 * CRDT state — but the document codec materializes only the canonical
 * subtree (`doc.getMap("resource")`), so the projection engine never sees an
 * unaccepted change.
 *
 * Lifecycle: `propose` → (`updateProposal` | `withdraw`) → `accept` /
 * `acceptAnyway` / `reject`. Accepting applies the intent to the canonical
 * subtree AND marks the proposal accepted in ONE Yjs transaction (atomic).
 * Proposing over a path with older still-`proposed` intents marks those
 * `superseded`.
 */
import * as Y from "yjs";
import { defineMapping, many } from "@yorm/core";
import type { Mapping } from "@yorm/core";

import { DEFAULT_ROOT_KEY, applyPathWrite } from "../codecs/json.js";

/** Operation an intent applies to the canonical subtree when accepted. */
export type ProposalOp = "set" | "insert" | "remove";

/** Where an intent is in its lifecycle. */
export type ProposalStatus = "proposed" | "accepted" | "rejected" | "superseded";

/** A semantic change intent, as materialized from the proposals subtree. */
export interface ChangeIntent {
  id: string;
  /** Path into the canonical subtree (string keys / number array indices). */
  path: (string | number)[];
  op: ProposalOp;
  /** Value to write for `set` / `insert`; absent for `remove`. */
  proposedValue?: unknown;
  /**
   * Canonical value at `path` when the proposal was made (for `insert`: the
   * element currently at the insertion index, absent when appending). Used
   * for stale detection on accept.
   */
  baseValue?: unknown;
  baseDocumentVersion: number;
  actor: string;
  status: ProposalStatus;
  createdAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

/** Root key of the proposals subtree (decision #11). */
export const PROPOSALS_KEY = "yorm:proposals";

/** Thrown when a proposal id does not exist in the subtree. */
export class ProposalNotFoundError extends Error {
  constructor(id: string) {
    super(`proposal not found: ${id}`);
    this.name = "ProposalNotFoundError";
  }
}

/** Thrown when an operation requires a still-`proposed` intent. */
export class ProposalStateError extends Error {
  constructor(id: string, status: ProposalStatus) {
    super(`proposal ${id} is "${status}", not "proposed"`);
    this.name = "ProposalStateError";
  }
}

export interface ProposeInput {
  path: (string | number)[];
  op: ProposalOp;
  proposedValue?: unknown;
  actor: string;
  /** Defaults to the injected `version()` (the session's document version). */
  baseDocumentVersion?: number;
}

export interface ProposalsApi {
  /**
   * Records a change intent in one Yjs transaction on the proposals subtree
   * only (the canonical resource is untouched). Captures `baseValue` from the
   * current canonical state and marks older still-`proposed` intents on the
   * same path `superseded`.
   */
  propose(intent: ProposeInput): ChangeIntent;
  /** Amends a still-`proposed` intent's value. */
  updateProposal(id: string, changes: { proposedValue?: unknown }): void;
  /** Deletes a still-`proposed` intent from the subtree (proposer withdraws). */
  withdraw(id: string): void;
  /**
   * Applies the intent to the canonical subtree and marks it `accepted`
   * (status, resolvedBy, resolvedAt) in ONE Yjs transaction. If the current
   * canonical value at `path` no longer deep-equals `baseValue`, nothing is
   * applied or resolved and `{ conflict: true, currentValue }` is returned —
   * the caller decides (acceptAnyway / reject / re-propose).
   */
  accept(
    id: string,
    resolvedBy: string,
  ): { conflict: false } | { conflict: true; currentValue: unknown };
  /** Accepts without the stale check (caller has seen the conflict). */
  acceptAnyway(id: string, resolvedBy: string): void;
  /** Marks the intent `rejected`; the canonical subtree is untouched. */
  reject(id: string, resolvedBy: string): void;
  /**
   * Deletes every resolved (non-`proposed`) intent from the subtree in one
   * Yjs transaction and returns how many were removed. A semantic CRDT
   * delete: it syncs to every client (including ones holding old state) and
   * the tracking projection reconciles the corresponding rows away. Open
   * intents are never touched.
   */
  clearResolved(): number;
  /** All intents, sorted by `createdAt` then id, optionally filtered. */
  list(filter?: { status?: ProposalStatus }): ChangeIntent[];
  /** Fires whenever the proposals subtree changes. Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface ProposalsApiOptions {
  /** Root key of the canonical subtree. Defaults to `"resource"`. */
  rootKey?: string;
  /** Timestamp source (injectable for tests). Defaults to ISO now. */
  now?: () => string;
  /** Proposal id source (injectable for tests). Defaults to `crypto.randomUUID`. */
  genId?: () => string;
  /** Current document version, captured as `baseDocumentVersion`. Defaults to `() => 0`. */
  version?: () => number;
}

/** JSON deep equality (objects key-order-insensitive, arrays ordered). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (
    typeof a === "object" &&
    a !== null &&
    !Array.isArray(a) &&
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(b)
  ) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) =>
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

/** Materializes the canonical value at `path`, or `undefined` when absent. */
function readPath(doc: Y.Doc, rootKey: string, path: (string | number)[]): unknown {
  let node: unknown = doc.getMap(rootKey);
  for (const segment of path) {
    if (node instanceof Y.Map) {
      node = typeof segment === "string" ? node.get(segment) : undefined;
    } else if (node instanceof Y.Array) {
      node =
        typeof segment === "number" &&
        Number.isInteger(segment) &&
        segment >= 0 &&
        segment < node.length
          ? node.get(segment)
          : undefined;
    } else {
      return undefined;
    }
  }
  return node instanceof Y.Map || node instanceof Y.Array ? node.toJSON() : node;
}

/** Converts a plain JSON value into Y form for storage in a proposal record. */
function toYField(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = new Y.Array<unknown>();
    arr.push(value.map((item) => toYField(item)));
    return arr;
  }
  if (typeof value === "object" && value !== null) {
    const map = new Y.Map<unknown>();
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        map.set(key, toYField(item));
      }
    }
    return map;
  }
  return value;
}

type ProposalRecord = Y.Map<unknown>;

function recordToIntent(record: ProposalRecord): ChangeIntent {
  return record.toJSON() as ChangeIntent;
}

/**
 * Reads every intent from the proposals subtree, sorted deterministically by
 * `createdAt` then `id`. Shared by {@link ProposalsApi.list} and the
 * orchestrator's materialization for {@link proposalTrackingMapping}.
 */
export function readProposals(doc: Y.Doc): ChangeIntent[] {
  const proposals = doc.getMap(PROPOSALS_KEY);
  const intents: ChangeIntent[] = [];
  for (const value of proposals.values()) {
    if (value instanceof Y.Map) {
      intents.push(recordToIntent(value));
    }
  }
  return intents.sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
  );
}

/**
 * Proposals API over one `Y.Doc`. See the module TSDoc for the model and
 * lifecycle. All mutations run as single Yjs transactions.
 */
export function proposalsApi(doc: Y.Doc, opts: ProposalsApiOptions = {}): ProposalsApi {
  const rootKey = opts.rootKey ?? DEFAULT_ROOT_KEY;
  const now = opts.now ?? ((): string => new Date().toISOString());
  const genId = opts.genId ?? ((): string => crypto.randomUUID());
  const version = opts.version ?? ((): number => 0);
  const proposals = doc.getMap(PROPOSALS_KEY);

  function getRecord(id: string): ProposalRecord {
    const record = proposals.get(id);
    if (!(record instanceof Y.Map)) {
      throw new ProposalNotFoundError(id);
    }
    return record;
  }

  function getProposedRecord(id: string): { record: ProposalRecord; intent: ChangeIntent } {
    const record = getRecord(id);
    const intent = recordToIntent(record);
    if (intent.status !== "proposed") {
      throw new ProposalStateError(id, intent.status);
    }
    return { record, intent };
  }

  function markResolved(
    record: ProposalRecord,
    status: Exclude<ProposalStatus, "proposed">,
    resolvedBy: string,
  ): void {
    record.set("status", status);
    record.set("resolvedBy", resolvedBy);
    record.set("resolvedAt", now());
  }

  /** Applies the intent to the canonical subtree (inside a transaction). */
  function applyIntent(intent: ChangeIntent): void {
    const root = doc.getMap(rootKey);
    if (intent.op === "insert") {
      applyPathWrite(root, intent.path, intent.proposedValue, "insert");
    } else {
      applyPathWrite(root, intent.path, intent.op === "remove" ? undefined : intent.proposedValue);
    }
  }

  /** Apply + mark accepted in ONE Yjs transaction (atomic). */
  function acceptRecord(record: ProposalRecord, intent: ChangeIntent, resolvedBy: string): void {
    doc.transact(() => {
      applyIntent(intent);
      markResolved(record, "accepted", resolvedBy);
    });
  }

  return {
    propose(input: ProposeInput): ChangeIntent {
      const intent: ChangeIntent = {
        id: genId(),
        path: [...input.path],
        op: input.op,
        ...(input.proposedValue !== undefined ? { proposedValue: input.proposedValue } : {}),
        baseDocumentVersion: input.baseDocumentVersion ?? version(),
        actor: input.actor,
        status: "proposed",
        createdAt: now(),
      };
      const baseValue = readPath(doc, rootKey, intent.path);
      if (baseValue !== undefined) {
        intent.baseValue = baseValue;
      }
      doc.transact(() => {
        // Supersede older still-proposed intents on the same path.
        for (const value of proposals.values()) {
          if (value instanceof Y.Map && value.get("status") === "proposed") {
            const path = (value.get("path") as Y.Array<string | number> | undefined)?.toJSON();
            if (path !== undefined && deepEqual(path, intent.path)) {
              markResolved(value, "superseded", input.actor);
            }
          }
        }
        const record = new Y.Map<unknown>();
        proposals.set(intent.id, record);
        for (const [key, value] of Object.entries(intent)) {
          record.set(key, toYField(value));
        }
      });
      return intent;
    },

    updateProposal(id: string, changes: { proposedValue?: unknown }): void {
      const { record } = getProposedRecord(id);
      doc.transact(() => {
        if (changes.proposedValue !== undefined) {
          record.set("proposedValue", toYField(changes.proposedValue));
        }
      });
    },

    withdraw(id: string): void {
      getProposedRecord(id);
      doc.transact(() => {
        proposals.delete(id);
      });
    },

    accept(id: string, resolvedBy: string) {
      const { record, intent } = getProposedRecord(id);
      const currentValue = readPath(doc, rootKey, intent.path);
      if (!deepEqual(currentValue, intent.baseValue)) {
        return { conflict: true as const, currentValue };
      }
      acceptRecord(record, intent, resolvedBy);
      return { conflict: false as const };
    },

    acceptAnyway(id: string, resolvedBy: string): void {
      const { record, intent } = getProposedRecord(id);
      acceptRecord(record, intent, resolvedBy);
    },

    reject(id: string, resolvedBy: string): void {
      const { record } = getProposedRecord(id);
      doc.transact(() => {
        markResolved(record, "rejected", resolvedBy);
      });
    },

    clearResolved(): number {
      const resolvedIds: string[] = [];
      for (const [id, value] of proposals.entries()) {
        if (value instanceof Y.Map && value.get("status") !== "proposed") {
          resolvedIds.push(id);
        }
      }
      doc.transact(() => {
        for (const id of resolvedIds) {
          proposals.delete(id);
        }
      });
      return resolvedIds.length;
    },

    list(filter?: { status?: ProposalStatus }): ChangeIntent[] {
      const intents = readProposals(doc);
      return filter?.status === undefined
        ? intents
        : intents.filter((intent) => intent.status === filter.status);
    },

    subscribe(listener: () => void): () => void {
      const handler = (): void => {
        listener();
      };
      proposals.observeDeep(handler);
      return () => {
        proposals.unobserveDeep(handler);
      };
    },
  };
}

/** Well-known name prefix marking the proposal tracking mapping. */
export const PROPOSAL_TRACKING_NAME = "yorm.proposals";

/**
 * `true` when `mapping` is a {@link proposalTrackingMapping}. `createYorm`
 * materializes the proposals subtree (via {@link readProposals}) as the
 * mapping context object for such mappings, instead of the codec output —
 * the codec only ever sees the canonical subtree.
 */
export function isProposalTrackingMapping(mapping: Mapping<unknown>): boolean {
  return (
    mapping.name === PROPOSAL_TRACKING_NAME || mapping.name.startsWith(`${PROPOSAL_TRACKING_NAME}.`)
  );
}

/**
 * Forward-only tracking projection (PLAN.md 7b): open/resolved proposals of
 * one document type become rows of `table` (default `"yorm_proposal"`), so
 * DBAs and reports can see pending suggestions — dogfooding the mapping
 * engine on YORM's own metadata. Row key: `{ document_id, proposal_id }`;
 * reconcile scope: `{ document_id }` (withdrawn proposals are deleted).
 */
export function proposalTrackingMapping(
  documentType: string,
  table = "yorm_proposal",
): Mapping<ChangeIntent[]> {
  return defineMapping<ChangeIntent[]>({
    name: PROPOSAL_TRACKING_NAME,
    version: 1,
    documentType,
    direction: "forward",
    projections: [
      many<ChangeIntent[]>(table, {
        rows: ({ object, documentId }) =>
          object.map((intent) => ({
            key: { document_id: documentId, proposal_id: intent.id },
            values: {
              path: JSON.stringify(intent.path),
              op: intent.op,
              status: intent.status,
              actor: intent.actor,
              resolved_by: intent.resolvedBy ?? null,
              resolved_at: intent.resolvedAt ?? null,
              created_at: intent.createdAt,
            },
          })),
        scope: ({ documentId }) => ({ document_id: documentId }),
      }),
    ],
  });
}
