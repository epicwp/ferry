import { execFile } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { DROP_INS } from './overlay.js';

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

const GITIGNORE = `/.gitignore
/CLAUDE.md
/wp-config.php
/wp-config-ddev.php
/.ddev/
/wp-content/uploads/
/wp-content/mu-plugins/ferry-*
/ferry-uploads-fallback.php
`;

export async function writeGitignore(dir: string): Promise<void> {
  await fsp.writeFile(join(dir, '.gitignore'), GITIGNORE);
}

const CLAUDE_MD = `# Ferry clone - ground rules

This is a **ferry clone** of a production WordPress site, for debugging. Work here as you
would in Claude Code: grep, read, edit, and run \`wp-cli\`, \`git\`, and shell commands.

- **The database is a point-in-time snapshot.** Production owns the live data - do not assume
  orders, users, or options here are current.
- **The clone is airtight.** Outbound email and HTTP are blocked (license checks for EDD,
  Freemius, and WooCommerce.com are answered locally with valid stubs). Missing uploads
  are fetched from production on first request and saved locally; \`ferry fetch-uploads\`
  bulk-fetches. This is expected, not a bug.
- **Changes go back through git.** Make code changes on your work branch; \`git diff production\`
  is exactly what would be pushed to production.
- **Never edit these local artifacts** - they are ferry/DDEV-generated, git-ignored, and never
  travel to production: \`wp-config.php\`, anything under \`.ddev/\`, and
  \`wp-content/mu-plugins/ferry-overlay.php\`, \`wp-content/mu-plugins/ferry-stubs.php\`,
  \`ferry-uploads-fallback.php\`.
- **Drop-ins are disabled on purpose.** Files like \`object-cache.php\` are renamed to
  \`*.php.ferry-disabled\` so the clone does not fatal on services (Redis, etc.) that are not
  running locally.
`;

export async function writeClaudeMd(dir: string): Promise<void> {
  await fsp.writeFile(join(dir, 'CLAUDE.md'), CLAUDE_MD);
}

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
