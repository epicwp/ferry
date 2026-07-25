import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from 'undici';
import { saveProfile, slugFromUrl, type SiteProfile } from './profile.js';

export class MultisiteError extends Error {}

export async function link(url: string, code: string, dir?: string): Promise<SiteProfile> {
  const res = await request(new URL('/wp-json/ferry/v1/pair', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = (await res.body.json()) as { secret?: string; code?: string; message?: string };
  if (res.statusCode !== 200 || !data.secret) {
    if (data.code === 'ferry_multisite') {
      throw new MultisiteError('This site is a multisite install. Ferry refuses multisite by design - single sites only for now.');
    }
    throw new Error(data.message ?? `Pairing failed (${res.statusCode}).`);
  }
  const slug = slugFromUrl(url);
  const profile: SiteProfile = {
    url,
    secret: data.secret,
    slug,
    clonePath: dir ?? join(homedir(), 'ferry-sites', slug),
  };
  saveProfile(profile);
  return profile;
}
