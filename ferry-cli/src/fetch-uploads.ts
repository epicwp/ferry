import { join } from 'node:path';
import type { ManifestEntry } from './client.js';
import { FerryClient } from './client.js';
import { loadProfile } from './profile.js';
import { md5File } from './provenance/md5.js';
import { fetchAll, fetchManifest } from './transfer.js';

export interface FetchUploadsResult {
  fetched: number;
  bytes: number;
  skipped: string[];
}

/** §2.8 escape hatch, bulk edition: materialize production uploads into the clone. */
export async function fetchUploads(slug: string, opts: { prefix?: string; all?: boolean }): Promise<FetchUploadsResult> {
  if (!opts.all && !opts.prefix) {
    throw new Error('specify a prefix (e.g. ferry fetch-uploads mysite 2026/07/) or --all');
  }
  const profile = loadProfile(slug);
  const client = new FerryClient(profile.url, profile.secret);
  await client.syncClock();
  const query: Record<string, string> = { scope: 'uploads' };
  if (!opts.all && opts.prefix) {
    query.prefix = opts.prefix;
  }
  const entries = await fetchManifest(client, query);
  const { skipped } = await fetchAll(client, entries, profile.clonePath);

  // §5/§8 gate 4: hash-verify what landed on disk; re-fetch mismatches once before
  // giving up on them (folded into `skipped` - they were not delivered intact).
  const skippedSet = new Set(skipped);
  const verifiable = entries.filter((e) => e.hash !== null && !skippedSet.has(e.path));
  const mismatched = (
    await Promise.all(
      verifiable.map(async (e) => ((await md5File(join(profile.clonePath, e.path))) === e.hash ? null : e)),
    )
  ).filter((e): e is ManifestEntry => e !== null);
  if (mismatched.length > 0) {
    await fetchAll(client, mismatched, profile.clonePath);
    for (const e of mismatched) {
      if ((await md5File(join(profile.clonePath, e.path))) !== e.hash) {
        skipped.push(e.path);
      }
    }
  }

  return {
    fetched: entries.length - skipped.length,
    bytes: entries.reduce((n, e) => n + e.size, 0),
    skipped,
  };
}
