import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CloneEnv, TableColumns } from '../src/env/ddev.js';
import { saveProfile, type SiteInfo } from '../src/profile.js';
import { pull, type PullProgress } from '../src/pull.js';
import { hashOf, sizeOf, startMockPlugin, type MockPlugin } from './helpers/mockPlugin.js';

const DEAD_WPORG = { api: 'http://127.0.0.1:1', downloads: 'http://127.0.0.1:1' };

class FakeEnv implements CloneEnv {
  async provision(): Promise<void> {}
  async importDb(): Promise<void> {}
  async createAdmin(): Promise<{ user: string; password: string }> {
    return { user: 'ferry-admin', password: 'pw123' };
  }
  url(name: string): string {
    return `https://${name}.ddev.site`;
  }
  async binlogPosition(): Promise<{ file: string; position: number }> {
    return { file: 'ferry-bin.000001', position: 0 };
  }
  async extractBinlog(): Promise<string> {
    return '';
  }
  async showColumns(): Promise<TableColumns> { return { fields: [], pkCols: [] }; }
  async deployFiles(): Promise<void> {}
  async destroy(): Promise<void> {}
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

describe('pull progress', () => {
  let home: string;
  let fixture: string;
  let mock: MockPlugin;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ferry-home-'));
    process.env.FERRY_HOME = home;
    fixture = mkdtempSync(join(tmpdir(), 'ferry-site-'));
    mkdirSync(join(fixture, 'wp-content'), { recursive: true });
    writeFileSync(join(fixture, 'index.php'), '<?php // wp');
    writeFileSync(join(fixture, 'wp-load.php'), '<?php // load');
  });

  afterEach(() => {
    mock?.close();
    delete process.env.FERRY_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('emits phases in order with counters', async () => {
    const paths = ['index.php', 'wp-load.php'];
    mock = await startMockPlugin(fixture, {
      info: siteInfo(),
      manifest: paths.map((p) => ({ path: p, size: sizeOf(fixture, p), hash: hashOf(fixture, p) })),
      dbTables: [{
        name: 'wp_posts', rows: 1, bytes: 64, pk: 'ID', maxpk: 1,
        batches: [{ sql: 'INSERT INTO wp_posts VALUES (1);\n', lastKey: 1, complete: true }],
      }, {
        name: 'wp_options', rows: 1, bytes: 64, pk: 'option_id', maxpk: 1,
        batches: [{ sql: 'INSERT INTO wp_options VALUES (1);\n', lastKey: 1, complete: true }],
      }],
    });
    saveProfile({ url: mock.base, secret: 's', slug: 'fixture', clonePath: join(home, 'clone') });

    const events: PullProgress[] = [];
    await pull('fixture', { env: new FakeEnv(), wporg: DEAD_WPORG }, { onProgress: (e) => events.push(e) });

    const phases = events.map((e) => e.phase);
    // every phase appears, in the documented order
    const order = ['info', 'manifest', 'resolve', 'files', 'git', 'db', 'import', 'done'];
    const firstIndex = order.map((p) => phases.indexOf(p));
    expect(firstIndex.every((i) => i >= 0)).toBe(true);
    expect([...firstIndex].sort((a, b) => a - b)).toEqual(firstIndex);

    const manifestEvent = events.find((e) => e.phase === 'manifest');
    expect(manifestEvent?.total).toBe(2);
    const fileEvents = events.filter((e) => e.phase === 'files' && e.current !== undefined);
    expect(fileEvents.at(-1)?.current).toBe(fileEvents.at(-1)?.total);
    const dbEvent = events.find((e) => e.phase === 'db' && e.detail === 'wp_posts');
    expect(dbEvent).toBeDefined();
    const dbEvents = events.filter((e) => e.phase === 'db' && e.current !== undefined);
    expect(dbEvents[0]?.current).toBe(1); // 1-based: never "0 of N"
    expect(dbEvents.at(-1)?.current).toBe(2); // reaches N of N, like the files counter
    expect(dbEvents.at(-1)?.total).toBe(2);
    expect(dbEvents.at(-1)?.detail).toBe('wp_options');
    expect(phases.at(-1)).toBe('done');
    // clone actually materialized — progress reporting must not change behavior
    expect(existsSync(join(home, 'clone', 'index.php'))).toBe(true);
  });
});
