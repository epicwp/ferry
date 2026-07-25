import type { ManifestEntry } from './client.js';
import { createWriteStream, promises as fsp } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import pLimit from 'p-limit';
import * as tar from 'tar';
import { FerryClient } from './client.js';

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

export const META_ENTRY = '.ferry-meta.json';
const RANGE_CHUNK = 4 * 1024 * 1024;

/** Tar writers may prefix entry names with './' - normalize before comparing. */
export function isMetaEntry(path: string): boolean {
  return path.replace(/^\.\//, '') === META_ENTRY;
}

export interface BatchMeta {
  complete: boolean;
  next_index: number;
  skipped: string[];
}

/** Extracts a batch; the trailing meta entry is read in-stream, never written to disk. */
export async function extractBatch(buffer: Buffer, destDir: string): Promise<BatchMeta> {
  let metaRaw = '';
  const parser = tar.t({
    onReadEntry: (entry) => {
      if (isMetaEntry(entry.path)) {
        entry.on('data', (c: Buffer) => (metaRaw += c.toString('utf8')));
      } else {
        entry.resume();
      }
    },
  });
  await pipeline(Readable.from(buffer), createGunzip(), parser as unknown as NodeJS.WritableStream);
  await pipeline(
    Readable.from(buffer),
    createGunzip(),
    tar.x({ cwd: destDir, filter: (p) => !isMetaEntry(p) }),
  );
  if (metaRaw === '') {
    throw new Error('file batch response is missing its .ferry-meta.json trailer');
  }
  return JSON.parse(metaRaw) as BatchMeta;
}

async function fetchBatch(client: FerryClient, paths: string[], destDir: string): Promise<string[]> {
  let remaining = paths;
  const skipped: string[] = [];
  while (remaining.length > 0) {
    const { stream } = await client.postStream('/ferry/v1/files', { paths: remaining });
    const chunks: Buffer[] = [];
    for await (const c of stream) {
      chunks.push(c as Buffer);
    }
    const meta = await extractBatch(Buffer.concat(chunks), destDir);
    skipped.push(...meta.skipped);
    if (meta.complete) {
      break;
    }
    if (!Number.isInteger(meta.next_index) || meta.next_index <= 0) {
      throw new Error('server made no progress on a file batch - aborting to avoid an infinite loop');
    }
    remaining = remaining.slice(meta.next_index);
  }
  return skipped;
}

/** §3.4: files larger than one batch come in raw 4MB ranges. */
async function fetchOversized(client: FerryClient, entry: { path: string; size: number }, destDir: string): Promise<void> {
  const destRoot = resolve(destDir);
  const dest = resolve(destDir, entry.path);
  if (!dest.startsWith(destRoot + sep)) {
    throw new Error(`refusing range write outside the clone: ${entry.path}`);
  }
  await fsp.mkdir(dirname(dest), { recursive: true });
  const out = createWriteStream(dest);
  let writeError: Error | null = null;
  out.on('error', (err) => { writeError = err; });
  for (let offset = 0; offset < entry.size; offset += RANGE_CHUNK) {
    if (writeError) throw writeError;
    const { stream } = await client.postStream('/ferry/v1/files', {
      path: entry.path,
      offset,
      length: Math.min(RANGE_CHUNK, entry.size - offset),
    });
    for await (const chunk of stream) {
      if (writeError) throw writeError;
      if (!out.write(chunk)) {
        // 'drain' never fires once the stream has errored, so also resolve on 'error'
        // (rather than reject) and let the writeError check above/below handle it.
        await new Promise<void>((resolve) => {
          const onDrain = () => { out.off('error', onError); resolve(); };
          const onError = () => { out.off('drain', onDrain); resolve(); };
          out.once('drain', onDrain);
          out.once('error', onError);
        });
      }
    }
  }
  if (writeError) throw writeError;
  out.end();
  await finished(out); // rejects on any stream error, including one already emitted
  if (writeError) {
    throw writeError;
  }
}

export async function fetchAll(
  client: FerryClient,
  entries: import('./client.js').ManifestEntry[],
  destDir: string,
  opts: { maxBytes?: number; concurrency?: number } = {},
): Promise<{ skipped: string[] }> {
  const { batches, oversized } = binPack(entries, opts.maxBytes ?? DEFAULT_BATCH_BYTES);
  const limit = pLimit(opts.concurrency ?? 4); // §3.4: more collides with per-account PHP process caps
  const skippedLists = await Promise.all(
    batches.map((b) => limit(() => fetchBatch(client, b.map((e) => e.path), destDir))),
  );
  await Promise.all(oversized.map((e) => limit(() => fetchOversized(client, e, destDir))));
  return { skipped: skippedLists.flat() };
}
