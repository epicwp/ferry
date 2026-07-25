import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Engine } from './engine.js';
import { authRoutes } from './routes/auth.js';
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
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
