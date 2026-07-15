/**
 * Thin fetch helpers for the demo's HTTP surface: the YORM plugin routes for
 * the `p-demo` Patient (policy / flush / signal / projection-state /
 * proposals) and the demo server's `/api/rows` projection snapshot.
 *
 * Every request carries the demo role in an `X-Demo-Role` header (M7c) —
 * the server's `onAuthorizeWrite` refuses canonical writes from proposers.
 */
import type { ChangeIntent, ProposalOp } from "@yorm/yjs";
import type {
  ContactMultivalueEntryRow,
  ContactMultivalueRow,
  ContactRawPropertyRow,
  ContactRow,
} from "example-fhir-patient-contacts/schema";

export const DOC_TYPE = "Patient";
export const DOC_ID = "p-demo";
const DOC_PATH = `/yorm/docs/${DOC_TYPE}/${DOC_ID}`;

export type PolicyKind = "every-change" | "on-blur" | "idle" | "explicit";

export type DemoRole = "editor" | "proposer";

let currentRole: DemoRole = "editor";

/** Sets the role sent with every subsequent request. */
export function setApiRole(role: DemoRole): void {
  currentRole = role;
}

function roleHeaders(): Record<string, string> {
  return { "x-demo-role": currentRole };
}

/** One `yorm_proposal` tracking-projection row (PLAN.md 7b). */
export interface ProposalRow {
  document_id: string;
  proposal_id: string;
  path: string;
  op: string;
  status: string;
  actor: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface RowsSnapshot {
  contact: ContactRow[];
  contact_multivalue: ContactMultivalueRow[];
  contact_multivalue_entry: ContactMultivalueEntryRow[];
  contact_raw_property: ContactRawPropertyRow[];
  yorm_proposal: ProposalRow[];
}

async function postJson(path: string, body: unknown): Promise<Response> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...roleHeaders() },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`);
  }
  return response;
}

export function postPolicy(kind: PolicyKind): Promise<void> {
  const policy = kind === "idle" ? { kind, ms: 30_000 } : { kind };
  return postJson(`${DOC_PATH}/policy`, policy).then(() => undefined);
}

export function postFlush(): Promise<void> {
  return postJson(`${DOC_PATH}/flush`, {}).then(() => undefined);
}

export function postBlurSignal(): Promise<void> {
  return postJson(`${DOC_PATH}/signal`, { kind: "blur" }).then(() => undefined);
}

export async function fetchRows(): Promise<RowsSnapshot> {
  const response = await fetch("/api/rows");
  return (await response.json()) as RowsSnapshot;
}

export async function fetchProjectionPending(): Promise<boolean> {
  const response = await fetch(`${DOC_PATH}/projection-state`);
  // `pending` is a version range `{ from, to }` or null when projected.
  const state = (await response.json()) as { pending?: { from: number; to: number } | null };
  return state.pending != null;
}

// --- Proposals (PLAN.md M7c) ----------------------------------------------

export interface ProposeInput {
  path: (string | number)[];
  op: ProposalOp;
  proposedValue: unknown;
  actor: string;
}

export async function fetchProposals(): Promise<ChangeIntent[]> {
  const response = await fetch(`${DOC_PATH}/proposals`, { headers: roleHeaders() });
  const body = (await response.json()) as { proposals: ChangeIntent[] };
  return body.proposals;
}

export async function postProposal(input: ProposeInput): Promise<ChangeIntent> {
  const response = await postJson(`${DOC_PATH}/proposals`, input);
  return ((await response.json()) as { proposal: ChangeIntent }).proposal;
}

export type AcceptResult = { conflict: false } | { conflict: true; currentValue: unknown };

/** Accepts a proposal; a stale 409 surfaces as `{ conflict: true, currentValue }`. */
export async function acceptProposal(id: string, resolvedBy: string): Promise<AcceptResult> {
  const response = await fetch(`${DOC_PATH}/proposals/${id}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json", ...roleHeaders() },
    body: JSON.stringify({ resolvedBy }),
  });
  if (response.status === 409) {
    const body = (await response.json()) as { conflict?: boolean; currentValue?: unknown };
    if (body.conflict === true) {
      return { conflict: true, currentValue: body.currentValue };
    }
  }
  if (!response.ok) {
    throw new Error(`accept failed: ${response.status}`);
  }
  return { conflict: false };
}

export function acceptProposalAnyway(id: string, resolvedBy: string): Promise<void> {
  return postJson(`${DOC_PATH}/proposals/${id}/accept-anyway`, { resolvedBy }).then(
    () => undefined,
  );
}

export function rejectProposal(id: string, resolvedBy: string): Promise<void> {
  return postJson(`${DOC_PATH}/proposals/${id}/reject`, { resolvedBy }).then(() => undefined);
}

/** Deletes all resolved intents from the document (editor action). */
export function clearResolvedProposals(): Promise<number> {
  return postJson(`${DOC_PATH}/proposals/clear-resolved`, {})
    .then((response) => response.json() as Promise<{ cleared: number }>)
    .then((body) => body.cleared);
}
