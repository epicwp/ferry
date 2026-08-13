import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Lifecycle } from '../src/lifecycle.js';
import { gracefulShutdown } from '../src/shutdown.js';
import { makeApp, signup, stubEngine } from './helpers/testApp.js';

describe('gracefulShutdown', () => {
  it('ends open SSE streams with a shutdown frame, then closes the listener and store', async () => {
    const lifecycle = new Lifecycle();
    const { app, store } = makeApp({ engine: stubEngine(), lifecycle });
    const cookie = await signup(app);
    const created = await app.inject({ method: 'POST', url: '/api/sites', headers: { cookie }, payload: { name: 'S', url: 'https://example.com' } });
    const siteId = created.json().id as number;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    let received = '';
    const socketClosed = new Promise<void>((resolve) => {
      const req = get(
        { host: '127.0.0.1', port, path: `/api/sites/${siteId}/sync/events`, headers: { cookie } },
        (res) => {
          res.on('data', (chunk: Buffer) => { received += chunk.toString(); });
          res.on('end', resolve);
          res.on('close', resolve);
        },
      );
      req.on('error', () => resolve());
    });
    // wait until the SSE handshake delivered the snapshot frame
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => { if (received.includes('data:')) { clearInterval(poll); resolve(); } }, 20);
    });

    await gracefulShutdown({ app, store, lifecycle });

    await socketClosed;
    expect(received).toContain('event: shutdown');
    // store is closed — any query now throws
    expect(() => store.purgeExpiredSessions()).toThrow();
  }, 15_000);

  it('waits for an in-flight push up to pushDrainMs', async () => {
    const lifecycle = new Lifecycle();
    const { app, store } = makeApp({ lifecycle });
    let busy = true;
    lifecycle.pushBusy = () => busy;
    setTimeout(() => { busy = false; }, 500);
    const start = Date.now();
    await gracefulShutdown({ app, store, lifecycle, pushDrainMs: 5_000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(4_000); // returned when the push finished, not at the deadline
  });
});
