# YORM

<img width="1024" height="341" alt="yorm-banner" src="https://github.com/user-attachments/assets/02994dec-4a21-46d2-8f90-ce8c48760e11" />

## Yjs Object-Relational Mapper

_Yet another Object-Relational Mapper._

> **Keep the object. Project the rows.**
>
> **Collaborate as a document. Query as a database.**
>
> **One canonical object. Any number of relational projections.**

_For the SQL geeks:_
```sql
BEGIN;
-- Collaborate on one canonical object using CRDT in a Yjs room.  
-- When someone saves: 
WITH document AS (
  SELECT crdt_merge(current_state, incoming_update)
)
UPDATE tables
FROM document;
COMMIT;
```

**🧪 Live sandbox demo: [yorm.os.mieweb.org](https://yorm.os.mieweb.org/)** — a
two-browser collaborative FHIR Patient editor with live SQL projections. Open it
in two windows to edit the same Patient in real time. See the
[demo's README](examples/patient-collab-demo/README.md) for what it shows and
how it works.

YORM is an object-preserving, CRDT-aware mapping layer for turning serialized domain objects into versioned, replayable relational models.

Applications work with real objects backed by Yjs. Database teams work with ordinary tables, keys, indexes, constraints, and SQL. YORM keeps both representations useful without pretending they are the same thing.

The original object remains intact as the canonical aggregate. Relational tables are deterministic projections that can be added, changed, rebuilt, and selectively mapped back into the document.

YORM was created to make complex healthcare objects, especially FHIR resources, practical in collaborative and relational systems. The same architecture applies to any serialized object model, including JSON, XML, configuration documents, product catalogs, forms, workflow records, and custom domain messages.

## Project status

The **SQLite vertical slice is implemented and tested** ([PLAN.md](PLAN.md) milestones M0–M8): `@yorm/core` (mapping DSL + planner), `@yorm/yjs` (runtime, codecs, trigger policies, proposals, replay), `@yorm/hono` (REST + WebSocket plugin), `@yorm/drizzle` (SQLite stores + adapter conformance suite), `@yorm/fhir` (Patient codec + element identity), two runnable examples (the lossless Contacts ⇄ FHIR Patient POC and the two-browser collaborative Patient editor), suggestion mode, and mapping replay.

The rest of this README is the design vision. Sections describing features that are not built yet are marked **(roadmap)** or **(deferred)** inline. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for an honest map of what exists versus the vision, and [PLAN.md](PLAN.md) for the milestone plan (M9, additional backends, is next).

---

## Why YORM exists

Traditional ORMs usually start with a relational schema and make rows feel like objects.

Document databases preserve object shape, but often leave DBAs, analysts, reporting systems, and relational integrations working around opaque blobs.

CRDT frameworks make collaborative editing possible, but they do not solve the object-to-relational impedance mismatch.

YORM takes a different approach:

1. Keep the actual serialized object.
2. represent its live state in a `Y.Doc`;
3. persist the Yjs state and document metadata;
4. map the materialized object into relational projections;
5. let those projections evolve independently;
6. replay mappings across every document when the relational model changes; and
7. translate approved relational edits back into semantic Yjs transactions.

This makes the object model and the relational model independent but connected.

```text
                         canonical state

Browser / service  <-->  Yjs runtime  <-->  Y.Doc + persisted document
                                |
                                | versioned mappings
                                v
                         relational projections
                         +---------------------+
                         | patient             |
                         | patient_identifier  |
                         | patient_address     |
                         | reporting_dimension |
                         | future tables       |
                         +---------------------+
                                ^
                                | semantic changes
                                |
                         database outbox
```

---

## The core idea

YORM is not a serializer wrapped around an ORM. It is a projection system with an object-shaped canonical model.

```text
Canonical write model:
    serialized object + Yjs CRDT state

Relational read and integration models:
    versioned, deterministic SQL projections

Reverse synchronization:
    selected SQL changes -> outbox -> semantic Yjs transaction
```

The canonical document can be stored as:

- an encoded Yjs snapshot;
- incremental Yjs updates;
- an inspectable JSON snapshot;
- the original serialized payload;
- or a combination of these.

The JSON or XML representation is not required to be the persistence format used by Yjs. It is the materialized domain object that mappings read and project.

Relational projections can be:

- fully normalized;
- partially normalized;
- denormalized for reporting;
- forward-only;
- bidirectional;
- computed;
- owned by another system; or
- added years after the original document was created.

---

## What YORM gives you

### Preserve the complete object

No field must be discarded merely because it is inconvenient to normalize today. Unknown properties, FHIR extensions, sparse fields, nested collections, and future schema additions remain in the canonical document.

### Give DBAs real tables

Projection tables are ordinary relational tables. They can have:

- primary and foreign keys;
- indexes;
- check constraints;
- views;
- row-level security;
- triggers;
- materialized views;
- warehouse pipelines; and
- conventional SQL access.

### Add relational models later

A DBA can introduce a table or reporting structure after documents already exist. A new mapping version can replay every canonical document into the new structure.

```text
existing documents + new mapping + replay = populated new tables
```

### Keep collaboration semantics

YORM does not replace Yjs. Browser and service changes remain real CRDT transactions, with Yjs handling concurrent and offline edits.

### Support safe reverse mapping

Database changes do not overwrite the Yjs binary. Triggers write a semantic change request to an outbox. YORM then applies that change through a real Yjs transaction and reprojects the document.

### Make projections reproducible

A projection is derived state. It can be verified, repaired, dropped, rebuilt, or migrated without losing the canonical object.

---

## A FHIR-first motivation

FHIR resources are excellent serialized domain objects and difficult relational schemas.

A single resource may contain:

- optional and repeated elements;
- nested datatypes;
- polymorphic fields such as `value[x]`;
- references to other resources;
- local and implementation-specific extensions;
- identifiers from multiple systems;
- version-dependent fields; and
- information that is clinically important but rarely queried relationally.

Flattening every possible FHIR path into a fixed schema is expensive and lossy. Keeping only JSONB makes operational SQL, referential integrity, reporting, and downstream integration harder.

YORM lets a system preserve the complete resource while projecting only the relational models that are useful now.

For example, a `Patient` resource might remain intact while YORM maintains:

```text
patient
patient_name
patient_identifier
patient_address
patient_contact
patient_general_practitioner
patient_extension_index
```

Later, a DBA can add:

```text
patient_reporting_region
patient_identity_resolution
patient_quality_measure_population
```

A mapping version is added, every stored Patient document is replayed, and the new tables are populated without changing or rewriting the original resource.

YORM is not a FHIR validator, terminology server, authorization layer, or complete FHIR server. It is the object-to-relational and relational-to-object projection layer beneath or beside those capabilities.

---

## Architecture

YORM separates live coordination from durable persistence.

```text
Browser or service
        |
        | Yjs sync, WebSocket, or HTTP
        v
Hono application
        |
        +-- authentication and authorization
        +-- document routing
        +-- Yjs protocol transport
        +-- YORM API
        |
        v
YORM runtime
        |
        +-- active Y.Doc ownership
        +-- awareness and presence
        +-- update fan-out
        +-- transaction boundaries
        |
        +-----------------------------+
        |                             |
        v                             v
Document store                  Projection engine
        |                             |
        +-- snapshots                 +-- materialize object
        +-- incremental updates       +-- select mapping version
        +-- document versions         +-- create projection plan
        +-- original payload          +-- upserts
                                      +-- reconciliation deletes
                                      +-- projection checkpoint
                                            |
                                            v
                                      Relational database
                                            |
                                            +-- 3NF tables
                                            +-- views and indexes
                                            +-- outbox trigger
                                            +-- audit history
```

A production deployment usually has two swappable drivers:

### Runtime driver

The runtime driver coordinates active collaborative documents.

Examples:

- in-memory runtime for development;
- Redis or NATS coordination for multi-node servers;
- Cloudflare Durable Objects for one logical room per document; or
- a custom room or actor runtime.

> Only the in-memory runtime is implemented today; the others are roadmap items behind the `Runtime` contract.

### Persistence driver

The persistence driver stores canonical documents, updates, projection metadata, and relational rows.

Examples:

- Drizzle with PostgreSQL;
- Drizzle with SQLite;
- Drizzle with Cloudflare D1;
- native PostgreSQL;
- an object store plus SQL metadata; or
- a custom adapter.

> SQLite (better-sqlite3) is the implemented backend today; additional backends land with PLAN.md Milestone 9 via the adapter conformance suite.

Hono is the transport and application layer. Yjs provides CRDT semantics. YORM connects the canonical object to relational projections.

---

## Package map

A typical YORM application uses these packages:

```text
@yorm/core       Mapping DSL, projection planner, replay engine
@yorm/yjs        Y.Doc lifecycle, codecs, transactions, update handling
@yorm/hono       Hono routes, WebSocket transport, request context
@yorm/drizzle    Drizzle document and projection stores
@yorm/fhir       FHIR codecs, path helpers, stable element identity
@yorm/cli        Mapping plans, replay, verification, and repair (roadmap)
```

The core package does not require Hono or Drizzle. Adapters are intentionally replaceable.

---

## Quick start

### 1. Install

```bash
pnpm add @yorm/core @yorm/yjs @yorm/hono @yorm/drizzle yjs hono drizzle-orm
```

Add the database driver used by your application, such as `pg`, `postgres`, `better-sqlite3`, or the Cloudflare D1 adapter.

### 2. Define relational tables

The example below uses Drizzle and PostgreSQL.

```ts
import { boolean, date, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const patients = pgTable("patient", {
  id: text("id").primaryKey(),
  active: boolean("active"),
  birthDate: date("birth_date"),
  genderCode: text("gender_code"),
});

export const patientIdentifiers = pgTable(
  "patient_identifier",
  {
    patientId: text("patient_id")
      .notNull()
      .references(() => patients.id),
    elementId: text("element_id").notNull(),
    system: text("system"),
    value: text("value"),
    useCode: text("use_code"),
  },
  (table) => [
    primaryKey({
      columns: [table.patientId, table.elementId],
    }),
  ],
);
```

Projection tables should use stable logical keys. Array position is not a stable identity.

### 3. Define a mapping

```ts
import { defineMapping, many, one } from "@yorm/core";
import { fhirElementId, fhirResource } from "@yorm/fhir";

import { patientIdentifiers, patients } from "./schema";

export const patientMapping = defineMapping({
  name: "fhir.Patient",
  version: 1,

  document: fhirResource("Patient"),

  projections: [
    one(patients, {
      key: ({ object }) => ({
        id: object.id,
      }),

      values: ({ object }) => ({
        active: object.active ?? null,
        birthDate: object.birthDate ?? null,
        genderCode: object.gender ?? null,
      }),
    }),

    many(patientIdentifiers, {
      rows: ({ object }) =>
        (object.identifier ?? []).map((identifier) => ({
          key: {
            patientId: object.id,
            elementId: fhirElementId(identifier),
          },

          values: {
            system: identifier.system ?? null,
            value: identifier.value ?? null,
            useCode: identifier.use ?? null,
          },
        })),
    }),
  ],
});
```

A `many(...)` projection owns the row set emitted for that document. During reconciliation, YORM:

1. upserts rows present in the current object;
2. retains columns not owned by the mapping; and
3. deletes previously projected rows that are no longer present.

Upserts alone are insufficient because object properties and collection elements can be removed.

### 4. Create the YORM service

```ts
import { createYorm } from "@yorm/core";
import { drizzleDocumentStore, drizzleProjectionStore } from "@yorm/drizzle";
import { createHonoYorm } from "@yorm/hono";
import { memoryRuntime } from "@yorm/yjs";
import { Hono } from "hono";

import { db } from "./db";
import { patientMapping } from "./mappings/patient";

const yorm = createYorm({
  runtime: memoryRuntime(),

  documents: drizzleDocumentStore(db),
  projections: drizzleProjectionStore(db),

  mappings: [patientMapping],
});

const app = new Hono();

app.route("/yorm", createHonoYorm(yorm));

export default app;
```

The in-memory runtime is appropriate for local development and a single long-lived process. Use a distributed or actor-based runtime in production.

### 5. Connect a browser

```ts
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const doc = new Y.Doc();

const provider = new WebsocketProvider("wss://api.example.com/yorm/ws", "Patient/patient-123", doc);

const patient = doc.getMap("resource");

doc.transact(() => {
  patient.set("active", true);
});
```

A production client will normally use a YORM-aware codec or generated domain bindings rather than manipulating the root map directly.

---

## How a document change flows

When a browser changes a document:

```text
1. Client creates a Yjs transaction.
2. Yjs produces an update.
3. The runtime broadcasts the update to other clients.
4. The document store persists the update.
5. YORM increments the document version.
6. The codec materializes the domain object.
7. The mapping produces a deterministic projection plan.
8. The projection store applies all row changes in one SQL transaction.
9. The projection checkpoint advances.
```

A projection transaction typically looks like:

```text
BEGIN

SET projection origin
UPSERT root row
UPSERT child rows
DELETE removed mapping-owned rows
UPDATE projection checkpoint

COMMIT
```

The checkpoint records at least:

```text
document_id
document_version
mapping_name
mapping_version
projected_at
status
error
```

This makes projection lag and failures observable.

---

## Inline, queued, and batch projection

YORM supports three execution modes.

### Inline

Projection runs as part of the document commit path.

Use this when relational reads must reflect a document change immediately and the mapping is small enough to remain inside the request latency budget.

### Queued (roadmap)

Document updates are persisted first and projection work is placed on a durable queue.

Use this for high-volume systems, large documents, or mappings that touch many tables. Relational state is eventually consistent and its exact checkpoint is visible.

### Batch and replay

Mappings run across a selected document population.

Use this for:

- a new table;
- a new mapping version;
- repair after a failed deployment;
- reindexing;
- schema migration;
- verification; or
- disaster recovery.

> Replay is implemented today as a library API — `replayProjections(yorm)` in `@yorm/yjs`. The `@yorm/cli` commands below are roadmap.

```bash
pnpm yorm project --mapping fhir.Patient@2 --all --dry-run
pnpm yorm project --mapping fhir.Patient@2 --all
```

---

## Projection trigger policy (autosave)

Collaboration and projection have different tempos. Every keystroke should reach other clients immediately, but most relational consumers do not need a row version per keystroke.

YORM therefore separates the two:

- Yjs updates are always persisted immediately. Collaboration, offline merge, and document versioning are never delayed.
- The projection commit is gated by a per-session trigger policy.

| Policy         | Projection runs                                               |
| -------------- | ------------------------------------------------------------- |
| `every-change` | After every persisted document change.                        |
| `on-blur`      | When the client signals that a field or form lost focus.      |
| `idle`         | After a configurable quiet period (default 30 seconds).       |
| `explicit`     | Only when the client requests a flush, such as a Save button. |

While a policy defers projection, changes coalesce. When the trigger fires, YORM projects the latest document state once and the checkpoint records the document version range covered. Typing a sentence into a text field under `idle` produces one projection transaction, not one per character.

Deferred state is observable: the projection-state endpoint reports pending unprojected changes, and an explicit flush endpoint forces projection now. The server sets a default policy and a maximum-lag cap, so `explicit` sessions cannot defer projection indefinitely.

This reduces SQL churn and table versioning noise without weakening the CRDT collaboration path.

---

## Mapping versions and schema evolution

Mappings are immutable once released.

```ts
defineMapping({
  name: "fhir.Patient",
  version: 2,
  // ...
});
```

Changing a projection creates a new version. YORM tracks which document version was processed by which mapping version.

A normal relational evolution workflow is:

1. add or migrate relational tables;
2. add a new mapping version;
3. run a dry plan against representative documents;
4. replay the mapping over existing documents;
5. verify counts, constraints, and checksums;
6. cut relational consumers over; and
7. retire the old projection version when safe.

The canonical documents do not need to be rewritten merely because a reporting or integration schema changed.

This is the primary advantage of late-bound relationalization.

---

## Reverse synchronization

> **Deferred** ([PLAN.md Decision #3](PLAN.md#decisions-finalized-2026-07-15)): reverse sync — the outbox, `editable(...)`, and database triggers described in this section — is not implemented in the current phase. The lossless thesis is proven via import plus forward projection round trips. This section documents the roadmap design.

Some relational projections are editable. Others are not.

YORM makes directionality explicit:

```ts
defineMapping({
  name: "fhir.Patient",
  version: 2,

  direction: "bidirectional",

  // ...
});
```

Supported projection directions are:

| Direction       | Meaning                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `forward`       | Document changes update relational rows. SQL rows are read-only projections.                     |
| `bidirectional` | Approved relational changes can become semantic document transactions.                           |
| `computed`      | The table contains derived or aggregate values and is never mapped backward.                     |
| `external`      | Selected values are owned by another system and imported into the document under explicit rules. |

### Why triggers do not rewrite the blob

A Yjs document is not merely JSON stored as bytes. Its encoded state contains CRDT structure and causal information.

A database trigger must not deserialize, patch, and replace a Yjs blob as though it were an ordinary JSON column.

Instead, triggers write a change intent to an outbox:

```text
SQL UPDATE
    |
    v
yorm_change_outbox
    |
    v
YORM reverse mapper
    |
    v
semantic Yjs transaction
    |
    v
normal forward projection
```

Example outbox fields:

```text
id
document_id
source_table
operation
row_key
changed_values
expected_document_version
actor
created_at
processed_at
status
error
```

The reverse mapper receives the latest `Y.Doc`, applies the business-level mutation, and lets Yjs generate the actual CRDT update.

```ts
import { editable } from "@yorm/core";

export const editablePatient = editable({
  table: patients,

  onUpdate({ change, object }) {
    if ("active" in change.values) {
      object.active = change.values.active;
    }

    if ("birthDate" in change.values) {
      object.birthDate = change.values.birthDate;
    }
  },
});
```

Not every table is meaningfully reversible. An aggregate such as `open_condition_count` cannot necessarily be translated into one unambiguous FHIR mutation. Those projections should remain forward-only or computed.

---

## Preventing feedback loops

Every write carries an origin and causation identifier.

Common origins include:

```text
yjs
sql
projection
replay
migration
external-import
repair
```

A projection transaction marks its writes as `projection`. Database triggers ignore projection-originated changes.

A SQL-originated outbox event becomes a Yjs transaction with the outbox record as its causation ID. When that document is projected again, the system recognizes the causal chain and does not emit a second reverse change.

YORM records enough provenance to answer:

- who changed the data;
- which representation initiated the change;
- which mapping version ran;
- which document version was read;
- which rows were written;
- whether an optimistic precondition failed; and
- whether the resulting projection converged.

---

## Conflict semantics

Yjs resolves concurrent CRDT operations. It does not invent business rules for arbitrary SQL edits.

For bidirectional tables, a mapping can define:

- optimistic document-version checks;
- field-level preconditions;
- last-observed values;
- merge functions;
- conflict queues;
- rejection rules; or
- manual review.

For example, a DBA may update one address row while a clinician edits the same Patient resource in a browser. The reverse mapper applies the SQL edit to the latest document state, not to a stale serialized copy.

If the target element no longer exists, the mapping decides whether to:

- recreate it;
- reject the change;
- attach it as a new element;
- or send it to conflict review.

These are domain semantics and belong in the mapping, not in a generic database trigger.

---

## Proposed changes (suggestion mode)

Not every collaborator should write directly. YORM supports a suggestion workflow in which one user edits the canonical document while another can only propose changes. Relational tables reflect accepted state only.

Proposals are semantic change intents stored in a separate subtree of the same `Y.Doc`:

```text
yorm:proposals
--------------
id
path
op                    set | insert | remove
proposed_value
base_value
base_document_version
actor
status                proposed | accepted | rejected | superseded
resolved_by
resolved_at
```

Because proposals live in the document, they sync, merge, and work offline like any other CRDT state. Because the codec materializes only the canonical subtree, the projection engine never sees an unaccepted change, so no pending proposal ever reaches a relational row.

The lifecycle is:

1. A proposer records a change intent. The canonical resource is untouched.
2. Reviewers see the proposal in every connected client.
3. Accepting applies the intent to the canonical subtree and marks the proposal accepted in one atomic Yjs transaction. Projection then runs under the normal trigger policy.
4. Rejecting marks the proposal rejected and changes nothing else.
5. If the canonical value moved after the proposal was made, the stale proposal surfaces as a conflict for the application to resolve.

Roles are enforced server-side: the authorization hook can grant a session write access to the proposals subtree while refusing direct canonical edits. Note that this is **write** authorization only — every participant in the document can read all of it, including other users' pending proposals (see [Security](#security)).

Open proposals can themselves be projected into a forward-only tracking table, giving DBAs and reports visibility into pending suggestions using the same mapping engine.

Whole-document branch proposals (forking a `Y.Doc` and merging on approval) are a possible future extension; the intent-based model above is the supported v1 design.

---

## Security

YORM treats each Yjs `Y.Doc` as an **authorization boundary**. Any client permitted to synchronize a document must be assumed capable of inspecting _all_ content synchronized into that document — the CRDT state a provider replicates is the whole document, not the fields a UI chooses to render. Hiding fields in the user interface or filtering them in client-side code is not a confidentiality control, and Yjs explicitly notes that read/write permissions cannot practically be enforced within a single `Y.Doc`.[^yjs-permissions]

This has two concrete consequences for YORM deployments:

- **Suggestion mode is write authorization, not confidentiality.** The proposals subtree lives in the same `Y.Doc` as the canonical resource, so a proposer — or any synchronized reader — sees the full canonical state and every other participant's pending proposals. The server-side write-mode hook (and the WebSocket guard that refuses proposers' canonical edits) controls who may _change_ what; it cannot hide anything.
- **Content with different audiences belongs in different documents.** Store separately authorized material — shared, staff-only, counsel-only, participant-specific — in separate, independently authorized documents or subdocuments, each with its own projections.[^yjs-subdocuments] A document is YORM's consistency boundary _and_ its confidentiality boundary.

When per-role redaction of one logical document is needed, YORM's **role policies** (policy lens, POC) apply the "different documents" rule automatically: a developer-defined `RolePolicy` (`view`/`canWrite`/`mergeWrite`) gives each role a server-held _derived_ `Y.Doc` holding only its view, with every write validated before it reaches canonical state. See [@yorm/yjs](packages/yjs/README.md#role-policies--the-policy-lens-role-security-poc) for the lens and [@yorm/hono](packages/hono/README.md#role-policies-policy-lens-role-security-poc) for the transport wiring.

Authentication and authorization are the collaboration server's job, enforced on every document connection: verify read access before sending any state or updates, and reject incoming updates unless the participant has write permission for the targeted subtree. In `@yorm/hono` these are the `onAuthorize` (connection/read) and `onAuthorizeWrite` (canonical vs. proposals scope) hooks. Room identifiers, client-side logic, and UI visibility rules are not security boundaries. Yjs documents `y-websocket` as the natural centralized point for authentication and authorization, and its threat model assigns authentication, transport security, and server-side read/write access control to the application.[^yjs-websocket][^yjs-threat-model]

Encryption, auditing, tenant isolation, retention, and regulatory controls remain deployment responsibilities (see "Protect PHI" above).

[^yjs-permissions]: [Yjs FAQ: Structuring data in smaller YDocs](https://docs.yjs.dev/api/faq#structuring-data-in-smaller-ydocs)

[^yjs-subdocuments]: [Yjs documentation: Subdocuments](https://docs.yjs.dev/api/subdocuments)

[^yjs-websocket]: [Yjs documentation: y-websocket](https://docs.yjs.dev/ecosystem/connection-provider/y-websocket)

[^yjs-threat-model]: [Yjs Threat Model](https://github.com/yjs/yjs/blob/main/THREAT_MODEL.md)

---

## Column and table ownership

A mapping only updates columns it owns.

```text
patient
+-------------------------+----------------------+
| column                  | owner                |
+-------------------------+----------------------+
| id                      | shared key           |
| active                  | fhir.Patient mapping |
| birth_date              | fhir.Patient mapping |
| reporting_region        | DBA                  |
| warehouse_surrogate_id  | warehouse            |
+-------------------------+----------------------+
```

This lets DBAs add operational or warehouse-managed columns without having them overwritten during replay.

Ownership can be declared per:

- table;
- column;
- relationship;
- row set; or
- computed value.

Mappings should avoid `SELECT *`, whole-row replacement, and unconstrained deletes. Projection plans are explicit about what they own.

---

## Stable identity

Every nested object that becomes a row needs a stable identity.

Good:

```json
{
  "address": [
    {
      "id": "addr-4e28",
      "use": "home",
      "city": "Indianapolis"
    }
  ]
}
```

Unsafe:

```json
{
  "address": [
    {
      "use": "home",
      "city": "Indianapolis"
    }
  ]
}
```

Array index is not identity. Reordering an array must not appear to delete and recreate every row.

For FHIR, YORM can derive element identity from:

1. an explicit element `id`;
2. a configured business key;
3. a durable Yjs item identity recorded on ingestion; or
4. a mapping-defined identity function.

Identity policy is part of the mapping contract and must remain stable across mapping versions.

---

## Source codecs

YORM maps materialized objects, not only JSON strings.

A codec defines how a domain representation enters and leaves a Yjs document.

```ts
interface DocumentCodec<T> {
  decode(input: Uint8Array | string): T;
  encode(value: T): Uint8Array | string;

  read(doc: Y.Doc): T;
  write(doc: Y.Doc, value: T): void;
}
```

Built-in and custom codecs can support:

### JSON

Maps ordinary objects, arrays, and scalar values into Yjs structures.

### XML (roadmap)

Preserves element order, attributes, namespaces, and repeated nodes according to the codec policy. Applications that require byte-for-byte XML round trips should retain the original payload alongside the materialized object.

### FHIR JSON and XML

Normalizes both encodings into the same resource-level object model while retaining source metadata and FHIR element identity.

### Custom formats

Protocol messages, configuration languages, domain-specific records, or legacy payloads can provide their own codecs.

The relational mapper only requires a deterministic materialized object and stable identity rules.

---

## Persistence model

A common SQL layout is:

```text
yorm_document
--------------
document_id
document_type
encoded_state
json_snapshot
original_payload
document_version
codec_version
created_at
updated_at

yorm_update
-----------
update_id
document_id
document_version
encoded_update
actor
origin
created_at

yorm_projection_state
---------------------
document_id
mapping_name
mapping_version
source_document_version
status
projected_at
error

yorm_change_outbox
------------------
outbox_id
document_id
source_table
operation
row_key
changed_values
expected_document_version
actor
status
created_at
processed_at
error
```

A deployment may store only snapshots, snapshots plus updates, or updates plus periodic compaction. (`yorm_change_outbox` is roadmap — deferred with reverse synchronization.)

The relational projections themselves live in application-owned tables rather than a generic entity-attribute-value store.

---

## Replay and repair

Because the canonical document is preserved, relational state is disposable and recoverable.

YORM can:

- replay one document;
- replay one document type;
- replay one mapping version;
- replay only stale checkpoints;
- rebuild one projection table;
- compare planned rows with stored rows;
- verify idempotency;
- emit checksums; and
- quarantine projection failures.

> Implemented today: `replayProjections(yorm)` (full or per-type rebuild) and `retryFailedProjections(yorm)` (re-run quarantined failures) in `@yorm/yjs`. The CLI below is roadmap.

```bash
pnpm yorm inspect Patient/patient-123
pnpm yorm plan Patient/patient-123 --mapping fhir.Patient@2
pnpm yorm verify --mapping fhir.Patient@2
pnpm yorm repair --stale
```

Projection failures do not corrupt the canonical document. They are recorded and can be retried after the mapping or relational schema is corrected.

---

## Consistency guarantees

Within a single projection run, YORM applies all changes for one document and mapping in a database transaction.

YORM guarantees that:

- a successful checkpoint corresponds to a committed projection transaction;
- replaying the same document version and mapping version is idempotent;
- mapping-owned collections are reconciled, not merely appended;
- projection-originated writes do not become reverse-sync loops; and
- failed projections do not advance the checkpoint.

Cross-document transactions depend on the selected database and application design. YORM treats a document as the default consistency boundary.

---

## FHIR-specific patterns

### Project only what is useful

Do not normalize every possible FHIR path preemptively. Keep the complete resource and project fields needed for:

- patient matching;
- operational workflows;
- reporting;
- quality measures;
- search acceleration;
- authorization;
- billing integration; or
- analytics.

### Preserve extensions

Extensions remain in the canonical resource. Frequently queried extensions can be projected into typed tables or an extension index.

### Treat references intentionally

A FHIR `Reference` can be projected as:

- the literal reference string;
- parsed resource type and logical ID;
- an internal foreign key when resolvable;
- a versioned reference;
- or an unresolved external reference.

YORM does not assume every FHIR reference is a valid local foreign key.

### Validate outside the projection engine

FHIR profile validation, terminology validation, consent rules, and clinical business rules should run before or during document transactions. A relational projection succeeding does not imply that a resource is clinically or profile-valid.

### Protect PHI

YORM supplies mapping and synchronization infrastructure. Encryption, auditing, access control, tenant isolation, retention, key management, backups, and regulatory controls remain deployment responsibilities.

---

## When to use YORM

YORM is a strong fit when:

- the canonical domain model is naturally object-shaped;
- users collaborate or work offline;
- preserving the complete serialized object matters;
- relational access is still required;
- the relational model will evolve independently;
- DBAs need to add indexes, tables, and views later;
- projections must be rebuilt from source;
- only some relational tables should be editable; or
- a system must bridge CRDT state with existing SQL infrastructure.

Examples include:

- FHIR and healthcare records;
- collaborative forms;
- case management;
- product and configuration catalogs;
- claims or eligibility documents;
- regulated workflow records;
- complex application settings;
- engineering models;
- content systems; and
- integration hubs.

---

## When not to use YORM

YORM may be unnecessary when:

- the relational schema is already the natural canonical model;
- no object fidelity must be preserved;
- collaboration and offline edits are not required;
- a simple JSONB column and a few indexes solve the problem;
- every write must be an ordinary SQL transaction across many aggregates; or
- the projected tables cannot tolerate eventual consistency and inline projection is too expensive.

Use the simplest architecture that preserves the semantics your system needs.

---

## Non-goals

YORM does not attempt to:

- replace Yjs;
- hide SQL from database engineers;
- turn every relational table into an editable document view;
- infer reversible mappings automatically;
- treat array order as identity;
- mutate Yjs binary state from SQL triggers;
- replace a FHIR server, validator, or terminology service;
- guarantee that arbitrary SQL edits have meaningful object semantics; or
- force one database, ORM, web framework, or runtime.

---

## Mental model for new contributors

The project has seven main concepts.

### `Runtime`

Owns active Yjs documents and routes live updates.

### `DocumentStore`

Persists snapshots, incremental updates, document versions, and source metadata.

### `Codec`

Converts a serialized domain format into a materialized object backed by Yjs structures.

### `Mapping`

Declares how one document type and mapping version becomes relational rows, and optionally how selected row changes map back.

### `ProjectionPlanner`

Produces a deterministic, database-independent plan of upserts, deletes, and assertions.

### `ProjectionStore`

Applies a projection plan transactionally through Drizzle or another database adapter.

### `OutboxProcessor`

Turns approved relational change events into semantic Yjs transactions.

Most bugs belong clearly to one of these boundaries. Keep them separate.

---

## Repository layout

```text
.
├── packages
│   ├── core
│   │   ├── mapping
│   │   ├── planner
│   │   ├── replay
│   │   └── provenance
│   ├── yjs
│   │   ├── runtime
│   │   ├── codecs
│   │   └── transactions
│   ├── hono
│   │   ├── http
│   │   └── websocket
│   ├── drizzle
│   │   ├── document-store
│   │   └── projection-store
│   ├── fhir
│   │   ├── codecs
│   │   ├── identity
│   │   └── paths
│   └── cli
├── examples
│   ├── basic-json
│   ├── fhir-patient
│   ├── postgres-hono
│   └── cloudflare-durable-objects
├── fixtures
│   ├── fhir-r4
│   └── generic-json
└── docs
```

---

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

Run the local PostgreSQL example:

```bash
docker compose up -d postgres
pnpm --filter @yorm/example-fhir-patient db:migrate
pnpm --filter @yorm/example-fhir-patient dev
```

Run the full test suite:

```bash
pnpm test
```

Run mapping golden tests:

```bash
pnpm test:mappings
```

---

## Testing mappings

Mappings should be tested as deterministic transforms.

At minimum, test:

1. a new document;
2. optional fields;
3. repeated elements;
4. element removal;
5. collection reorder;
6. null and absent values;
7. unknown extensions;
8. mapping replay;
9. idempotent second projection;
10. reverse mapping;
11. reverse conflicts; and
12. column ownership.

A useful golden test compares:

```text
input object
    ->
projection plan
    ->
expected rows and deletes
```

A round-trip test additionally checks:

```text
SQL change
    ->
outbox event
    ->
Yjs transaction
    ->
materialized object
    ->
new projection
```

---

## Design principles

1. **The object is real.** It is not reconstructed from rows on every read.
2. **Rows are projections.** They are valuable, queryable, and rebuildable.
3. **Mappings are versioned.** Released mapping behavior does not change silently.
4. **Identity is explicit.** Array position is never a primary key.
5. **Deletes are first-class.** Projection means reconciliation, not append-only upserts.
6. **Ownership is declared.** YORM updates only the tables, rows, and columns it owns.
7. **Reverse mapping is selective.** Not every projection is editable.
8. **Triggers emit intent.** They do not rewrite CRDT state.
9. **Replays are normal.** Schema evolution is an expected operational workflow.
10. **Provenance is mandatory.** Every cross-model change is traceable.
11. **Adapters are replaceable.** Hono, Drizzle, and any specific runtime are integrations, not the architecture.
12. **FHIR is a proving ground, not a constraint.** The core works with any deterministic object codec.

---

## The one-sentence version

**YORM keeps the collaborative object your application wants and continuously produces the relational database your organization needs.**
