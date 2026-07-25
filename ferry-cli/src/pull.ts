import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { FerryClient, type ManifestEntry } from './client.js';
import { LITE_SKIP, pullDatabase } from './db.js';
import { DdevEnv, type CloneEnv } from './env/ddev.js';
import { applyOverlay, finalizeClone } from './overlay.js';
import { ferryHome, loadProfile, saveProfile, type SiteInfo } from './profile.js';
import { resolve } from './resolve.js';
import { cleanTmp } from './provenance/cache.js';
import { reconstruct } from './provenance/reconstruct.js';
import { buildReport, summarize, writeReport } from './provenance/report.js';
import type { WporgEndpoints } from './provenance/wporg.js';
import { commitProduction, ensureRepo, neutralizeNestedGit, writeClaudeMd, writeGitignore } from './git.js';
import { fetchAll } from './transfer.js';

export interface PullDeps { env?: CloneEnv; wporg?: WporgEndpoints; cacheDir?: string }

export interface PullOpts { full?: boolean }

export interface PullResult {
  url: string;
  adminUser: string;
  adminPassword: string;
  skipped: string[];
  commit: string;
  neutralizedRepos: number;
  liteSkip: string[];
  provenance: { reportPath: string; summary: string; reused: number; reconstructed: number; fetched: number };
}

/** The §4.6 flow. DDEV provisioning starts early and is awaited late ("join"). */
export async function pull(slug: string, deps: PullDeps = {}, opts: PullOpts = {}): Promise<PullResult> {
  const env = deps.env ?? new DdevEnv();
  const profile = loadProfile(slug);
  const client = new FerryClient(profile.url, profile.secret);
  await client.syncClock();

  const { data: info } = (await client.getJson('/ferry/v1/info')) as { data: SiteInfo };
  if (info.multisite) {
    throw new Error('This site is a multisite install. Ferry refuses multisite by design - single sites only for now.');
  }
  profile.info = info;
  saveProfile(profile);

  const docroot = profile.clonePath;
  await fsp.mkdir(docroot, { recursive: true });
  await applyOverlay(docroot, info, env.url(slug));       // phase 1: files DDEV needs at boot
  const envReady = env.provision(docroot, info, slug);    // boots while the transport runs
  envReady.catch(() => {});                               // surfaced at the await below

  const cacheDir = deps.cacheDir ?? join(ferryHome(), 'cache');
  cleanTmp(cacheDir);
  const manifest = await fetchManifest(client);
  const plan = await resolve(manifest, info, { docroot, cacheDir, wporg: deps.wporg });
  const report = buildReport(plan.evidence, plan.unverified);
  const reportPath = writeReport(slug, report);
  const [fetched, rec] = await Promise.all([
    fetchAll(client, plan.fetch, docroot),
    reconstruct(plan.reconstruct, docroot),
  ]);
  const skipped = [...fetched.skipped];
  if (rec.failed.length > 0) {
    // cache let us down (corruption): demote to the bucket that always works
    const byPath = new Map(manifest.map((e) => [e.path, e]));
    const retry = rec.failed.map((f) => byPath.get(f.path)).filter((e): e is ManifestEntry => e !== undefined);
    skipped.push(...(await fetchAll(client, retry, docroot)).skipped);
  }
  await finalizeClone(docroot, info);                     // phase 2: drop-ins arrived with the pull

  // Git substrate: neutralize nested repos BEFORE init so git never treats one as a submodule,
  // then commit the WP-root tree as a `production` snapshot (DB stays outside git).
  const neutralized = await neutralizeNestedGit(docroot);
  await ensureRepo(docroot);
  await writeGitignore(docroot);
  await writeClaudeMd(docroot);
  const commit = await commitProduction(docroot, manifest.map((e) => e.path), 'ferry: production snapshot');

  const liteSkip = opts.full ? [] : LITE_SKIP;
  const dump = await pullDatabase(client, join(ferryHome(), 'sites', slug, 'db-dump'), liteSkip);

  await envReady;                                         // join (§4.6)
  await env.importDb(docroot, dump);
  const admin = await env.createAdmin(docroot);
  return {
    url: env.url(slug),
    adminUser: admin.user,
    adminPassword: admin.password,
    skipped,
    commit,
    neutralizedRepos: neutralized.length,
    liteSkip,
    provenance: {
      reportPath,
      summary: summarize(report),
      reused: plan.reuse.length,
      reconstructed: plan.reconstruct.length - rec.failed.length,
      fetched: plan.fetch.length + rec.failed.length,
    },
  };
}

async function fetchManifest(client: FerryClient): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  let after = 0;
  for (;;) {
    const { data, headers } = await client.getJson('/ferry/v1/manifest', { after: String(after) });
    entries.push(...(data.files as ManifestEntry[]));
    if (headers['x-complete'] === '1') {
      return entries;
    }
    const next = Number(headers['x-next-index']);
    if (!Number.isFinite(next) || next <= after) {
      throw new Error('manifest made no progress - aborting');
    }
    after = next;
  }
}
