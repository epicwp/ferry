import type { FastifyInstance } from 'fastify';
import { hashPassword, newSessionToken, sessionExpiry, verifyPassword, SESSION_MAX_AGE_S } from '../auth.js';
import { SESSION_COOKIE, type AppDeps } from '../app.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE_S } as const;

export function authRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post('/api/auth/signup', async (request, reply) => {
    const { email, password } = (request.body ?? {}) as { email?: string; password?: string };
    if (!email || !EMAIL_RE.test(email)) {
      return reply.code(400).send({ error: 'Enter a valid email address.' });
    }
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: 'Password must be at least 8 characters.' });
    }
    const user = deps.store.createUser(email.toLowerCase(), hashPassword(password));
    if (!user) {
      return reply.code(409).send({ error: 'An account with this email already exists.' });
    }
    const token = newSessionToken();
    deps.store.createSession(token, user.id, sessionExpiry());
    return reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTS).send({ email: user.email });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const { email, password } = (request.body ?? {}) as { email?: string; password?: string };
    const user = email ? deps.store.userByEmail(email.toLowerCase()) : undefined;
    if (!user || !password || !verifyPassword(password, user.passwordHash)) {
      return reply.code(401).send({ error: 'Wrong email or password.' });
    }
    const token = newSessionToken();
    deps.store.createSession(token, user.id, sessionExpiry());
    return reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTS).send({ email: user.email });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) deps.store.deleteSession(token);
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send();
  });

  app.get('/api/me', { preHandler: app.requireUser }, async (request) => {
    return { email: request.user.email };
  });
}
