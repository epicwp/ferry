import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Process-lifecycle seam (spec 6a §3.3). buildApp decorates the instance onto the app;
 * gracefulShutdown() flips the flag, drains SSE through the registry, and waits on pushBusy.
 * Hijacked SSE sockets are invisible to app.close() — this registry is the only handle.
 */
export class Lifecycle {
  shuttingDown = false;
  /** Overwritten by buildApp when a PushManager exists. */
  pushBusy: () => boolean = () => false;
  private sse = new Set<() => void>();

  registerSse(end: () => void): () => void {
    this.sse.add(end);
    return () => this.sse.delete(end);
  }

  closeAllSse(): void {
    for (const end of [...this.sse]) {
      try {
        end();
      } catch (err) {
        console.error('SSE shutdown close failed:', err);
      }
    }
    this.sse.clear();
  }
}

/** Extra preHandler for routes that START work (sync/push/rollback/retry/agent/pair). */
export function refuseDuringShutdown(lifecycle: Lifecycle) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (lifecycle.shuttingDown) {
      await reply.code(503).send({ error: 'Server is shutting down.' });
    }
  };
}
