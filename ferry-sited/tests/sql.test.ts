import { describe, expect, it } from 'vitest';
import { buildSited, type SitedDeps } from '../src/app.js';
import { SECRET, inject } from './helpers.js';

describe('POST /sql', () => {
  it('binlog-status parses the SHOW BINLOG STATUS table', async () => {
    const exec: SitedDeps['exec'] = async (cmd, args) => {
      expect(cmd).toBe('mysql');
      expect(args).toEqual(['db', '-e', 'SHOW BINLOG STATUS']);
      return { stdout: 'File\tPosition\tBinlog_Do_DB\nferry-bin.000002\t1234\t\n', stderr: '', exitCode: 0 };
    };
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec });
    const res = await inject(app, 'POST', '/sql', { kind: 'binlog-status' });
    expect(res.json()).toEqual({ file: 'ferry-bin.000002', position: 1234 });
  });

  it('binlog-status returns 500 on empty/malformed output', async () => {
    const exec: SitedDeps['exec'] = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec });
    const res = await inject(app, 'POST', '/sql', { kind: 'binlog-status' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'unexpected SHOW BINLOG STATUS output' });
  });

  it('show-columns validates the table name and parses columns', async () => {
    const exec: SitedDeps['exec'] = async (_c, args) => {
      expect(args[2]).toBe('SHOW COLUMNS FROM wp_options');
      return { stdout: 'Field\tType\tNull\tKey\tDefault\tExtra\noption_id\tbigint\tNO\tPRI\t\tauto\n', stderr: '', exitCode: 0 };
    };
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec });
    const ok = await inject(app, 'POST', '/sql', { kind: 'show-columns', table: 'wp_options' });
    expect(ok.json()).toEqual({ fields: ['option_id'], pkCols: ['option_id'] });
    const bad = await inject(app, 'POST', '/sql', { kind: 'show-columns', table: 'wp_options; DROP TABLE x' });
    expect(bad.statusCode).toBe(400);
  });
});
