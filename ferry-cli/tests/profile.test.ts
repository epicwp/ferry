import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProfile, profilePath, saveProfile, slugFromUrl } from '../src/profile.js';

describe('profile store', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ferry-'));
    process.env.FERRY_HOME = home;
  });

  afterEach(() => {
    delete process.env.FERRY_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('derives a filesystem-safe slug from the site url', () => {
    expect(slugFromUrl('https://www.wasgeurtje.nl')).toBe('wasgeurtje-nl');
    expect(slugFromUrl('https://blog.studiokraft.nl/')).toBe('blog-studiokraft-nl');
  });

  it('round-trips a profile as readable json', () => {
    const profile = {
      url: 'https://wasgeurtje.nl',
      secret: 'abc123',
      slug: 'wasgeurtje-nl',
      clonePath: join(home, 'clone'),
    };
    saveProfile(profile);
    expect(profilePath('wasgeurtje-nl')).toBe(join(home, 'sites', 'wasgeurtje-nl', 'profile.json'));
    expect(loadProfile('wasgeurtje-nl')).toEqual(profile);
  });

  it('fails with an actionable message for unknown sites', () => {
    expect(() => loadProfile('nope')).toThrowError(/ferry link/);
  });
});
