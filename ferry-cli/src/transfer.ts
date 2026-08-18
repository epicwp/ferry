import type { ManifestEntry } from './client.js';
import { createWriteStream, promises as fsp } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
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

const TRANSFER_RETRY_ATTEMPTS = 4;

/** Transport/stream failures a smothered shared-hosting connection produces mid-body -
 *  truncated gzip (zlib sets code Z_BUF_ERROR), undici's body/headers timeout or a reset/closed
 *  socket (all carry UND_ERR* codes), or a batch that lost its trailing meta entry. Checked by
 *  `.code` first (undici/zlib errors carry one; their `.message` text does not name the code),
 *  falling back to message substrings for errors that only surface as text. Security guards
 *  (e.g. the path-traversal refusal) are excluded first and must never loop. */
export function isTransferRetryable(err: unknown): boolean {
  const message =
    typeof (err as { message?: unknown })?.message === 'string' ? (err as { message: string }).message : String(err);
  if (message.includes('refusing')) {
    return false;
  }
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : undefined;
  if (code !== undefined && (code.startsWith('UND_ERR') || code === 'ECONNRESET' || code === 'Z_BUF_ERROR')) {
    return true;
  }
  return (
    message.includes('unexpected end of file') ||
    message.includes('other side closed') ||
    message.includes('ECONNRESET') ||
    message.includes('missing its .ferry-meta.json trailer')
  );
}

/** Thrown by withTransferRetry only when a *retryable* error survives every attempt - lets
 *  fetchBatch tell "give up, try something smaller" apart from a non-retryable error (e.g. the
 *  path-traversal guard), which must propagate immediately without splitting. */
class TransferExhaustedError extends Error {}

/** Retries a streaming fetch+consume unit up to TRANSFER_RETRY_ATTEMPTS times with exponential
 *  backoff when it fails with a transport/stream error; re-throws immediately otherwise. */
async function withTransferRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSFER_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransferRetryable(err)) {
        throw err;
      }
      lastError = err;
      if (attempt === TRANSFER_RETRY_ATTEMPTS) {
        break;
      }
      await sleep(500 * 2 ** attempt);
    }
  }
  throw new TransferExhaustedError(
    `${label}: still failing after ${TRANSFER_RETRY_ATTEMPTS} attempts (transport failure). Last error: ${String(lastError)}`,
  );
}

/** Fetches a group of files via the batch endpoint. Some shared hosts kill the plugin's PHP
 *  process mid-response once a batch's output crosses a CPU-seconds threshold - the response
 *  arrives cleanly closed but truncated, deterministically, so the per-request retry above
 *  cannot help. When a multi-path batch is still failing with a retryable error after
 *  exhausting that retry, split the path list in half and fetch each half independently
 *  (sequentially, not concurrently, so a struggling host isn't re-piled with parallel
 *  requests). This recurses and bottoms out at a single path: splitting stops there and falls
 *  back to the byte-range endpoint (fetchOversized) instead, which streams the one file in much
 *  smaller pieces. If even that fails after its own retries, the file is unrecoverable on this
 *  host and we throw a terminal error naming it. */
async function fetchBatch(client: FerryClient, entries: ManifestEntry[], destDir: string): Promise<string[]> {
  let remaining = entries;
  const skipped: string[] = [];
  while (remaining.length > 0) {
    let meta: BatchMeta;
    try {
      meta = await withTransferRetry('file batch fetch', async () => {
        const { stream } = await client.postStream('/ferry/v1/files', { paths: remaining.map((e) => e.path) });
        const chunks: Buffer[] = [];
        for await (const c of stream) {
          chunks.push(c as Buffer);
        }
        return extractBatch(Buffer.concat(chunks), destDir);
      });
    } catch (batchErr) {
      if (!(batchErr instanceof TransferExhaustedError)) {
        throw batchErr;
      }
      if (remaining.length > 1) {
        const mid = Math.ceil(remaining.length / 2);
        const first = remaining.slice(0, mid);
        const second = remaining.slice(mid);
        console.warn(
          `[ferry] file batch of ${remaining.length} truncated after retries - splitting into ${first.length} + ${second.length} and retrying`,
        );
        skipped.push(...(await fetchBatch(client, first, destDir)));
        skipped.push(...(await fetchBatch(client, second, destDir)));
        return skipped;
      }
      const entry = remaining[0];
      console.warn(
        `[ferry] ${entry.path} still truncates as a lone batch after retries - falling back to the byte-range endpoint`,
      );
      try {
        await fetchOversized(client, entry, destDir);
      } catch (rangeErr) {
        throw new Error(
          `${entry.path}: unrecoverable - failed on both the batch endpoint and the byte-range fallback after retries. ` +
            `The host is likely killing the request mid-response. Batch error: ${String(batchErr)}. Range error: ${String(rangeErr)}`,
        );
      }
      return skipped;
    }
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
    // Buffer the whole range chunk (<= RANGE_CHUNK, 4MB) before writing it: a retried attempt
    // re-fetches the same offset from scratch, and writing only after a full, successful fetch
    // keeps that retry idempotent (no partial-range bytes already landed in `out` to duplicate).
    const length = Math.min(RANGE_CHUNK, entry.size - offset);
    const chunkBuffer = await withTransferRetry(`oversized range fetch (${entry.path} @${offset})`, async () => {
      const { stream } = await client.postStream('/ferry/v1/files', { path: entry.path, offset, length });
      const parts: Buffer[] = [];
      for await (const chunk of stream) {
        parts.push(chunk as Buffer);
      }
      const buf = Buffer.concat(parts);
      // A short read with no stream error (connection closed clean but early) is still a
      // smothered range - fail it in a retryable-shaped way rather than write a truncated file.
      if (buf.length !== length) {
        throw new Error(
          `oversized range fetch got ${buf.length} of ${length} bytes for ${entry.path}@${offset} - other side closed early`,
        );
      }
      return buf;
    });
    if (writeError) throw writeError;
    if (!out.write(chunkBuffer)) {
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
  opts: { maxBytes?: number; concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ skipped: string[] }> {
  const { batches, oversized } = binPack(entries, opts.maxBytes ?? DEFAULT_BATCH_BYTES);
  const limit = pLimit(opts.concurrency ?? 4); // §3.4: more collides with per-account PHP process caps
  const total = entries.length;
  let done = 0;
  const skippedLists = await Promise.all(
    batches.map((b) =>
      limit(async () => {
        const skipped = await fetchBatch(client, b, destDir);
        done += b.length;
        opts.onProgress?.(done, total);
        return skipped;
      }),
    ),
  );
  await Promise.all(
    oversized.map((e) =>
      limit(async () => {
        await fetchOversized(client, e, destDir);
        done += 1;
        opts.onProgress?.(done, total);
      }),
    ),
  );
  return { skipped: skippedLists.flat() };
}

export async function fetchManifest(
  client: FerryClient,
  query: Record<string, string> = {},
): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  let after = 0;
  for (;;) {
    const { data, headers } = await client.getJson('/ferry/v1/manifest', { ...query, after: String(after) });
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
