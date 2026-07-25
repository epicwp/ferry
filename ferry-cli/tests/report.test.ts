import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReport, summarize, writeReport } from '../src/provenance/report.js';
import type { PackageEvidence } from '../src/resolve.js';

const coreEvidence = (over: Partial<PackageEvidence> = {}): PackageEvidence => ({
  ref: { type: 'core', slug: 'core', version: '6.8.2', locale: 'en_US' },
  checksums: {
    'wp-includes/clean.php': 'aaa',
    'wp-includes/hacked.php': 'bbb',
    'wp-admin/deleted.php': 'ccc',
    'wp-content/themes/twentytwentyfive/style.css': 'ddd', // API bundles wp-content - must be ignored
  },
  entries: [
    { relPath: 'wp-includes/clean.php', hash: 'aaa' },
    { relPath: 'wp-includes/hacked.php', hash: 'EVIL' },
    { relPath: 'wp-includes/rogue.php', hash: 'fff' },      // extra: not in any official list
    { relPath: 'license-note.txt', hash: 'eee' },           // root extra: NOT reported (legit custom root files)
    { relPath: 'wp-includes/unreadable.php', hash: null },  // never judged
  ],
  ...over,
});

describe('report', () => {
  it('buckets modified, missing, and extra for core; ignores wp-content and null hashes', () => {
    const report = buildReport([coreEvidence()], []);
    const core = report.verified[0];
    expect(core.modified).toEqual(['wp-includes/hacked.php']);
    expect(core.missing).toEqual(['wp-admin/deleted.php']);
    expect(core.extra).toEqual(['wp-includes/rogue.php']);
  });

  it('plugin packages get modified+missing but never extra', () => {
    const report = buildReport([{
      ref: { type: 'plugin', slug: 'akismet', version: '5.3.7' },
      checksums: { 'akismet.php': 'aaa', 'removed.php': 'bbb' },
      entries: [{ relPath: 'akismet.php', hash: 'PATCHED' }, { relPath: 'custom-note.txt', hash: 'ccc' }],
    }], []);
    expect(report.verified[0].modified).toEqual(['akismet.php']);
    expect(report.verified[0].missing).toEqual(['removed.php']);
    expect(report.verified[0].extra).toEqual([]);
  });

  it('summarize: clean line when nothing flagged, warning with counts otherwise', () => {
    const clean = buildReport([{
      ref: { type: 'core', slug: 'core', version: '6.8.2', locale: 'en_US' },
      checksums: { 'wp-includes/a.php': 'aaa' },
      entries: [{ relPath: 'wp-includes/a.php', hash: 'aaa' }],
    }], []);
    expect(summarize(clean)).toBe('core and wp.org packages verified clean');
    const dirty = summarize(buildReport([coreEvidence()], []));
    expect(dirty).toContain('1 modified core file');
    expect(dirty).toContain('1 unexpected file');
    expect(dirty).toContain('1 missing core file');
  });

  it('writeReport writes JSON under FERRY_HOME/sites/<slug>/', () => {
    const home = mkdtempSync(join(tmpdir(), 'ferry-home-'));
    process.env.FERRY_HOME = home;
    try {
      const report = buildReport([], [{ type: 'plugin', slug: 'premium-seo', version: null, reason: 'no-version-hint' }]);
      const path = writeReport('mysite', report);
      expect(path).toBe(join(home, 'sites/mysite/provenance.json'));
      expect(JSON.parse(readFileSync(path, 'utf8')).unverified[0].slug).toBe('premium-seo');
    } finally {
      delete process.env.FERRY_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('bundled themes: files matching core checksums are not reported as modified', () => {
    // Bundled themes (e.g., twentytwentythree) ship with the core release but may have
    // different bytes than their standalone zips on downloads.wordpress.org
    const report = buildReport([
      {
        ref: { type: 'core', slug: 'core', version: '6.8.2', locale: 'en_US' },
        checksums: {
          'wp-includes/version.php': 'core-version-hash',
          'wp-content/themes/twentytwentythree/style.css': 'CORE-BUNDLED-MD5', // bundled with core
        },
        entries: [
          { relPath: 'wp-includes/version.php', hash: 'core-version-hash' },
          { relPath: 'wp-content/themes/twentytwentythree/style.css', hash: 'CORE-BUNDLED-MD5' },
        ],
      },
      {
        ref: { type: 'theme', slug: 'twentytwentythree', version: '1.1' },
        checksums: {
          'style.css': 'STANDALONE-MD5', // standalone zip has different checksum
          'readme.txt': 'readme-hash',
        },
        entries: [
          { relPath: 'style.css', hash: 'CORE-BUNDLED-MD5' }, // matches core release, not standalone
          { relPath: 'readme.txt', hash: 'GENUINELY-MODIFIED' }, // different from both
        ],
      },
    ], []);
    const theme = report.verified[1];
    // style.css matches core checksum → NOT modified, even though it differs from standalone
    expect(theme.modified).toEqual(['readme.txt']);
    expect(theme.missing).toEqual([]);
  });
});
