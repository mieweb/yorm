/**
 * Thin fetch helpers for the demo's HTTP surface: the YORM plugin routes for
 * the `p-demo` Patient (policy / flush / signal / projection-state) and the
 * demo server's `/api/rows` projection snapshot.
 */
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

export interface RowsSnapshot {
  contact: ContactRow[];
  contact_multivalue: ContactMultivalueRow[];
  contact_multivalue_entry: ContactMultivalueEntryRow[];
  contact_raw_property: ContactRawPropertyRow[];
}

async function postJson(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`);
  }
}

export function postPolicy(kind: PolicyKind): Promise<void> {
  const policy = kind === "idle" ? { kind, ms: 30_000 } : { kind };
  return postJson(`${DOC_PATH}/policy`, policy);
}

export function postFlush(): Promise<void> {
  return postJson(`${DOC_PATH}/flush`, {});
}

export function postBlurSignal(): Promise<void> {
  return postJson(`${DOC_PATH}/signal`, { kind: "blur" });
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
