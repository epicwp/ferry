import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, promises as fsp, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRepo, neutralizeNestedGit, writeGitignore, writeClaudeMd } from '../src/git.js';

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
