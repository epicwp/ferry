// Filled in by the pairing task; the interface exists first so app wiring can reference it.
export interface Engine {
  link(url: string, code: string): Promise<void>;
  pull(slug: string, opts: import('../../ferry-cli/src/pull.js').PullOpts): Promise<import('../../ferry-cli/src/pull.js').PullResult>;
  siteInfo(slug: string): Promise<import('../../ferry-cli/src/profile.js').SiteInfo>;
  verifyClone(url: string): Promise<boolean>;
  cloneUrl(slug: string): string;
}
