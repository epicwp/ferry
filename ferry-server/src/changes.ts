import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { runGit } from '../../ferry-cli/src/git.js';
import { writeJournal } from '../../ferry-cli/src/journal.js';
import type { ChangeFile, DbOp, Precondition, SmokeCheck } from '../../ferry-cli/src/push-types.js';
import { isRefusedBareTable, stripTablePrefix } from '../../ferry-cli/src/refusals.js';
import type { Change, Site, Store } from './store.js';

const execFileP = promisify(execFile);

export interface ChangeServiceDeps {
  cloneDir: (slug: string) => string;
  appendSystemEvent: (siteId: number, type: string, payload: Record<string, unknown>) => void;
  /** The site's actual table prefix (real wiring: `loadProfile(slug).info?.prefix ?? 'wp_'`,
   *  mirroring journal.ts) - a hardening install may run `shop_` instead of `wp_`. */
  prefixFor: (slug: string) => string;
}

export interface CreateChangeInput {
  title: string;
  summary: string;
  ops: DbOp[];
  preconditions: Precondition[];
  smoke: SmokeCheck[];
}

// Mirrors classify()'s refusal check (ferry-cli/src/journal.ts) and DbOps.php's
// REFUSED_TABLES/REFUSED_PATTERNS: content tables never travel through a change card, even if
// the agent's tool call somehow smuggled one in - never trust tool input. Shared source:
// ferry-cli/src/refusals.ts.

const VALID_OP_KINDS = new Set([
  'option_set', 'option_delete', 'postmeta_set', 'postmeta_delete',
  'row_update', 'row_insert', 'row_delete',
]);

/** Ops arrive from the agent's tool call as untyped JSON cast to `DbOp` - never trust the
 *  compile-time type. Checks the runtime shape the same way isValidPrecondition/
 *  isValidSmokeCheck do before deciding whether a row op needs the refused-table check. */
function validateOps(ops: DbOp[], prefix: string): void {
  for (const op of ops) {
    const r = op as unknown as Record<string, unknown>;
    const kind = r.kind;
    if (typeof kind !== 'string' || !VALID_OP_KINDS.has(kind)) throw new Error(`invalid_op: ${String(kind)}`);
    if (kind === 'row_update' || kind === 'row_insert' || kind === 'row_delete') {
      const table = r.table;
      if (typeof table !== 'string' || table === '') throw new Error(`invalid_op: ${kind}`);
      if (isRefusedBareTable(stripTablePrefix(table, prefix))) throw new Error(`refused_op: ${table}`);

      const pkCol = r.pkCol;
      if (typeof pkCol === 'string') {
        for (const side of ['new', 'old'] as const) {
          const row = r[side];
          if (row && typeof row === 'object' && pkCol in (row as Record<string, unknown>)) {
            const value = (row as Record<string, unknown>)[pkCol];
            if (Number(value) !== Number(r.pk)) throw new Error(`pk_mismatch: ${table}`);
          }
        }
      }
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

// Resolved against a placeholder origin below to check `path` doesn't escape it - a bare
// prefix check (startsWith('/') && !startsWith('//')) isn't enough, since `new URL` treats a
// backslash as a path separator for special schemes: `/\evil.example/x` passes that check yet
// still resolves to `https://evil.example/x` (SSRF).
const SMOKE_CHECK_PLACEHOLDER = 'https://placeholder.invalid';

function isValidSmokePath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  try {
    return new URL(path, SMOKE_CHECK_PLACEHOLDER).origin === new URL(SMOKE_CHECK_PLACEHOLDER).origin;
  } catch {
    return false;
  }
}

function isValidSmokeCheck(s: unknown): s is SmokeCheck {
  if (typeof s !== 'object' || s === null) return false;
  const r = s as Record<string, unknown>;
  return (
    typeof r.label === 'string' &&
    // Relative path only - an absolute URL, protocol-relative, or backslash-disguised path
    // handed to `new URL(path, baseUrl)` (runSmoke, ferry-cli/src/push.ts) would resolve
    // against a HOST OTHER than the site's own, turning a smoke check into an SSRF vector.
    typeof r.path === 'string' && isValidSmokePath(r.path) &&
    typeof r.expectStatus === 'number' &&
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
    validateOps(input.ops, this.deps.prefixFor(site.slug));
    for (const p of input.preconditions) {
      if (!isValidPrecondition(p)) {
        throw new Error(
          'invalid_precondition: expected {type:"option",name,expected} | {type:"file_hash",path,expected} | ' +
            '{type:"row",table,pkCol,pk,column,expected} — expected is the pre-change value (string or null)',
        );
      }
      // The plugin's drift check compares hash_file('sha256', …) — any other digest (md5,
      // sha1) can never match and would make every push conflict against an unchanged file.
      if (p.type === 'file_hash' && !/^[0-9a-f]{64}$/.test(p.expected)) {
        throw new Error(
          'invalid_precondition: file_hash expected must be the sha256 of the baseline file as 64 lowercase hex chars ' +
            '(e.g. `git show production:PATH | sha256sum`) — production compares sha256, so an md5 or other digest always conflicts',
        );
      }
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
    // An empty ops list writes zero journal lines - if the previous change on this branch also
    // had none, the content is byte-identical and `git add` is a no-op: nothing staged, so
    // `git commit` would exit non-zero (nothing to commit) and runGit would throw. Skip the
    // commit in that case; headSha below is then just the current HEAD, unchanged.
    const staged = await runGit(dir, ['status', '--porcelain']);
    if (staged !== '') {
      await runGit(dir, ['commit', '-q', '-m', `ferry: journal for "${input.title}"`]);
    }
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
