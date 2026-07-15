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
