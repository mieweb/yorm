# SQL Projection Panel — Toast + Cell Flash

When SQLite rows update: show a short-lived toast near the panel and flash the changed cells.

No new dependencies. All state local to `ProjectionPanel`. No Zustand store changes.

---

## Phase 1 — Toast Banner — committed `8e90fa1`

- [x] **`i18n.ts`** — add `"rows.updated": "SQL rows updated"` (short toast copy)
- [x] **`ProjectionPanel.tsx`** — add `previousRows = useRef<RowsSnapshot | null>(null)` to track last snapshot
- [x] **`ProjectionPanel.tsx`** — add `const [toastVisible, setToastVisible] = useState(false)`
- [x] **`ProjectionPanel.tsx`** — `useEffect` on `rows`: skip first load (prevRef is null), on real change set toast visible, schedule `setTimeout` to hide after 3 000 ms, update `previousRows.current`
- [x] **`ProjectionPanel.tsx`** — render the `.projection-toast` div inside `.projection-panel`. Marked `aria-hidden="true"` rather than `aria-live` — the app shell's live region already announces `"announce.rowsUpdated"`, so a live toast would double-announce.
- [x] **`projection-panel.scss`** — `.projection-toast`: absolute top-right of panel, pill shape, `opacity: 0` + `transform: translateY(-8px)` by default; `--visible` modifier transitions to `opacity: 1` + `translateY(0)`

## Phase 2 — Cell Flash Animation — committed `f1640dd`

- [x] **`ProjectionPanel.tsx`** — add `const [changedCells, setChangedCells] = useState<ReadonlySet<string>>(new Set())` — keys: `"tableName:rowIndex:column"`
- [x] **`ProjectionPanel.tsx`** — `diffCells(previous, next)` compares per table / row index / column; a row index missing from the previous snapshot flags all its columns
- [x] **`ProjectionPanel.tsx`** — `setChangedCells(diffCells(...))` then `setTimeout(() => setChangedCells(new Set()), 1500)` to clear after animation
- [x] **`ProjectionPanel.tsx`** — pass `changedCells` into `RowsTable` as a prop
- [x] **`RowsTable`** — `data-changed` on `<TableCell>` when the cell key is in `changedCells`
- [x] **`projection-panel.scss`** — `@keyframes flash-update` (primary highlight → transparent) on `[data-changed]`, `1.4s ease-out forwards`; `prefers-reduced-motion` falls back to a static outline

## Phase 3 — Show the actual SQL — committed `3fa6ee4`, `0aac05a`

The toast said *that* rows changed; this makes it say *what ran*.

- [x] **`packages/drizzle/src/sqlite.ts`** — optional `onStatement` forwarded to
      better-sqlite3's `verbose` hook. That hook is the only place the
      fully-expanded statement exists — values inlined, not `?` placeholders.
- [x] **`examples/fhir-patient-contacts/src/setup.ts`** — pass `onStatement`
      through `PocServerOptions` to the adapter
- [x] **`examples/patient-collab-demo/src/server.ts`** — `recordStatement` keeps a
      100-entry ring buffer, filtered to insert/update/delete against the
      projection tables (`verbose` also fires for every read); served by
      `GET /api/sql?since=N`
- [x] **`api.ts` / `store.ts`** — `fetchSql(lastSqlSeq)` alongside the rows poll;
      new statements are **buffered** until the poll that actually sees the rows
      change, then flushed into `sqlStatements`
- [x] **`ProjectionPanel.tsx`** — toast lists the first 4 statements plus a
      `+N more` line; `TOAST_MS` raised to 6 000 ms to leave time to read them
- [x] **`i18n.ts`** — `"rows.moreStatements": "+{count} more"`
- [x] **`projection-panel.scss`** — toast moved into the panel flow. Floating at
      the top-right it covered the very rows it was pointing at.

## Phase 4 — SQL attributed to the commit, not scraped — committed `a801fa8`

Phase 3 read better-sqlite3's `verbose` hook: a global stream of *every*
statement the driver ran, reads included, filtered back down by verb and table
name. It could not say which document change set a statement belonged to.

`applyPlan` is already the per-commit boundary — one plan, one transaction, one
document version — so the SQL is captured there instead.

- [x] **`packages/drizzle/src/projection-store/index.ts`** — render each plan
      operation with the public `SQLiteSyncDialect.sqlToQuery` before running it;
      hand the set to `options.onCommit` as a `ProjectionCommit`
      (`mapping`, `documentId`, `documentType`, `documentVersion`, `origin`,
      `statements`). Emitted *after* the transaction, so a rollback reports
      nothing.
- [x] **`packages/drizzle/src/sqlite.ts`** — `onStatement` / the `verbose` hook
      deleted; the adapter already forwards `options.projections`
- [x] **`examples/patient-collab-demo/src/server.ts`** — `/api/sql` returns
      commits, not a flat statement stream; no verb/table-prefix guessing
- [x] **client** — buffers commits; the toast titles itself
      `SQL rows updated · document v{version}`
- [x] **tests** — one commit per plan carrying that plan's statements; nothing
      emitted when the transaction throws

Trade-off: `sqlToQuery` returns the parameterized SQL plus its bindings, which
is what the engine actually sends. The demo inlines the parameters for display
only (`displaySql`), never for execution.

## Verification

- [x] `pnpm --filter patient-collab-demo typecheck` passes with no new errors
- [x] `pnpm lint` clean
- [x] Edit a patient field → toast appears near the projection panel and auto-dismisses
- [x] Changed cells flash a highlight, then return to normal
- [x] First load (null → initial data) does **not** show the toast

Verified in the browser against the dev server, editing `Given names` / `Family name`:

| check | result |
| --- | --- |
| toast text / visibility | `"SQL rows updated"`, `.projection-toast--visible` present |
| cells marked | exactly one — `contact.first`, then `contact.last` — never the whole row |
| flashed cell computed style | `animation-name: flash-update`, `background: rgba(33,156,85,1)`, `color: #fff` |
| flash clears | `[data-changed]` count 1 → 0 |
| toast auto-dismiss | `.projection-toast--visible` detaches on its own |
| first load | no toast on the initial snapshot |
| SQL shown | 4 statements + `+10 more`, first one is the real `insert into "contact" (...) values ('p-demo', 'Peter', 'Chalmers-Reid', ...) on conflict ("contact_id") do update set ...` with the edited value inlined |
| SQL on first load | empty — the seed's statements are history, not news |
| toast overlap | none: the `contact` row and its flashing cell stay visible below the toast |

Demo document restored to its seeded values afterwards
(`Peter` / `Chalmers` / `James`).

### Blocked: browser verification — resolved in `82b34e7`

`pnpm --filter patient-collab-demo dev` used to die before Vite served anything,
on a failure unrelated to this change:

```
Error: Build failed with 1047 errors:
  node_modules/@mieweb/ui/dist/chunk-*.js: ERROR: Transforming destructuring to
  the configured target environment ("chrome87", "edge88", "es2020", "firefox78",
  "safari14" + 2 overrides) is not supported yet
```

esbuild 0.28.1 refuses to transform `@mieweb/ui` (and `luxon`) to Vite's default
`optimizeDeps` target. The root `pnpm.overrides.esbuild` range was open-ended
(`>=0.25.0`), so pnpm forced 0.28.1 onto Vite 6.4, which is built against 0.25.x.
Capping it at `^0.25.0` stays above the security advisory and restores `pnpm dev`.
