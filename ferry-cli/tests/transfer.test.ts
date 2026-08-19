import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tar from 'tar';
import { FerryClient } from '../src/client.js';
import { fetchAll, isMetaEntry, extractBatch, isTransferRetryable } from '../src/transfer.js';
import { startMockPlugin, sizeOf, type MockPlugin } from './helpers/mockPlugin.js';

// Retry backoff (500ms * 2**attempt) would otherwise add real seconds to these tests -
// the retried unit itself (fetchBatch/fetchOversized) is what's under test, not the delay.
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }));

describe('isMetaEntry', () => {
  it('matches bare and dot-slash-prefixed meta entries only', () => {
    expect(isMetaEntry('.ferry-meta.json')).toBe(true);
    expect(isMetaEntry('./.ferry-meta.json')).toBe(true);
    expect(isMetaEntry('wp-content/.ferry-meta.json')).toBe(false);
    expect(isMetaEntry('index.php')).toBe(false);
  });
});

describe('fetchAll', () => {
  let fixture: string;
  let dest: string;
  let mock: MockPlugin;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'ferry-fixture-'));
    dest = mkdtempSync(join(tmpdir(), 'ferry-dest-'));
    mkdirSync(join(fixture, 'sub'), { recursive: true });
    writeFileSync(join(fixture, 'a.txt'), 'contents of a');
    writeFileSync(join(fixture, 'sub/b.txt'), 'contents of b, nested');
    writeFileSync(join(fixture, 'big.bin'), Buffer.alloc(300, 7));
  });

  afterEach(() => {
    mock?.close();
    rmSync(fixture, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  it('fetches batches, resumes partial responses, and ranges oversized files', async () => {
    mock = await startMockPlugin(fixture, { partialFirstBatch: true });
    const client = new FerryClient(mock.base, 'irrelevant');
    const entries = [
      { path: 'a.txt', size: sizeOf(fixture, 'a.txt'), hash: null },
      { path: 'sub/b.txt', size: sizeOf(fixture, 'sub/b.txt'), hash: null },
      { path: 'big.bin', size: 300, hash: null },
    ];
    await fetchAll(client, entries, dest, { maxBytes: 100, concurrency: 2 });
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('contents of a');
    expect(readFileSync(join(dest, 'sub/b.txt'), 'utf8')).toBe('contents of b, nested');
    expect(readFileSync(join(dest, 'big.bin'))).toEqual(Buffer.alloc(300, 7));
    expect(existsSync(join(dest, '.ferry-meta.json'))).toBe(false);
  });

  it('rejects when an oversized destination cannot be written', async () => {
    mock = await startMockPlugin(fixture);
    const client = new FerryClient(mock.base, 'irrelevant');
    mkdirSync(join(dest, 'big.bin'), { recursive: true }); // dest path occupied by a directory
    const entries = [{ path: 'big.bin', size: 300, hash: null }];
    await expect(fetchAll(client, entries, dest, { maxBytes: 100 })).rejects.toThrow();
  });

  it('range mode refuses to write outside the clone', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'ferry-guard-'));
    const client = new FerryClient('http://127.0.0.1:9', 'never-reached');
    await expect(
      fetchAll(client, [{ path: '../evil.bin', size: 10, hash: null }], destDir, { maxBytes: 4 }),
    ).rejects.toThrow(/refusing range write outside the clone/);
    expect(existsSync(join(destDir, '..', 'evil.bin'))).toBe(false);
    rmSync(destDir, { recursive: true, force: true });
  });

  it('batch extraction never writes tar entries outside destDir (node-tar guard)', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'ferry-tarx-'));
    const meta = Buffer.from(JSON.stringify({ complete: true, next_index: 2, skipped: [] }));
    const archive = Buffer.concat([
      rawTarEntry('../escape.txt', Buffer.from('evil')),
      rawTarEntry('.ferry-meta.json', meta),
      Buffer.alloc(1024), // end-of-archive blocks
    ]);
    await extractBatch(gzipSync(archive), destDir);
    expect(existsSync(join(destDir, '..', 'escape.txt'))).toBe(false);
    rmSync(destDir, { recursive: true, force: true });
  });

  it('extracts a plugin-emitted GNU LongLink entry to its full long path (ferry-plugin/src/Tar.php round-trip)', async () => {
    // Real WP fatal fixture: 152-byte path whose final segment is 103 bytes, over the
    // ustar 100-byte name-field limit. This is the entry ferry-plugin/src/Tar.php now
    // emits as a GNU LongLink extension instead of throwing. Hand-built here per the
    // exact same byte layout Tar.php writes, to prove node-tar reads it transparently
    // and lands the file at its FULL long path (not the 100-byte-truncated name).
    const destDir = mkdtempSync(join(tmpdir(), 'ferry-longlink-'));
    const longPath =
      'wp-content/plugins/elementor-pro/assets/js/notes/vendors-node_modules_radix-ui_react-alert-dialog_dist_index_module_js-node_modules_radix-ui_r-e4587e.js';
    expect(longPath.length).toBe(152);
    const content = Buffer.from('js content');
    const meta = Buffer.from(JSON.stringify({ complete: true, next_index: 1, skipped: [] }));
    const archive = Buffer.concat([
      rawLongLinkEntry(longPath, content),
      rawTarEntry('.ferry-meta.json', meta),
      Buffer.alloc(1024), // end-of-archive blocks
    ]);
    const result = await extractBatch(gzipSync(archive), destDir);
    expect(result).toEqual({ complete: true, next_index: 1, skipped: [] });
    expect(readFileSync(join(destDir, longPath))).toEqual(content);
    rmSync(destDir, { recursive: true, force: true });
  });
});

/** Fake FerryClient: postStream is scripted per call - lets tests control exactly what a
 *  given attempt streams back without a real HTTP server. */
function fakeStreamClient(
  makeStream: (attempt: number, body: any) => Readable,
): { client: FerryClient; state: { calls: number } } {
  const state = { calls: 0 };
  const client = {
    postStream: async (_route: string, body: any) => {
      state.calls++;
      return { stream: makeStream(state.calls, body), headers: {}, statusCode: 200 };
    },
  };
  return { client: client as unknown as FerryClient, state };
}

/** A real gzip'd tar batch (one file + .ferry-meta.json trailer), built the same way the
 *  plugin would build one - so "truncate by slicing" produces a genuinely broken gzip stream. */
async function buildBatchBuffer(
  fileName: string,
  content: string,
  complete: boolean,
  nextIndex: number,
): Promise<Buffer> {
  const staging = mkdtempSync(join(tmpdir(), 'ferry-batch-'));
  writeFileSync(join(staging, fileName), content);
  writeFileSync(join(staging, '.ferry-meta.json'), JSON.stringify({ complete, next_index: nextIndex, skipped: [] }));
  const chunks: Buffer[] = [];
  const stream = tar.c({ gzip: true, cwd: staging }, [fileName, '.ferry-meta.json']);
  for await (const c of stream) {
    chunks.push(c as Buffer);
  }
  rmSync(staging, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

/** Same as buildBatchBuffer but for an arbitrary set of already-on-disk files - lets
 *  split/fallback tests build a real (truncatable) archive for whichever path subset a
 *  given batch request asks for. */
async function buildBatchFromDir(
  srcDir: string,
  paths: string[],
  complete: boolean,
  nextIndex: number,
): Promise<Buffer> {
  const staging = mkdtempSync(join(tmpdir(), 'ferry-batch-'));
  for (const p of paths) {
    cpSync(join(srcDir, p), join(staging, p));
  }
  writeFileSync(join(staging, '.ferry-meta.json'), JSON.stringify({ complete, next_index: nextIndex, skipped: [] }));
  const chunks: Buffer[] = [];
  const stream = tar.c({ gzip: true, cwd: staging }, [...paths, '.ferry-meta.json']);
  for await (const c of stream) {
    chunks.push(c as Buffer);
  }
  rmSync(staging, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

/** Simulates a connection smothered mid-stream (e.g. undici's SocketError on a premature
 *  close): a few bytes arrive, then the stream errors instead of ending cleanly. */
function erroringStream(partial: Buffer, message: string): Readable {
  const r = new Readable({ read() {} });
  process.nextTick(() => {
    r.push(partial);
    r.emit('error', new Error(message));
  });
  return r;
}

describe('fetchAll retry (fake streaming client)', () => {
  let dest: string;

  beforeEach(() => {
    dest = mkdtempSync(join(tmpdir(), 'ferry-retry-dest-'));
  });

  afterEach(() => {
    rmSync(dest, { recursive: true, force: true });
  });

  it('fetchBatch: retries a truncated batch stream and succeeds on the next attempt', async () => {
    const valid = await buildBatchBuffer('a.txt', 'hello from a', true, 1);
    const truncated = valid.subarray(0, Math.floor(valid.length * 0.6));
    const { client, state } = fakeStreamClient((attempt) => Readable.from(attempt === 1 ? truncated : valid));
    const entries = [{ path: 'a.txt', size: 12, hash: null }];
    await fetchAll(client, entries, dest, { maxBytes: 100 });
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('hello from a');
    expect(state.calls).toBe(2);
  });

  it('fetchBatch: a lone path that truncates on both the batch and the range fallback throws a terminal error naming it', async () => {
    // Every request (batch or range) gets the same truncated buffer, regardless of what it
    // asked for - so both the batch attempt AND the byte-range fallback it recurses to are
    // unrecoverable. This is Layer 2's floor: split bottoms out at one path, that path's
    // batch fetch is exhausted, its range fallback is exhausted too, so fetchBatch must throw
    // a clear terminal error rather than loop forever or silently drop the file.
    const valid = await buildBatchBuffer('a.txt', 'hello from a', true, 1);
    const truncated = valid.subarray(0, Math.floor(valid.length * 0.6));
    const { client, state } = fakeStreamClient(() => Readable.from(truncated));
    const entries = [{ path: 'a.txt', size: 12, hash: null }];
    await expect(fetchAll(client, entries, dest, { maxBytes: 100 })).rejects.toThrow(
      /a\.txt.*unrecoverable.*batch.*byte-range/is,
    );
    // 4 attempts on the batch endpoint, then 4 more on the range fallback for the same file.
    expect(state.calls).toBe(8);
  });

  it('fetchBatch: splits a truncating multi-file batch in half and succeeds on the smaller batches', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'ferry-split-fixture-'));
    const files = [
      { path: 'p0.txt', content: 'file zero contents' },
      { path: 'p1.txt', content: 'file one contents!' },
      { path: 'p2.txt', content: 'file two contents!!' },
      { path: 'p3.txt', content: 'file three contents' },
    ];
    for (const f of files) writeFileSync(join(fixtureDir, f.path), f.content);
    const SPLIT_THRESHOLD = 2; // batches of > 2 paths truncate; <= 2 succeed
    const requestedPaths: string[][] = [];
    const client = {
      postStream: async (_route: string, body: any) => {
        const paths: string[] = body.paths;
        requestedPaths.push(paths);
        const full = await buildBatchFromDir(fixtureDir, paths, true, paths.length);
        const stream =
          paths.length > SPLIT_THRESHOLD ? full.subarray(0, Math.floor(full.length * 0.5)) : full;
        return { stream: Readable.from(stream), headers: {}, statusCode: 200 };
      },
    } as unknown as FerryClient;

    const entries = files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content), hash: null }));
    const progressSteps: [number, number][] = [];
    await fetchAll(client, entries, dest, {
      maxBytes: 1000, // all 4 files fit in a single bin-packed batch
      onProgress: (done, total) => progressSteps.push([done, total]),
    });

    for (const f of files) {
      expect(readFileSync(join(dest, f.path), 'utf8')).toBe(f.content);
    }
    // The original 4-path batch was attempted (and truncated) before being split into halves
    // of <= SPLIT_THRESHOLD paths each, which succeeded.
    expect(requestedPaths.some((p) => p.length === 4)).toBe(true);
    expect(requestedPaths.filter((p) => p.length > 0 && p.length <= SPLIT_THRESHOLD).length).toBeGreaterThanOrEqual(2);
    // fetchAll reports progress once per bin-packed batch, after the whole (possibly split)
    // group resolves - so despite the internal split, each file is still counted exactly once.
    expect(progressSteps).toEqual([[4, 4]]);

    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('fetchBatch: recurses batch -> single file, then falls back to the byte-range endpoint for the one path that keeps truncating', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'ferry-fallback-fixture-'));
    const pathA = 'stubborn.bin';
    const contentA = Buffer.from('A'.repeat(37));
    const pathB = 'friendly.txt';
    const contentB = 'friendly file contents';
    writeFileSync(join(fixtureDir, pathA), contentA);
    writeFileSync(join(fixtureDir, pathB), contentB);

    const rangeCalls: { path: string; offset: number; length: number }[] = [];
    const client = {
      postStream: async (_route: string, body: any) => {
        if (body.path !== undefined) {
          rangeCalls.push(body);
          const data = readFileSync(join(fixtureDir, body.path));
          return {
            stream: Readable.from(data.subarray(body.offset, body.offset + body.length)),
            headers: {},
            statusCode: 200,
          };
        }
        const paths: string[] = body.paths;
        const full = await buildBatchFromDir(fixtureDir, paths, true, paths.length);
        // The 2-path batch always truncates (forcing a split); once split, pathA's lone
        // single-file batch keeps truncating too (forcing the range fallback), but pathB's
        // lone single-file batch succeeds normally.
        const shouldTruncate = paths.length > 1 || paths[0] === pathA;
        const stream = shouldTruncate ? full.subarray(0, Math.floor(full.length * 0.5)) : full;
        return { stream: Readable.from(stream), headers: {}, statusCode: 200 };
      },
    } as unknown as FerryClient;

    const entries = [
      { path: pathA, size: contentA.length, hash: null },
      { path: pathB, size: Buffer.byteLength(contentB), hash: null },
    ];
    await fetchAll(client, entries, dest, { maxBytes: 1000 });

    expect(readFileSync(join(dest, pathB), 'utf8')).toBe(contentB);
    expect(readFileSync(join(dest, pathA))).toEqual(contentA);
    // pathA was only ever recovered via the range endpoint.
    expect(rangeCalls.length).toBeGreaterThan(0);
    expect(rangeCalls.every((c) => c.path === pathA)).toBe(true);

    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('fetchBatch: split levels below the top get one attempt each, bounding total retry cost near 2N (not ~8N)', async () => {
    // A batch that truncated once at a given size is deterministic (the whole root cause) -
    // re-retrying the SAME size at every level of the split tree would just stack exponential
    // backoff for no benefit. So every request here truncates, no matter how small: the top
    // level still gets the full 4-attempt retry, but every node below it should give up after
    // a single attempt and split immediately instead of retrying 4x per node.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'ferry-retrycost-fixture-'));
    const files = ['q0.txt', 'q1.txt', 'q2.txt', 'q3.txt'].map((path, i) => ({
      path,
      content: `contents of file number ${i}`,
    }));
    for (const f of files) writeFileSync(join(fixtureDir, f.path), f.content);

    const batchCalls: string[][] = [];
    const rangeCalls: { path: string }[] = [];
    const client = {
      postStream: async (_route: string, body: any) => {
        if (body.path !== undefined) {
          rangeCalls.push(body);
          const data = readFileSync(join(fixtureDir, body.path));
          return {
            stream: Readable.from(data.subarray(body.offset, body.offset + body.length)),
            headers: {},
            statusCode: 200,
          };
        }
        const paths: string[] = body.paths;
        batchCalls.push(paths);
        const full = await buildBatchFromDir(fixtureDir, paths, true, paths.length);
        return { stream: Readable.from(full.subarray(0, Math.floor(full.length * 0.5))), headers: {}, statusCode: 200 };
      },
    } as unknown as FerryClient;

    const entries = files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content), hash: null }));
    await fetchAll(client, entries, dest, { maxBytes: 1000 });

    for (const f of files) {
      expect(readFileSync(join(dest, f.path), 'utf8')).toBe(f.content);
    }
    // Split tree for N=4, every node truncating: root gets 4 attempts (top level); the two
    // 2-file nodes and four 1-file leaves below it get 1 attempt each before moving on
    // (splitting, or falling back to range) = 4 + 1+1 + 1+1+1+1 = 10 = 2N+2, not the
    // 4 * (2N-1) = 28 it would be if every node retried in full.
    expect(batchCalls.length).toBe(10);
    expect(batchCalls.length).toBeLessThan(8 * files.length);
    expect(rangeCalls.length).toBe(4); // one lone-file range fetch per leaf, each succeeds first try

    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('fetchBatch: does not retry a non-transport (security guard) error', async () => {
    const { client, state } = fakeStreamClient(() => {
      throw new Error('refusing range write outside the clone: a.txt');
    });
    const entries = [{ path: 'a.txt', size: 12, hash: null }];
    await expect(fetchAll(client, entries, dest, { maxBytes: 100 })).rejects.toThrow(/refusing/);
    expect(state.calls).toBe(1);
  });

  it('fetchOversized: retries a broken range fetch without duplicating bytes', async () => {
    const full = Buffer.from('Y'.repeat(20));
    const { client, state } = fakeStreamClient((attempt) =>
      attempt === 1 ? erroringStream(full.subarray(0, 8), 'other side closed') : Readable.from(full),
    );
    const entries = [{ path: 'big.bin', size: full.length, hash: null }];
    await fetchAll(client, entries, dest, { maxBytes: 4 }); // forces the oversized/range path
    const written = readFileSync(join(dest, 'big.bin'));
    expect(written.length).toBe(full.length);
    expect(written.equals(full)).toBe(true);
    expect(state.calls).toBe(2);
  });

  it('fetchOversized: retries a short range read that ends cleanly (no stream error)', async () => {
    const full = Buffer.from('Z'.repeat(20));
    const { client, state } = fakeStreamClient((attempt) =>
      attempt === 1 ? Readable.from(full.subarray(0, 8)) : Readable.from(full),
    );
    const entries = [{ path: 'short.bin', size: full.length, hash: null }];
    await fetchAll(client, entries, dest, { maxBytes: 4 });
    const written = readFileSync(join(dest, 'short.bin'));
    expect(written.length).toBe(full.length);
    expect(written.equals(full)).toBe(true);
    expect(state.calls).toBe(2);
  });
});

describe('isTransferRetryable', () => {
  it('retries by error code for real undici/zlib error shapes', () => {
    expect(isTransferRetryable({ code: 'UND_ERR_BODY_TIMEOUT', message: 'Body Timeout Error' })).toBe(true);
    expect(isTransferRetryable({ code: 'UND_ERR_HEADERS_TIMEOUT', message: 'Headers Timeout Error' })).toBe(true);
    expect(isTransferRetryable({ code: 'ECONNRESET', message: 'read ECONNRESET' })).toBe(true);
    expect(isTransferRetryable({ code: 'Z_BUF_ERROR', message: 'unexpected end of file' })).toBe(true);
  });

  it('does not retry the path-traversal guard or an unrecognized error', () => {
    expect(isTransferRetryable({ message: 'refusing range write outside the clone' })).toBe(false);
    expect(isTransferRetryable({ message: 'boom' })).toBe(false);
  });
});

/** Hand-built ustar entry: node-tar must sanitize what a malicious server could send. */
function rawTarEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148); // checksum field = spaces while summing
  header.write('0', 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(body);
  return Buffer.concat([header, body]);
}

/** Hand-built GNU LongLink entry pair - mirrors exactly what ferry-plugin/src/Tar.php emits
 *  for a path that overflows the ustar 100-byte name field: a typeflag 'L' header whose
 *  data payload is the full path (+ NUL, padded to 512), followed by the real entry header
 *  (name truncated to 100 bytes, prefix empty) and its content. */
function rawLongLinkEntry(fullPath: string, content: Buffer): Buffer {
  function ustarHeader(name: string, size: number, typeflag: string): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(size.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148); // checksum field = spaces while summing
    header.write(typeflag, 156);
    header.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return header;
  }
  function padTo512(buf: Buffer): Buffer {
    const pad = (512 - (buf.length % 512)) % 512;
    return pad === 0 ? buf : Buffer.concat([buf, Buffer.alloc(pad)]);
  }
  const longData = Buffer.from(fullPath + '\0', 'utf8');
  const longHeader = ustarHeader('././@LongLink', longData.length, 'L');
  const realHeader = ustarHeader(fullPath.slice(0, 100), content.length, '0');
  return Buffer.concat([longHeader, padTo512(longData), realHeader, padTo512(content)]);
}
