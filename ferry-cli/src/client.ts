import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { request, type Dispatcher } from 'undici';
import { sign } from './signing.js';

export interface ManifestEntry {
  path: string;
  size: number;
  hash: string | null;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

export class FerryClient {
  private clockOffsetMs = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  /** §4.5: shared hosts drift minutes off; derive server time from the Date header. */
  async syncClock(): Promise<void> {
    const res = await request(new URL('/wp-json/', this.baseUrl));
    await res.body.text();
    const date = res.headers['date'];
    if (typeof date === 'string' && !Number.isNaN(Date.parse(date))) {
      this.clockOffsetMs = Date.parse(date) - Date.now();
    }
  }

  async getJson(
    route: string,
    query: Record<string, string> = {},
  ): Promise<{ data: any; headers: IncomingHttpHeaders }> {
    const res = await this.send('GET', route, query, '');
    const text = await res.body.text();
    if (res.statusCode !== 200) {
      throw new Error(`GET ${route} failed (${res.statusCode}): ${text.slice(0, 300)}`);
    }
    return { data: JSON.parse(text), headers: res.headers as IncomingHttpHeaders };
  }

  async getBuffer(
    route: string,
    query: Record<string, string> = {},
  ): Promise<{ buffer: Buffer; headers: IncomingHttpHeaders }> {
    const res = await this.send('GET', route, query, '');
    const buffer = Buffer.from(await res.body.arrayBuffer());
    if (res.statusCode !== 200) {
      throw new Error(`GET ${route} failed (${res.statusCode}): ${buffer.toString('utf8', 0, 300)}`);
    }
    return { buffer, headers: res.headers as IncomingHttpHeaders };
  }

  async postJson(route: string, body: unknown): Promise<{ data: any; headers: IncomingHttpHeaders }> {
    const raw = JSON.stringify(body);
    const res = await this.send('POST', route, {}, raw);
    const text = await res.body.text();
    if (res.statusCode !== 200) {
      throw new Error(`POST ${route} failed (${res.statusCode}): ${text.slice(0, 300)}`);
    }
    return { data: JSON.parse(text), headers: res.headers as IncomingHttpHeaders };
  }

  async postStream(
    route: string,
    body: unknown,
  ): Promise<{ stream: Readable; headers: IncomingHttpHeaders; statusCode: number }> {
    const raw = JSON.stringify(body);
    // §hardening: shared hosting can smother a PHP response mid-stream; a tight body timeout
    // turns that into a fast, retryable failure instead of undici's 300s default stall. 120s
    // (not 60s) because SiteGround-style CPU throttling can stall a still-alive stream for
    // tens of seconds between flushes - 60s risked aborting a slow-but-alive transfer.
    const res = await this.send('POST', route, {}, raw, { headersTimeout: 30_000, bodyTimeout: 120_000 });
    if (res.statusCode !== 200) {
      const text = await res.body.text();
      throw new Error(`POST ${route} failed (${res.statusCode}): ${text.slice(0, 300)}`);
    }
    return {
      stream: res.body as unknown as Readable,
      headers: res.headers as IncomingHttpHeaders,
      statusCode: res.statusCode,
    };
  }

  private async send(
    method: 'GET' | 'POST',
    route: string,
    query: Record<string, string>,
    body: string,
    requestOpts?: Pick<Dispatcher.RequestOptions, 'headersTimeout' | 'bodyTimeout'>,
  ): Promise<Dispatcher.ResponseData> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const timestamp = Math.floor((Date.now() + this.clockOffsetMs) / 1000);
      const nonce = randomBytes(16).toString('hex'); // fresh per attempt: a retried request must not replay its own nonce
      const url = new URL(`/wp-json${route}`, this.baseUrl);
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
      let res: Dispatcher.ResponseData;
      try {
        res = await request(url, {
          method,
          body: body === '' ? undefined : body,
          headers: {
            ...(body === '' ? {} : { 'content-type': 'application/json' }),
            'x-ferry-timestamp': String(timestamp),
            'x-ferry-nonce': nonce,
            'x-ferry-signature': sign(this.secret, method, route, query, body, timestamp, nonce),
          },
          ...requestOpts,
        });
      } catch (err) {
        lastError = err;
        if (attempt === MAX_ATTEMPTS) {
          break;
        }
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (RETRYABLE.has(res.statusCode)) {
        const text = await res.body.text();
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(
            `${method} ${route}: still failing with HTTP ${res.statusCode} after ${MAX_ATTEMPTS} attempts. ` +
              `If a security plugin (e.g. Wordfence) runs on the site, allowlist the /wp-json/ferry/v1 namespace. ` +
              `Last response: ${text.slice(0, 300)}`,
          );
        }
        const retryAfter = Number(res.headers['retry-after']);
        const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await sleep(delay);
        continue;
      }
      return res;
    }
    throw new Error(
      `${method} ${route}: request failed after ${MAX_ATTEMPTS} attempts. ` +
        `If a security plugin (e.g. Wordfence) runs on the site, allowlist the /wp-json/ferry/v1 namespace. ` +
        `Last error: ${String(lastError)}`,
    );
  }
}
