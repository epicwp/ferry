/**
 * Fixed-window in-memory rate limiter (spec 6a §3.4). Single-process by design —
 * the server is one Node process; a restart resets the windows, accepted.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Record one attempt. null = allowed; number = refused, seconds until the window resets. */
  hit(key: string, now = Date.now()): number | null {
    if (this.hits.size > 10_000) this.sweep(now); // unbounded-key guard (IPs); lazy, amortized
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return null;
    }
    entry.count += 1;
    if (entry.count > this.max) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return null;
  }

  /** null = not limited; number = limited, seconds until reset. Does NOT record an attempt. */
  limitedFor(key: string, now = Date.now()): number | null {
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt || entry.count < this.max) return null;
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }
}
