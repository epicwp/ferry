import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloneEnv } from '../src/env/ddev.js';
import { saveProfile, type SiteInfo } from '../src/profile.js';
import { pull } from '../src/pull.js';
import { startMockPlugin, sizeOf, type MockPlugin } from './helpers/mockPlugin.js';

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
    const manifest = ['index.php', 'wp-load.php', 'wp-content/object-cache.php']
      .map((p) => ({ path: p, size: sizeOf(fixture, p), hash: null }));
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
    const result = await pull('fixture', { env });

    expect(result.url).toBe('https://fixture.ddev.site');
    expect(result.adminPassword).toBe('pw123');
    expect(env.calls).toEqual(['provision', 'importDb', 'createAdmin']);
    expect(env.wpConfigPresentAtImport).toBe(true);
    expect(readFileSync(join(clonePath, 'index.php'), 'utf8')).toBe('<?php // wp');
    expect(existsSync(join(clonePath, 'wp-content/object-cache.php.ferry-disabled'))).toBe(true);
    expect(existsSync(join(clonePath, 'wp-content/mu-plugins/ferry-overlay.php'))).toBe(true);
    const dump = readFileSync(join(home, 'sites/fixture/db-dump/dump.sql'), 'utf8');
    expect(dump).toContain('wp_options');
    const profile = JSON.parse(readFileSync(join(home, 'sites/fixture/profile.json'), 'utf8'));
    expect(profile.info.wp).toBe('6.5');
  });

  it('refuses multisite before transferring anything', async () => {
    mock = await startMockPlugin(fixture, { info: siteInfo({ multisite: true }) });
    pair(mock.base);
    const env = new FakeEnv();
    await expect(pull('fixture', { env })).rejects.toThrowError(/[Mm]ultisite/);
    expect(env.calls).toEqual([]);
  });
});
