# @yorm/core

The deterministic object→rows projection engine of [YORM](../../README.md). Pure functions and types — **zero runtime dependencies** (no Hono, Drizzle, or Yjs imports).

What lives here:

- **`mapping/`** — the mapping DSL: `defineMapping`, `one(...)`, `many(...)`, versioned and frozen mapping contracts.
- **`planner/`** — `planProjection(mapping, input)`: turns a materialized object into a deterministic `ProjectionPlan` of upserts and scoped reconciliation deletes, plus a checkpoint.
- **`provenance/`** — the `Origin` tag (`yjs`, `sql`, `replay`, …) carried by every plan and update.
- **`stores/`** — the `DocumentStore`, `ProjectionStore`, and `Runtime` contracts that adapters implement.

## Usage

```ts
import { defineMapping, many, one, planProjection } from "@yorm/core";

const patientMapping = defineMapping<{ id: string; active?: boolean }>({
  name: "fhir.Patient",
  version: 1,
  documentType: "Patient",
  projections: [
    one("patient", {
      key: ({ object }) => ({ id: object.id }),
      values: ({ object }) => ({ active: object.active ?? null }),
    }),
  ],
});

const plan = planProjection(patientMapping, {
  object: { id: "p1", active: true },
  documentId: "p1",
  documentVersion: 1,
  origin: "yjs",
});
// → { operations: [{ kind: "upsert", table: "patient", ... }], checkpoint: { ... } }
```

Adapters apply plans transactionally; core never performs I/O. See the root [README](../../README.md) for the full design (stable identity, column ownership, reconciliation semantics).
