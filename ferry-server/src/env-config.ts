// Deployment env parsing (spec 2026-08-17 §4-§5). Pure so each flag is unit-testable;
// every default preserves pre-Fly local-dev behavior.

export function listenHost(env: NodeJS.ProcessEnv): string {
  return env.FERRY_HOST || '127.0.0.1';
}

export function secureCookies(env: NodeJS.ProcessEnv): boolean {
  return env.FERRY_SECURE_COOKIES === '1';
}

export function accountCap(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.FERRY_MAX_ACCOUNTS;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    // Fail the boot, not the check: a typo here must never mean "unlimited signups".
    throw new Error(`FERRY_MAX_ACCOUNTS must be a non-negative integer, got "${raw}"`);
  }
  return n;
}
