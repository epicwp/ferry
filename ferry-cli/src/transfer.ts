import type { ManifestEntry } from './client.js';

export const DEFAULT_BATCH_BYTES = 8 * 1024 * 1024; // §3.2: ~8MB batches

export function binPack(
  entries: ManifestEntry[],
  maxBytes = DEFAULT_BATCH_BYTES,
): { batches: ManifestEntry[][]; oversized: ManifestEntry[] } {
  const batches: ManifestEntry[][] = [];
  const oversized: ManifestEntry[] = [];
  let current: ManifestEntry[] = [];
  let bytes = 0;
  for (const e of entries) {
    if (e.size > maxBytes) {
      oversized.push(e);
      continue;
    }
    if (bytes + e.size > maxBytes && current.length > 0) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(e);
    bytes += e.size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return { batches, oversized };
}
