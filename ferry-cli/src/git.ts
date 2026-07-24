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
