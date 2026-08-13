import type { FastifyInstance } from 'fastify';
import { MultisiteError } from '../../../ferry-cli/src/link.js';
import { slugFromUrl } from '../../../ferry-cli/src/profile.js';
import { RateLimiter } from '../rate-limit.js';
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

  const engine = deps.engine;
  if (!engine) return; // app built without an engine (store-only tests)

  // Spec 6a §3.4: every pair attempt drives a real outbound HTTP request to the
  // operator-supplied site.url — cap the pump per site.
  const pairLimiter = new RateLimiter(5, 10 * 60_000);

  app.post('/api/sites/:id/pair', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    if (site.status !== 'new' && site.status !== 'refused_multisite') {
      return reply.code(409).send({ error: 'This site is already paired.' });
    }
    const { code } = (request.body ?? {}) as { code?: string };
    if (!code || code.trim() === '') {
      return reply.code(400).send({ error: 'Enter the pairing code shown by the plugin.' });
    }
    const retry = pairLimiter.hit(`pair:${site.id}`);
    if (retry !== null) {
      return reply.code(429).header('retry-after', String(retry)).send({ error: 'Too many pairing attempts. Try again later.' });
    }
    try {
      await engine.link(site.url, code.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof MultisiteError) {
        deps.store.setStatus(site.id, 'refused_multisite', { lastError: message });
        return reply.code(422).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
    deps.store.setStatus(site.id, 'paired', { lastError: null });
    return siteJson(deps.store.siteFor(request.user.id, site.id)!);
  });

  app.post('/api/sites/:id/test', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    if (site.status === 'new' || site.status === 'refused_multisite') {
      return reply.code(409).send({ error: 'Pair the site first.' });
    }
    try {
      const info = await engine.siteInfo(site.slug);
      return {
        wp: info.wp,
        php: info.php.version,
        db: `${info.db.server} ${info.db.version}`,
        server: info.server,
      };
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      if (message.includes('(403)')) {
        message += ' — is a security plugin blocking the ferry REST namespace?'; // spec §3.4
      }
      return reply.code(502).send({ error: message });
    }
  });
}
