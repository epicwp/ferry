import { join } from 'node:path';
import { request } from 'undici';
import { FerryClient } from '../../ferry-cli/src/client.js';
import { DdevEnv } from '../../ferry-cli/src/env/ddev.js';
import { link } from '../../ferry-cli/src/link.js';
import { ferryHome, loadProfile, slugFromUrl, type SiteInfo } from '../../ferry-cli/src/profile.js';
import { pull, type PullOpts, type PullResult } from '../../ferry-cli/src/pull.js';
import { push as runPush, rollback as runRollback } from '../../ferry-cli/src/push.js';
import type { PushRunner } from './push/types.js';

export interface VerifyResult {
  ok: boolean;
  detail?: string;
}

export type VerifyFetch = (
  url: string,
  opts: { maxRedirections: number },
) => Promise<{ statusCode: number; body: { text(): Promise<string> } }>;

export interface Engine {
  link(url: string, code: string): Promise<void>;
  pull(slug: string, opts: PullOpts): Promise<PullResult>;
  siteInfo(slug: string): Promise<SiteInfo>;
  verifyClone(url: string): Promise<VerifyResult>;
  cloneUrl(slug: string): string;
}

export interface RealEngineOptions {
  verifyFetch?: VerifyFetch;
}

export function realEngine(opts: RealEngineOptions = {}): Engine {
  const env = new DdevEnv();
  const verifyFetch = opts.verifyFetch ?? request;
  return {
    async link(url, code) {
      // clone dirs live under the server's FERRY_HOME, not the operator's homedir
      await link(url, code, join(ferryHome(), 'clones', slugFromUrl(url)));
    },
    async pull(slug, opts) {
      return pull(slug, {}, opts);
    },
    async siteInfo(slug) {
      const profile = loadProfile(slug);
      const client = new FerryClient(profile.url, profile.secret);
      await client.syncClock();
      const { data } = await client.getJson('/ferry/v1/info');
      return data as SiteInfo;
    },
    async verifyClone(url) {
      // Spec §3.3: HTTP 200 with a non-empty HTML body, checked from the machine running the clone.
      // Retries through DDEV's ~5s restart window; a bounded loop, not an unbounded wait.
      const deadline = Date.now() + 30_000;
      let last = '';
      for (;;) {
        try {
          const res = await verifyFetch(url, { maxRedirections: 3 });
          const body = await res.body.text();
          if (res.statusCode === 200 && /<html/i.test(body)) return { ok: true };
          last = `HTTP ${res.statusCode}`;
        } catch (err) {
          last = err instanceof Error ? err.message : String(err);
          if (/certificate|CERT|issuer/i.test(last)) {
            return {
              ok: false,
              detail: `TLS trust failure: ${last}. The server process must start with NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" — it cannot be set after boot.`,
            };
          }
        }
        if (Date.now() >= deadline) return { ok: false, detail: `clone did not answer within 30s (last: ${last})` };
        await new Promise((r) => setTimeout(r, 2_000)); // DDEV's restart window is ~5s; 2s polls cover it
      }
    },
    cloneUrl(slug) {
      return env.url(slug);
    },
  };
}

/** Real PushRunner (Task 13): wraps ferry-cli's push()/rollback() (spec §8) and reads the
 *  plugin's tx status directly for boot recovery. */
export function realPushRunner(): PushRunner {
  return {
    async push(slug, spec, opts) {
      return runPush(slug, spec, { headSha: opts.headSha, force: opts.force, txid: opts.txid, onStep: opts.onStep });
    },
    async rollback(slug, opts) {
      return runRollback(slug, { txid: opts.txid, ops: opts.ops });
    },
    async txStatus(slug, txid) {
      const profile = loadProfile(slug);
      const client = new FerryClient(profile.url, profile.secret);
      await client.syncClock();
      const { data } = await client.getJson('/ferry/v1/tx', { txid });
      return data.status as 'committed' | 'dirty' | 'staged' | 'rolled_back' | 'unknown';
    },
  };
}
