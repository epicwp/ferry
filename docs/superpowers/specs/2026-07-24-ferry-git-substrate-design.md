# Ferry Plan 2 — Git Substrate + CLAUDE.md — Design

**Date:** July 24, 2026
**Status:** design, approved in brainstorming
**Builds on:** the shipped v0 pull skeleton (`feature/v0-pull-skeleton`, PR #1) and its plan `docs/superpowers/plans/2026-07-24-ferry-v0-pull-skeleton.md`
**Roadmap:** `docs/superpowers/plans/2026-07-24-ferry-roadmap.md` — this is the first slice of Plan 2 ("clone versioning & agent-readiness"). Provenance/speed and clone-fidelity (DB exclusions, license stubs, uploads materialization) are deliberately deferred to following plans.

## 1. Purpose & scope

Make every clone a git repository so an agent (Plan 4) can work on its own branch and `git diff production` shows exactly what would be pushed back (Plan 5). This slice builds **only** the `production`-branch substrate plus the auto-placed `CLAUDE.md` ground-rules file. It is **entirely CLI-side — no `ferry-plugin` changes.**

**In scope:**
- Every pull commits the WP-root file tree to a `production` branch, faithful to production (including files deleted upstream between pulls).
- `.gitignore` keeps ferry-local artifacts out of the tracked tree, so a later diff shows only real changes.
- Nested `.git` directories (plugins/themes shipped with their own repo) are renamed to `.git.ferry-disabled` so git tracks their files instead of treating them as submodules.
- An auto-placed `CLAUDE.md` gives the agent the clone's ground rules (auto-loaded by the Claude Agent SDK in Plan 4; deliberately keeping the SDK's magic filename).

**Deferred (confirmed in brainstorming):**
- Work-branch creation and lifecycle → Plan 4 (the agent is what creates changes).
- Re-pull while a work branch has changes (rebase / conflict surfacing) → Plan 5.
- Provenance, content-addressable cache, "modified core files" report → a later speed plan.
- Binary-file diff quality — accepted as-is (base doc §5, the acknowledged 10/100).
- Database versioning — the DB is not in git; it gets its own versioning in Plan 5 (base doc §6).

## 2. Architecture

One new CLI module, `ferry-cli/src/git.ts`, a thin wrapper over the `git` CLI (via `execFile`) operating on the clone directory as a **host path** — no DDEV container round-trip, since the clone lives on the host filesystem. One new step is wired into the existing `pull()` orchestration in `ferry-cli/src/pull.ts`, after `finalizeClone` (files settled) and before the database import (DB is outside git). No changes to `ferry-plugin`.

## 3. Module: `git.ts`

A small, focused set of functions, each independently testable against a real `git` binary in a temp directory.

- **`ensureRepo(dir): Promise<void>`** — if `dir/.git` is absent, `git init` and set the initial branch to `production`; on an existing repo, ensure HEAD is on `production`. Always set a **repo-local** identity (`git config user.name "ferry"`, `user.email "ferry@localhost"`) so commits never depend on the machine's global git config. Mark the repo as ferry-owned by writing a sentinel file `dir/.git/ferry-clone`, so neutralization can tell our repo apart from a transferred one.

- **`neutralizeNestedGit(dir): Promise<string[]>`** — walk `dir` and rename every `.git` directory that is **not** the clone's own ferry repo (identified by the `.git/ferry-clone` sentinel) to `.git.ferry-disabled`. Returns the list of neutralized locations. This covers bundled plugin/theme repos on every pull, and a production **root-level** `.git` on the first pull (before the ferry repo exists, an incoming root `.git` has no sentinel and is neutralized like any other; `ensureRepo` then creates the ferry repo). **Idempotent and re-pull-safe:** if a freshly-transferred `.git` appears where a `.git.ferry-disabled` already exists, the stale target is removed and the fresh one renamed. Renaming (not deleting) keeps the contents visible to the agent, per the base doc's choice. Runs **before** `ensureRepo` so the sentinel check never trips over a half-initialized repo.

- **`writeGitignore(dir): Promise<void>`** — write `dir/.gitignore` (see §4). Self-ignoring, so the ignore file itself never enters the tracked snapshot.

- **`writeClaudeMd(dir): Promise<void>`** — write `dir/CLAUDE.md` (see §6). Also gitignored.

- **`commitProduction(dir, manifestPaths, message): Promise<string>`** — on the `production` branch: reconcile the working tree against `manifestPaths` (the authoritative current file set from this pull), then `git add -A` and commit; returns the commit SHA. Reconciliation physically removes **tracked** files that are no longer in the manifest so upstream deletions are captured (gitignored artifacts are untracked and therefore never removed). Manifest paths under a `.git/` segment are remapped to `.git.ferry-disabled/` before comparison, matching the on-disk neutralization, so re-pulls of a bundled-repo plugin stay clean. Every pull commits (a clean re-pull uses `--allow-empty`) so the `production` timeline has one commit per pull.

## 4. What is tracked vs ignored

`production` commits must contain **only production's real files**, so `git diff production...<work-branch>` in Plan 5 is exactly the change set to push. The generated `.gitignore` therefore hides every ferry-local artifact:

```
/.gitignore
/CLAUDE.md
/wp-config.php
/wp-config-ddev.php
/.ddev/
/wp-content/uploads/
/wp-content/mu-plugins/ferry-overlay.php
```

Notes:
- `.gitignore` and `CLAUDE.md` self-ignore so the snapshot stays a pure production mirror.
- `wp-config.php` is ferry-generated locally (never pulled); `wp-config-ddev.php` only appears on DDEV-based hosts; `.ddev/`, `uploads/`, and `ferry-overlay.php` are ferry/DDEV-local.
- **Drop-in renames (`*.php.ferry-disabled`) stay tracked** — the base doc (§2.6) wants those visible in the diff, and they are production code artifacts.

## 5. Flow (inside `pull()`)

The new step slots into the existing orchestration without reordering the rest:

```
… fetchAll (transfer) → finalizeClone
   → neutralizeNestedGit(docroot)
   → ensureRepo(docroot)
   → writeGitignore(docroot) + writeClaudeMd(docroot)
   → commitProduction(docroot, manifestPaths, "ferry: production snapshot")
→ pullDatabase → await provision (join) → importDb → createAdmin
```

`manifestPaths` is the list of paths already fetched in `pull()` (`entries.map(e => e.path)`). The `pull()` result gains `commit: string` (the SHA) and `neutralizedRepos: number`; the CLI prints the commit line (e.g. `✔ Committed production snapshot <sha7> (N nested repos neutralized)`).

Ordering rationale: neutralization runs **before** `ensureRepo`/`add` so git never sees a nested `.git` as an embedded repo; the git step runs **after** `finalizeClone` so drop-in renames are already on disk and get committed in the same snapshot; the DB import stays outside git.

## 6. CLAUDE.md content

A short ground-rules file so the agent understands the clone it is working in:

- This is a ferry clone of a production WordPress site, for debugging.
- The database is a point-in-time snapshot — production owns live data; don't assume it is current.
- The clone is airtight: outbound mail and HTTP are blocked, and missing uploads/media 302-fall-back to production.
- `wp-cli`, `git`, and a shell are available — work as you would in Claude Code (grep, read, edit, bash).
- Make code changes on your work branch; `git diff production` is exactly what would be pushed to production.
- Never edit `wp-config.php`, anything under `.ddev/`, or `wp-content/mu-plugins/ferry-overlay.php` — they are local ferry artifacts (gitignored) and never travel to production.
- Drop-ins (`object-cache.php`, etc.) are renamed to `*.php.ferry-disabled` to avoid local fatals; that is expected.

## 7. Error handling

- `git` binary missing → a clear, actionable CLI error naming git as a prerequisite (mirrors the existing DDEV/security-plugin error style).
- Reconciliation only ever removes **tracked** files absent from the manifest; a bug that produced an empty manifest must not wipe the tree — `commitProduction` treats an empty `manifestPaths` as an error, not "delete everything."
- Neutralization is best-effort per directory; a rename failure is reported but does not abort the pull (the file tree is already valid; the diff is merely less clean for that one nested repo).

**Known limitation (documented, not a bug):** a production site whose *entire docroot* is a git repo (a root-level `.git`) is fully handled on the **first** pull — its root `.git` is neutralized to `.git.ferry-disabled` before the ferry repo is created. On a **re-pull**, the full transfer re-writes that root `.git` over the ferry repo's own `.git`; supporting this rare case (moving the ferry repo aside during transfer, or excluding a top-level `.git` upstream) is deferred. Nested plugin/theme repos — the case the base doc §5 actually calls out — are fully supported on every pull. The `.git/ferry-clone` sentinel makes this boundary explicit rather than silent.

## 8. Testing

- **Unit — `ferry-cli/tests/git.test.ts`** (real `git` binary, temp dirs): init + `production` branch; `neutralizeNestedGit` idempotency and fresh-over-stale replacement; `.gitignore` correctness verified with `git check-ignore`; `commitProduction` capturing add / modify / **delete**; empty-manifest guard; one-commit-per-pull including a clean `--allow-empty` re-pull.
- **Integration — extend `ferry-cli/tests/pull.test.ts`** (existing FakeEnv): after a pull, assert `.git` exists with HEAD on `production`, the §4 artifacts are ignored (`git check-ignore`), a seeded nested `.git` was renamed to `.git.ferry-disabled`, `CLAUDE.md` is present, and the result carries the commit SHA.
- **E2E — extend `docs/superpowers/plans/2026-07-24-ferry-v0-e2e-runbook.md`**: real pull → `git -C <clone> log --oneline` shows a `production` commit; create a `work` branch, edit one file, `git diff production` shows exactly that edit; `git status` stays clean of ferry artifacts; seed a nested `.git` in a plugin and confirm its files appear in the tree (not as a submodule).

## 9. Done when

- A pull commits the WP-root tree to `production`.
- A re-pull faithfully reflects upstream adds, modifications, and deletions.
- From a work branch, `git diff production` shows exactly and only the changes — never a ferry-local artifact.
- A nested plugin `.git` does not hide that plugin's files from git.
- `CLAUDE.md` is auto-placed in the clone root.
