import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbOp, Precondition, SmokeCheck } from '../../ferry-cli/src/push-types.js';
import type { ChangeServiceDeps, CreateChangeInput } from '../src/changes.js';
import { ChangeService } from '../src/changes.js';
import type { Site } from '../src/store.js';
import { Store } from '../src/store.js';

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

/** production branch with one committed file, then agent/work branched off with a
 *  committed edit to that file - the shape ChangeService.create() expects to run against. */
function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ferry-clone-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'ferry');
  git(dir, 'config', 'user.email', 'ferry@localhost');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/production');
  writeFileSync(join(dir, 'site.php'), 'old value\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  git(dir, 'checkout', '-q', '-b', 'agent/work');
  writeFileSync(join(dir, 'site.php'), 'new value\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fix: vat calc');
  return dir;
}

const DEFAULT_OPS: DbOp[] = [{ kind: 'option_set', name: 'blogname', old: 'A', new: 'B' }];
const DEFAULT_PRECONDITIONS: Precondition[] = [];
const DEFAULT_SMOKE: SmokeCheck[] = [{ label: 'home', path: '/', expectStatus: 200 }];

function validInput(over: Partial<CreateChangeInput> = {}): CreateChangeInput {
  return {
    title: 'Fix VAT calc',
    summary: 'VAT was computed pre-discount; now computed after.',
    ops: DEFAULT_OPS,
    preconditions: DEFAULT_PRECONDITIONS,
    smoke: DEFAULT_SMOKE,
    ...over,
  };
}

describe('ChangeService', () => {
  let cloneDir: string;
  let store: Store;
  let site: Site;
  let events: { siteId: number; type: string; payload: Record<string, unknown> }[];
  let service: ChangeService;

  function serviceWith(overrides: Partial<ChangeServiceDeps>): ChangeService {
    return new ChangeService(store, {
      cloneDir: () => cloneDir,
      appendSystemEvent: (siteId, type, payload) => { events.push({ siteId, type, payload }); },
      prefixFor: () => 'wp_',
      ...overrides,
    });
  }

  beforeEach(() => {
    cloneDir = setupRepo();
    store = new Store(':memory:');
    const user = store.createUser('a@example.com', 'h')!;
    site = store.createSite(user.id, 'Klant', 'https://klant.nl', 'klant-nl')!;
    events = [];
    service = serviceWith({});
  });

  afterEach(() => {
    store.close();
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it('creates a draft change card from committed work on agent/work', async () => {
    const change = await service.create(site, validInput());

    expect(change.status).toBe('draft');
    expect(change.branch).toBe('agent/work');
    expect(change.diffText).toContain('-old value');
    expect(change.diffText).toContain('+new value');
    expect(change.diffText).not.toContain('journal.ndjson');

    // journal.ndjson was written and committed on agent/work (tree clean afterwards)
    expect(git(cloneDir, 'status', '--porcelain')).toBe('');
    const journalAtHead = git(cloneDir, 'show', 'HEAD:journal.ndjson');
    expect(journalAtHead).toBe(JSON.stringify(validInput().ops[0]));
    expect(git(cloneDir, 'rev-parse', 'HEAD')).toBe(change.headSha);

    // persisted as a draft row, keyed by seq
    const stored = store.changeBySeq(site.id, change.seq);
    expect(stored).toMatchObject({ id: change.id, status: 'draft', title: 'Fix VAT calc' });

    // system event fired on the change_card, carrying the new change's identity
    expect(events).toEqual([{
      siteId: site.id,
      type: 'change_card',
      payload: { changeId: change.id, seq: change.seq, title: 'Fix VAT calc', status: 'draft' },
    }]);
  });

  it('maps files_json sanely for edits, adds, deletes, and renames', async () => {
    // Extend the fixture: add a new file, delete an existing one, and rename a third.
    writeFileSync(join(cloneDir, 'keep.php'), 'keep me\n');
    git(cloneDir, 'checkout', '-q', 'production');
    writeFileSync(join(cloneDir, 'keep.php'), 'keep me\n');
    git(cloneDir, 'add', '-A');
    git(cloneDir, 'commit', '-q', '-m', 'add keep.php on production');
    git(cloneDir, 'checkout', '-q', 'agent/work');
    git(cloneDir, 'merge', '-q', 'production', '-m', 'merge');
    writeFileSync(join(cloneDir, 'new.php'), 'brand new\n');
    git(cloneDir, 'mv', 'keep.php', 'renamed.php');
    git(cloneDir, 'add', '-A');
    git(cloneDir, 'commit', '-q', '-m', 'add/rename');

    const change = await service.create(site, validInput());
    const byPath = new Map(change.files.map((f) => [f.path, f]));

    expect(byPath.get('site.php')).toMatchObject({ oldHash: expect.any(String), newHash: expect.any(String) });
    expect(byPath.get('new.php')).toMatchObject({ oldHash: null, newHash: expect.any(String) });
    // rename decomposes into an old-side delete and a new-side add
    expect(byPath.get('keep.php')).toMatchObject({ oldHash: expect.any(String), newHash: null });
    expect(byPath.get('renamed.php')).toMatchObject({ oldHash: null, newHash: expect.any(String) });
  });

  it('throws uncommitted_work when the tree is dirty', async () => {
    writeFileSync(join(cloneDir, 'site.php'), 'uncommitted edit\n');
    await expect(service.create(site, validInput())).rejects.toThrow('uncommitted_work');
    expect(events).toEqual([]);
  });

  it('throws wrong_branch when HEAD is not agent/work', async () => {
    git(cloneDir, 'checkout', '-q', 'production');
    await expect(service.create(site, validInput())).rejects.toThrow(/wrong_branch/);
    expect(events).toEqual([]);
  });

  it('throws refused_op for a row op on a refused table, before touching the clone', async () => {
    const input = validInput({
      ops: [{ kind: 'row_update', table: 'wp_posts', pkCol: 'ID', pk: 1, old: {}, new: {} }],
    });
    await expect(service.create(site, input)).rejects.toThrow(/refused_op/);
    // guard fires before any git mutation - still clean, still on the pre-existing commit
    expect(git(cloneDir, 'status', '--porcelain')).toBe('');
    expect(store.changesFor(site.id)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('throws refused_op case-insensitively (mixed-case table name, default wp_ prefix)', async () => {
    const input = validInput({
      ops: [{ kind: 'row_update', table: 'WP_POSTS', pkCol: 'ID', pk: 1, old: {}, new: {} }],
    });
    await expect(service.create(site, input)).rejects.toThrow(/refused_op/);
  });

  it('refuses a row op on the actual site prefix, not just the wp_ default', async () => {
    const shopService = serviceWith({ prefixFor: () => 'shop_' });
    const input = validInput({
      ops: [{ kind: 'row_update', table: 'shop_users', pkCol: 'ID', pk: 1, old: {}, new: {} }],
    });
    await expect(shopService.create(site, input)).rejects.toThrow(/refused_op/);
  });

  it('does not refuse a wp_-prefixed table when the real prefix is shop_ (not stripped, no false match)', async () => {
    const shopService = serviceWith({ prefixFor: () => 'shop_' });
    // Under a shop_ install this table is some unrelated custom table named wp_something,
    // not WordPress's own wp_posts - it must not be silently stripped and misclassified.
    const input = validInput({
      ops: [{ kind: 'row_update', table: 'wp_widgets', pkCol: 'ID', pk: 1, old: {}, new: {} }],
    });
    await expect(shopService.create(site, input)).resolves.toMatchObject({ status: 'draft' });
  });

  it('throws invalid_op for an unrecognized op kind, before touching the clone', async () => {
    const input = validInput({
      ops: [{ kind: 'row_updatee', table: 'wp_options', pkCol: 'ID', pk: 1, old: {}, new: {} } as unknown as DbOp],
    });
    await expect(service.create(site, input)).rejects.toThrow(/invalid_op/);
    expect(git(cloneDir, 'status', '--porcelain')).toBe('');
    expect(store.changesFor(site.id)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('throws invalid_op (not a raw TypeError) for a row op missing table', async () => {
    const input = validInput({
      ops: [{ kind: 'row_update', pkCol: 'ID', pk: 1, old: {}, new: {} } as unknown as DbOp],
    });
    await expect(service.create(site, input)).rejects.toThrow(/invalid_op/);
    expect(git(cloneDir, 'status', '--porcelain')).toBe('');
    expect(store.changesFor(site.id)).toEqual([]);
  });

  // ---- Task 12: pk / new[pkCol] cross-check ----

  it('throws pk_mismatch when a row op\'s new[pkCol] disagrees with pk, before touching the clone', async () => {
    const input = validInput({
      ops: [{ kind: 'row_insert', table: 'wp_custom', pkCol: 'id', pk: 7, new: { id: 8 } } as unknown as DbOp],
    });
    await expect(service.create(site, input)).rejects.toThrow('pk_mismatch: wp_custom');
    expect(git(cloneDir, 'status', '--porcelain')).toBe('');
    expect(store.changesFor(site.id)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('accepts a row op whose new[pkCol] agrees with pk as a numeric string (binlog values are strings)', async () => {
    const input = validInput({
      ops: [{ kind: 'row_insert', table: 'wp_custom', pkCol: 'id', pk: 7, new: { id: '7' } }],
    });
    await expect(service.create(site, input)).resolves.toMatchObject({ status: 'draft' });
  });

  // ---- final-review fix 8: a smoke check path must be relative, not an absolute URL ----

  it('throws invalid_smoke for a smoke check with an absolute URL path (SSRF guard)', async () => {
    const input = validInput({ smoke: [{ label: 'evil', path: 'https://evil.example', expectStatus: 200 }] });
    await expect(service.create(site, input)).rejects.toThrow(/invalid_smoke/);
    expect(git(cloneDir, 'status', '--porcelain')).toBe('');
    expect(store.changesFor(site.id)).toEqual([]);
  });

  // ---- SSRF bypass: a backslash is a path separator for `new URL` on special schemes, so a
  // path starting with '/' and not '//' can still resolve to a different host at push time. ----

  it('throws invalid_smoke for a backslash-disguised absolute host (single backslash)', async () => {
    const input = validInput({ smoke: [{ label: 'evil', path: '/\\evil.example/x', expectStatus: 200 }] });
    await expect(service.create(site, input)).rejects.toThrow(/invalid_smoke/);
    expect(git(cloneDir, 'status', '--porcelain')).toBe('');
    expect(store.changesFor(site.id)).toEqual([]);
  });

  it('throws invalid_smoke for a backslash-disguised absolute host (double backslash)', async () => {
    const input = validInput({ smoke: [{ label: 'evil', path: '/\\\\127.0.0.1/x', expectStatus: 200 }] });
    await expect(service.create(site, input)).rejects.toThrow(/invalid_smoke/);
    expect(git(cloneDir, 'status', '--porcelain')).toBe('');
    expect(store.changesFor(site.id)).toEqual([]);
  });

  it('still accepts a normal relative smoke path', async () => {
    const input = validInput({ smoke: [{ label: 'checkout', path: '/checkout', expectStatus: 200 }] });
    await expect(service.create(site, input)).resolves.toMatchObject({ status: 'draft' });
  });

  // ---- final-review fix 9: an empty-ops journal must not break a second no-op change ----

  it('two consecutive changes with no DB ops both succeed on the same branch', async () => {
    const first = await service.create(site, validInput({ ops: [] }));
    expect(first.status).toBe('draft');
    const headAfterFirst = git(cloneDir, 'rev-parse', 'HEAD');

    const second = await service.create(site, validInput({ ops: [] }));

    expect(second.status).toBe('draft');
    // journal content unchanged (both empty) - nothing new to commit, HEAD stands still.
    expect(second.headSha).toBe(headAfterFirst);
    expect(git(cloneDir, 'status', '--porcelain')).toBe('');
  });
});
