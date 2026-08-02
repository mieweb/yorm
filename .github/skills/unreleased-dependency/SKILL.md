---
name: unreleased-dependency
description: 'Depend on an unreleased or unmerged change in a third-party package while its pull request is pending. Use when you need a fix or feature that only exists on a branch, when you must patch a dependency and upstream it, when asked to vendor/fork/link a package, or when wiring a git submodule dependency into a build. Covers submodule pinning, link:/file: resolution, building from source, CI wiring, and unwinding once the PR ships. DO NOT USE for ordinary version bumps of published packages.'
argument-hint: 'The package you need to change and what change it needs'
---

# Depending on an Unmerged Upstream Change

You need behavior that only exists on a branch — your own PR against a
dependency, or someone else's unmerged work. You want it wired in *today*
without creating something painful to unwind *later*.

## When to Use

- A required fix or feature is not in any published release.
- You must modify a dependency and want the change to land upstream.
- You are asked to "fork", "vendor", "patch", or "link" a package.

**Not for**: bumping a published version, or a change you never intend to
upstream (that is a real fork — different problem, different trade-offs).

## The Core Idea

"Depend on unreleased code" is three independent questions. Answer each with
the tool built for it and the setup stays boring; conflate them and you get
hacks that are hard to remove.

| Question | Tool | Failure if you use the wrong tool |
|---|---|---|
| Which revision of the source? | git submodule | Copy-paste drifts silently |
| How does the import specifier resolve? | package manager (`link:` / `file:`) | Bundler aliases that only one tool reads |
| How does source become a loadable module? | the dependency's own build | Committed build artifacts nobody can verify |

Paths below assume the consuming project is at the repository root and the
dependency lives at `vendor/<dep>`.

## Procedure

### 1. Upstream first

Branch the dependency's repo and open the PR **before** wiring anything up.
The whole approach depends on your change being on a branch you can point at,
and it keeps the change reviewable while you use it.

### 2. Pin the revision

```sh
git submodule add -b <pr-branch> https://github.com/<org>/<dep> vendor/<dep>
```

Your repo now records an exact SHA in its tree. Everyone gets the same code,
and edits made in `vendor/<dep>` are committed to the PR branch — not stranded
in your repo as an unreviewable copy.

### 3. Build it with *its* package manager

```json
"scripts": {
  "dep:build": "cd vendor/<dep> && pnpm install --frozen-lockfile && pnpm build"
}
```

Read the dependency's `packageManager` field and lockfile and match them. Using
npm on a pnpm project (or vice versa) resolves a different tree than upstream
tests against and writes a stray lockfile that the dependency does not
gitignore — which shows up forever as `modified: vendor/<dep> (untracked
content)` in your `git status`.

Its `node_modules` stays separate from yours. That is a feature: conflicting
overrides between the two projects never collide.

### 4. Resolve the specifier with `link:`

```json
"dependencies": {
  "@scope/pkg": "link:../vendor/<dep>"
}
```

pnpm symlinks `node_modules/@scope/pkg` at the submodule. Use `file:` for
npm/yarn (npm symlinks local paths rather than copying).

Every tool — bundler, `tsc`, test runner, plain Node — now resolves through the
package's real `exports` map, including subpaths like `@scope/pkg/styles.css`.

**Do not** hand-roll this with bundler aliases and `tsconfig.paths`. That
duplicates an `exports` map the package already ships, in two places, neither of
which the test runner or Node reads. It also resolves worse: a regex pointed at
one entry file tree-shakes less than the real export conditions.

### 5. Wire CI and docs

Build output is gitignored in the dependency, so it does not exist on a fresh
clone. Add the build step **before** anything that typechecks or bundles:

```yaml
- uses: actions/checkout@v4
  with: { submodules: true }
- run: pnpm install --frozen-lockfile
- run: pnpm dep:build
- run: pnpm typecheck && pnpm build
```

Document the same two commands (`git submodule update --init`, `pnpm dep:build`)
in the README, and record *why* the submodule exists with a link to the PR.

### 6. Commit the pointer and verify

Stage the submodule path explicitly, then confirm a clean tree:

```sh
git add vendor/<dep> package.json <lockfile>
git status --short          # expect no submodule noise
```

Verify resolution really goes through the package, not a leftover alias: run
typecheck, build, and the test suite. A passing bundler build alone does not
prove `tsc` or the test runner can resolve it.

### 7. Unwind when the PR merges

```json
"dependencies": { "@scope/pkg": "^1.2.0" }
```

Then `git submodule deinit -f vendor/<dep>`, remove it from `.gitmodules`, and
delete the build script and its CI step. Nothing to reconcile, no fork to
rebase.

**This is the test for any stopgap: how much work is it to undo?** Prefer the
shape that deletes cleanly over the shape that is fastest to add.

## Gotchas

- **Duplicate singletons.** The linked package brings its own copy of peer-ish
  libraries (React, and anything using module-level state). Dedupe them in the
  bundler or hooks/context break at runtime with confusing errors.
- **No watch mode.** Editing the dependency's source does nothing until you
  re-run its build. Say so in the README or people lose an hour.
- **Rewritten submodule commits orphan the pointer.** If you rebase or amend on
  the dependency branch, push it, then re-commit the pointer in the parent repo.
  Otherwise a fresh clone cannot init the submodule at all.
- **Nested submodules.** Some dependencies have their own. Check whether their
  install hook initializes them before assuming a non-recursive checkout is
  enough.
- **Long installs look hung.** Progress written with `\r` disappears behind
  `tail`/pipes, and a download-bound install shows near-zero CPU. Log to a file
  and inspect it before concluding anything is stuck.

## Anti-patterns

| Instead of | Do |
|---|---|
| Copying the component into your repo | Submodule + `link:`, so fixes go upstream |
| Committing the dependency's build output | Build it in CI; artifacts drift from the pinned SHA |
| Bundler alias + `tsconfig.paths` | `link:`, and use the shipped `exports` map |
| `npm link` / global links | Path-based `link:`/`file:`, reproducible for everyone |
| Publishing a scoped fork to the registry | Submodule; a fork you must maintain outlives the need |
| Whatever package manager you personally use | The one the dependency declares |
