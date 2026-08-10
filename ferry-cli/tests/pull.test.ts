import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloneEnv } from '../src/env/ddev.js';
import { saveProfile, type SiteInfo } from '../src/profile.js';
import { pull } from '../src/pull.js';
import { hashOf, startMockPlugin, sizeOf, type MockPlugin } from './helpers/mockPlugin.js';
import { startMockWporg, zipOf, type MockWporg } from './helpers/mockWporg.js';

const DEAD_WPORG = { api: 'http://127.0.0.1:1', downloads: 'http://127.0.0.1:1' };

class FakeEnv implements CloneEnv {
  calls: string[] = [];
  wpConfigPresentAtImport = false;
  async provision(): Promise<void> {
    this.calls.push('provision');
  }
  async importDb(clonePath: string): Promise<void> {
    this.calls.push('importDb');
    this.wpConfigPresentAtImport = existsSync(join(clonePath, 'wp-config.php'));
  }
  async createAdmin(): Promise<{ user: string; password: string }> {
    this.calls.push('createAdmin');
    return { user: 'ferry-admin', password: 'pw123' };
  }
  url(name: string): string {
    return `https://${name}.ddev.site`;
  }
  async binlogPosition(): Promise<{ file: string; position: number }> {
    this.calls.push('binlogPosition');
    return { file: 'ferry-bin.000001', position: 328 };
  }
  async extractBinlog(): Promise<string> {
    return '';
  }
}

const siteInfo = (over: Partial<SiteInfo> = {}): SiteInfo => ({
  wp: '6.5',
  php: { version: '8.2.15', extensions: [], ini: {} },
  db: { server: 'mariadb', version: '10.6.16', charset: 'utf8mb4', collation: '', bytes: 1000 },
  server: 'nginx',
  constants: { WP_DEBUG: false },
  multisite: false,
  prefix: 'wp_',
  abspath: '/var/www/html/',
  siteurl: 'https://fixture.example',
  ...over,
});

describe('pull', () => {
  let home: string;
  let fixture: string;
  let clonePath: string;
  let mock: MockPlugin;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ferry-home-'));
    process.env.FERRY_HOME = home;
    fixture = mkdtempSync(join(tmpdir(), 'ferry-site-'));
    clonePath = join(home, 'clone');
    mkdirSync(join(fixture, 'wp-content'), { recursive: true });
    writeFileSync(join(fixture, 'index.php'), '<?php // wp');
    writeFileSync(join(fixture, 'wp-load.php'), '<?php // load');
    writeFileSync(join(fixture, 'wp-content/object-cache.php'), '<?php // redis');
    mkdirSync(join(fixture, 'wp-content/plugins/foo/.git'), { recursive: true });
    writeFileSync(join(fixture, 'wp-content/plugins/foo/.git/HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(fixture, 'wp-content/plugins/foo/plugin.php'), '<?php // bundled plugin');
  });

  afterEach(() => {
    mock?.close();
    delete process.env.FERRY_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  function pair(base: string): void {
    saveProfile({ url: base, secret: 's', slug: 'fixture', clonePath });
  }

  it('runs the full §4.6 flow', async () => {
    const manifest = [
      'index.php',
      'wp-load.php',
      'wp-content/object-cache.php',
      'wp-content/plugins/foo/.git/HEAD',
      'wp-content/plugins/foo/plugin.php',
    ].map((p) => ({ path: p, size: sizeOf(fixture, p), hash: null }));
    mock = await startMockPlugin(fixture, {
      info: siteInfo(),
      manifest,
      dbTables: [{
        name: 'wp_options', rows: 1, bytes: 10, pk: 'option_id', maxpk: 1,
        batches: [{ sql: 'INSERT INTO `wp_options` VALUES (1);\n', lastKey: 1, complete: true }],
      }],
    });
    pair(mock.base);
    const env = new FakeEnv();
    const result = await pull('fixture', { env, wporg: DEAD_WPORG });

    expect(result.url).toBe('https://fixture.ddev.site');
    expect(result.adminPassword).toBe('pw123');
    expect(result.provenance.fetched).toBe(5);
    expect(result.provenance.reused).toBe(0);
    expect(result.provenance.reconstructed).toBe(0);
    expect(existsSync(join(home, 'sites/fixture/provenance.json'))).toBe(true);
    expect(env.calls).toEqual(['provision', 'importDb', 'binlogPosition', 'createAdmin']);
    expect(env.wpConfigPresentAtImport).toBe(true);
    expect(readFileSync(join(clonePath, 'index.php'), 'utf8')).toBe('<?php // wp');
    expect(existsSync(join(clonePath, 'wp-content/object-cache.php.ferry-disabled'))).toBe(true);
    expect(existsSync(join(clonePath, 'wp-content/mu-plugins/ferry-overlay.php'))).toBe(true);
    const dump = readFileSync(join(home, 'sites/fixture/db-dump/dump.sql'), 'utf8');
    expect(dump).toContain('wp_options');
    const profile = JSON.parse(readFileSync(join(home, 'sites/fixture/profile.json'), 'utf8'));
    expect(profile.info.wp).toBe('6.5');
    expect(profile.binlog).toEqual({ file: 'ferry-bin.000001', position: 328 });

    const git = (...args: string[]) => execFileSync('git', args, { cwd: clonePath, encoding: 'utf8' }).trim();
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.neutralizedRepos).toBe(1);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('production');
    expect(existsSync(join(clonePath, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(clonePath, 'wp-content/plugins/foo/.git.ferry-disabled/HEAD'))).toBe(true);
    expect(existsSync(join(clonePath, 'wp-content/plugins/foo/.git'))).toBe(false);
    expect(git('ls-files', 'wp-content/plugins/foo/plugin.php')).toBe('wp-content/plugins/foo/plugin.php');
    const ignored = (p: string) => {
      try {
        execFileSync('git', ['check-ignore', p], { cwd: clonePath });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('wp-config.php')).toBe(true);
    expect(ignored('wp-content/mu-plugins/ferry-overlay.php')).toBe(true);
    expect(ignored('CLAUDE.md')).toBe(true);
  });

  it('refuses multisite before transferring anything', async () => {
    mock = await startMockPlugin(fixture, { info: siteInfo({ multisite: true }) });
    pair(mock.base);
    const env = new FakeEnv();
    await expect(pull('fixture', { env })).rejects.toThrowError(/[Mm]ultisite/);
    expect(env.calls).toEqual([]);
  });

  it('reconstructs wp.org-matched files, fetches unique ones, reports tampering, and re-pull reuses', async () => {
    // fixture: one core file matching official checksums, one tampered core file, one unique file
    mkdirSync(join(fixture, 'wp-includes'), { recursive: true });
    writeFileSync(join(fixture, 'wp-includes/functions.php'), '<?php // official-functions');
    writeFileSync(join(fixture, 'wp-includes/version.php'), '<?php // TAMPERED');
    const officialVersion = '<?php // official-version';
    const wporg = await startMockWporg({
      checksums: { '6.5-en_US': {
        'wp-includes/functions.php': createHash('md5').update('<?php // official-functions').digest('hex'),
        'wp-includes/version.php': createHash('md5').update(officialVersion).digest('hex'),
      } },
      zips: { '/release/wordpress-6.5.zip': zipOf('wordpress', {
        'wp-includes/functions.php': '<?php // official-functions',
        'wp-includes/version.php': officialVersion,
      }) },
    });
    try {
      const paths = ['index.php', 'wp-includes/functions.php', 'wp-includes/version.php'];
      const manifest = paths.map((p) => ({ path: p, size: sizeOf(fixture, p), hash: hashOf(fixture, p) }));
      mock = await startMockPlugin(fixture, {
        info: siteInfo({ locale: 'en_US' }),
        manifest,
        dbTables: [{
          name: 'wp_options', rows: 1, bytes: 10, pk: 'option_id', maxpk: 1,
          batches: [{ sql: 'INSERT INTO `wp_options` VALUES (1);\n', lastKey: 1, complete: true }],
        }],
      });
      pair(mock.base);
      const result = await pull('fixture', { env: new FakeEnv(), wporg: wporg.endpoints });

      // functions.php was reconstructed from wp.org - never crossed the bridge
      const bridged = mock.requests.files.flat();
      expect(bridged).not.toContain('wp-includes/functions.php');
      expect(bridged).toContain('index.php');                 // unique (not in checksums)
      expect(bridged).toContain('wp-includes/version.php');   // tampered → mirror production's bytes
      expect(result.provenance.reconstructed).toBe(1);
      expect(readFileSync(join(clonePath, 'wp-includes/version.php'), 'utf8')).toBe('<?php // TAMPERED');

      // the report flags the tampering
      const report = JSON.parse(readFileSync(result.provenance.reportPath, 'utf8'));
      const core = report.verified.find((p: { type: string }) => p.type === 'core');
      expect(core.modified).toEqual(['wp-includes/version.php']);
      expect(result.provenance.summary).toContain('1 modified core file');

      // warm re-pull of the unchanged site: everything reuses, nothing crosses the bridge
      const before = mock.requests.files.length;
      const again = await pull('fixture', { env: new FakeEnv(), wporg: wporg.endpoints });
      expect(again.provenance.reused).toBe(3);
      expect(again.provenance.fetched).toBe(0);
      expect(mock.requests.files.length).toBe(before);
    } finally {
      wporg.close();
    }
  });
});
