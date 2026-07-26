import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classify, parseBinlog, writeJournal } from '../src/journal.js';
import type { DbOp } from '../src/push-types.js';

const FIXTURES = join(__dirname, '..', 'test-fixtures', 'binlog');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const columnsStub = (table: string): string[] => {
  switch (table) {
    case 'wp_options': return ['option_id', 'option_name', 'option_value', 'autoload'];
    case 'wp_postmeta': return ['meta_id', 'post_id', 'meta_key', 'meta_value'];
    case 'ferry_spike_table': return ['id', 'val'];
    default: return [];
  }
};

describe('parseBinlog', () => {
  it('parses an ### UPDATE event with before+after images (update-option.txt)', () => {
    const events = parseBinlog(read('update-option.txt'), columnsStub);
    expect(events).toEqual([{
      table: 'wp_options',
      kind: 'update',
      before: { option_id: '506', option_name: 'ferry_spike_opt', option_value: 'hello', autoload: 'auto' },
      after: { option_id: '506', option_name: 'ferry_spike_opt', option_value: 'world', autoload: 'auto' },
    }]);
  });

  it('parses an ### INSERT event with only an after-image (insert-postmeta.txt)', () => {
    const events = parseBinlog(read('insert-postmeta.txt'), columnsStub);
    expect(events).toHaveLength(1);
    expect(events[0].before).toBeUndefined();
    expect(events[0]).toEqual({
      table: 'wp_postmeta',
      kind: 'insert',
      after: { meta_id: '13', post_id: '5', meta_key: 'ferry_spike_meta', meta_value: 'hello_meta' },
    });
  });

  it('parses a ### DELETE event with only a before-image (delete-row.txt)', () => {
    const events = parseBinlog(read('delete-row.txt'), columnsStub);
    expect(events).toHaveLength(1);
    expect(events[0].after).toBeUndefined();
    expect(events[0]).toEqual({
      table: 'ferry_spike_table',
      kind: 'delete',
      before: { id: '1', val: 'x' },
    });
  });
});

describe('classify', () => {
  it('flags transient option updates as noise', () => {
    const ev = {
      table: 'wp_options', kind: 'update' as const,
      before: { option_id: '1', option_name: '_transient_foo', option_value: 'a', autoload: 'no' },
      after: { option_id: '1', option_name: '_transient_foo', option_value: 'b', autoload: 'no' },
    };
    expect(classify(ev, 'wp_')).toEqual({ noise: true });
  });

  it('flags _site_transient_, cron, and ferry_ options as noise', () => {
    const names = ['_site_transient_wp_theme_files_patterns', 'cron', 'ferry_nonce_abc123'];
    for (const name of names) {
      const ev = {
        table: 'wp_options', kind: 'update' as const,
        before: { option_id: '1', option_name: name, option_value: 'a', autoload: 'no' },
        after: { option_id: '1', option_name: name, option_value: 'b', autoload: 'no' },
      };
      expect(classify(ev, 'wp_')).toEqual({ noise: true });
    }
  });

  it('refuses content tables (wp_posts)', () => {
    const ev = {
      table: 'wp_posts', kind: 'update' as const,
      before: { ID: '1', post_title: 'a' },
      after: { ID: '1', post_title: 'b' },
    };
    const result = classify(ev, 'wp_');
    expect('refused' in result).toBe(true);
  });

  it('refuses woocommerce_*, wc_*, and actionscheduler_* tables', () => {
    for (const table of ['wp_woocommerce_order_items', 'wp_wc_customer_lookup', 'wp_actionscheduler_actions']) {
      const ev = { table, kind: 'update' as const, before: { id: '1' }, after: { id: '1' } };
      expect('refused' in classify(ev, 'wp_')).toBe(true);
    }
  });

  it('classifies a non-noise wp_options update as option_set/low', () => {
    // Same shape as update-option.txt, but a non-ferry-prefixed option name: the fixture's own
    // "ferry_spike_opt" (Task 1's spike-artifact naming, for easy cleanup) collides with the
    // ferry_* noise rule below and is correctly classified as noise, not a candidate op - see
    // the dedicated noise test above.
    const ev = {
      table: 'wp_options', kind: 'update' as const,
      before: { option_id: '506', option_name: 'site_description', option_value: 'hello', autoload: 'auto' },
      after: { option_id: '506', option_name: 'site_description', option_value: 'world', autoload: 'auto' },
    };
    expect(classify(ev, 'wp_')).toEqual({
      op: { kind: 'option_set', name: 'site_description', old: 'hello', new: 'world' },
      risk: 'low',
    });
  });

  it('classifies a wp_postmeta insert as postmeta_set/low with old=null', () => {
    const [ev] = parseBinlog(read('insert-postmeta.txt'), columnsStub);
    expect(classify(ev, 'wp_')).toEqual({
      op: { kind: 'postmeta_set', postId: 5, key: 'ferry_spike_meta', old: null, new: 'hello_meta' },
      risk: 'low',
    });
  });

  it('classifies a custom-table delete as row_delete/higher', () => {
    const [ev] = parseBinlog(read('delete-row.txt'), columnsStub);
    expect(classify(ev, 'wp_')).toEqual({
      op: { kind: 'row_delete', table: 'ferry_spike_table', pkCol: 'id', pk: 1, old: { id: '1', val: 'x' } },
      risk: 'higher',
    });
  });

  it('classifies a custom-table update as row_update/higher', () => {
    const ev = {
      table: 'ferry_spike_table', kind: 'update' as const,
      before: { id: '1', val: 'x' },
      after: { id: '1', val: 'y' },
    };
    expect(classify(ev, 'wp_')).toEqual({
      op: { kind: 'row_update', table: 'ferry_spike_table', pkCol: 'id', pk: 1, old: { id: '1', val: 'x' }, new: { id: '1', val: 'y' } },
      risk: 'higher',
    });
  });

  it('classifies a custom-table insert as row_insert/higher', () => {
    const ev = { table: 'ferry_spike_table', kind: 'insert' as const, after: { id: '1', val: 'x' } };
    expect(classify(ev, 'wp_')).toEqual({
      op: { kind: 'row_insert', table: 'ferry_spike_table', pkCol: 'id', pk: 1, new: { id: '1', val: 'x' } },
      risk: 'higher',
    });
  });
});

describe('writeJournal', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ferry-journal-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one parseable JSON op per line', async () => {
    const ops: DbOp[] = [
      { kind: 'option_set', name: 'foo', old: 'a', new: 'b' },
      { kind: 'postmeta_delete', postId: 5, key: 'bar', old: 'baz' },
    ];
    await writeJournal(dir, ops);
    const lines = readFileSync(join(dir, 'journal.ndjson'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l))).toEqual(ops);
  });
});
