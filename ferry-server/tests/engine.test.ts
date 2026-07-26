import { afterEach, describe, expect, it, vi } from 'vitest';
import { realEngine, type VerifyFetch } from '../src/engine.js';

function fakeResponse(statusCode: number, body: string): { statusCode: number; body: { text(): Promise<string> } } {
  return { statusCode, body: { text: async () => body } };
}

describe('realEngine().verifyClone', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns ok on the first 200+HTML response', async () => {
    const verifyFetch: VerifyFetch = vi.fn(async () => fakeResponse(200, '<html>hi</html>'));
    const engine = realEngine({ verifyFetch });
    await expect(engine.verifyClone('https://clone.test')).resolves.toEqual({ ok: true });
    expect(verifyFetch).toHaveBeenCalledTimes(1);
  });

  it('retries through transient 502s (DDEV restart window) and succeeds within budget', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const verifyFetch: VerifyFetch = vi.fn(async () => {
      calls++;
      return calls < 3 ? fakeResponse(502, '') : fakeResponse(200, '<html>ok</html>');
    });
    const engine = realEngine({ verifyFetch });
    const resultPromise = engine.verifyClone('https://clone.test');
    // two 2s polls stand between the first 502 and the eventual 200
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(resultPromise).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('reports a TLS trust failure immediately, naming the cause and the fix', async () => {
    const verifyFetch: VerifyFetch = vi.fn(async () => {
      throw new Error('unable to get local issuer certificate');
    });
    const engine = realEngine({ verifyFetch });
    const result = await engine.verifyClone('https://clone.test');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('local issuer');
    expect(result.detail).toContain('NODE_EXTRA_CA_CERTS');
    // no retry for a trust failure — it can't fix itself by waiting
    expect(verifyFetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after the 30s deadline, citing the last HTTP status', async () => {
    vi.useFakeTimers();
    const verifyFetch: VerifyFetch = vi.fn(async () => fakeResponse(502, ''));
    const engine = realEngine({ verifyFetch });
    const resultPromise = engine.verifyClone('https://clone.test');
    await vi.advanceTimersByTimeAsync(32_000);
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('502');
  });
});
