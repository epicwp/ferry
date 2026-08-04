import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { runGit } from '../../ferry-cli/src/git.js';
import { writeJournal } from '../../ferry-cli/src/journal.js';
import type { ChangeFile, DbOp, Precondition, SmokeCheck } from '../../ferry-cli/src/push-types.js';
import type { Change, Site, Store } from './store.js';

const execFileP = promisify(execFile);

export interface ChangeServiceDeps {
  cloneDir: (slug: string) => string;
  appendSystemEvent: (siteId: number, type: string, payload: Record<string, unknown>) => void;
}

export interface CreateChangeInput {
  title: string;
  summary: string;
  ops: DbOp[];
  preconditions: Precondition[];
  smoke: SmokeCheck[];
}

// Mirrors Task 10's classify() refusal list (ferry-cli/src/journal.ts) and DbOps.php's
// REFUSED_TABLES/REFUSED_PATTERNS: content tables never travel through a change card, even if
// the agent's tool call somehow smuggled one in - never trust tool input.
const REFUSED_TABLES = new Set(['posts', 'comments', 'commentmeta', 'users', 'usermeta']);
const REFUSED_PREFIXES = ['woocommerce_', 'wc_', 'actionscheduler_'];

function isRefusedTable(table: string): boolean {
  const stripped = table.startsWith('wp_') ? table.slice(3) : table;
  return REFUSED_TABLES.has(stripped) || REFUSED_PREFIXES.some((p) => stripped.startsWith(p));
}

/** Only row_* ops name a table; option/postmeta ops never touch content tables. */
function validateOps(ops: DbOp[]): void {
  for (const op of ops) {
    if (op.kind === 'row_update' || op.kind === 'row_insert' || op.kind === 'row_delete') {
      if (isRefusedTable(op.table)) throw new Error(`refused_op: ${op.table}`);
    }
  }
}

function isValidPrecondition(p: unknown): p is Precondition {
  if (typeof p !== 'object' || p === null) return false;
  const r = p as Record<string, unknown>;
  switch (r.type) {
    case 'option':
      return typeof r.name === 'string' && (r.expected === null || typeof r.expected === 'string');
    case 'file_hash':
      return typeof r.path === 'string' && typeof r.expected === 'string';
    case 'row':
      return (
        typeof r.table === 'string' && typeof r.pkCol === 'string' && typeof r.pk === 'number' &&
        typeof r.column === 'string' && (r.expected === null || typeof r.expected === 'string')
      );
    default:
      return false;
  }
}

function isValidSmokeCheck(s: unknown): s is SmokeCheck {
  if (typeof s !== 'object' || s === null) return false;
  const r = s as Record<string, unknown>;
  return (
    typeof r.label === 'string' && typeof r.path === 'string' && typeof r.expectStatus === 'number' &&
    (r.expectText === undefined || typeof r.expectText === 'string')
  );
}

/** Raw bytes of `path` at `rev` - bypasses runGit's stdout .trim()/utf8 decode, which would
 *  corrupt trailing-newline text files and mangle binary blobs (Task 11's defaultBlobFor
 *  pattern, ferry-cli/src/push.ts). Null when the path doesn't exist at that rev. */
async function blobAt(cloneDir: string, rev: string, path: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileP('git', ['show', `${rev}:${path}`], {
      cwd: cloneDir,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout as unknown as Buffer;
  } catch {
    return null;
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Parses `git diff --numstat -z`'s NUL-delimited output into the set of touched paths. A
 *  rename/copy line has an empty path field followed by two NUL-terminated pathnames (old,
 *  new) instead of one - both are returned, decomposing the rename into an old-side "delete"
 *  and a new-side "add" (each independently hashed at base/head by the caller, naturally null
 *  on the side where the path doesn't exist). */
function numstatPaths(raw: string): string[] {
  const tokens = raw.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i];
    if (!line) continue;
    const firstTab = line.indexOf('\t');
    const secondTab = line.indexOf('\t', firstTab + 1);
    const path = line.slice(secondTab + 1);
    if (path === '') {
      const oldPath = tokens[++i];
      const newPath = tokens[++i];
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
    } else {
      paths.push(path);
    }
  }
  return [...new Set(paths)];
}

/**
 * Turns committed work on `agent/work` into a draft change card (design §Write-back: the
 * agent proposes, the human pushes). Never mutates the clone until every guard has passed.
 */
export class ChangeService {
  constructor(
    private readonly store: Store,
    private readonly deps: ChangeServiceDeps,
  ) {}

  async create(site: Site, input: CreateChangeInput): Promise<Change> {
    // Validate everything first - no journal commit on a change that then fails validation.
    validateOps(input.ops);
    for (const p of input.preconditions) {
      if (!isValidPrecondition(p)) throw new Error('invalid_precondition');
    }
    for (const s of input.smoke) {
      if (!isValidSmokeCheck(s)) throw new Error('invalid_smoke');
    }

    const dir = this.deps.cloneDir(site.slug);
    const status = await runGit(dir, ['status', '--porcelain']);
    if (status !== '') throw new Error('uncommitted_work');
    const branch = await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch !== 'agent/work') throw new Error(`wrong_branch: ${branch}`);

    const base = await runGit(dir, ['merge-base', 'production', 'HEAD']);
    const diffText = await runGit(dir, ['diff', `${base}..HEAD`, '--', '.', ':(exclude)journal.ndjson']);
    const numstat = await runGit(dir, ['diff', '--numstat', '-z', `${base}..HEAD`, '--', '.', ':(exclude)journal.ndjson']);
    const files: ChangeFile[] = [];
    for (const path of numstatPaths(numstat)) {
      const [oldBlob, newBlob] = await Promise.all([blobAt(dir, base, path), blobAt(dir, 'HEAD', path)]);
      files.push({ path, oldHash: oldBlob ? sha256(oldBlob) : null, newHash: newBlob ? sha256(newBlob) : null });
    }

    await writeJournal(dir, input.ops);
    await runGit(dir, ['add', 'journal.ndjson']);
    await runGit(dir, ['commit', '-q', '-m', `ferry: journal for "${input.title}"`]);
    const headSha = await runGit(dir, ['rev-parse', 'HEAD']);

    const change = this.store.createChange(site.id, {
      title: input.title,
      summary: input.summary,
      branch,
      baseSha: base,
      headSha,
      diffText,
      files,
      ops: input.ops,
      preconditions: input.preconditions,
      smoke: input.smoke,
    });

    this.deps.appendSystemEvent(site.id, 'change_card', {
      changeId: change.id,
      seq: change.seq,
      title: change.title,
      status: change.status,
    });
    return change;
  }
}
