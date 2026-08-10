import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, promises as fsp, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRepo, neutralizeNestedGit, writeGitignore, writeClaudeMd, commitProduction } from '../src/git.js';

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

  it('returns HEAD to production from a diverged work branch without touching the tree', async () => {
    // Live finding (Plan 5a acceptance): after an agent session HEAD stays on agent/work;
    // the next pull writes fetched files into the tree first, and a plain
    // `git checkout production` then refuses over those "local changes" whenever a pulled
    // path also differs between the branches. HEAD must move without a tree touch — the
    // post-pull tree IS the new production truth and is committed as the snapshot next.
    await ensureRepo(dir);
    await fsp.writeFile(join(dir, 'wp-version.php'), 'v1\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'snapshot v1');
    git(dir, 'checkout', '-q', '-b', 'agent/work');
    await fsp.writeFile(join(dir, 'journal.json'), '{}\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'agent work');
    git(dir, 'checkout', '-q', 'production');
    await fsp.writeFile(join(dir, 'wp-version.php'), 'v2\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'snapshot v2');
    git(dir, 'checkout', '-q', 'agent/work');
    // the "pull": production's newer content lands in the tree while agent/work is checked out
    await fsp.writeFile(join(dir, 'wp-version.php'), 'v2\n');

    await ensureRepo(dir);

    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('production');
    expect(await fsp.readFile(join(dir, 'wp-version.php'), 'utf8')).toBe('v2\n'); // tree untouched
  });
});

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
