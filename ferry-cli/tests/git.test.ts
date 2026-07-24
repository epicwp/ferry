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
