import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadProfile } from '../../../ferry-cli/src/profile.js';

const run = promisify(execFile);

export interface AgentContext {
  branch: string;
  baseCommit: string;
  shortstat: string;
  files: { status: string; path: string }[];
  environment: { wp?: string; php?: string; db?: string; webServer?: string };
}

async function git(cloneDir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: cloneDir });
  return stdout.trim();
}

export async function siteContext(
  slug: string,
  cloneDir: string,
  loadProfileFn: (slug: string) => { info?: unknown } = loadProfile,
): Promise<AgentContext> {
  const [branch, baseCommit, shortstat, nameStatus] = await Promise.all([
    git(cloneDir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(cloneDir, 'rev-parse', '--short', 'production'),
    git(cloneDir, 'diff', '--shortstat', 'production'),
    git(cloneDir, 'diff', '--name-status', 'production'),
  ]);
  const files = nameStatus === '' ? [] : nameStatus.split('\n').slice(0, 20).map((line) => {
    const [status = '', ...rest] = line.split('\t');
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
    const path = isRenameOrCopy ? rest[rest.length - 1]! : rest.join('\t');
    return { status, path };
  });
  let environment: AgentContext['environment'] = {};
  try {
    const info = (loadProfileFn(slug).info ?? {}) as Record<string, unknown>;
    const php = (info.php ?? {}) as Record<string, unknown>;
    const db = (info.db ?? {}) as Record<string, unknown>;
    environment = {
      ...(typeof info.wp === 'string' ? { wp: info.wp } : {}),
      ...(typeof php.version === 'string' ? { php: php.version } : {}),
      ...(db.server ? { db: `${String(db.server)} ${String(db.version ?? '')}`.trim() } : {}),
      ...(typeof info.server === 'string' ? { webServer: info.server } : {}),
    };
  } catch {
    environment = {};
  }
  return { branch, baseCommit, shortstat, files, environment };
}
