import type { FastifyInstance } from 'fastify';
import { slugFromUrl } from '../../../ferry-cli/src/profile.js';
import type { AppDeps } from '../app.js';
import type { Site } from '../store.js';

export function siteJson(site: Site): object {
  const { userId: _userId, ...rest } = site;
  return rest;
}

function parseSiteUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function siteRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/api/sites', { preHandler: app.requireUser }, async (request, reply) => {
    const { name, url: rawUrl } = (request.body ?? {}) as { name?: string; url?: string };
    const url = parseSiteUrl(rawUrl);
    if (!name || name.trim() === '') {
      return reply.code(400).send({ error: 'Give the site a name.' });
    }
    if (!url) {
      return reply.code(400).send({ error: 'Enter a valid http(s) site URL.' });
    }
    const site = deps.store.createSite(request.user.id, name.trim(), url, slugFromUrl(url));
    if (!site) {
      return reply.code(409).send({ error: 'This site is already registered on this server.' });
    }
    return reply.code(201).send(siteJson(site));
  });

  app.get('/api/sites', { preHandler: app.requireUser }, async (request) => {
    return deps.store.sitesFor(request.user.id).map(siteJson);
  });

  app.get('/api/sites/:id', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    return siteJson(site);
  });
}
