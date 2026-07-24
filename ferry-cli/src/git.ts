import { execFile } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import { join, relative } from 'node:path';
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
