import type { ManifestEntry } from './client.js';

// Seam (§4.3): v0 fetches everything the manifest lists. Later, provenance
// (§2.14) replaces this single function with a hash-diff against official
// checksums - without touching the transfer layer.
export function resolve(entries: ManifestEntry[]): ManifestEntry[] {
  return entries;
}
