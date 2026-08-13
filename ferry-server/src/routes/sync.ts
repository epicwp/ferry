import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { hasUncommittedAgentWork } from '../agent/branch.js';
import type { AgentManager } from '../agent/manager.js';
import { refuseDuringShutdown } from '../lifecycle.js';
import type { PushManager } from '../push-manager.js';
import type { SyncManager } from '../sync.js';

export function syncRoutes(app: FastifyInstance, deps: AppDeps, sync: SyncManager, agents?: AgentManager, push?: PushManager): void {
  app.post('/api/sites/:id/sync', { preHandler: [app.requireUser, refuseDuringShutdown(app.lifecycle)] }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    if (site.status === 'new' || site.status === 'refused_multisite') {
      return reply.code(409).send({ error: 'Pair the site first.' });
    }
    if (agents?.isActive(site.id)) {
      return reply.code(409).send({ error: 'The agent is working on this site — finish or start a new session first.' });
    }
    if (push?.isPushing(site.id)) {
      return reply.code(409).send({ error: 'A push is in progress for this site.' });
    }
    if (deps.agent && await hasUncommittedAgentWork(deps.agent.cloneDir(site.slug))) {
      return reply.code(409).send({ error: 'The agent has uncommitted work — ask it to commit, or start a new session first.' });
    }
    try {
      sync.start(site);
    } catch (err) {
      if (err instanceof Error && err.message === 'already_syncing') {
        return reply.code(409).send({ error: 'A sync is already running for this site.' });
      }
      throw err;
    }
    return reply.code(202).send({ started: true });
  });

  app.get('/api/sites/:id/sync/events', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const unsubscribe = sync.subscribe(site, (state) => {
      reply.raw.write(`data: ${JSON.stringify(state)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    const unregister = app.lifecycle.registerSse(() => {
      clearInterval(heartbeat);
      unsubscribe();
      try {
        // Named event: browser EventSource onmessage ignores it — no dashboard change.
        reply.raw.write('event: shutdown\ndata: {}\n\n');
      } catch {
        // socket already gone
      }
      reply.raw.end();
    });
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      unregister();
    });
  });
}
