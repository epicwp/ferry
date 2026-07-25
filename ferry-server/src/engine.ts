import { join } from 'node:path';
import { request } from 'undici';
import { FerryClient } from '../../ferry-cli/src/client.js';
import { DdevEnv } from '../../ferry-cli/src/env/ddev.js';
import { link } from '../../ferry-cli/src/link.js';
import { ferryHome, loadProfile, slugFromUrl, type SiteInfo } from '../../ferry-cli/src/profile.js';
import { pull, type PullOpts, type PullResult } from '../../ferry-cli/src/pull.js';

export interface Engine {
  link(url: string, code: string): Promise<void>;
  pull(slug: string, opts: PullOpts): Promise<PullResult>;
  siteInfo(slug: string): Promise<SiteInfo>;
  verifyClone(url: string): Promise<boolean>;
  cloneUrl(slug: string): string;
}

export function realEngine(): Engine {
  const env = new DdevEnv();
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
      try {
        const res = await request(url, { maxRedirections: 3 });
        const body = await res.body.text();
        return res.statusCode === 200 && /<html/i.test(body);
      } catch {
        return false;
      }
    },
    cloneUrl(slug) {
      return env.url(slug);
    },
  };
}
