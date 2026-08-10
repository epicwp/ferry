import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureAgentBranch, hasUncommittedAgentWork, resetAgentBranchIfIdle } from '../src/agent/branch.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function makeClone(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-branch-'));
  git(dir, 'init', '-b', 'production');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'index.php'), '<?php // wp');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'pull');
  return dir;
}

describe('ensureAgentBranch', () => {
  it('creates agent/work from production and checks it out', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/work');
    expect(git(dir, 'rev-parse', 'agent/work')).toBe(git(dir, 'rev-parse', 'production'));
  });

  it('is idempotent and never resets existing agent work', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    writeFileSync(join(dir, 'fix.php'), '<?php // fix');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'agent fix');
    const head = git(dir, 'rev-parse', 'HEAD');
    await ensureAgentBranch(dir);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head); // unchanged
  });

  it('checks agent/work back out when the tree sits on production', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    git(dir, 'checkout', 'production'); // a sync leaves the tree here
    await ensureAgentBranch(dir);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/work');
  });
});

describe('hasUncommittedAgentWork', () => {
  it('is false when agent/work does not exist yet', async () => {
    const dir = makeClone();
    expect(await hasUncommittedAgentWork(dir)).toBe(false);
  });

  it('is false when agent/work exists and the tree is clean', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    expect(await hasUncommittedAgentWork(dir)).toBe(false);
  });

  it('is true when agent/work exists and the tree has uncommitted changes', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    writeFileSync(join(dir, 'fix.php'), '<?php // wip');
    expect(await hasUncommittedAgentWork(dir)).toBe(true);
  });

  it('tolerates a missing/non-git clone dir', async () => {
    expect(await hasUncommittedAgentWork('/no/such/ferry-clone-dir')).toBe(false);
  });
});

describe('resetAgentBranchIfIdle', () => {
  it('resets agent/work to production when the worktree is clean', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    writeFileSync(join(dir, 'fix.php'), '<?php // fix');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'agent fix');
    expect(await resetAgentBranchIfIdle(dir)).toBe(true);
    expect(git(dir, 'rev-parse', 'agent/work')).toBe(git(dir, 'rev-parse', 'production'));
  });

  it('does not reset when the worktree is dirty', async () => {
    const dir = makeClone();
    await ensureAgentBranch(dir);
    writeFileSync(join(dir, 'fix.php'), '<?php // fix');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'agent fix');
    writeFileSync(join(dir, 'fix.php'), '<?php // wip');
    expect(await resetAgentBranchIfIdle(dir)).toBe(false);
    expect(git(dir, 'rev-parse', 'agent/work')).not.toBe(git(dir, 'rev-parse', 'production'));
  });

  it('is a no-op without an agent/work branch and on a non-git dir', async () => {
    const bareProductionOnlyDir = makeClone();
    expect(await resetAgentBranchIfIdle(bareProductionOnlyDir)).toBe(false);
    expect(await resetAgentBranchIfIdle('/nonexistent')).toBe(false);
  });
});
