import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sessionExpiry(): string {
  return new Date(Date.now() + SESSION_MAX_AGE_S * 1000).toISOString();
}
