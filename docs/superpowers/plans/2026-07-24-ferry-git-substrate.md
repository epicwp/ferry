# Ferry Plan 2 — Git Substrate + CLAUDE.md — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every ferry clone a git repository — each pull commits the WP-root file tree to a `production` branch that faithfully mirrors production — and auto-place a `CLAUDE.md` ground-rules file, so an agent (Plan 4) can work on its own branch and `git diff production` shows exactly what would be pushed (Plan 5).

**Architecture:** One new CLI module `ferry-cli/src/git.ts` (a thin `execFile` wrapper over the `git` CLI, operating on the clone directory as a host path) plus one new step wired into the existing `pull()` orchestration after `finalizeClone`. No `ferry-plugin` changes. Ferry-local artifacts are `.gitignore`d so the `production` snapshot stays a pure mirror; nested `.git` dirs are renamed to `.git.ferry-disabled` so git tracks their files instead of treating them as submodules.

**Tech Stack:** Node ≥20, TypeScript ESM, the system `git` binary, Vitest ^2. Builds on the shipped v0 pull skeleton (`ferry-cli/src/{pull,transfer,overlay,profile,client}.ts`).

**Spec:** `docs/superpowers/specs/2026-07-24-ferry-git-substrate-design.md`.

## Global Constraints

- CLI-only — **no `ferry-plugin` changes**. TypeScript ESM, `.js` import specifiers.
- All git operations run against the clone directory (host path) via `execFile('git', …, { cwd })`; a missing `git` binary produces one clear, actionable error.
- The clone's own repo is on a branch literally named **`production`** and is marked with a sentinel file `.git/ferry-clone`.
- Repo-local git identity only: `user.name=ferry`, `user.email=ferry@localhost`, `commit.gpgsign=false`, `core.autocrlf=false` — never `--global`.
- Every pull commits (a clean re-pull uses `--allow-empty`). The reconcile step **only removes tracked files** absent from the pull's manifest; an **empty manifest is an error**, never "delete the whole tree".
- `.gitignore` (exact set, each anchored with a leading `/`): `/.gitignore`, `/CLAUDE.md`, `/wp-config.php`, `/wp-config-ddev.php`, `/.ddev/`, `/wp-content/uploads/`, `/wp-content/mu-plugins/ferry-overlay.php`.
- Nested `.git` → `.git.ferry-disabled` (rename, not delete — contents stay visible); idempotent and re-pull-safe. Drop-in renames (`*.php.ferry-disabled`) stay **tracked**.
- All user-facing copy in English.
- **Known limitation (documented, not to be "fixed" here):** a production site whose *entire docroot* is a git repo (root-level `.git`) is handled on the first pull but not across re-pulls; nested plugin/theme repos are fully supported. See spec §7.

## File Structure

- Create `ferry-cli/src/git.ts` — the git substrate module (Tasks 1–4 build it incrementally).
- Create `ferry-cli/tests/git.test.ts` — unit tests against a real `git` binary (Tasks 1–4).
- Modify `ferry-cli/src/overlay.ts` — export the existing `DROP_INS` const so `git.ts` reuses it (Task 4).
- Modify `ferry-cli/src/pull.ts` — extend `PullResult`, wire the git step in after `finalizeClone` (Task 5).
- Modify `ferry-cli/src/main.ts` — print the committed snapshot line (Task 5).
- Modify `ferry-cli/tests/pull.test.ts` — integration assertions on the git outcome (Task 5).
- Modify `docs/superpowers/plans/2026-07-24-ferry-v0-e2e-runbook.md` — append the git-substrate E2E checks (Task 6).

---

### Task 1: git plumbing + `ensureRepo`

**Files:**
- Create: `ferry-cli/src/git.ts`
- Test: `ferry-cli/tests/git.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `runGit(dir: string, args: string[]): Promise<string>` (trimmed stdout; throws an actionable error if git is missing), `ensureRepo(dir: string): Promise<void>`, and the module constant `SENTINEL = 'ferry-clone'`. Later tasks append `neutralizeNestedGit`, `writeGitignore`, `writeClaudeMd`, `commitProduction` to this same file.

- [ ] **Step 1: Write the failing test `ferry-cli/tests/git.test.ts`**

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRepo } from '../src/git.js';

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

describe('ensureRepo', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ferry-git-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('inits a repo on the production branch with a ferry identity and sentinel', async () => {
    await ensureRepo(dir);
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('production');
    expect(git(dir, 'config', 'user.name')).toBe('ferry');
    expect(git(dir, 'config', 'user.email')).toBe('ferry@localhost');
    expect(existsSync(join(dir, '.git', 'ferry-clone'))).toBe(true);
  });

  it('is idempotent and keeps HEAD on production on a second call (unborn branch)', async () => {
    await ensureRepo(dir);
    await ensureRepo(dir);
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('production');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-cli && npx vitest run tests/git.test.ts`
Expected: FAIL — cannot find module `../src/git.js`.

- [ ] **Step 3: Implement `ferry-cli/src/git.ts`**

```ts
import { execFile } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const SENTINEL = 'ferry-clone';

/** Run git in `dir`; returns trimmed stdout. Throws an actionable error if git is missing. */
export async function runGit(dir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('git is required but was not found on PATH. Install git and retry.');
    }
    throw err;
  }
}

async function refExists(dir: string, ref: string): Promise<boolean> {
  try {
    await runGit(dir, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

/** Init (or reuse) the clone's git repo on the `production` branch, with a repo-local ferry identity. */
export async function ensureRepo(dir: string): Promise<void> {
  const gitDir = join(dir, '.git');
  if (!existsSync(gitDir)) {
    await runGit(dir, ['init', '-q']);
  }
  // Put HEAD on `production` whether the branch is unborn or already has commits,
  // independent of the host's init.defaultBranch.
  if (await refExists(dir, 'refs/heads/production')) {
    await runGit(dir, ['checkout', '-q', 'production']);
  } else {
    await runGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/production']);
  }
  await runGit(dir, ['config', 'user.name', 'ferry']);
  await runGit(dir, ['config', 'user.email', 'ferry@localhost']);
  await runGit(dir, ['config', 'commit.gpgsign', 'false']);
  await runGit(dir, ['config', 'core.autocrlf', 'false']);
  await fsp.writeFile(join(gitDir, SENTINEL), 'This directory is a ferry clone repo. Do not remove.\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ferry-cli && npx vitest run tests/git.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/git.ts ferry-cli/tests/git.test.ts
git commit -m "feat: git repo init on production branch with ferry identity and sentinel"
```

---

### Task 2: `neutralizeNestedGit`

**Files:**
- Modify: `ferry-cli/src/git.ts` (append)
- Test: `ferry-cli/tests/git.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `SENTINEL` (Task 1).
- Produces: `neutralizeNestedGit(dir: string): Promise<string[]>` — renames every `.git` directory that is not the clone's own ferry repo (identified by the `.git/<SENTINEL>` file) to a sibling `.git.ferry-disabled`, returning the neutralized locations as root-relative forward-slash paths. Idempotent: a fresh `.git` replaces a stale `.git.ferry-disabled`. Also exports the module constant `DISABLED = '.git.ferry-disabled'`.

- [ ] **Step 1: Write the failing test (append to `ferry-cli/tests/git.test.ts`)**

Add `neutralizeNestedGit` to the existing `../src/git.js` import, and add `promises as fsp` to the existing `node:fs` import so it reads `import { existsSync, mkdtempSync, promises as fsp, rmSync } from 'node:fs';`. Then append:

```ts
describe('neutralizeNestedGit', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ferry-git-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('renames a nested .git and leaves the ferry repo alone', async () => {
    await ensureRepo(dir); // creates dir/.git with the sentinel
    await fsp.mkdir(join(dir, 'wp-content/plugins/foo/.git'), { recursive: true });
    await fsp.writeFile(join(dir, 'wp-content/plugins/foo/.git/HEAD'), 'ref: refs/heads/main\n');
    await fsp.writeFile(join(dir, 'wp-content/plugins/foo/plugin.php'), '<?php');

    const neutralized = await neutralizeNestedGit(dir);

    expect(neutralized).toEqual(['wp-content/plugins/foo/.git.ferry-disabled']);
    expect(existsSync(join(dir, 'wp-content/plugins/foo/.git'))).toBe(false);
    expect(existsSync(join(dir, 'wp-content/plugins/foo/.git.ferry-disabled/HEAD'))).toBe(true);
    expect(existsSync(join(dir, '.git', 'ferry-clone'))).toBe(true); // ferry repo untouched
  });

  it('replaces a stale .git.ferry-disabled on re-pull (idempotent)', async () => {
    await fsp.mkdir(join(dir, 'p/.git.ferry-disabled'), { recursive: true });
    await fsp.writeFile(join(dir, 'p/.git.ferry-disabled/OLD'), 'stale');
    await fsp.mkdir(join(dir, 'p/.git'), { recursive: true });
    await fsp.writeFile(join(dir, 'p/.git/NEW'), 'fresh');

    await neutralizeNestedGit(dir);

    expect(existsSync(join(dir, 'p/.git.ferry-disabled/NEW'))).toBe(true);
    expect(existsSync(join(dir, 'p/.git.ferry-disabled/OLD'))).toBe(false);
    expect(existsSync(join(dir, 'p/.git'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-cli && npx vitest run tests/git.test.ts`
Expected: FAIL — `neutralizeNestedGit` is not exported.

- [ ] **Step 3: Implement (append to `ferry-cli/src/git.ts`)**

Add `relative` to the `node:path` import (`import { join, relative } from 'node:path';`) and append:

```ts
export const DISABLED = '.git.ferry-disabled';

/** Rename every nested `.git` (a bundled plugin/theme repo) to `.git.ferry-disabled`,
 *  leaving the clone's own ferry repo (marked by the sentinel) alone. */
export async function neutralizeNestedGit(dir: string): Promise<string[]> {
  const out: string[] = [];
  await walk(dir, dir, out);
  return out;
}

async function walk(root: string, current: string, out: string[]): Promise<void> {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === DISABLED) continue; // already neutralized; don't descend
    const abs = join(current, entry.name);
    if (entry.name === '.git') {
      if (existsSync(join(abs, SENTINEL))) continue; // our ferry repo
      const target = join(current, DISABLED);
      if (existsSync(target)) {
        await fsp.rm(target, { recursive: true, force: true });
      }
      await fsp.rename(abs, target);
      out.push(relative(root, target).split(/[/\\]/).join('/'));
      continue; // never descend into a git dir
    }
    await walk(root, abs, out);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ferry-cli && npx vitest run tests/git.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/git.ts ferry-cli/tests/git.test.ts
git commit -m "feat: neutralize nested .git dirs so their files stay in the diff"
```

---

### Task 3: `writeGitignore` + `writeClaudeMd`

**Files:**
- Modify: `ferry-cli/src/git.ts` (append)
- Test: `ferry-cli/tests/git.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `ensureRepo` (Task 1).
- Produces: `writeGitignore(dir: string): Promise<void>` and `writeClaudeMd(dir: string): Promise<void>` — write the self-ignoring `.gitignore` (exact Global-Constraints set) and the clone's `CLAUDE.md` ground rules, respectively.

- [ ] **Step 1: Write the failing test (append to `ferry-cli/tests/git.test.ts`)**

Add `writeGitignore, writeClaudeMd` to the `../src/git.js` import, and add:

```ts
describe('writeGitignore / writeClaudeMd', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ferry-git-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a self-ignoring .gitignore that hides ferry artifacts but not real code', async () => {
    await ensureRepo(dir);
    await writeGitignore(dir);
    const ignored = (p: string) => {
      try {
        execFileSync('git', ['check-ignore', p], { cwd: dir });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('wp-config.php')).toBe(true);
    expect(ignored('wp-config-ddev.php')).toBe(true);
    expect(ignored('.ddev/config.yaml')).toBe(true);
    expect(ignored('wp-content/uploads/2026/x.jpg')).toBe(true);
    expect(ignored('wp-content/mu-plugins/ferry-overlay.php')).toBe(true);
    expect(ignored('.gitignore')).toBe(true);
    expect(ignored('CLAUDE.md')).toBe(true);
    expect(ignored('wp-content/plugins/foo/plugin.php')).toBe(false);
  });

  it('writes CLAUDE.md ground rules', async () => {
    await writeClaudeMd(dir);
    const md = await fsp.readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(md).toContain('git diff production');
    expect(md).toContain('ferry-overlay.php');
    expect(md).toContain('snapshot');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-cli && npx vitest run tests/git.test.ts`
Expected: FAIL — `writeGitignore` / `writeClaudeMd` not exported.

- [ ] **Step 3: Implement (append to `ferry-cli/src/git.ts`)**

```ts
const GITIGNORE = `/.gitignore
/CLAUDE.md
/wp-config.php
/wp-config-ddev.php
/.ddev/
/wp-content/uploads/
/wp-content/mu-plugins/ferry-overlay.php
`;

export async function writeGitignore(dir: string): Promise<void> {
  await fsp.writeFile(join(dir, '.gitignore'), GITIGNORE);
}

const CLAUDE_MD = `# Ferry clone - ground rules

This is a **ferry clone** of a production WordPress site, for debugging. Work here as you
would in Claude Code: grep, read, edit, and run \`wp-cli\`, \`git\`, and shell commands.

- **The database is a point-in-time snapshot.** Production owns the live data - do not assume
  orders, users, or options here are current.
- **The clone is airtight.** Outbound email and HTTP are blocked, and missing uploads/media
  are redirected (302) to production. This is expected, not a bug.
- **Changes go back through git.** Make code changes on your work branch; \`git diff production\`
  is exactly what would be pushed to production.
- **Never edit these local artifacts** - they are ferry/DDEV-generated, git-ignored, and never
  travel to production: \`wp-config.php\`, anything under \`.ddev/\`, and
  \`wp-content/mu-plugins/ferry-overlay.php\`.
- **Drop-ins are disabled on purpose.** Files like \`object-cache.php\` are renamed to
  \`*.php.ferry-disabled\` so the clone does not fatal on services (Redis, etc.) that are not
  running locally.
`;

export async function writeClaudeMd(dir: string): Promise<void> {
  await fsp.writeFile(join(dir, 'CLAUDE.md'), CLAUDE_MD);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ferry-cli && npx vitest run tests/git.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ferry-cli/src/git.ts ferry-cli/tests/git.test.ts
git commit -m "feat: self-ignoring .gitignore and auto-placed CLAUDE.md"
```

---

### Task 4: `commitProduction` (reconcile + commit)

**Files:**
- Modify: `ferry-cli/src/git.ts` (append)
- Modify: `ferry-cli/src/overlay.ts` (export `DROP_INS`)
- Test: `ferry-cli/tests/git.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `runGit`, `DISABLED` (Tasks 1–2); `DROP_INS` from `overlay.ts`.
- Produces: `commitProduction(dir: string, manifestPaths: string[], message: string): Promise<string>` — reconciles the working tree against the pull's manifest (removing tracked files no longer upstream, accounting for the `.git`→`.git.ferry-disabled` rename and drop-in renames), then `git add -A` and commits with `--allow-empty`, returning the commit SHA. An empty `manifestPaths` throws.
- Requires `export const DROP_INS` in `overlay.ts` (currently a private const `['object-cache.php', 'advanced-cache.php', 'db.php', 'sunrise.php']`).

- [ ] **Step 1: Export `DROP_INS` from `ferry-cli/src/overlay.ts`**

Change the existing line

```ts
const DROP_INS = ['object-cache.php', 'advanced-cache.php', 'db.php', 'sunrise.php'];
```

to

```ts
export const DROP_INS = ['object-cache.php', 'advanced-cache.php', 'db.php', 'sunrise.php'];
```

- [ ] **Step 2: Write the failing test (append to `ferry-cli/tests/git.test.ts`)**

Add `commitProduction` to the `../src/git.js` import, and add:

```ts
describe('commitProduction', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ferry-git-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('captures adds, modifications, and deletions across pulls', async () => {
    await ensureRepo(dir);
    await fsp.writeFile(join(dir, 'a.php'), 'A1');
    await fsp.mkdir(join(dir, 'wp-content'), { recursive: true });
    await fsp.writeFile(join(dir, 'wp-content/b.php'), 'B1');
    const sha1 = await commitProduction(dir, ['a.php', 'wp-content/b.php'], 'snap 1');
    expect(sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, 'ls-files').split('\n').sort()).toEqual(['a.php', 'wp-content/b.php']);

    await fsp.writeFile(join(dir, 'a.php'), 'A2'); // modified
    await fsp.writeFile(join(dir, 'c.php'), 'C1'); // added; b.php deleted upstream (not in manifest)
    const sha2 = await commitProduction(dir, ['a.php', 'c.php'], 'snap 2');
    expect(sha2).not.toBe(sha1);
    expect(git(dir, 'ls-files').split('\n').sort()).toEqual(['a.php', 'c.php']);
    expect(existsSync(join(dir, 'wp-content/b.php'))).toBe(false);
    expect(git(dir, 'show', 'HEAD:a.php')).toBe('A2');
  });

  it('refuses an empty manifest', async () => {
    await ensureRepo(dir);
    await expect(commitProduction(dir, [], 'x')).rejects.toThrow(/empty manifest/);
  });

  it('commits an empty (no-change) re-pull', async () => {
    await ensureRepo(dir);
    await fsp.writeFile(join(dir, 'a.php'), 'A');
    await commitProduction(dir, ['a.php'], 'snap 1');
    await commitProduction(dir, ['a.php'], 'snap 2 no change');
    expect(git(dir, 'rev-list', '--count', 'HEAD')).toBe('2');
  });

  it('keeps a renamed drop-in whose manifest still lists the original name', async () => {
    await ensureRepo(dir);
    await fsp.mkdir(join(dir, 'wp-content'), { recursive: true });
    await fsp.writeFile(join(dir, 'index.php'), '<?php');
    await fsp.writeFile(join(dir, 'wp-content/object-cache.php.ferry-disabled'), '<?php');
    await commitProduction(dir, ['index.php', 'wp-content/object-cache.php'], 'snap 1');
    await commitProduction(dir, ['index.php', 'wp-content/object-cache.php'], 'snap 2');
    expect(existsSync(join(dir, 'wp-content/object-cache.php.ferry-disabled'))).toBe(true);
    expect(git(dir, 'ls-files').split('\n')).toContain('wp-content/object-cache.php.ferry-disabled');
  });

  it('keeps neutralized nested-repo files whose manifest lists .git paths', async () => {
    await ensureRepo(dir);
    await fsp.mkdir(join(dir, 'p/.git.ferry-disabled'), { recursive: true });
    await fsp.writeFile(join(dir, 'p/.git.ferry-disabled/HEAD'), 'ref');
    await commitProduction(dir, ['p/.git/HEAD'], 'snap 1');
    await commitProduction(dir, ['p/.git/HEAD'], 'snap 2');
    expect(existsSync(join(dir, 'p/.git.ferry-disabled/HEAD'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ferry-cli && npx vitest run tests/git.test.ts`
Expected: FAIL — `commitProduction` not exported.

- [ ] **Step 4: Implement (append to `ferry-cli/src/git.ts`)**

Add the import `import { DROP_INS } from './overlay.js';` at the top of `git.ts`, then append:

```ts
/** Map a manifest path to the set of on-disk paths it may occupy after local transforms:
 *  a bundled `.git/` becomes `.git.ferry-disabled/`, and a wp-content drop-in may be renamed
 *  to `*.php.ferry-disabled`. Both variants are kept so reconciliation never deletes them. */
function keepVariants(path: string): string[] {
  const remapped = path.replace(/(^|\/)\.git\//g, `$1${DISABLED}/`);
  if (DROP_INS.some((d) => remapped === `wp-content/${d}`)) {
    return [remapped, `${remapped}.ferry-disabled`];
  }
  return [remapped];
}

/** Reconcile the working tree against the pull's manifest, then commit on `production`. */
export async function commitProduction(dir: string, manifestPaths: string[], message: string): Promise<string> {
  if (manifestPaths.length === 0) {
    throw new Error('refusing to commit an empty manifest - this would delete the whole tree');
  }
  const keep = new Set(manifestPaths.flatMap(keepVariants));
  const tracked = (await runGit(dir, ['ls-files'])).split('\n').filter(Boolean);
  for (const path of tracked) {
    if (!keep.has(path)) {
      await fsp.rm(join(dir, path), { force: true }); // upstream deletion
    }
  }
  await runGit(dir, ['add', '-A']);
  await runGit(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  return runGit(dir, ['rev-parse', 'HEAD']);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ferry-cli && npx vitest run tests/git.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add ferry-cli/src/git.ts ferry-cli/src/overlay.ts ferry-cli/tests/git.test.ts
git commit -m "feat: reconcile-and-commit production snapshot with upstream deletions"
```

---

### Task 5: Wire the git step into `pull()` + CLI output + integration test

**Files:**
- Modify: `ferry-cli/src/pull.ts`
- Modify: `ferry-cli/src/main.ts`
- Modify: `ferry-cli/tests/pull.test.ts`

**Interfaces:**
- Consumes: `neutralizeNestedGit`, `ensureRepo`, `writeGitignore`, `writeClaudeMd`, `commitProduction` (Tasks 1–4); the existing `pull()` flow.
- Produces: `PullResult` gains `commit: string` and `neutralizedRepos: number`; the git step runs between `finalizeClone` and `pullDatabase`.

- [ ] **Step 1: Extend the integration test in `ferry-cli/tests/pull.test.ts`**

Add `import { execFileSync } from 'node:child_process';` at the top. In `beforeEach`, after the `object-cache.php` line, seed a bundled plugin repo:

```ts
    mkdirSync(join(fixture, 'wp-content/plugins/foo/.git'), { recursive: true });
    writeFileSync(join(fixture, 'wp-content/plugins/foo/.git/HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(fixture, 'wp-content/plugins/foo/plugin.php'), '<?php // bundled plugin');
```

In the `runs the full §4.6 flow` test, replace the `manifest` array with the five-path version:

```ts
    const manifest = [
      'index.php',
      'wp-load.php',
      'wp-content/object-cache.php',
      'wp-content/plugins/foo/.git/HEAD',
      'wp-content/plugins/foo/plugin.php',
    ].map((p) => ({ path: p, size: sizeOf(fixture, p), hash: null }));
```

At the end of that same test (after the existing `profile.info.wp` assertion), add the git-outcome assertions:

```ts
    const git = (...args: string[]) => execFileSync('git', args, { cwd: clonePath, encoding: 'utf8' }).trim();
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.neutralizedRepos).toBe(1);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('production');
    expect(existsSync(join(clonePath, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(clonePath, 'wp-content/plugins/foo/.git.ferry-disabled/HEAD'))).toBe(true);
    expect(existsSync(join(clonePath, 'wp-content/plugins/foo/.git'))).toBe(false);
    expect(git('ls-files', 'wp-content/plugins/foo/plugin.php')).toBe('wp-content/plugins/foo/plugin.php');
    const ignored = (p: string) => {
      try {
        execFileSync('git', ['check-ignore', p], { cwd: clonePath });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('wp-config.php')).toBe(true);
    expect(ignored('wp-content/mu-plugins/ferry-overlay.php')).toBe(true);
    expect(ignored('CLAUDE.md')).toBe(true);
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ferry-cli && npx vitest run tests/pull.test.ts`
Expected: FAIL — `result.commit` is `undefined` (git step not wired yet).

- [ ] **Step 3: Wire the git step into `ferry-cli/src/pull.ts`**

Add the import after the existing `import { resolve } from './resolve.js';` line:

```ts
import { commitProduction, ensureRepo, neutralizeNestedGit, writeClaudeMd, writeGitignore } from './git.js';
```

Extend `PullResult`:

```ts
export interface PullResult {
  url: string;
  adminUser: string;
  adminPassword: string;
  skipped: string[];
  commit: string;
  neutralizedRepos: number;
}
```

Immediately after `await finalizeClone(docroot, info);`, insert the git step:

```ts

  // Git substrate: neutralize nested repos BEFORE init so git never treats one as a submodule,
  // then commit the WP-root tree as a `production` snapshot (DB stays outside git).
  const neutralized = await neutralizeNestedGit(docroot);
  await ensureRepo(docroot);
  await writeGitignore(docroot);
  await writeClaudeMd(docroot);
  const commit = await commitProduction(docroot, entries.map((e) => e.path), 'ferry: production snapshot');
```

Replace the final `return { … }` with:

```ts
  return {
    url: env.url(slug),
    adminUser: admin.user,
    adminPassword: admin.password,
    skipped,
    commit,
    neutralizedRepos: neutralized.length,
  };
```

- [ ] **Step 4: Print the snapshot line in `ferry-cli/src/main.ts`**

After the `Media is not cloned …` `console.log` line, add:

```ts
    console.log(
      `  Committed production snapshot ${result.commit.slice(0, 7)}` +
        (result.neutralizedRepos > 0 ? ` (${result.neutralizedRepos} nested repo(s) neutralized)` : ''),
    );
```

- [ ] **Step 5: Run the full CLI suite + build**

Run: `cd ferry-cli && npm test && npm run build`
Expected: all suites PASS (including the extended `pull.test.ts`); `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add ferry-cli/src/pull.ts ferry-cli/src/main.ts ferry-cli/tests/pull.test.ts
git commit -m "feat: commit a production snapshot on every pull"
```

---

### Task 6: E2E gate — git substrate on a real clone

No new production code — a milestone gate that extends the v0 runbook. It reuses the paired fixture from the v0 E2E gate (or re-creates it per that runbook), runs a real `ferry pull`, and verifies the git outcomes.

**Files:**
- Modify: `docs/superpowers/plans/2026-07-24-ferry-v0-e2e-runbook.md` (append a "Plan 2 — git substrate" section with results).

**Interfaces:**
- Consumes: everything.
- Produces: a checked-off git-substrate result log.

- [ ] **Step 1: Pull and inspect the production commit**

Assumes the v0 fixture `ferry-prod` is paired (see the runbook's Plan 1 section; re-run its fixture setup if torn down). To exercise nested-repo neutralization, seed a bundled repo on the fixture first:

```bash
mkdir -p ~/ferry-e2e/prod/wp-content/plugins/demo/.git && \
  echo 'ref: refs/heads/main' > ~/ferry-e2e/prod/wp-content/plugins/demo/.git/HEAD && \
  echo '<?php // demo' > ~/ferry-e2e/prod/wp-content/plugins/demo/plugin.php
# add it to the manifest exclusions? no - .git must transfer; confirm Excludes does not skip it
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
cd /Users/robbertvermeulen/Projects/ferry/ferry-cli
# fresh clone dir so the first-pull path is exercised:
ddev stop --unlist ferry-prod-ddev-site 2>/dev/null; rm -rf ~/ferry-sites/ferry-prod-ddev-site
npm run ferry -- pull ferry-prod-ddev-site
```

Expected: the CLI prints `Committed production snapshot <sha7> (1 nested repo(s) neutralized)`.

- [ ] **Step 2: Verify the git outcomes — record each in the runbook**

```bash
CLONE_DIR=~/ferry-sites/ferry-prod-ddev-site
G="git -C $CLONE_DIR"
$G log --oneline                                   # >=1 commit, subject "ferry: production snapshot"
$G rev-parse --abbrev-ref HEAD                      # production
$G status --porcelain | grep -E 'wp-config.php|\.ddev/|mu-plugins/ferry-overlay.php|CLAUDE.md' || echo "artifacts correctly ignored"
$G check-ignore wp-config.php CLAUDE.md .ddev/config.yaml wp-content/mu-plugins/ferry-overlay.php
ls "$CLONE_DIR/wp-content/plugins/demo/.git.ferry-disabled/HEAD"   # nested repo neutralized
$G ls-files wp-content/plugins/demo/plugin.php      # bundled plugin file IS tracked
# work-branch diff shows exactly one edit and no artifacts:
$G checkout -q -b work
printf '\n// edit\n' >> "$CLONE_DIR/index.php"
$G --no-pager diff --stat production                # exactly index.php changed
$G checkout -q production
```

Expected: HEAD on `production`; artifacts ignored (empty `status` for them); nested `.git.ferry-disabled/HEAD` present and `plugin.php` tracked; `git diff production` from `work` shows only `index.php`.

- [ ] **Step 3: Re-pull and confirm a second faithful commit**

```bash
$G checkout -q production
cd /Users/robbertvermeulen/Projects/ferry/ferry-cli && npm run ferry -- pull ferry-prod-ddev-site
git -C ~/ferry-sites/ferry-prod-ddev-site rev-list --count production   # >= 2
git -C ~/ferry-sites/ferry-prod-ddev-site status --porcelain            # clean of ferry artifacts
```

Expected: a second `production` commit; the clone still boots (re-run a couple of v0 §4.7 checks — site 200, admin login — to confirm the git step didn't disturb the working clone).

- [ ] **Step 4: Record results and commit the runbook**

Write pass/fail per check into the runbook's new section. Every check must pass before the milestone is done; failures become fix commits against the responsible `git.ts`/`pull.ts` code.

```bash
git add docs/superpowers/plans/2026-07-24-ferry-v0-e2e-runbook.md
git commit -m "test: git-substrate end-to-end gate results"
```

---

## Post-plan notes for the executor

- The whole plan is CLI-side; if any task tempts a `ferry-plugin` change, stop — the nested-`.git` files already transfer (Excludes does not skip `.git`), so neutralization is purely local.
- `commitProduction`'s reconcile deletes only **tracked** files absent from the (transform-aware) manifest; the empty-manifest guard is load-bearing — never remove it.
- Do not build work-branch creation, re-pull rebase, or provenance here — those are Plans 4/5 and a later speed plan (see the roadmap). Keep this slice to the `production` substrate + `CLAUDE.md`.
