import cookie from '@fastify/cookie';
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
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify();
  void app.register(cookie);

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

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
