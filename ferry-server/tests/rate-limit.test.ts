import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit.js';

describe('RateLimiter (fixed window)', () => {
  it('allows max hits, refuses beyond with a retry-after, and rolls the window', () => {
    const rl = new RateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(rl.hit('k', t0)).toBeNull();
    expect(rl.hit('k', t0 + 1)).toBeNull();
    expect(rl.hit('k', t0 + 2)).toBeNull();
    const retry = rl.hit('k', t0 + 30_000);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(30);
    expect(rl.hit('k', t0 + 60_001)).toBeNull(); // window rolled — fresh budget
  });

  it('limitedFor reports without recording; clear resets', () => {
    const rl = new RateLimiter(2, 60_000);
    const t0 = 5_000;
    expect(rl.limitedFor('k', t0)).toBeNull();
    rl.hit('k', t0);
    rl.hit('k', t0);
    expect(rl.limitedFor('k', t0 + 1)).toBeGreaterThanOrEqual(1);
    rl.clear('k');
    expect(rl.limitedFor('k', t0 + 2)).toBeNull();
    expect(rl.hit('k', t0 + 3)).toBeNull();
  });

  it('keys are independent', () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.hit('a', 0)).toBeNull();
    expect(rl.hit('b', 0)).toBeNull();
  });
});
