import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BRANCH = 'agent/work';

async function git(cloneDir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: cloneDir });
  return stdout.trim();
}

/** The agent works on agent/work, branched from production (design: Git branch policy).
 *  Existing agent commits are never reset mid-session; after a successful sync with no
 *  active change, `resetAgentBranchIfIdle` drops them. */
export async function ensureAgentBranch(cloneDir: string): Promise<void> {
  const exists = await git(cloneDir, 'branch', '--list', BRANCH);
  if (exists === '') {
    await git(cloneDir, 'branch', BRANCH, 'production');
  }
  const current = await git(cloneDir, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (current !== BRANCH) {
    await git(cloneDir, 'checkout', BRANCH);
  }
}

/** True when agent/work exists and the worktree has uncommitted changes — the case a sync's
 *  `git checkout production` + `git add -A` would bake into `production` (or fail on).
 *  Tolerates a missing/non-git clone dir (never-chatted sites) by returning false. */
export async function hasUncommittedAgentWork(cloneDir: string): Promise<boolean> {
  try {
    const exists = await git(cloneDir, 'branch', '--list', BRANCH);
    if (exists === '') return false;
    const status = await git(cloneDir, 'status', '--porcelain');
    return status !== '';
  } catch {
    return false;
  }
}

/** After a successful sync, `production` holds current prod content (including anything
 *  already pushed), so accumulated agent commits are safe to drop — IF the worktree is clean.
 *  The caller additionally guards on "no draft/conflict/pushing change rows" (issue #9:
 *  per-card file scoping); this function only owns the git-level safety checks. */
export async function resetAgentBranchIfIdle(cloneDir: string): Promise<boolean> {
  try {
    const exists = await git(cloneDir, 'branch', '--list', BRANCH);
    if (exists === '') return false;
    const status = await git(cloneDir, 'status', '--porcelain');
    if (status !== '') return false;
    const current = await git(cloneDir, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (current === BRANCH) await git(cloneDir, 'checkout', 'production');
    await git(cloneDir, 'branch', '-f', BRANCH, 'production');
    return true;
  } catch {
    return false;
  }
}
