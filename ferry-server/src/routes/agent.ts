import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { AgentManager } from '../agent/manager.js';
import type { AgentWireEvent } from '../agent/types.js';
import type { SyncManager } from '../sync.js';

const MESSAGE_MAX = 4000;

export function agentRoutes(app: FastifyInstance, deps: AppDeps, agents: AgentManager, sync: SyncManager): void {
  app.post('/api/sites/:id/agent/messages', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    if (site.status !== 'ready') return reply.code(409).send({ error: 'Sync the site first.' });
    if (sync.isRunning(site.id)) return reply.code(409).send({ error: 'A sync is running for this site.' });
    const text = String((request.body as { text?: unknown } | undefined)?.text ?? '').trim();
    if (text === '' || text.length > MESSAGE_MAX) {
      return reply.code(400).send({ error: `Message must be 1–${MESSAGE_MAX} characters.` });
    }
    await agents.send(site, text);
    return reply.code(202).send({ queued: true });
  });

  app.post('/api/sites/:id/agent/sessions', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    await agents.newSession(site);
    return reply.send({ created: true });
  });

  app.get('/api/sites/:id/agent/history', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    const after = Number((request.query as { after?: string }).after ?? 0) || 0;
    const session = deps.store.currentAgentSession(site.id);
    if (!session) return reply.send({ sessionId: null, events: [] });
    const events: AgentWireEvent[] = deps.store.agentEventsAfter(session.id, after)
      .map((row) => ({ seq: row.seq, type: row.type, payload: row.payload }));
    return reply.send({ sessionId: session.id, events });
  });

  app.get('/api/sites/:id/agent/events', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    const after = Number((request.query as { after?: string }).after ?? 0) || 0;

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (e: AgentWireEvent): void => { reply.raw.write(`data: ${JSON.stringify(e)}\n\n`); };

    // Subscribe first and buffer, then replay the store, then flush — no gap, no duplicates.
    let replaying = true;
    let lastSeq = after;
    const buffer: AgentWireEvent[] = [];
    const unsubscribe = agents.subscribe(site.id, (e) => {
      if (replaying) buffer.push(e);
      else send(e);
    });
    const session = deps.store.currentAgentSession(site.id);
    if (session) {
      for (const row of deps.store.agentEventsAfter(session.id, after)) {
        send({ seq: row.seq, type: row.type, payload: row.payload });
        lastSeq = row.seq;
      }
    }
    replaying = false;
    for (const e of buffer) {
      if (e.seq === undefined || e.seq > lastSeq) send(e);
    }

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
