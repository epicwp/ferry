import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Engine } from './engine.js';
import { authRoutes } from './routes/auth.js';
import { siteRoutes } from './routes/sites.js';
import { syncRoutes } from './routes/sync.js';
import { SyncManager } from './sync.js';
import type { Store, User } from './store.js';

export const SESSION_COOKIE = 'ferry_session';

export interface AppDeps {
  store: Store;
  engine?: Engine;   // wired in Task 5
  pluginZip?: Buffer; // wired in Task 7
  staticDir?: string; // built dashboard (prod mode); dev uses the Vite proxy instead
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify();
  void app.register(cookie);

  // Registered for all application/json requests. Some routes (e.g. POST .../test,
  // .../sync) are called with that content-type but no body, which Fastify's default
  // parser rejects (FST_ERR_CTP_EMPTY_JSON_BODY); treat an empty/whitespace body as
  // "no body" instead. Any non-empty body is handed to Fastify's own default JSON
  // parser unchanged, so secure-json-parse (proto/constructor poisoning guards) and
  // the 400-on-malformed-JSON behavior are unaffected.
  const defaultJsonParser = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body: string, done) => {
    if (body.trim() === '') {
      done(null, undefined);
      return;
    }
    defaultJsonParser(request, body, done);
  });

  // Session gate for everything private. Routes opt in via { preHandler: app.requireUser }.
  const requireUser = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    const user = token ? deps.store.userForSession(token) : undefined;
    if (!user) {
      await reply.code(401).send({ error: 'Not signed in.' });
      return;
    }
    request.user = user;
  };
  app.decorate('requireUser', requireUser);

  authRoutes(app, deps);
  siteRoutes(app, deps);
  if (deps.engine) {
    syncRoutes(app, deps, new SyncManager(deps.store, deps.engine));
  }

  app.get('/api/plugin.zip', { preHandler: app.requireUser }, async (_request, reply) => {
    if (!deps.pluginZip) return reply.code(404).send({ error: 'Plugin artifact not available.' });
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', 'attachment; filename="ferry-connect.zip"')
      .send(deps.pluginZip);
  });

  if (deps.staticDir) {
    void app.register(fastifyStatic, { root: deps.staticDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html'); // SPA fallback: the router owns non-API paths
      }
      return reply.code(404).send({ error: 'Not found.' });
    });
  }

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
