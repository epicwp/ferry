import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FerryClient } from '../src/client.js';
import { fetchAll, isMetaEntry, extractBatch } from '../src/transfer.js';
import { startMockPlugin, sizeOf, type MockPlugin } from './helpers/mockPlugin.js';

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
