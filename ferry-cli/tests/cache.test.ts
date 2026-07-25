import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanTmp, ensurePackage, packageDir, safeRelPath, type PackageRef } from '../src/provenance/cache.js';
import { startMockWporg, zipOf, type MockWporg } from './helpers/mockWporg.js';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('cache', () => {
  let cacheDir: string;
  let mock: MockWporg;

  beforeEach(() => { cacheDir = mkdtempSync(join(tmpdir(), 'ferry-cache-')); });
  afterEach(() => { mock?.close(); rmSync(cacheDir, { recursive: true, force: true }); });

  it('maps refs to package dirs', () => {
    expect(packageDir('/c', { type: 'core', slug: 'core', version: '6.8.2', locale: 'nl_NL' })).toBe('/c/packages/core/6.8.2-nl_NL');
    expect(packageDir('/c', { type: 'plugin', slug: 'akismet', version: '5.3.7' })).toBe('/c/packages/plugin/akismet/5.3.7');
    expect(packageDir('/c', { type: 'theme', slug: 'x', version: '1.2' })).toBe('/c/packages/theme/x/1.2');
  });

  it('strips the wp.org top dir and rejects zip-slip entries', () => {
    expect(safeRelPath('wordpress/wp-admin/about.php')).toBe('wp-admin/about.php');
    expect(safeRelPath('akismet/akismet.php')).toBe('akismet.php');
    expect(safeRelPath('toplevel.txt')).toBeNull();
    expect(safeRelPath('a/../../etc/passwd')).toBeNull();
    expect(safeRelPath('/abs/path')).toBeNull();
  });

  it('ingests a plugin zip: extracts, computes checksums, atomic rename', async () => {
    mock = await startMockWporg({ zips: { '/plugin/akismet.5.3.7.zip': zipOf('akismet', { 'akismet.php': '<?php // a', 'readme.txt': 'hi' }) } });
    const ref: PackageRef = { type: 'plugin', slug: 'akismet', version: '5.3.7' };
    const pkg = await ensurePackage(cacheDir, ref, mock.endpoints);
    expect(pkg).not.toBeNull();
    expect(pkg!.checksums['akismet.php']).toBe(md5('<?php // a'));
    expect(readFileSync(join(pkg!.filesDir, 'readme.txt'), 'utf8')).toBe('hi');
    expect(existsSync(join(cacheDir, 'tmp'))).toBe(true); // tmp parent may remain; no stray package dirs inside
    // cached hit: no second download
    const before = mock.requests.length;
    const again = await ensurePackage(cacheDir, ref, mock.endpoints);
    expect(again!.checksums).toEqual(pkg!.checksums);
    expect(mock.requests.length).toBe(before);
  });

  it('core ingest keeps the full API list but drops zip bytes that mismatch it', async () => {
    const good = '<?php // good';
    mock = await startMockWporg({
      checksums: { '6.8.2-en_US': { 'wp-includes/a.php': md5(good), 'wp-includes/b.php': md5('official-b'), 'wp-content/themes/x/s.css': md5('x') } },
      zips: { '/release/wordpress-6.8.2.zip': zipOf('wordpress', { 'wp-includes/a.php': good, 'wp-includes/b.php': 'TAMPERED' }) },
    });
    const pkg = await ensurePackage(cacheDir, { type: 'core', slug: 'core', version: '6.8.2', locale: 'en_US' }, mock.endpoints);
    expect(pkg!.checksums['wp-includes/b.php']).toBe(md5('official-b')); // full list kept for the report
    expect(existsSync(join(pkg!.filesDir, 'wp-includes/a.php'))).toBe(true);
    expect(existsSync(join(pkg!.filesDir, 'wp-includes/b.php'))).toBe(false); // unproven bytes never cached
  });

  it('returns null when the zip 404s or the API has no checksums for core', async () => {
    mock = await startMockWporg({});
    expect(await ensurePackage(cacheDir, { type: 'plugin', slug: 'nope', version: '1.0' }, mock.endpoints)).toBeNull();
    expect(await ensurePackage(cacheDir, { type: 'core', slug: 'core', version: '9.9.9', locale: 'en_US' }, mock.endpoints)).toBeNull();
  });

  it('cleanTmp removes only stale tmp dirs', () => {
    const stale = join(cacheDir, 'tmp', 'old');
    const fresh = join(cacheDir, 'tmp', 'new');
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const old = (Date.now() - 25 * 3600 * 1000) / 1000;
    utimesSync(stale, old, old);
    cleanTmp(cacheDir);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
