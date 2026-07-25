import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManifestEntry } from '../src/client.js';
import type { SiteInfo } from '../src/profile.js';
import { ownerOf, resolve } from '../src/resolve.js';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const DEAD_WPORG = { api: 'http://127.0.0.1:1', downloads: 'http://127.0.0.1:1' };

const entry = (path: string, content: string | null): ManifestEntry =>
  ({ path, size: content?.length ?? 0, hash: content === null ? null : md5(content) });

const info = (over: Partial<SiteInfo> = {}): SiteInfo => ({
  wp: '6.8.2', php: { version: '8.2', extensions: [], ini: {} },
  db: { server: 'mariadb', version: '10.6', charset: 'utf8mb4', collation: '', bytes: 1 },
  server: 'nginx', constants: {}, multisite: false, prefix: 'wp_',
  abspath: '/var/www/html/', siteurl: 'https://x.example', locale: 'en_US',
  plugins: [], themes: [], ...over,
});

/** Seed a ready-made cache package on disk - resolve must use it with zero network. */
function seedPackage(cacheDir: string, rel: string, files: Record<string, string>, checksums?: Record<string, string>): void {
  const dir = join(cacheDir, 'packages', rel);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'files', p)), { recursive: true });
    writeFileSync(join(dir, 'files', p), content);
  }
  mkdirSync(dir, { recursive: true });
  const sums = checksums ?? Object.fromEntries(Object.entries(files).map(([p, c]) => [p, md5(c)]));
  writeFileSync(join(dir, 'checksums.json'), JSON.stringify(sums));
}

describe('ownerOf', () => {
  it('maps paths to their owning package', () => {
    expect(ownerOf('wp-admin/about.php')).toEqual({ type: 'core', relPath: 'wp-admin/about.php' });
    expect(ownerOf('index.php')).toEqual({ type: 'core', relPath: 'index.php' });
    expect(ownerOf('wp-content/plugins/akismet/akismet.php')).toEqual({ type: 'plugin', dir: 'akismet', relPath: 'akismet.php' });
    expect(ownerOf('wp-content/themes/x/style.css')).toEqual({ type: 'theme', dir: 'x', relPath: 'style.css' });
    expect(ownerOf('wp-content/plugins/akismet-pro/a.php')).toEqual({ type: 'plugin', dir: 'akismet-pro', relPath: 'a.php' });
    expect(ownerOf('wp-content/plugins/hello.php')).toBeNull(); // single-file plugin: no package
    expect(ownerOf('wp-content/index.php')).toBeNull();
    expect(ownerOf('wp-content/mu-plugins/x.php')).toBeNull();
  });
});

describe('resolve', () => {
  let docroot: string;
  let cacheDir: string;

  beforeEach(() => {
    docroot = mkdtempSync(join(tmpdir(), 'ferry-docroot-'));
    cacheDir = mkdtempSync(join(tmpdir(), 'ferry-cache-'));
  });
  afterEach(() => {
    rmSync(docroot, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('classifies reuse > reconstruct > fetch, with evidence for the report', async () => {
    seedPackage(cacheDir, 'core/6.8.2-en_US', { 'wp-includes/a.php': 'official-a', 'wp-includes/b.php': 'official-b' });
    mkdirSync(join(docroot, 'wp-includes'), { recursive: true });
    writeFileSync(join(docroot, 'wp-includes/a.php'), 'official-a'); // already local → reuse
    const entries = [
      entry('wp-includes/a.php', 'official-a'),
      entry('wp-includes/b.php', 'official-b'),   // in cache → reconstruct
      entry('wp-includes/hacked.php', 'evil'),    // core-owned, not in checksums → fetch
      entry('wp-content/custom.txt', 'unique'),   // no owner → fetch
      entry('unreadable.php', null),              // null hash → fetch
    ];
    const plan = await resolve(entries, info(), { docroot, cacheDir, wporg: DEAD_WPORG });
    expect(plan.reuse.map((e) => e.path)).toEqual(['wp-includes/a.php']);
    expect(plan.reconstruct.map((r) => r.path)).toEqual(['wp-includes/b.php']);
    expect(plan.reconstruct[0].sourceFile).toBe(join(cacheDir, 'packages/core/6.8.2-en_US/files/wp-includes/b.php'));
    expect(plan.fetch.map((e) => e.path).sort()).toEqual(['unreadable.php', 'wp-content/custom.txt', 'wp-includes/hacked.php']);
    const core = plan.evidence.find((ev) => ev.ref.type === 'core')!;
    expect(core.entries.map((e) => e.relPath).sort()).toEqual(
      ['unreadable.php', 'wp-includes/a.php', 'wp-includes/b.php', 'wp-includes/hacked.php'],
    );
  });

  it('reuses a modified core file yet still carries it in evidence', async () => {
    seedPackage(cacheDir, 'core/6.8.2-en_US', { 'wp-includes/v.php': 'official' });
    mkdirSync(join(docroot, 'wp-includes'), { recursive: true });
    writeFileSync(join(docroot, 'wp-includes/v.php'), 'hacked'); // clone already mirrors the hack
    const plan = await resolve([entry('wp-includes/v.php', 'hacked')], info(), { docroot, cacheDir, wporg: DEAD_WPORG });
    expect(plan.reuse).toHaveLength(1); // transfer decision: nothing to move
    const core = plan.evidence.find((ev) => ev.ref.type === 'core')!;
    expect(core.entries[0]).toEqual({ relPath: 'wp-includes/v.php', hash: md5('hacked') }); // report will flag it
  });

  it('uses cached plugin/theme packages via hints', async () => {
    seedPackage(cacheDir, 'plugin/akismet/5.3.7', { 'akismet.php': 'plugin-code' });
    seedPackage(cacheDir, 'theme/twentytwentyfive/1.2', { 'style.css': 'theme-css' });
    const plan = await resolve(
      [entry('wp-content/plugins/akismet/akismet.php', 'plugin-code'), entry('wp-content/themes/twentytwentyfive/style.css', 'theme-css')],
      info({ plugins: [{ file: 'akismet/akismet.php', version: '5.3.7' }], themes: [{ stylesheet: 'twentytwentyfive', version: '1.2' }] }),
      { docroot, cacheDir, wporg: DEAD_WPORG },
    );
    expect(plan.reconstruct).toHaveLength(2);
    expect(plan.fetch).toEqual([]);
  });

  it('marks hintless dirs and unavailable packages as unverified, files fetch', async () => {
    const plan = await resolve(
      [entry('wp-content/plugins/premium-seo/seo.php', 'secret'), entry('wp-content/plugins/akismet/akismet.php', 'x')],
      info({ plugins: [{ file: 'akismet/akismet.php', version: '5.3.7' }] }), // premium-seo: no hint; akismet: cold cache + dead wp.org
      { docroot, cacheDir, wporg: DEAD_WPORG },
    );
    expect(plan.fetch).toHaveLength(2);
    expect(plan.unverified).toContainEqual({ type: 'plugin', slug: 'premium-seo', version: null, reason: 'no-version-hint' });
    expect(plan.unverified).toContainEqual({ type: 'plugin', slug: 'akismet', version: '5.3.7', reason: 'unavailable' });
    expect(plan.evidence).toEqual([]); // nothing verifiable - core owned no entries here
  });

  it('degrades to all-fetch with no hints and no hashes (old plugin)', async () => {
    const plan = await resolve(
      [entry('index.php', null), entry('wp-load.php', null)],
      info({ locale: undefined, plugins: undefined, themes: undefined }),
      { docroot, cacheDir, wporg: DEAD_WPORG },
    );
    expect(plan.fetch).toHaveLength(2);
    expect(plan.reuse).toEqual([]);
    expect(plan.reconstruct).toEqual([]);
  });
});
