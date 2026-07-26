import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureAgentBranch } from '../src/agent/branch.js';
import { siteContext } from '../src/agent/context.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function makeClone(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-ctx-'));
  git(dir, 'init', '-b', 'production');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'functions.php'), '<?php add_filter();');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'pull');
  return dir;
}

const profileFn = () => ({
  info: { wp: '6.5', php: { version: '8.2' }, db: { server: 'mariadb', version: '10.6' }, server: 'nginx' },
});

describe('siteContext', () => {
  it('reports branch, base and a clean diff on a fresh clone', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    const ctx = await siteContext('s', dir, profileFn);
    expect(ctx.branch).toBe('agent/work');
    expect(ctx.baseCommit).toBe(git(dir, 'rev-parse', '--short', 'production'));
    expect(ctx.files).toEqual([]);
    expect(ctx.environment).toEqual({ wp: '6.5', php: '8.2', db: 'mariadb 10.6', webServer: 'nginx' });
  });

  it('reports agent changes vs production', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    writeFileSync(join(dir, 'functions.php'), '<?php // fixed');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'fix');
    const ctx = await siteContext('s', dir, profileFn);
    expect(ctx.files).toEqual([{ status: 'M', path: 'functions.php' }]);
    expect(ctx.shortstat).toContain('1 file changed');
  });

  it('survives a missing profile info block', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    const ctx = await siteContext('s', dir, () => ({}));
    expect(ctx.environment).toEqual({});
  });
});
