import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import type { AgentManager } from '../agent/manager.js';
import type { PushManager, PushWireEvent } from '../push-manager.js';
import type { Conflict } from '../push/types.js';
import type { Change, ChangeStatus } from '../store.js';
import type { SyncManager } from '../sync.js';

/** Plain-text conflict table for the retry route - readable by both the human and the agent
 *  it gets sent to (which has no structured-JSON tool for reading conflict_json). */
function conflictMessage(change: Change): string {
  const rows = (change.conflict ?? []).map((c: Conflict) => `${c.key} | ${c.expected} | ${c.found}`);
  const table = ['key | expected | found', '--- | --- | ---', ...rows].join('\n');
  return `The push for "${change.title}" hit a conflict — production drifted since this change was drafted:\n\n${table}\n\nPlease investigate the drift and create a new change.`;
}

export function changesRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  push: PushManager,
  sync: SyncManager,
  agents?: AgentManager,
): void {
  app.get('/api/sites/:id/changes', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    const status = (request.query as { status?: string }).status as ChangeStatus | undefined;
    return reply.send({ changes: deps.store.changesFor(site.id, status) });
  });

  app.get('/api/sites/:id/changes/:seq', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    const seq = Number((request.params as { seq: string }).seq);
    const change = deps.store.changeBySeq(site.id, seq);
    if (!change) return reply.code(404).send({ error: 'Change not found.' });
    return reply.send(change);
  });

  app.post('/api/sites/:id/changes/:seq/push', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    const seq = Number((request.params as { seq: string }).seq);
    const change = deps.store.changeBySeq(site.id, seq);
    if (!change) return reply.code(404).send({ error: 'Change not found.' });
    // Same guard trio as sync.ts: sync running, agent mid-turn, another push already running.
    if (sync.isRunning(site.id)) return reply.code(409).send({ error: 'A sync is running for this site.' });
    if (agents?.isActive(site.id)) {
      return reply.code(409).send({ error: 'The agent is working on this site — finish or start a new session first.' });
    }
    if (change.status !== 'draft') return reply.code(409).send({ error: 'Only a draft change can be pushed.' });
    const force = !!(request.body as { force?: boolean } | undefined)?.force;
    try {
      push.start(site, change, { force });
    } catch (err) {
      if (err instanceof Error && err.message === 'busy') {
        return reply.code(409).send({ error: 'A push is already running for this site.' });
      }
      throw err;
    }
    return reply.code(202).send({ started: true });
  });

  app.post('/api/sites/:id/changes/:seq/rollback', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    const seq = Number((request.params as { seq: string }).seq);
    const change = deps.store.changeBySeq(site.id, seq);
    if (!change) return reply.code(404).send({ error: 'Change not found.' });
    // A rollback is itself a write-back call to the plugin - refuse it while another push (or
    // boot recovery) is already talking to the same site's plugin instance.
    if (push.isPushing(site.id)) return reply.code(409).send({ error: 'A push is already running for this site.' });
    // A second rollback of an already-rolled-back change wedges the plugin tx to dirty
    // (known bookkeeping gap) - refuse anything but exactly 'pushed'.
    if (change.status !== 'pushed') return reply.code(409).send({ error: 'Only a pushed change can be rolled back.' });
    await push.rollback(site, change);
    return reply.send({ rolledBack: true });
  });

  app.post('/api/sites/:id/changes/:seq/discard', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    const seq = Number((request.params as { seq: string }).seq);
    const change = deps.store.changeBySeq(site.id, seq);
    if (!change) return reply.code(404).send({ error: 'Change not found.' });
    if (change.status !== 'draft') return reply.code(409).send({ error: 'Only a draft change can be discarded.' });
    deps.store.setChangeStatus(change.id, 'discarded');
    return reply.send({ discarded: true });
  });

  app.post('/api/sites/:id/changes/:seq/retry', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    const seq = Number((request.params as { seq: string }).seq);
    const change = deps.store.changeBySeq(site.id, seq);
    if (!change) return reply.code(404).send({ error: 'Change not found.' });
    // Same guard trio as the agent message route: a retry opens an agent turn, which must not
    // start while a sync is running, while the site's plugin instance is mid-push, or before
    // the site has ever finished a sync (agents.send needs a ready clone to work from).
    if (sync.isRunning(site.id)) return reply.code(409).send({ error: 'A sync is running for this site.' });
    if (push.isPushing(site.id)) return reply.code(409).send({ error: 'A push is in progress for this site.' });
    if (site.status !== 'ready') return reply.code(409).send({ error: 'Sync the site first.' });
    if (change.status !== 'conflict') return reply.code(409).send({ error: 'Only a conflicted change can be retried.' });
    if (!agents) return reply.code(409).send({ error: 'Agent chat is not available.' });
    await agents.send(site, conflictMessage(change));
    return reply.code(202).send({ queued: true });
  });

  app.get('/api/sites/:id/push/events', { preHandler: app.requireUser }, async (request, reply) => {
    const site = deps.store.siteFor(request.user.id, Number((request.params as { id: string }).id));
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    const after = Number((request.query as { after?: string }).after ?? 0) || 0;

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (e: PushWireEvent): void => { reply.raw.write(`data: ${JSON.stringify(e)}\n\n`); };

    // Subscribe first and buffer, then replay this run's events, then flush — no gap, no duplicates.
    let replaying = true;
    let lastSeq = after;
    const buffer: PushWireEvent[] = [];
    const unsubscribe = push.subscribe(site.id, (e) => {
      if (replaying) buffer.push(e);
      else send(e);
    });
    for (const e of push.eventsAfter(site.id, after)) {
      send(e);
      lastSeq = e.seq;
    }
    replaying = false;
    for (const e of buffer) {
      if (e.seq > lastSeq) send(e);
    }

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
