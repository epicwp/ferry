import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../../src/app.js';
import { Store } from '../../src/store.js';

export function makeApp(overrides: Partial<AppDeps> = {}): { app: FastifyInstance; store: Store } {
  const store = overrides.store ?? new Store(':memory:');
  const app = buildApp({ store, ...overrides });
  return { app, store };
}

export async function signup(app: FastifyInstance, email = 'user@example.com', password = 'password1'): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const cookie = res.headers['set-cookie'];
  return (Array.isArray(cookie) ? cookie[0]! : cookie!).split(';')[0]!;
}
