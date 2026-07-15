# patient-collab-demo

A collaborative FHIR **Patient** editor (PLAN.md Milestones 6 + 7c): two browsers
edit the same Patient live over Yjs, while a SQLite projection panel shows the
relational `contact*` rows the YORM projection engine derives from the canonical
document — committed according to a selectable autosave policy. A role switcher
turns a browser into a **proposer** whose edits become reviewable suggestions
instead of direct writes.

What it demonstrates:

- **6a — Yjs ⇄ Zustand bridge** ([src/client/store.ts](src/client/store.ts)): the
  `Y.Doc` is the single source of truth. The store's `patient` slice is just
  `doc.getMap("resource").toJSON()` refreshed on every doc update; actions mutate
  Y types inside `doc.transact`. Awareness feeds a presence slice
  (`{clientId, name, color, focusedField}`).
- **6b — eSheet Patient form** ([src/client/components/PatientForm.tsx](src/client/components/PatientForm.tsx)):
  the form is rendered by `@esheet/renderer` from a `FormDefinition` built from
  [src/client/patientFields.ts](src/client/patientFields.ts) (given/family names,
  birth date, phone, email). The eSheet form store and the Yjs-backed store are
  wired both ways, writing only when a value actually differs (echo-safe).
- **6c — UI shell** with `@mieweb/ui`: presence avatars, connection status, the
  autosave-policy dropdown, Save button (explicit mode), an "unsaved projection
  changes" indicator, and the live SQLite rows panel (polled every 750 ms).
- **6d — Playwright e2e** ([tests/](tests/)): convergence across two browser
  contexts and policy semantics (explicit → rows only after Save; on-blur →
  rows after blur).
- **7c — Suggestion mode** ([src/client/components/ReviewPanel.tsx](src/client/components/ReviewPanel.tsx)):
  an editor/proposer role switcher, pending-suggestion chips on the form, an
  accept/reject review list, and the `yorm_proposal` tracking table in the
  rows panel — see [Roles & proposed changes](#roles--proposed-changes-m7c).

## One-command startup

```sh
pnpm --filter patient-collab-demo dev
```

This runs the YORM server (tsx, port **5178**) and the Vite dev server (port
**5173**, proxying `/yorm` + `/api` + WebSockets to 5178) concurrently. Open
http://localhost:5173 in two windows to collaborate.

Production mode (single port, used by the e2e suite):

```sh
pnpm --filter patient-collab-demo build   # vite build → dist/
pnpm --filter patient-collab-demo start   # serves client + API on :5178
```

## Data flow

```mermaid
graph LR
  subgraph BrowserA["Browser A (editor)"]
    FormA["eSheet Patient form"] <--> StoreA["Zustand store"] <--> DocA["Y.Doc"]
    ReviewA["Review list (accept/reject)"]
  end
  subgraph BrowserB["Browser B (proposer)"]
    FormB["eSheet Patient form"] <--> StoreB["Zustand store"] <--> DocB["Y.Doc"]
  end
  DocA <-->|"y-websocket /yorm/ws/Patient/p-demo?role=editor"| ServerDoc["Server Y.Doc (canonical + yorm:proposals)"]
  DocB <-->|"y-websocket ?role=proposer (canonical writes refused)"| ServerDoc
  StoreB -.->|"POST /proposals (change intent)"| Proposals["yorm:proposals subtree"]
  Proposals --- ServerDoc
  ReviewA -.->|"POST /proposals/:pid/accept | reject"| Proposals
  ServerDoc --> Scheduler["Projection scheduler (trigger policy)"]
  Scheduler --> Mapping["fhir.Patient@1 mapping (canonical subtree only)"]
  Scheduler --> Tracking["yorm.proposals@1 tracking mapping"]
  Mapping --> Sqlite[("SQLite contact* tables")]
  Tracking --> ProposalTable[("yorm_proposal table")]
  Sqlite -->|"GET /api/rows (poll 750 ms)"| PanelA["Rows panel A"]
  ProposalTable -->|"GET /api/rows"| PanelA
  Sqlite -->|"GET /api/rows"| PanelB["Rows panel B"]

  classDef doc fill:#e0e7ff,stroke:#4338ca;
  classDef store fill:#dcfce7,stroke:#15803d;
  classDef proposal fill:#fef3c7,stroke:#b45309;
  class DocA,DocB,ServerDoc doc;
  class Sqlite,ProposalTable store;
  class Proposals,ReviewA proposal;
```

The server ([src/server.ts](src/server.ts)) reuses the whole POC stack from
[examples/fhir-patient-contacts](../fhir-patient-contacts/README.md)
(`createPocServer` + `seedContacts`) and adds the demo roles
(`onAuthorizeWrite`), the `yorm_proposal` tracking projection
(`proposalTrackingMapping`), `GET /api/rows`, and static serving of the built
client.

## Autosave policies

Selected in the header dropdown → `POST /yorm/docs/Patient/p-demo/policy`.
Document sync over Yjs is **always live**; the policy only controls when the
SQLite projection commits.

| Policy       | Projection commits…                                   |
| ------------ | ----------------------------------------------------- |
| Every change | on every document update (default)                    |
| On blur      | when a field blur posts `POST …/signal {kind:"blur"}` |
| Idle (30 s)  | after 30 s without edits                              |
| Explicit     | only when the Save button posts `POST …/flush`        |

The "unsaved projection changes" indicator polls
`GET /yorm/docs/Patient/p-demo/projection-state`.

## Roles & proposed changes (M7c)

The header's **Role** select switches between:

| Role     | Canonical writes | Proposals                      |
| -------- | ---------------- | ------------------------------ |
| Editor   | direct (Yjs)     | reviews: accept / reject       |
| Proposer | refused          | creates via `POST …/proposals` |

This is demo-level auth: the client claims its role via `?role=` on the
WebSocket URL and an `X-Demo-Role` header on REST calls; the server's
`onAuthorizeWrite` hook lets proposers write only the `"proposals"` scope
(canonical PUT/PATCH/accept/reject get 403). The `@yorm/hono` plugin
additionally guards `?role=proposer` WebSocket connections server-side: a sync
update that would change the canonical subtree is refused and the socket is
closed with 1008 — proposer edits can never leak into the document.

The proposals flow: a proposer's field edits are debounced into semantic
change intents (`{ path, op: "set", proposedValue, actor }`, path taken from
the field spec in [src/client/patientFields.ts](src/client/patientFields.ts))
and stored in the `yorm:proposals` subtree of the same Y.Doc. Pending
suggestions render as chips under the form plus an outline on the affected
input (linked via `aria-describedby`, announced through the aria-live
region). Editors see them in the **Suggested changes** review list (proposed
vs. base value, actor) with Accept / Reject; a stale accept (the canonical
value changed since the proposal, HTTP 409) surfaces an inline "changed since
proposed" state offering **Accept anyway** or Reject. Because the document
codec materializes only the canonical subtree, the `contact*` rows never see
an unaccepted change — while the `yorm_proposal` tracking table (also in the
rows panel) shows every intent and its status live: pending → a
`yorm_proposal` row appears but contact rows are unchanged; accept → contact
rows update and the row flips to `accepted`; reject → only the status
changes.

## Accessibility & i18n

- All interactive elements have ARIA labels; presence and row updates are
  announced through an `aria-live="polite"` region; focus indicators are
  visible.
- Every user-facing string lives in [src/client/i18n.ts](src/client/i18n.ts)
  (`t(key)` lookup, English defaults) — no hardcoded literals in components.
- Styling is per-component SCSS using only `--mieweb-*` design tokens.

## Notes

- `@esheet/renderer@0.0.3` declares a React ≥ 19 peer but uses no 19-only
  APIs; the demo runs it on React 18 with Vite `resolve.dedupe` for
  react/react-dom.
- The phone field uses eSheet's plain `string` input type (not `tel`): the tel
  mask assumes US numbers and corrupts the fixture's international value.

![The collaborative Patient editor: eSheet form with the autosave policy dropdown on the left, live SQLite projection rows on the right](docs/screenshot.png)

## Tests

```sh
pnpm --filter patient-collab-demo typecheck
pnpm --filter patient-collab-demo test:e2e   # Playwright (chromium)
```

The e2e config builds the client and runs the single prod server on :5178 for
determinism. Specs live in `tests/` so the root vitest suite (which globs
`test/**/*.test.ts`) does not pick them up.
