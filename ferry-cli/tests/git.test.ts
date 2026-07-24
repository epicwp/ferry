import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, promises as fsp, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRepo, neutralizeNestedGit } from '../src/git.js';

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
