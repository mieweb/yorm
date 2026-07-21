# @yorm/yjs

Canonical document runtime for YORM (Milestone 2). Real objects live in a
`Y.Doc`; every persisted update bumps the document version and feeds a
policy-driven scheduler that projects the latest state through the
[`@yorm/core`](../core/README.md) planner into a `ProjectionStore`.

## Layout

| Module                | Purpose                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `codecs/json.ts`      | `jsonCodec()` — plain JSON ⇄ Yjs structures; `applyJsonPatchLike()` for partial semantic updates |
| `scheduler/policy.ts` | `ProjectionScheduler` — coalesces changes, triggers projection per policy                        |
| `runtime/memory.ts`   | `memoryRuntime()` — owns live `Y.Doc`s, persists updates, fans them out                          |
| `proposals/index.ts`  | `proposalsApi()` — suggestion mode (PLAN.md M7); `proposalTrackingMapping()`                     |
| `createYorm.ts`       | orchestrator wiring runtime + stores + codecs + mappings into sessions                           |

## JSON codec

`jsonCodec(rootKey = "resource")` reads/writes the document root map.
`write` is a merge-style semantic replace in a single transaction; `read`
materializes plain JSON. `applyJsonPatchLike(doc, rootKey, path, value)` sets
(or removes, when `value === undefined`) a nested value semantically, creating
intermediate containers — the `@yorm/hono` PATCH endpoint builds on it.

## Projection trigger policies (PLAN.md decision #10)

Yjs updates always persist immediately; only the SQL projection commit is
gated. Changes coalesce; each trigger projects the latest version exactly once.

| Policy         | Projects when…                                                            |
| -------------- | ------------------------------------------------------------------------- |
| `every-change` | after every persisted update (runs serialized, trailing changes coalesce) |
| `on-blur`      | on `signal("blur")`                                                       |
| `idle`         | after `ms` (default 30 000) without changes                               |
| `explicit`     | only on `signal("flush")`                                                 |

`maxLagMs` is a safety cap: if it elapses since the oldest unprojected change,
a flush is forced (so `explicit` can't defer forever). `signal("flush")`
always projects if anything is pending. Failed runs keep the pending range and
expose `lastError`; the next trigger retries.

## memoryRuntime

`memoryRuntime()` caches one `ManagedDocument` per `${type}/${id}`. It loads
existing state from the configured `DocumentStore`, persists each update
(`appendUpdate` + `saveSnapshot`), increments `version` per persisted update,
and fans updates out to subscribers — the transport hook `@yorm/hono` uses.
Local `doc.transact(...)` edits and remote `applyUpdate(...)` are treated
identically.

## createYorm

```ts
import { createYorm, memoryRuntime } from "@yorm/yjs";

const yorm = createYorm({
  runtime: memoryRuntime(),
  documents, // DocumentStore
  projections, // ProjectionStore
  mappings: [contactMapping],
  projectionPolicy: { default: { kind: "every-change" }, maxLagMs: 60_000 },
});

const session = await yorm.open("Contact", "c1");
await session.write({ id: "c1", firstName: "Ada" }); // → rows projected
session.setPolicy({ kind: "explicit" });
session.doc.transact(() => session.doc.getMap("resource").set("firstName", "Augusta"));
session.projectionState(); // { pending: { from: 2, to: 2 }, version: 2 }
await session.signal("flush"); // projects now
session.close();
```

Inline projection mode only: when the scheduler fires, the codec materializes
the object, `planProjection` runs for every mapping of the document type, and
each plan is applied via `ProjectionStore.applyPlan` (failures are recorded
with `recordFailure` and surfaced via `projectionState().lastError`). The plan
`origin` passes through from the triggering update (default `"yjs"`).

v1 simplification: the scheduler is per **document**, shared by all sessions
on it — `setPolicy` from any session switches the document's policy.

## Proposed changes (suggestion mode)

PLAN.md Milestone 7 / decision #11. Proposals are semantic change intents
(`ChangeIntent`) stored in the **same `Y.Doc`** under a **separate subtree**:
`doc.getMap("yorm:proposals")`, a map of proposal id → record. They sync,
merge, and survive offline like any CRDT state — but the codec materializes
only the canonical subtree (`doc.getMap("resource")`), so the projection
engine (and therefore SQL) never sees an unaccepted change.

```ts
const api = session.proposals(); // or proposalsApi(doc, opts) standalone

const intent = api.propose({
  path: ["telecom", 0, "value"],
  op: "set", // "set" | "insert" | "remove"
  proposedValue: "555-0100",
  actor: "dr-bob",
}); // canonical untouched; baseValue captured from current canonical state

const result = api.accept(intent.id, "dr-alice");
if (result.conflict) {
  // canonical moved since the proposal was made — nothing was applied;
  // caller decides: api.acceptAnyway(...) / api.reject(...) / re-propose
  console.log("current value is now", result.currentValue);
}
```

Lifecycle & semantics:

- **propose** — one Yjs transaction on the proposals subtree only. Captures
  `baseValue` from the current canonical value at `path` (for `insert`: the
  element currently at the insertion index). Older still-`proposed` intents
  on the same path are marked `superseded` in the same transaction.
- **accept** — applies the intent to the canonical subtree **and** marks the
  proposal `accepted` (status, `resolvedBy`, `resolvedAt`) in **one atomic
  Yjs transaction**; projection then fires per the normal trigger policy.
- **Stale handling** — if the current canonical value at `path` no longer
  deep-equals `baseValue`, `accept` returns `{ conflict: true, currentValue }`
  without applying or resolving anything. `acceptAnyway` skips the check.
- **reject** — marks `rejected`; the canonical subtree is untouched.
- **withdraw** — deletes a still-`proposed` intent from the subtree.
- **updateProposal** — amends a still-`proposed` intent's `proposedValue`.
- `list({ status? })` returns intents sorted by `createdAt` then id;
  `subscribe(listener)` fires on any proposals-subtree change.

Op semantics on accept: `set` writes `proposedValue` at `path`; `remove`
deletes at `path`; `insert` inserts into the array at `path` (the last
segment is the index).

### Tracking projection (`yorm_proposal`)

`proposalTrackingMapping(documentType, table = "yorm_proposal")` is a
forward-only `@yorm/core` mapping (name `yorm.proposals`) that projects the
proposals subtree into rows — key `{ document_id, proposal_id }`, values
`{ path, op, status, actor, resolved_by, resolved_at, created_at }`, scoped
by `{ document_id }` — so DBAs and reports can see open suggestions.

Because the codec only reads the canonical subtree, `createYorm` special-cases
mappings recognized by `isProposalTrackingMapping` (well-known name prefix
`yorm.proposals`): their mapping context object is the materialized proposals
list (`readProposals(doc)`) instead of the codec output. Pending proposals
appear in `yorm_proposal` rows while **never** appearing in canonical-mapping
rows.

Server-side role enforcement (proposer vs. editor) lives in
[@yorm/hono](../hono/README.md) (`onAuthorizeWrite` + the WebSocket
canonical-write guard).

## Role policies — the policy lens (role-security POC)

Developer-defined per-role protections over a canonical document, analogous
to how a `Mapping` projects a document into SQL rows: a `RolePolicy` projects
it into what one **role** may see and change.

```ts
import { defineRolePolicy, createPolicyLens } from "@yorm/yjs";

const receptionist = defineRolePolicy<Visit>({
  role: "receptionist",
  documentType: "Visit",
  // Outbound redaction: what this role sees (deterministic, plain object).
  view: (visit) => ({ demographics: visit.demographics ?? {} }),
  // Inbound guard over the *view's* before/after. Absent ⇒ read-only lens.
  canWrite: ({ before, after }) =>
    [...Object.keys(before), ...Object.keys(after)].every((k) => k === "demographics"),
  // Optional: translate an allowed view change back onto the canonical
  // object. Default: top-level key merge (removed view keys are deleted).
  mergeWrite: (canonical, { after }) => ({ ...canonical, ...after }),
});

const lens = createPolicyLens(session, receptionist, {
  role: "receptionist",
  documentType: "Visit",
  documentId: "v1",
});
lens.doc; // derived Y.Doc holding only the view — what clients sync
lens.applyClientUpdate(update); // { allowed } | { allowed: false, reason }
```

Why a derived doc instead of filtering updates: CRDT updates reference each
other by clock position, so a redacted view **cannot** share CRDT identity
with the canonical doc — hiding data requires a separate doc per (document,
role). The lens keeps that doc in sync with `view(canonical)` (loop-safe:
only rebuilt when the visible JSON changes), validates every client update
on a scratch doc (denied updates never touch anything), and writes allowed
changes back through the normal `session.write` path so projections,
persistence, and other lenses all observe them.

Semantics — secure by default: a role **with** a policy sees only `view` and
writes only what `canWrite` allows; roles **without** a policy are untouched
by the lens layer. v1 tradeoffs (same family as the canonical-write guard):
per-update encode + double-apply for validation; JSON-level write-back, so
concurrent edits to the same visible section resolve last-writer-wins at the
section level; denied updates are refused as a whole.

Transport wiring (`?role=` → lens rooms) lives in
[@yorm/hono](../hono/README.md#role-policies-policy-lens-role-security-poc).

## Replay & failed-projection retry (PLAN.md M8)

Projections are derived state — they can be dropped and rebuilt from the
stored canonical documents:

```ts
import { replayProjections, retryFailedProjections } from "@yorm/yjs";

// Rebuild every projection (e.g. after dropping/recreating tables or adding
// a mapping version). Plans carry origin "replay".
const result = await replayProjections(yorm, {
  documentType: "Patient", // optional filter; default: every mapped type
  onError: "record-and-continue", // default; or "throw" to abort on failure
});
// → { attempted, succeeded, failed: [{ documentId, error }] }

// Re-run only the quarantine set: documents whose projection state is
// status "error". Requires the store's optional listFailures()
// (implemented by @yorm/drizzle); throws a clear error otherwise.
await retryFailedProjections(yorm);
```

`replayProjections` walks `DocumentStore.listDocuments` per mapped document
type, loads each stored snapshot into a **fresh** `Y.Doc` (live runtime state
is never consulted), materializes it via the document's codec — or via the
proposals subtree for tracking mappings — and applies each plan via
`ProjectionStore.applyPlan`. Failures are recorded with `recordFailure`
(status `"error"`) and collected in the result; by default a failing document
does not stop the run.
