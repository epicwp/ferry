import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchUploads } from '../src/fetch-uploads.js';
import { startMockPlugin, sizeOf, hashOf, type MockPlugin } from './helpers/mockPlugin.js';

describe('fetchUploads', () => {
  let home: string;
  let fixture: string;
  let clone: string;
  let mock: MockPlugin;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ferry-home-'));
    fixture = mkdtempSync(join(tmpdir(), 'ferry-uploads-fixture-'));
    clone = mkdtempSync(join(tmpdir(), 'ferry-clone-'));
    process.env.FERRY_HOME = home;
    mkdirSync(join(fixture, 'wp-content', 'uploads', '2026'), { recursive: true });
    writeFileSync(join(fixture, 'wp-content', 'uploads', '2026', 'a.jpg'), 'image-bytes');
  });

  afterEach(() => {
    mock?.close();
    delete process.env.FERRY_HOME;
    for (const dir of [home, fixture, clone]) rmSync(dir, { recursive: true, force: true });
  });

  function writeProfile(base: string): void {
    mkdirSync(join(home, 'sites', 'demo'), { recursive: true });
    writeFileSync(
      join(home, 'sites', 'demo', 'profile.json'),
      JSON.stringify({ slug: 'demo', url: base, secret: 's', clonePath: clone }),
    );
  }

  it('fetches the uploads manifest for a prefix and materializes the files', async () => {
    const path = 'wp-content/uploads/2026/a.jpg';
    mock = await startMockPlugin(fixture, {
      manifest: [{ path, size: sizeOf(fixture, path), hash: null }],
    });
    writeProfile(mock.base);
    const result = await fetchUploads('demo', { prefix: '2026/' });
    expect(result.fetched).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(clone, path))).toBe(true);
    expect(mock.requests.manifest[0].scope).toBe('uploads');
    expect(mock.requests.manifest[0].prefix).toBe('2026/');
  });

  it('hash-verifies fetched files, retries a mismatch once, and folds a still-bad file into skipped', async () => {
    const goodPath = 'wp-content/uploads/2026/good.jpg';
    const badPath = 'wp-content/uploads/2026/bad.jpg';
    const noHashPath = 'wp-content/uploads/2026/nohash.jpg';
    writeFileSync(join(fixture, 'wp-content', 'uploads', '2026', 'good.jpg'), 'good-bytes');
    writeFileSync(join(fixture, 'wp-content', 'uploads', '2026', 'bad.jpg'), 'bad-bytes');
    writeFileSync(join(fixture, 'wp-content', 'uploads', '2026', 'nohash.jpg'), 'nohash-bytes');
    mock = await startMockPlugin(fixture, {
      manifest: [
        { path: goodPath, size: sizeOf(fixture, goodPath), hash: hashOf(fixture, goodPath) },
        { path: badPath, size: sizeOf(fixture, badPath), hash: 'deadbeefdeadbeefdeadbeefdeadbeef' },
        { path: noHashPath, size: sizeOf(fixture, noHashPath), hash: null },
      ],
    });
    writeProfile(mock.base);
    const result = await fetchUploads('demo', { prefix: '2026/' });

    expect(result.skipped).toEqual([badPath]);
    expect(result.fetched).toBe(2); // good (verified) + nohash (unverified) - bad excluded
    expect(existsSync(join(clone, goodPath))).toBe(true);
    expect(existsSync(join(clone, badPath))).toBe(true);
    expect(existsSync(join(clone, noHashPath))).toBe(true);
    expect(mock.requests.files[mock.requests.files.length - 1]).toEqual([badPath]);
  });

  it('requires a prefix or --all', async () => {
    writeProfile('http://127.0.0.1:9');
    await expect(fetchUploads('demo', {})).rejects.toThrow(/prefix .* or --all/);
  });
});
