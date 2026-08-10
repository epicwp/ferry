import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FerryClient } from '../src/client.js';
import { saveProfile } from '../src/profile.js';
import { defaultBlobFor, invertOp, push, runSmoke } from '../src/push.js';
import { ROLLBACK_FAILED_PREFIX } from '../src/push-types.js';
import type { ChangeSpec, DbOp, StepEvent } from '../src/push-types.js';

let home: string;
let server: Server | undefined;

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ferry-home-'));
  process.env.FERRY_HOME = home;
});

afterEach(() => {
  server?.close();
  server = undefined;
  delete process.env.FERRY_HOME;
  rmSync(home, { recursive: true, force: true });
});

function pair(base: string): void {
  saveProfile({ url: base, secret: 's', slug: 'site', clonePath: join(home, 'clone') });
}

interface FakeCall { route: string; body: any }

/** Fake FerryClient: records every postJson call, replies with canned responses per route
 *  (stage responses are consumed in order - one per /stage call). */
function fakeClient(opts: { stage?: any[]; commit?: any; rollback?: any }): { client: FerryClient; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let stageIdx = 0;
  const client = {
    postJson: async (route: string, body: any) => {
      calls.push({ route, body });
      if (route === '/ferry/v1/stage') return { data: (opts.stage ?? [])[stageIdx++] };
      if (route === '/ferry/v1/commit') return { data: opts.commit };
      if (route === '/ferry/v1/rollback') return { data: opts.rollback };
      throw new Error(`unexpected route: ${route}`);
    },
  };
  return { client: client as unknown as FerryClient, calls };
}

const COMMIT_OK = {
  committed: true,
  steps: [
    { name: 'hashes', ok: true, durationMs: 1 },
    { name: 'drift', ok: true, durationMs: 2 },
    { name: 'backup', ok: true, durationMs: 3 },
    { name: 'swap', ok: true, durationMs: 4 },
    { name: 'journal', ok: true, durationMs: 5 },
  ],
  conflicts: [],
};

function basicSpec(over: Partial<ChangeSpec> = {}): ChangeSpec {
  return {
    files: [{ path: 'wp-content/x.php', newHash: 'newhash', oldHash: 'oldhash' }],
    ops: [{ kind: 'option_set', name: 'blogname', old: 'A', new: 'B' }],
    preconditions: [],
    smoke: [{ label: 'home', path: '/', expectStatus: 200 }],
    ...over,
  };
}

const blobFor = async () => Buffer.from('new content');

describe('push', () => {
  it('happy path: stages, commits, smokes green -> pushed, all steps start/ok in order', async () => {
    const base = await listen((req, res) => {
      res.statusCode = 200;
      res.end('home ok');
    });
    pair(base);
    const { client, calls } = fakeClient({
      stage: [{ staged: ['wp-content/x.php'], rejected: [] }],
      commit: COMMIT_OK,
    });
    const events: StepEvent[] = [];
    const outcome = await push('site', basicSpec(), {
      headSha: 'deadbeef',
      client,
      blobFor,
      onStep: (e) => events.push(e),
    });

    expect(outcome.status).toBe('pushed');
    if (outcome.status === 'pushed') {
      expect(outcome.smoke).toEqual([{ label: 'home', ok: true, detail: expect.stringContaining('200') }]);
    }
    expect(events.map((e) => `${e.step}:${e.status}`)).toEqual([
      'staging:start', 'staging:ok',
      'hashes:start', 'hashes:ok',
      'drift:start', // emitted before the /commit POST (final-fix-wave 2) - bare, no matching
      // status yet, so a throw during that call leaves 'drift' (not 'hashes') as the last step.
      'drift:start', 'drift:ok', // then the plugin's own drift result is re-emitted as usual.
      'swap:start', 'swap:ok',
      'journal:start', 'journal:ok',
      'smoke:start', 'smoke:ok',
    ]);
    const swapOk = events.find((e) => e.step === 'swap' && e.status === 'ok');
    expect(swapOk?.durationMs).toBe(7); // backup(3) + swap(4), plugin steps folded into one
    const driftOk = events.find((e) => e.step === 'drift' && e.status === 'ok');
    expect(driftOk?.durationMs).toBe(2);
    const journalOk = events.find((e) => e.step === 'journal' && e.status === 'ok');
    expect(journalOk?.durationMs).toBe(5);

    const stageCall = calls.find((c) => c.route === '/ferry/v1/stage')!;
    expect(stageCall.body.txid).toMatch(/^[0-9a-f]{32}$/);
    expect(stageCall.body.files).toEqual([
      { path: 'wp-content/x.php', hash: 'newhash', data_b64: (await blobFor()).toString('base64') },
    ]);
    const commitCall = calls.find((c) => c.route === '/ferry/v1/commit')!;
    expect(commitCall.body).toEqual({
      txid: stageCall.body.txid,
      files: [{ path: 'wp-content/x.php', new_hash: 'newhash', old_hash: 'oldhash' }],
      ops: basicSpec().ops,
      preconditions: [],
      force: false,
    });
  });

  it('commit conflict -> conflict outcome; no smoke, no rollback', async () => {
    pair('http://127.0.0.1:1'); // unreachable on purpose - smoke must never be hit
    const { client, calls } = fakeClient({
      stage: [{ staged: ['wp-content/x.php'], rejected: [] }],
      commit: {
        committed: false,
        steps: [
          { name: 'hashes', ok: true, durationMs: 1 },
          { name: 'drift', ok: false, durationMs: 2 },
        ],
        conflicts: [{ key: 'wp-content/x.php', expected: 'oldhash', found: 'other-hash' }],
      },
    });
    const events: StepEvent[] = [];
    const outcome = await push('site', basicSpec(), {
      headSha: 'x',
      client,
      blobFor,
      onStep: (e) => events.push(e),
    });

    expect(outcome.status).toBe('conflict');
    if (outcome.status === 'conflict') {
      expect(outcome.conflicts).toEqual([{ key: 'wp-content/x.php', expected: 'oldhash', found: 'other-hash' }]);
    }
    expect(events.map((e) => e.step)).toEqual(['staging', 'staging', 'hashes', 'hashes', 'drift']);
    expect(calls.some((c) => c.route === '/ferry/v1/rollback')).toBe(false);
  });

  it('smoke fail -> rollback called with inverted ops; outcome rolled_back', async () => {
    const base = await listen((req, res) => {
      res.statusCode = 500;
      res.end('down');
    });
    pair(base);
    const { client, calls } = fakeClient({
      stage: [{ staged: ['wp-content/x.php'], rejected: [] }],
      commit: COMMIT_OK,
      rollback: { rolled_back: true, conflicts: [] },
    });
    const spec = basicSpec({ ops: [{ kind: 'option_set', name: 'x', old: 'incl', new: 'excl' }] });
    const outcome = await push('site', spec, { headSha: 'x', client, blobFor });

    expect(outcome.status).toBe('rolled_back');
    if (outcome.status === 'rolled_back') {
      expect(outcome.reason).toBe('smoke_failed');
      expect(outcome.smoke?.[0].ok).toBe(false);
    }
    const rollbackCall = calls.find((c) => c.route === '/ferry/v1/rollback');
    expect(rollbackCall).toBeDefined();
    expect(rollbackCall!.body.txid).toEqual(expect.any(String));
    expect(rollbackCall!.body.ops).toEqual([{ kind: 'option_set', name: 'x', old: 'excl', new: 'incl' }]);
  });

  it('smoke fail AND rollback itself fails -> honest error outcome, not a false rolled_back', async () => {
    const base = await listen((req, res) => {
      res.statusCode = 500;
      res.end('down');
    });
    pair(base);
    const { client } = fakeClient({
      stage: [{ staged: ['wp-content/x.php'], rejected: [] }],
      commit: COMMIT_OK,
      rollback: { rolled_back: false, conflicts: [{ key: 'option:x', expected: 'excl', found: 'other' }] },
    });
    const outcome = await push('site', basicSpec(), { headSha: 'x', client, blobFor });

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.detail).toContain('option:x');
      expect(outcome.detail.toLowerCase()).toContain('rollback');
      // Pinned to the shared constant (ferry-server's PushManager matches this exact prefix
      // to decide draft-vs-conflict) - a wording drift here must fail loudly on this side too.
      expect(outcome.detail.startsWith(ROLLBACK_FAILED_PREFIX)).toBe(true);
    }
  });

  it('defaultBlobFor reads the exact committed bytes - no trim, no UTF-8 mangling', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ferry-repo-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'ferry@localhost'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'ferry'], { cwd: repo });

      const textBytes = Buffer.from('hello world\n', 'utf8'); // trailing newline - runGit's .trim() would strip it
      const binaryBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xbf, 0x00, 0x0a]); // invalid UTF-8
      writeFileSync(join(repo, 'text.txt'), textBytes);
      writeFileSync(join(repo, 'binary.bin'), binaryBytes);
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

      const blobFor = defaultBlobFor(repo, headSha);
      const gotText = await blobFor('text.txt');
      const gotBinary = await blobFor('binary.bin');

      const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
      expect(sha256(gotText)).toBe(sha256(textBytes));
      expect(sha256(gotBinary)).toBe(sha256(binaryBytes));
      expect(gotText.equals(textBytes)).toBe(true);
      expect(gotBinary.equals(binaryBytes)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('batches files into two /stage calls at the ~2MB base64 boundary', async () => {
    pair('http://127.0.0.1:1'); // smoke list is empty - never contacted
    // 0.75 MiB raw -> exactly 1 MiB base64 each; two fit in the 2 MiB cap, the third overflows.
    const bigBuf = Buffer.alloc(786432, 7);
    const { client, calls } = fakeClient({
      stage: [
        { staged: ['f1.bin', 'f2.bin'], rejected: [] },
        { staged: ['f3.bin'], rejected: [] },
      ],
      commit: { ...COMMIT_OK, steps: COMMIT_OK.steps }, // ok for a files-only commit too
    });
    const spec: ChangeSpec = {
      files: ['f1.bin', 'f2.bin', 'f3.bin'].map((p) => ({ path: p, newHash: `${p}-hash`, oldHash: null })),
      ops: [],
      preconditions: [],
      smoke: [],
    };
    const outcome = await push('site', spec, { headSha: 'x', client, blobFor: async () => bigBuf });

    expect(outcome.status).toBe('pushed');
    const stageCalls = calls.filter((c) => c.route === '/ferry/v1/stage');
    expect(stageCalls).toHaveLength(2);
    expect(stageCalls[0].body.files.map((f: any) => f.path)).toEqual(['f1.bin', 'f2.bin']);
    expect(stageCalls[1].body.files.map((f: any) => f.path)).toEqual(['f3.bin']);
  });

  it('stage rejection -> error outcome, no commit call', async () => {
    pair('http://127.0.0.1:1');
    const { client, calls } = fakeClient({
      stage: [{ staged: [], rejected: [{ path: 'wp-content/x.php', code: 'denied_path' }] }],
    });
    const outcome = await push('site', basicSpec(), { headSha: 'x', client, blobFor });
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.detail).toContain('denied_path');
    }
    expect(calls.some((c) => c.route === '/ferry/v1/commit')).toBe(false);
  });

  it('commit apply_error -> error outcome, not conflict', async () => {
    pair('http://127.0.0.1:1');
    const { client } = fakeClient({
      stage: [{ staged: ['wp-content/x.php'], rejected: [] }],
      commit: {
        committed: false,
        steps: [
          { name: 'hashes', ok: true, durationMs: 1 },
          { name: 'drift', ok: true, durationMs: 2 },
          { name: 'backup', ok: true, durationMs: 3 },
          { name: 'swap', ok: true, durationMs: 4 },
          { name: 'journal', ok: false, durationMs: 5 },
        ],
        conflicts: [],
        apply_error: { key: 'option:blogname', detail: 'option_set apply failed' },
      },
    });
    const outcome = await push('site', basicSpec(), { headSha: 'x', client, blobFor });
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.detail).toContain('option_set apply failed');
    }
  });

  it('uses a caller-supplied txid instead of minting its own (final-review fix 3)', async () => {
    const base = await listen((req, res) => {
      res.statusCode = 200;
      res.end('home ok');
    });
    pair(base);
    const { client, calls } = fakeClient({
      stage: [{ staged: ['wp-content/x.php'], rejected: [] }],
      commit: COMMIT_OK,
    });
    const outcome = await push('site', basicSpec(), {
      headSha: 'deadbeef', client, blobFor, txid: 'caller-supplied-txid',
    });

    expect(outcome.txid).toBe('caller-supplied-txid');
    expect(calls.every((c) => c.body.txid === 'caller-supplied-txid')).toBe(true);
  });

  it('commit denied -> error outcome', async () => {
    pair('http://127.0.0.1:1');
    const { client } = fakeClient({
      stage: [{ staged: ['wp-content/x.php'], rejected: [] }],
      commit: { committed: false, steps: [], conflicts: [], denied: [{ path: 'wp-config.php', code: 'denied_path' }] },
    });
    const outcome = await push('site', basicSpec(), { headSha: 'x', client, blobFor });
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.detail).toContain('denied_path');
    }
  });
});

describe('runSmoke', () => {
  it('refuses an absolute URL path without making a request (final-review fix 8)', async () => {
    const results = await runSmoke('http://127.0.0.1:1', [{ label: 'evil', path: 'https://evil.example', expectStatus: 200 }]);
    expect(results).toEqual([{ label: 'evil', ok: false, detail: 'invalid path' }]);
  });

  it('refuses a protocol-relative path without making a request', async () => {
    const results = await runSmoke('http://127.0.0.1:1', [{ label: 'evil', path: '//evil.example', expectStatus: 200 }]);
    expect(results).toEqual([{ label: 'evil', ok: false, detail: 'invalid path' }]);
  });

  it('still runs a normal relative-path check', async () => {
    const base = await listen((req, res) => {
      res.statusCode = 200;
      res.end('home ok');
    });
    const results = await runSmoke(base, [{ label: 'home', path: '/', expectStatus: 200 }]);
    expect(results[0].ok).toBe(true);
  });

  it('still runs a normal /checkout path', async () => {
    const base = await listen((req, res) => {
      res.statusCode = 200;
      res.end('checkout ok');
    });
    const results = await runSmoke(base, [{ label: 'checkout', path: '/checkout', expectStatus: 200 }]);
    expect(results[0].ok).toBe(true);
  });

  // ---- SSRF bypass: `new URL` treats a backslash as a path separator for special schemes, so
  // `/\evil-host/x` still passes `startsWith('/') && !startsWith('//')` yet resolves to a HOST
  // OTHER than baseUrl. A local "evil" server that must never see a hit proves no fetch happens. ----

  it('refuses a backslash-disguised host (single backslash) without ever hitting it', async () => {
    let evilHit = false;
    const evilBase = await listen((req, res) => {
      evilHit = true;
      res.statusCode = 200;
      res.end('should never be reached');
    });
    const evilPort = new URL(evilBase).port;
    const safeBase = 'http://127.0.0.1:1'; // unreachable on purpose - must never be contacted either
    const results = await runSmoke(safeBase, [
      { label: 'evil', path: `/\\127.0.0.1:${evilPort}/x`, expectStatus: 200 },
    ]);
    expect(results).toEqual([{ label: 'evil', ok: false, detail: 'invalid path' }]);
    expect(evilHit).toBe(false);
  });

  it('refuses a backslash-disguised host (double backslash) without ever hitting it', async () => {
    let evilHit = false;
    const evilBase = await listen((req, res) => {
      evilHit = true;
      res.statusCode = 200;
      res.end('should never be reached');
    });
    const evilPort = new URL(evilBase).port;
    const safeBase = 'http://127.0.0.1:1';
    const results = await runSmoke(safeBase, [
      { label: 'evil', path: `/\\\\127.0.0.1:${evilPort}/x`, expectStatus: 200 },
    ]);
    expect(results).toEqual([{ label: 'evil', ok: false, detail: 'invalid path' }]);
    expect(evilHit).toBe(false);
  });

  it('fails a path that passes the prefix gate but does not parse, without throwing or fetching', async () => {
    let hit = false;
    const base = await listen((req, res) => {
      hit = true;
      res.statusCode = 200;
      res.end('should never be reached');
    });
    // backslash-then-slash yields an empty hostname once `\` is normalized to `/` - `new URL`
    // throws Invalid URL for this input rather than resolving to a different origin.
    const results = await runSmoke(base, [{ label: 'bad', path: '/\\/', expectStatus: 200 }]);
    expect(results).toEqual([{ label: 'bad', ok: false, detail: 'invalid path' }]);
    expect(hit).toBe(false);
  });
});

describe('invertOp', () => {
  it('inverts option_set (old present)', () => {
    const op: DbOp = { kind: 'option_set', name: 'blogname', old: 'A', new: 'B' };
    expect(invertOp(op)).toEqual({ kind: 'option_set', name: 'blogname', old: 'B', new: 'A' });
  });

  it('inverts option_set with old:null (absent before) -> option_delete', () => {
    const op: DbOp = { kind: 'option_set', name: 'incl_x', old: null, new: 'excl' };
    expect(invertOp(op)).toEqual({ kind: 'option_delete', name: 'incl_x', old: 'excl' });
  });

  it('inverts option_delete -> option_set with old:null', () => {
    const op: DbOp = { kind: 'option_delete', name: 'blogname', old: 'X' };
    expect(invertOp(op)).toEqual({ kind: 'option_set', name: 'blogname', old: null, new: 'X' });
  });

  it('inverts postmeta_set (old present)', () => {
    const op: DbOp = { kind: 'postmeta_set', postId: 1, key: 'k', old: 'A', new: 'B' };
    expect(invertOp(op)).toEqual({ kind: 'postmeta_set', postId: 1, key: 'k', old: 'B', new: 'A' });
  });

  it('inverts postmeta_set with old:null -> postmeta_delete', () => {
    const op: DbOp = { kind: 'postmeta_set', postId: 1, key: 'k', old: null, new: 'B' };
    expect(invertOp(op)).toEqual({ kind: 'postmeta_delete', postId: 1, key: 'k', old: 'B' });
  });

  it('inverts postmeta_delete -> postmeta_set with old:null', () => {
    const op: DbOp = { kind: 'postmeta_delete', postId: 1, key: 'k', old: 'X' };
    expect(invertOp(op)).toEqual({ kind: 'postmeta_set', postId: 1, key: 'k', old: null, new: 'X' });
  });

  it('inverts row_update (old/new swapped)', () => {
    const op: DbOp = { kind: 'row_update', table: 'wp_t', pkCol: 'id', pk: 1, old: { a: '1' }, new: { a: '2' } };
    expect(invertOp(op)).toEqual({ kind: 'row_update', table: 'wp_t', pkCol: 'id', pk: 1, old: { a: '2' }, new: { a: '1' } });
  });

  it('inverts row_insert -> row_delete', () => {
    const op: DbOp = { kind: 'row_insert', table: 'wp_t', pkCol: 'id', pk: 1, new: { a: '1' } };
    expect(invertOp(op)).toEqual({ kind: 'row_delete', table: 'wp_t', pkCol: 'id', pk: 1, old: { a: '1' } });
  });

  it('inverts row_delete -> row_insert', () => {
    const op: DbOp = { kind: 'row_delete', table: 'wp_t', pkCol: 'id', pk: 1, old: { a: '1' } };
    expect(invertOp(op)).toEqual({ kind: 'row_insert', table: 'wp_t', pkCol: 'id', pk: 1, new: { a: '1' } });
  });
});
