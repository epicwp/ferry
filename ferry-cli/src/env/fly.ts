import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { request } from 'undici';
import * as tar from 'tar';
import { loadProfile, saveProfile, type SiteInfo } from '../profile.js';
import type { CloneEnv, TableColumns } from './ddev.js';
import { FlyApi } from './fly-api.js';

// Origin: ferry-sited/src/verify.ts sitedCanonical — copied so the cli client signs
// identically; sited ships dependency-free into the site image, so this can't be a shared import.
function sitedCanonical(
  method: string,
  path: string,
  query: Record<string, string>,
  bodySha256Hex: string,
  timestamp: number,
  nonce: string,
): string {
  const pairs = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`);
  return `${method.toUpperCase()}\n${path}\n${pairs.join('&')}\n${bodySha256Hex}\n${timestamp}\n${nonce}`;
}

function signedHeaders(
  secret: string,
  method: string,
  path: string,
  query: Record<string, string>,
  bodyHash: string,
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(8).toString('hex');
  const sig = createHmac('sha256', secret).update(sitedCanonical(method, path, query, bodyHash, ts, nonce)).digest('hex');
  return { 'x-ferry-timestamp': String(ts), 'x-ferry-nonce': nonce, 'x-ferry-signature': sig };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Tars `clonePath` (gzip), excluding `.git`, into an in-memory buffer for PUT /files.
 *  tar entries under a `['.']` pack root carry a `./` prefix, so the exclusion strips it
 *  before comparing - matching on the bare `.git`/`.git/...` prefix used to leave it in. */
async function packTar(clonePath: string): Promise<Buffer> {
  const stream = tar.c(
    {
      gzip: true,
      cwd: clonePath,
      filter: (p) => {
        const rel = p.replace(/^\.\//, '');
        return rel !== '.git' && !rel.startsWith('.git/');
      },
    },
    ['.'],
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

type HttpResponse = { statusCode: number; body: { text(): Promise<string> } };

async function ensureOk(res: HttpResponse, method: string, path: string): Promise<void> {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = await res.body.text();
    throw new Error(`sited ${method} ${path} → ${res.statusCode}: ${text.slice(0, 300)}`);
  }
}

async function readJson(res: HttpResponse, method: string, path: string): Promise<unknown> {
  await ensureOk(res, method, path);
  const text = await res.body.text();
  return text ? JSON.parse(text) : undefined;
}

// Public method surface of FlyApi, extracted via Pick so a plain fake object (no private
// fields) can satisfy the type in tests without importing/duplicating FlyApi's signatures.
type FlyApiClient = Pick<FlyApi, 'createApp' | 'allocateIps' | 'createVolume' | 'createMachine' | 'waitStarted' | 'destroyApp'>;

export interface FlyEnvConfig {
  token: string;
  org: string;
  region: string;
  imageRepo: string;
  sitedPort?: number; // default 2323
  sitedBaseFor?: (app: string, machineId: string) => string; // test seam
  api?: FlyApiClient; // test seam (Task 8)
}

const PHP_TAGS = ['8.1', '8.2', '8.3', '8.4'];

/** Maps a production PHP version to a supported clone image tag. Unsupported minors
 *  (e.g. EOL 7.4) fall back to the nearest supported tag and carry a parity note for
 *  the pull progress stream (§2.5: parity is core, but the clone still has to boot). */
function phpTag(version: string): { tag: string; note?: string } {
  const minor = version.split('.').slice(0, 2).join('.');
  if (PHP_TAGS.includes(minor)) return { tag: `php${minor}` };
  const nearest = PHP_TAGS.reduce((a, b) =>
    Math.abs(Number(b) - Number(minor)) < Math.abs(Number(a) - Number(minor)) ? b : a);
  return { tag: `php${nearest}`, note: `PHP parity gap: production runs ${version}, clone runs ${nearest} (nearest supported).` };
}

export function flyConfigFromEnv(env: NodeJS.ProcessEnv): FlyEnvConfig {
  const token = env.FERRY_FLY_TOKEN;
  if (!token) throw new Error('FERRY_FLY_TOKEN is required');
  const imageRepo = env.FERRY_SITE_RUNTIME_IMAGE;
  if (!imageRepo) throw new Error('FERRY_SITE_RUNTIME_IMAGE is required');
  return {
    token,
    org: env.FERRY_FLY_ORG ?? 'personal',
    region: env.FERRY_FLY_REGION ?? 'ams',
    imageRepo,
  };
}

export class FlyEnv implements CloneEnv {
  private readonly flyApi: FlyApiClient;

  constructor(private readonly cfg: FlyEnvConfig) {
    this.flyApi = cfg.api ?? new FlyApi({ token: cfg.token });
  }

  static appName(slug: string): string {
    const hash6 = createHash('sha256').update(`ferry-site:${slug}`).digest('hex').slice(0, 6);
    return `ferry-s-${slug.slice(0, 30)}-${hash6}`.toLowerCase();
  }

  url(name: string): string {
    return `https://${FlyEnv.appName(name)}.fly.dev`;
  }

  /** App-per-site on Fly Machines API (spike findings doc §1-3): create app → allocate
   *  IPs → 3GB data volume → machine (sited secret shipped as a boot-time file) → wait
   *  started → poll sited /health until it answers. Idempotent: a profile that already
   *  points at a live, healthy machine short-circuits (re-pull after a prior provision) -
   *  the health probe retries 3x/2s apart so one transient blip doesn't trigger a doomed
   *  re-provision attempt (createApp on an app that's still alive throws).
   *  Self-cleaning: once createApp has succeeded, any later failure (allocateIps,
   *  createVolume, createMachine, waitStarted, or the post-start health poll timing out)
   *  best-effort destroys the half-built app before rethrowing, so a retry starts clean
   *  instead of dying on "app already exists" against orphaned Fly state. */
  async provision(clonePath: string, info: SiteInfo, name: string): Promise<void> {
    const slug = name;
    const app = FlyEnv.appName(slug);
    const profile = loadProfile(slug);

    if (profile.flySited && (await healthOkRetrying(this.sitedBaseUrl(profile.flySited.app, profile.flySited.machineId), 3, 2000))) {
      return;
    }

    await this.flyApi.createApp(app, this.cfg.org);
    try {
      await this.flyApi.allocateIps(app);
      const volume = await this.flyApi.createVolume(app, 'data', this.cfg.region, 3);
      const secret = randomBytes(32).toString('hex');
      const { tag, note } = phpTag(info.php.version);

      const machine = await this.flyApi.createMachine(app, this.cfg.region, {
        image: `${this.cfg.imageRepo}:${tag}`,
        guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
        mounts: [{ volume: volume.id, path: '/data' }],
        files: [{ guest_path: '/etc/ferry/sited-secret', raw_value: Buffer.from(secret).toString('base64') }],
        services: [
          {
            protocol: 'tcp',
            internal_port: 80,
            ports: [
              { port: 80, handlers: ['http'] },
              { port: 443, handlers: ['tls', 'http'] },
            ],
          },
        ],
        restart: { policy: 'always' },
      });
      await this.flyApi.waitStarted(app, machine.id);

      const baseUrl = this.sitedBaseUrl(app, machine.id);
      if (!(await waitForHealth(baseUrl, 2000, 120_000))) {
        throw new Error(`fly machine ${machine.id} for app ${app} never answered /health within 120s`);
      }

      profile.flySited = { app, machineId: machine.id, volumeId: volume.id, secret, ...(note ? { parityNote: note } : {}) };
      saveProfile(profile);
    } catch (err) {
      try {
        await this.flyApi.destroyApp(app);
      } catch (cleanupErr) {
        console.warn(`fly: best-effort cleanup of app "${app}" failed after a provision error`, cleanupErr);
      }
      throw err;
    }
  }

  /** Volumes die with the app (spike-confirmed: `DELETE ?force=true` removes machines
   *  + volumes together), so this is just app teardown + clearing the saved Fly state.
   *  An already-absent app (404) is tolerated so destroy is safe to retry. */
  async destroy(name: string): Promise<void> {
    const app = FlyEnv.appName(name);
    try {
      await this.flyApi.destroyApp(app);
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    const profile = loadProfile(name);
    if (profile.flySited) {
      delete profile.flySited;
      saveProfile(profile);
    }
  }

  private sitedBaseUrl(app: string, machineId: string): string {
    return this.cfg.sitedBaseFor
      ? this.cfg.sitedBaseFor(app, machineId)
      : `http://${machineId}.vm.${app}.internal:${this.cfg.sitedPort ?? 2323}`;
  }

  async showColumns(clonePath: string, table: string): Promise<TableColumns> {
    const { baseUrl, secret } = this.sitedFor(clonePath);
    return (await postJson(baseUrl, secret, '/sql', { kind: 'show-columns', table })) as TableColumns;
  }

  async binlogPosition(clonePath: string): Promise<{ file: string; position: number }> {
    const { baseUrl, secret } = this.sitedFor(clonePath);
    return (await postJson(baseUrl, secret, '/sql', { kind: 'binlog-status' })) as { file: string; position: number };
  }

  async extractBinlog(clonePath: string, pos: { file: string; position: number }): Promise<string> {
    const { baseUrl, secret } = this.sitedFor(clonePath);
    const data = (await get(baseUrl, secret, '/binlog', { file: pos.file, position: String(pos.position) })) as { stdout: string };
    return data.stdout;
  }

  async importDb(clonePath: string, dumpFile: string): Promise<void> {
    const { baseUrl, secret } = this.sitedFor(clonePath);
    const bodyHash = await hashFile(dumpFile);
    const headers = signedHeaders(secret, 'POST', '/db/import', {}, bodyHash);
    headers['content-type'] = 'application/octet-stream';
    const res = await request(`${baseUrl}/db/import`, { method: 'POST', headers, body: createReadStream(dumpFile) });
    await ensureOk(res, 'POST', '/db/import');
  }

  /** §4.6: a working admin requires a local user - the customer's production credentials never travel. */
  async createAdmin(clonePath: string): Promise<{ user: string; password: string }> {
    const password = randomBytes(9).toString('base64url');
    const { stdout, stderr, exitCode } = await this.runWp(clonePath, [
      'user', 'create', 'ferry-admin', 'ferry-admin@ferry.local',
      '--role=administrator', `--user_pass=${password}`,
    ]);
    if (exitCode !== 0 && !/already exists/i.test(stderr) && !/already exists/i.test(stdout)) {
      throw new Error(`wp user create failed: ${stderr.slice(0, 500)}`);
    }
    return { user: 'ferry-admin', password };
  }

  async deployFiles(clonePath: string): Promise<void> {
    const { baseUrl, secret } = this.sitedFor(clonePath);
    const tarball = await packTar(clonePath);
    const bodyHash = createHash('sha256').update(tarball).digest('hex');
    const headers = signedHeaders(secret, 'PUT', '/files', {}, bodyHash);
    headers['content-type'] = 'application/gzip';
    const res = await request(`${baseUrl}/files`, { method: 'PUT', headers, body: tarball });
    await ensureOk(res, 'PUT', '/files');
  }

  /** The agent's wp tool (Task 9) - not part of CloneEnv. */
  async runWp(clonePath: string, argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { baseUrl, secret } = this.sitedFor(clonePath);
    return (await postJson(baseUrl, secret, '/wp', { argv })) as { stdout: string; stderr: string; exitCode: number };
  }

  private sitedFor(clonePath: string): { baseUrl: string; secret: string } {
    const slug = basename(clonePath);
    const profile = loadProfile(slug);
    if (!profile.flySited) {
      throw new Error(`site "${slug}" has no Fly machine — pull/provision first`);
    }
    const { app, machineId, secret } = profile.flySited;
    return { baseUrl: this.sitedBaseUrl(app, machineId), secret };
  }
}

/** Unauthenticated single-shot check — sited's `/health` route needs no signature. */
async function healthOk(baseUrl: string): Promise<boolean> {
  try {
    const res = await request(`${baseUrl}/health`, { method: 'GET' });
    if (res.statusCode !== 200) return false;
    const text = await res.body.text();
    const data = text ? (JSON.parse(text) as { ok?: boolean }) : {};
    return data.ok === true;
  } catch {
    return false;
  }
}

/** Spike finding §3: first 6PN request lands in ~2s, so checking before ever sleeping
 *  keeps an already-healthy machine (or a fast-booting one) from waiting needlessly. */
async function waitForHealth(baseUrl: string, intervalMs: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await healthOk(baseUrl)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Bounded-attempt variant for the idempotency probe: a fixed retry count (not a wall-clock
 *  deadline) so one transient blip against an already-provisioned machine doesn't fall through
 *  to a doomed re-provision attempt (createApp on a still-live app throws). */
async function healthOkRetrying(baseUrl: string, attempts: number, intervalMs: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await healthOk(baseUrl)) return true;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /\b404\b/.test(err.message);
}

async function postJson(baseUrl: string, secret: string, path: string, payload: unknown): Promise<unknown> {
  const body = Buffer.from(JSON.stringify(payload));
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const headers = signedHeaders(secret, 'POST', path, {}, bodyHash);
  headers['content-type'] = 'application/json';
  const res = await request(`${baseUrl}${path}`, { method: 'POST', headers, body });
  return readJson(res, 'POST', path);
}

async function get(baseUrl: string, secret: string, path: string, query: Record<string, string>): Promise<unknown> {
  const bodyHash = createHash('sha256').update('').digest('hex');
  const headers = signedHeaders(secret, 'GET', path, query, bodyHash);
  const qs = new URLSearchParams(query).toString();
  const res = await request(`${baseUrl}${path}?${qs}`, { method: 'GET', headers });
  return readJson(res, 'GET', path);
}
