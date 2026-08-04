import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AgentManager } from './agent/manager.js';
import type { AgentRunner } from './agent/types.js';
import type { Engine } from './engine.js';
import { PushManager } from './push-manager.js';
import type { ChangeSpec, PushRunner } from './push/types.js';
import { agentRoutes } from './routes/agent.js';
import { authRoutes } from './routes/auth.js';
import { changesRoutes } from './routes/changes.js';
import { siteRoutes } from './routes/sites.js';
import { syncRoutes } from './routes/sync.js';
import { SyncManager } from './sync.js';
import type { Change, Store, User } from './store.js';

export const SESSION_COOKIE = 'ferry_session';

export interface AppDeps {
  store: Store;
  engine?: Engine;   // wired in Task 5
  pluginZip?: Buffer; // wired in Task 7
  staticDir?: string; // built dashboard (prod mode); dev uses the Vite proxy instead
  agent?: {
    runner: AgentRunner;
    cloneDir: (slug: string) => string;
    ensureBranch: (cloneDir: string) => Promise<void>;
    idleMs?: number;
    // Passthroughs for the /changes routes (Task 13) to consume from `deps` directly —
    // main.ts wires the real ones (ChangeService/journalCandidates); tests inject fakes.
    journalCandidates?: (slug: string) => Promise<unknown>;
    createChange?: (slug: string, input: Record<string, unknown>) => Promise<unknown>;
    // main.ts's sdkRunner() is built before the AgentManager exists (it's constructed below,
    // from the already-built runner) - this hands the instance back once it does, so a
    // createChange override built ahead of time can reach appendSystemEvent for live SSE.
    onManagerReady?: (agents: AgentManager) => void;
  };
  push?: {
    runner: PushRunner;
  };
}

function specFor(change: Change): ChangeSpec {
  return { files: change.files, ops: change.ops, preconditions: change.preconditions, smoke: change.smoke };
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
    const sync = new SyncManager(deps.store, deps.engine);
    const agents = deps.agent
      ? new AgentManager(deps.store, deps.agent.runner, {
          cloneDir: deps.agent.cloneDir,
          ensureBranch: deps.agent.ensureBranch,
          idleMs: deps.agent.idleMs,
        })
      : undefined;
    if (agents) deps.agent?.onManagerReady?.(agents);
    const push = deps.push ? new PushManager(deps.store, deps.push.runner, { specFor }) : undefined;
    if (push) void push.recover().catch((err) => console.error('push recovery failed:', err));
    syncRoutes(app, deps, sync, agents, push);
    if (agents) agentRoutes(app, deps, agents, sync, push);
    if (push) changesRoutes(app, deps, push, sync, agents);
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
