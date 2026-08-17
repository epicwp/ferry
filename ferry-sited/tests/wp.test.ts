import { describe, expect, it } from 'vitest';
import { buildSited, type SitedDeps } from '../src/app.js';
import { SECRET, inject } from './helpers.js';

describe('POST /wp', () => {
  it('runs wp with --path and returns the exec triple', async () => {
    const exec: SitedDeps['exec'] = async (cmd, args) => {
      expect(cmd).toBe('wp');
      expect(args).toEqual(['--path=/tmp/www', '--allow-root', 'plugin', 'list']);
      return { stdout: 'akismet\n', stderr: '', exitCode: 0 };
    };
    const app = buildSited({ secret: SECRET, docroot: '/tmp/www', exec });
    const res = await inject(app, 'POST', '/wp', { argv: ['plugin', 'list'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stdout: 'akismet\n', stderr: '', exitCode: 0 });
  });

  it('caps runtime via timeoutMs 120000', async () => {
    let capturedTimeoutMs: number | undefined;
    const exec: SitedDeps['exec'] = async (_cmd, _args, opts) => {
      capturedTimeoutMs = opts?.timeoutMs;
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const app = buildSited({ secret: SECRET, docroot: '/tmp/www', exec });
    const res = await inject(app, 'POST', '/wp', { argv: ['core', 'version'] });
    expect(res.statusCode).toBe(200);
    expect(capturedTimeoutMs).toBe(120_000);
  });
});
