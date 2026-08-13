import type { FastifyInstance } from 'fastify';
import type { Lifecycle } from './lifecycle.js';
import type { Store } from './store.js';

export const PUSH_DRAIN_MS = 10_000;   // an in-flight push/rollback gets this long to finish
export const HARD_DEADLINE_MS = 15_000; // main.ts force-exits after this, whatever happens

/**
 * Drain order (spec 6a §3.3): refuse new work (Lifecycle flag — routes already 503),
 * end SSE via the registry (app.close() cannot see hijacked sockets), wait bounded for
 * an in-flight push/rollback (the two-phase-commit window is the one thing worth
 * draining), then close listener and store. Syncs and agent turns are NOT awaited —
 * they are resumable by design and boot recovery already handles them.
 */
export async function gracefulShutdown(opts: {
  app: FastifyInstance;
  store: Store;
  lifecycle: Lifecycle;
  pushDrainMs?: number;
}): Promise<void> {
  const { app, store, lifecycle } = opts;
  const drainMs = opts.pushDrainMs ?? PUSH_DRAIN_MS;
  lifecycle.shuttingDown = true;
  lifecycle.closeAllSse();
  const start = Date.now();
  while (lifecycle.pushBusy() && Date.now() - start < drainMs) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await app.close();
  store.close();
}
