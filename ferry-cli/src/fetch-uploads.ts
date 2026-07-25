import { FerryClient } from './client.js';
import { loadProfile } from './profile.js';
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
  return {
    fetched: entries.length - skipped.length,
    bytes: entries.reduce((n, e) => n + e.size, 0),
    skipped,
  };
}
