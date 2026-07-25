import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

  it('falls back to the en_US core zip when the locale zip 404s, proving bytes against the locale list', async () => {
    const shared = '<?php // shared';
    const enUsOnly = '<?php // en_US';
    mock = await startMockWporg({
      checksums: { '6.8.2-nl_NL': { 'wp-includes/a.php': md5(shared), 'wp-includes/b.php': md5('locale-only') } },
      zips: { '/release/wordpress-6.8.2.zip': zipOf('wordpress', { 'wp-includes/a.php': shared, 'wp-includes/b.php': enUsOnly }) },
    });
    const pkg = await ensurePackage(cacheDir, { type: 'core', slug: 'core', version: '6.8.2', locale: 'nl_NL' }, mock.endpoints);
    expect(pkg).not.toBeNull();
    expect(pkg!.checksums).toEqual({ 'wp-includes/a.php': md5(shared), 'wp-includes/b.php': md5('locale-only') }); // full nl_NL list kept
    expect(existsSync(join(pkg!.filesDir, 'wp-includes/a.php'))).toBe(true); // proven byte
    expect(existsSync(join(pkg!.filesDir, 'wp-includes/b.php'))).toBe(false); // en_US bytes mismatch the nl list - never cached
    expect(pkg!.ref).toEqual({ type: 'core', slug: 'core', version: '6.8.2', locale: 'nl_NL' });
    // Verify fallback ordering: nl_NL zip attempt before en_US zip attempt
    const nlZipAttempt = mock.requests.findIndex(r => r.includes('/release/nl_NL/'));
    const enZipAttempt = mock.requests.findIndex(r => r === '/release/wordpress-6.8.2.zip');
    expect(nlZipAttempt).toBeGreaterThanOrEqual(0); // nl_NL zip was attempted first (and 404'd)
    expect(enZipAttempt).toBeGreaterThan(nlZipAttempt); // en_US zip was attempted second
  });

  it('returns null when the zip 404s or the API has no checksums for core', async () => {
    mock = await startMockWporg({});
    expect(await ensurePackage(cacheDir, { type: 'plugin', slug: 'nope', version: '1.0' }, mock.endpoints)).toBeNull();
    expect(await ensurePackage(cacheDir, { type: 'core', slug: 'core', version: '9.9.9', locale: 'en_US' }, mock.endpoints)).toBeNull();
  });

  it('self-heals a corrupt checksums.json: drops the package and re-ingests', async () => {
    mock = await startMockWporg({ zips: { '/plugin/akismet.5.3.7.zip': zipOf('akismet', { 'akismet.php': '<?php // a' }) } });
    const ref: PackageRef = { type: 'plugin', slug: 'akismet', version: '5.3.7' };
    const dir = packageDir(cacheDir, ref);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checksums.json'), '{{{ not json');
    const pkg = await ensurePackage(cacheDir, ref, mock.endpoints);
    expect(pkg).not.toBeNull();
    expect(pkg!.checksums['akismet.php']).toBe(md5('<?php // a'));
    expect(() => JSON.parse(readFileSync(join(dir, 'checksums.json'), 'utf8'))).not.toThrow();
  });

  it('returns null instead of throwing when a corrupt cache cannot be re-ingested (wp.org unreachable)', async () => {
    const ref: PackageRef = { type: 'plugin', slug: 'akismet', version: '5.3.7' };
    const dir = packageDir(cacheDir, ref);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checksums.json'), '{{{ not json');
    const dead = { api: 'http://127.0.0.1:1', downloads: 'http://127.0.0.1:1' };
    await expect(ensurePackage(cacheDir, ref, dead)).resolves.toBeNull();
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
