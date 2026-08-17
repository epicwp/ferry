import { join } from 'node:path';
import { Agent, interceptors, request } from 'undici';
import { FerryClient } from '../../ferry-cli/src/client.js';
import { DdevEnv, type CloneEnv } from '../../ferry-cli/src/env/ddev.js';
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
  destroyClone(slug: string): Promise<void>;
}

export interface RealEngineOptions {
  verifyFetch?: VerifyFetch;
  env?: CloneEnv; // clone substrate; defaults to DDEV (local dev)
}

// Private dispatcher pinned to this module, like wporg.ts's redirectAgent: the
// process-global dispatcher (Symbol.for registry) is shared with every undici copy in
// the process — node's bundled v7 can claim it via an early fetch() and rejects the v6
// maxRedirections request option outright, failing every verifyClone attempt.
const verifyAgent = new Agent().compose(interceptors.redirect({ maxRedirections: 3 }));
const defaultVerifyFetch: VerifyFetch = (url) => request(url, { dispatcher: verifyAgent });

export function realEngine(opts: RealEngineOptions = {}): Engine {
  const env = opts.env ?? new DdevEnv();
  const verifyFetch = opts.verifyFetch ?? defaultVerifyFetch;
  return {
    async link(url, code) {
      // clone dirs live under the server's FERRY_HOME, not the operator's homedir
      await link(url, code, join(ferryHome(), 'clones', slugFromUrl(url)));
    },
    async pull(slug, opts) {
      return pull(slug, { env }, opts);
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
            const hint = url.includes('.ddev.site')
              ? ' The server process must start with NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" — it cannot be set after boot.'
              : '';
            return { ok: false, detail: `TLS trust failure: ${last}.${hint}` };
          }
        }
        if (Date.now() >= deadline) return { ok: false, detail: `clone did not answer within 30s (last: ${last})` };
        await new Promise((r) => setTimeout(r, 2_000)); // DDEV's restart window is ~5s; 2s polls cover it
      }
    },
    cloneUrl(slug) {
      return env.url(slug);
    },
    async destroyClone(slug) {
      await env.destroy(slug);
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
    async hashes(slug, paths) {
      const profile = loadProfile(slug);
      const client = new FerryClient(profile.url, profile.secret);
      await client.syncClock();
      const { data } = await client.postJson('/ferry/v1/hashes', { paths });
      return data.hashes as Record<string, string | null>;
    },
  };
}
