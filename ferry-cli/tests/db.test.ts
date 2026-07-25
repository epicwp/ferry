import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FerryClient } from '../src/client.js';
import { pullDatabase } from '../src/db.js';
import { startMockPlugin, type MockPlugin } from './helpers/mockPlugin.js';

describe('pullDatabase', () => {
  let dumpDir: string;
  let fixture: string;
  let mock: MockPlugin;

  beforeEach(() => {
    dumpDir = mkdtempSync(join(tmpdir(), 'ferry-dump-'));
    fixture = mkdtempSync(join(tmpdir(), 'ferry-nofiles-'));
  });

  afterEach(() => {
    mock?.close();
    rmSync(dumpDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  it('pulls all tables with resume and snapshot bounds, then combines', async () => {
    mock = await startMockPlugin(fixture, {
      dbTables: [
        {
          name: 'wp_posts', rows: 3, bytes: 1000, pk: 'ID', maxpk: 3,
          batches: [
            { sql: 'INSERT INTO `wp_posts` VALUES (1),(2);\n', lastKey: 2, complete: false },
            { sql: 'INSERT INTO `wp_posts` VALUES (3);\n', lastKey: 3, complete: true },
          ],
        },
        {
          name: 'wp_nopk', rows: 1, bytes: 100, pk: null, maxpk: null,
          batches: [{ sql: 'INSERT INTO `wp_nopk` VALUES (0x61);\n', lastKey: 1, complete: true }],
        },
      ],
    });
    const client = new FerryClient(mock.base, 'irrelevant');
    const combined = await pullDatabase(client, dumpDir);
    expect(readFileSync(join(dumpDir, 'wp_posts.sql'), 'utf8'))
      .toBe('INSERT INTO `wp_posts` VALUES (1),(2);\nINSERT INTO `wp_posts` VALUES (3);\n');
    const dump = readFileSync(combined, 'utf8');
    expect(dump.startsWith('SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n')).toBe(true);
    expect(dump).toContain('wp_posts');
    expect(dump).toContain('wp_nopk');
  });
});
