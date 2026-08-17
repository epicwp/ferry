import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSited, type SitedDeps } from '../../ferry-sited/src/app.js';
import { FlyEnv, flyConfigFromEnv, type FlyEnvConfig } from '../src/env/fly.js';
import { loadProfile, saveProfile, type SiteInfo } from '../src/profile.js';

const SECRET = 'fly-test-secret';
const SLUG = 'my-site';

interface FakeApiCall { method: string; args: unknown[] }

/** Records every FlyApi call in order; return values are fixed test doubles
 *  (vol_fake / m_fake) so assertions on the machine config and saved profile stay simple. */
function fakeFlyApi(opts: { destroyError?: Error } = {}): { api: NonNullable<FlyEnvConfig['api']>; calls: FakeApiCall[] } {
  const calls: FakeApiCall[] = [];
  return {
    calls,
    api: {
      async createApp(name: string, org: string): Promise<void> {
        calls.push({ method: 'createApp', args: [name, org] });
      },
      async allocateIps(app: string): Promise<void> {
        calls.push({ method: 'allocateIps', args: [app] });
      },
      async createVolume(app: string, name: string, region: string, sizeGb: number): Promise<{ id: string }> {
        calls.push({ method: 'createVolume', args: [app, name, region, sizeGb] });
        return { id: 'vol_fake' };
      },
      async createMachine(app: string, region: string, config: Record<string, unknown>): Promise<{ id: string }> {
        calls.push({ method: 'createMachine', args: [app, region, config] });
        return { id: 'm_fake' };
      },
      async waitStarted(app: string, machineId: string): Promise<void> {
        calls.push({ method: 'waitStarted', args: [app, machineId] });
      },
      async destroyApp(app: string): Promise<void> {
        calls.push({ method: 'destroyApp', args: [app] });
        if (opts.destroyError) throw opts.destroyError;
      },
    },
  };
}

function fakeInfo(phpVersion: string): SiteInfo {
  return {
    wp: '6.4',
    php: { version: phpVersion, extensions: [], ini: {} },
    db: { server: 'mysql', version: '8.0', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', bytes: 0 },
    server: 'apache',
    constants: {},
    multisite: false,
    prefix: 'wp_',
    abspath: '/var/www/html/',
    siteurl: 'https://example.test',
  };
}

describe('FlyEnv', () => {
  let home: string;
  let www: string;
  let clonePath: string;
  let sited: FastifyInstance;
  let baseUrl: string;
  let execImpl: SitedDeps['exec'];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'ferry-home-'));
    process.env.FERRY_HOME = home;
    www = mkdtempSync(join(tmpdir(), 'sited-www-'));
    clonePath = join(home, 'clones', SLUG);
    mkdirSync(clonePath, { recursive: true });

    execImpl = async () => ({ stdout: '', stderr: '', exitCode: 0 });
    const exec: SitedDeps['exec'] = (cmd, args, opts) => execImpl(cmd, args, opts);
    sited = buildSited({ secret: SECRET, docroot: www, exec });
    baseUrl = await sited.listen({ port: 0, host: '127.0.0.1' });

    saveProfile({
      url: 'https://example.test',
      secret: 's',
      slug: SLUG,
      clonePath,
      flySited: { app: 'a', machineId: 'm', volumeId: 'v', secret: SECRET },
    });
  });

  afterEach(async () => {
    await sited.close();
    delete process.env.FERRY_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(www, { recursive: true, force: true });
  });

  function env(overrides: Partial<FlyEnvConfig> = {}): FlyEnv {
    return new FlyEnv({
      token: 't',
      org: 'personal',
      region: 'ams',
      imageRepo: 'ghcr.io/epicwp/ferry-site-runtime',
      sitedBaseFor: () => baseUrl,
      ...overrides,
    });
  }

  describe('FlyEnv.appName', () => {
    it('is deterministic, ≤63 chars, and slug-prefixed', () => {
      const name = FlyEnv.appName('wasgeurtje-nl');
      expect(name).toBe(FlyEnv.appName('wasgeurtje-nl'));
      expect(name.startsWith('ferry-s-wasgeurtje-nl-')).toBe(true);
      expect(name).toBe(name.toLowerCase());
      expect(name.length).toBeLessThanOrEqual(63);
      // a long slug still fits: 8 + 30 + 1 + 6 = 45
      const long = FlyEnv.appName('a'.repeat(80));
      expect(long.length).toBeLessThanOrEqual(63);
    });
  });

  it('url() derives from appName synchronously', () => {
    expect(env().url('wasgeurtje-nl')).toBe(`https://${FlyEnv.appName('wasgeurtje-nl')}.fly.dev`);
  });

  it('showColumns round-trips through sited /sql', async () => {
    execImpl = async (cmd, args) => {
      expect(cmd).toBe('mysql');
      expect(args).toEqual(['db', '-e', 'SHOW COLUMNS FROM wp_options']);
      return { stdout: 'Field\tType\tNull\tKey\tDefault\tExtra\noption_id\tbigint\tNO\tPRI\t\tauto\n', stderr: '', exitCode: 0 };
    };
    expect(await env().showColumns(clonePath, 'wp_options')).toEqual({ fields: ['option_id'], pkCols: ['option_id'] });
  });

  it('binlogPosition round-trips through sited /sql', async () => {
    execImpl = async (cmd, args) => {
      expect(cmd).toBe('mysql');
      expect(args).toEqual(['db', '-e', 'SHOW BINLOG STATUS']);
      return { stdout: 'File\tPosition\tBinlog_Do_DB\nferry-bin.000002\t1234\t\n', stderr: '', exitCode: 0 };
    };
    expect(await env().binlogPosition(clonePath)).toEqual({ file: 'ferry-bin.000002', position: 1234 });
  });

  it('importDb streams the dump file body to /db/import', async () => {
    const sql = 'CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\n';
    const dumpFile = join(home, 'dump.sql');
    writeFileSync(dumpFile, sql);
    let received: Buffer | undefined;
    execImpl = async (cmd, args, opts) => {
      expect(cmd).toBe('mysql');
      expect(args).toEqual(['db']);
      received = opts?.input;
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await env().importDb(clonePath, dumpFile);
    expect(received?.toString('utf8')).toBe(sql);
  });

  it("createAdmin drives wp user create via /wp, returns the generated credentials, and tolerates 'already exists'", async () => {
    let captured: string[] = [];
    execImpl = async (cmd, args) => {
      expect(cmd).toBe('wp');
      captured = args;
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const { user, password } = await env().createAdmin(clonePath);
    expect(user).toBe('ferry-admin');
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(captured).toEqual([
      `--path=${www}`, '--allow-root',
      'user', 'create', 'ferry-admin', 'ferry-admin@ferry.local',
      '--role=administrator', `--user_pass=${password}`,
    ]);

    execImpl = async () => ({ stdout: '', stderr: 'user ferry-admin already exists', exitCode: 1 });
    await expect(env().createAdmin(clonePath)).resolves.toMatchObject({ user: 'ferry-admin' });
  });

  it('createAdmin throws with the stderr excerpt on a real (non-"already exists") failure', async () => {
    execImpl = async () => ({ stdout: '', stderr: 'Error: something broke', exitCode: 1 });
    await expect(env().createAdmin(clonePath)).rejects.toThrow(/something broke/);
  });

  it('extractBinlog fetches /binlog output', async () => {
    execImpl = async (cmd, args) => {
      expect(cmd).toBe('mysqlbinlog');
      expect(args).toEqual([
        '--no-defaults', '--base64-output=decode-rows', '-v',
        '--start-position=328', '/data/mysql/ferry-bin.000001',
      ]);
      return { stdout: '# binlog events\n', stderr: '', exitCode: 0 };
    };
    expect(await env().extractBinlog(clonePath, { file: 'ferry-bin.000001', position: 328 })).toBe('# binlog events\n');
  });

  it('deployFiles tars the docroot (excluding .git) and PUTs /files', async () => {
    writeFileSync(join(clonePath, 'index.php'), '<?php // wp');
    mkdirSync(join(clonePath, '.git'), { recursive: true });
    writeFileSync(join(clonePath, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    await env().deployFiles(clonePath);

    expect(existsSync(join(www, 'index.php'))).toBe(true);
    expect(existsSync(join(www, '.git'))).toBe(false);
  });

  it('runWp forwards argv', async () => {
    execImpl = async (cmd, args) => {
      expect(cmd).toBe('wp');
      expect(args).toEqual([`--path=${www}`, '--allow-root', 'plugin', 'list']);
      return { stdout: 'akismet\n', stderr: '', exitCode: 0 };
    };
    expect(await env().runWp(clonePath, ['plugin', 'list'])).toEqual({ stdout: 'akismet\n', stderr: '', exitCode: 0 });
  });

  it('signed requests fail against a wrong secret (401 surfaces as thrown error)', async () => {
    saveProfile({
      url: 'https://example.test',
      secret: 's',
      slug: SLUG,
      clonePath,
      flySited: { app: 'a', machineId: 'm', volumeId: 'v', secret: 'the-wrong-secret' },
    });
    await expect(env().binlogPosition(clonePath)).rejects.toThrow(/401/);
  });

  it('throws a clear error naming the slug when the profile has no flySited state', async () => {
    const otherSlug = 'no-fly-site';
    const otherClone = join(home, 'clones', otherSlug);
    mkdirSync(otherClone, { recursive: true });
    saveProfile({ url: 'https://x.test', secret: 's', slug: otherSlug, clonePath: otherClone });
    await expect(env().binlogPosition(otherClone)).rejects.toThrow(/no-fly-site/);
  });

  describe('provision', () => {
    beforeEach(() => {
      // Each provision test starts from a profile with no flySited state, so the
      // idempotent short-circuit doesn't fire (the outer beforeEach's default profile has one).
      saveProfile({ url: 'https://example.test', secret: 's', slug: SLUG, clonePath });
    });

    it('creates app → ips → volume → machine → waits → polls sited health → saves flySited to the profile', async () => {
      const { api, calls } = fakeFlyApi();
      await env({ api }).provision(clonePath, fakeInfo('8.2.15'), SLUG);

      expect(calls.map((c) => c.method)).toEqual(['createApp', 'allocateIps', 'createVolume', 'createMachine', 'waitStarted']);
      const appName = FlyEnv.appName(SLUG);
      expect(calls[0].args).toEqual([appName, 'personal']);
      expect(calls[1].args).toEqual([appName]);
      expect(calls[2].args).toEqual([appName, 'data', 'ams', 3]);
      expect(calls[4].args).toEqual([appName, 'm_fake']);

      const saved = loadProfile(SLUG);
      expect(saved.flySited).toMatchObject({ app: appName, machineId: 'm_fake', volumeId: 'vol_fake' });
      expect(saved.flySited?.secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it('picks the image tag from info.php.version (8.2.15 → :php8.2)', async () => {
      const { api, calls } = fakeFlyApi();
      await env({ api }).provision(clonePath, fakeInfo('8.2.15'), SLUG);

      const config = calls.find((c) => c.method === 'createMachine')!.args[2] as { image: string };
      expect(config.image).toBe('ghcr.io/epicwp/ferry-site-runtime:php8.2');
      expect(loadProfile(SLUG).flySited?.parityNote).toBeUndefined();
    });

    it('maps an unsupported PHP minor to the nearest tag and records a parityNote', async () => {
      const { api, calls } = fakeFlyApi();
      await env({ api }).provision(clonePath, fakeInfo('7.4.33'), SLUG);

      const config = calls.find((c) => c.method === 'createMachine')!.args[2] as { image: string };
      expect(config.image).toBe('ghcr.io/epicwp/ferry-site-runtime:php8.1');
      const note = loadProfile(SLUG).flySited?.parityNote;
      expect(note).toContain('7.4.33');
      expect(note).toContain('8.1');
    });

    it('is idempotent when flySited already exists and the machine responds (no duplicate create calls)', async () => {
      saveProfile({
        url: 'https://example.test', secret: 's', slug: SLUG, clonePath,
        flySited: { app: 'a', machineId: 'm', volumeId: 'v', secret: SECRET },
      });
      const { api, calls } = fakeFlyApi();
      await env({ api }).provision(clonePath, fakeInfo('8.2.15'), SLUG);
      expect(calls).toHaveLength(0);
    });

    it('idempotency probe retries past one flaky /health response before concluding the machine is still alive', async () => {
      let hits = 0;
      const flaky: Server = createServer((_req, res) => {
        hits++;
        if (hits === 1) {
          res.writeHead(500);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      await new Promise<void>((resolve) => flaky.listen(0, '127.0.0.1', resolve));
      const address = flaky.address();
      if (address === null || typeof address === 'string') throw new Error('unexpected server address');
      const flakyUrl = `http://127.0.0.1:${address.port}`;

      saveProfile({
        url: 'https://example.test', secret: 's', slug: SLUG, clonePath,
        flySited: { app: 'a', machineId: 'm', volumeId: 'v', secret: SECRET },
      });
      const { api, calls } = fakeFlyApi();
      try {
        await env({ api, sitedBaseFor: () => flakyUrl }).provision(clonePath, fakeInfo('8.2.15'), SLUG);
      } finally {
        await new Promise<void>((resolve) => flaky.close(() => resolve()));
      }

      expect(hits).toBe(2); // one failed probe, one that succeeded
      expect(calls).toHaveLength(0); // never fell through to re-provisioning
    });

    it('self-cleans (destroyApp) when a step after createApp fails, rethrows the original error, and leaves no flySited', async () => {
      const boom = new Error('createMachine exploded');
      const { api, calls } = fakeFlyApi();
      api.createMachine = async (app: string, region: string, config: Record<string, unknown>) => {
        calls.push({ method: 'createMachine', args: [app, region, config] });
        throw boom;
      };

      await expect(env({ api }).provision(clonePath, fakeInfo('8.2.15'), SLUG)).rejects.toThrow(/createMachine exploded/);

      expect(calls.map((c) => c.method)).toEqual(['createApp', 'allocateIps', 'createVolume', 'createMachine', 'destroyApp']);
      expect(calls.at(-1)).toEqual({ method: 'destroyApp', args: [FlyEnv.appName(SLUG)] });
      expect(loadProfile(SLUG).flySited).toBeUndefined();
    });

    it('carries the sited secret as a files entry, the volume mount at /data, services 80/443, guest 1024MB shared-1x', async () => {
      const { api, calls } = fakeFlyApi();
      await env({ api }).provision(clonePath, fakeInfo('8.2.15'), SLUG);

      const config = calls.find((c) => c.method === 'createMachine')!.args[2] as Record<string, unknown>;
      expect(config.guest).toEqual({ cpu_kind: 'shared', cpus: 1, memory_mb: 1024 });
      expect(config.mounts).toEqual([{ volume: 'vol_fake', path: '/data' }]);
      expect(config.services).toEqual([{
        protocol: 'tcp',
        internal_port: 80,
        ports: [
          { port: 80, handlers: ['http'] },
          { port: 443, handlers: ['tls', 'http'] },
        ],
      }]);
      expect(config.restart).toEqual({ policy: 'always' });

      const files = config.files as { guest_path: string; raw_value: string }[];
      expect(files).toHaveLength(1);
      expect(files[0].guest_path).toBe('/etc/ferry/sited-secret');
      const savedSecret = loadProfile(SLUG).flySited?.secret;
      expect(Buffer.from(files[0].raw_value, 'base64').toString('utf8')).toBe(savedSecret);
    });
  });

  describe('destroy', () => {
    it('calls FlyApi.destroyApp with the derived app name and clears flySited', async () => {
      const { api, calls } = fakeFlyApi();
      await env({ api }).destroy(SLUG);
      expect(calls).toEqual([{ method: 'destroyApp', args: [FlyEnv.appName(SLUG)] }]);
      expect(loadProfile(SLUG).flySited).toBeUndefined();
    });

    it('tolerates an already-absent app (404) and still clears flySited', async () => {
      const { api } = fakeFlyApi({ destroyError: new Error(`fly api DELETE .../apps/${FlyEnv.appName(SLUG)}?force=true → 404`) });
      await expect(env({ api }).destroy(SLUG)).resolves.toBeUndefined();
      expect(loadProfile(SLUG).flySited).toBeUndefined();
    });

    it('propagates non-404 errors from destroyApp and leaves flySited untouched', async () => {
      const { api } = fakeFlyApi({ destroyError: new Error(`fly api DELETE .../apps/${FlyEnv.appName(SLUG)}?force=true → 500`) });
      await expect(env({ api }).destroy(SLUG)).rejects.toThrow(/500/);
      expect(loadProfile(SLUG).flySited).toBeDefined();
    });
  });
});

describe('flyConfigFromEnv', () => {
  it('requires FERRY_FLY_TOKEN and FERRY_SITE_RUNTIME_IMAGE, defaulting org/region', () => {
    expect(() => flyConfigFromEnv({})).toThrow(/FERRY_FLY_TOKEN/);
    expect(() => flyConfigFromEnv({ FERRY_FLY_TOKEN: 't' })).toThrow(/FERRY_SITE_RUNTIME_IMAGE/);
    expect(flyConfigFromEnv({ FERRY_FLY_TOKEN: 't', FERRY_SITE_RUNTIME_IMAGE: 'ghcr.io/x/y' })).toEqual({
      token: 't', org: 'personal', region: 'ams', imageRepo: 'ghcr.io/x/y',
    });
  });

  it('honors FERRY_FLY_ORG and FERRY_FLY_REGION overrides', () => {
    expect(flyConfigFromEnv({
      FERRY_FLY_TOKEN: 't', FERRY_SITE_RUNTIME_IMAGE: 'ghcr.io/x/y',
      FERRY_FLY_ORG: 'epicwp', FERRY_FLY_REGION: 'fra',
    })).toEqual({ token: 't', org: 'epicwp', region: 'fra', imageRepo: 'ghcr.io/x/y' });
  });
});
