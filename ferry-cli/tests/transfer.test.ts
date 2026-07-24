import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FerryClient } from '../src/client.js';
import { fetchAll, isMetaEntry } from '../src/transfer.js';
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
});
