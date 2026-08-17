import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildSited, sitedCanonical, type SitedDeps } from '../src/app.js';
import { SECRET, inject } from './helpers.js';

/** Signs and injects a GET with query params, as sited's clients would for /binlog. */
function injectGet(app: Parameters<typeof inject>[0], path: string, query: Record<string, string>) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(8).toString('hex');
  const bodyHash = createHash('sha256').update('').digest('hex');
  const sig = createHmac('sha256', SECRET).update(sitedCanonical('GET', path, query, bodyHash, ts, nonce)).digest('hex');
  const headers = { 'x-ferry-timestamp': String(ts), 'x-ferry-nonce': nonce, 'x-ferry-signature': sig };
  const qs = new URLSearchParams(query).toString();
  return app.inject({ method: 'GET', url: `${path}?${qs}`, headers });
}

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

describe('GET /binlog', () => {
  it('runs mysqlbinlog against /data/mysql/<file> from --start-position, returns stdout, and rejects a bad file name', async () => {
    const exec: SitedDeps['exec'] = async (cmd, args, opts) => {
      expect(cmd).toBe('mysqlbinlog');
      expect(args).toEqual([
        '--no-defaults', '--base64-output=decode-rows', '-v',
        '--start-position=1234', '/data/mysql/ferry-bin.000002',
      ]);
      expect(opts?.timeoutMs).toBe(120_000);
      return { stdout: '# row event\n', stderr: '', exitCode: 0 };
    };
    const app = buildSited({ secret: SECRET, docroot: '/tmp', exec });
    const ok = await injectGet(app, '/binlog', { file: 'ferry-bin.000002', position: '1234' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ stdout: '# row event\n' });

    const bad = await injectGet(app, '/binlog', { file: '../etc/passwd', position: '0' });
    expect(bad.statusCode).toBe(400);
  });
});
