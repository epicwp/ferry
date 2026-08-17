import type { FastifyInstance } from 'fastify';
import { hashPassword, newSessionToken, sessionExpiry, verifyPassword, SESSION_MAX_AGE_S } from '../auth.js';
import { SESSION_COOKIE, type AppDeps } from '../app.js';
import { RateLimiter } from '../rate-limit.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE_S } as const;
const AUTH_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 10; // per account+IP, cleared on success
const SIGNUP_MAX_ATTEMPTS = 10; // per IP
const LIMIT_BODY = { error: 'Too many attempts. Try again later.' };

export function authRoutes(app: FastifyInstance, deps: AppDeps): void {
  const loginLimiter = new RateLimiter(LOGIN_MAX_FAILURES, AUTH_WINDOW_MS);
  const signupLimiter = new RateLimiter(deps.authLimits?.signupMax ?? SIGNUP_MAX_ATTEMPTS, AUTH_WINDOW_MS);
  const cookieOpts = deps.secureCookies ? { ...COOKIE_OPTS, secure: true } : COOKIE_OPTS;

  app.post('/api/auth/signup', async (request, reply) => {
    const { email, password } = (request.body ?? {}) as { email?: string; password?: string };
    const retry = signupLimiter.hit(`signup:${request.ip}`);
    if (retry !== null) return reply.code(429).header('retry-after', String(retry)).send(LIMIT_BODY);
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
    return reply.setCookie(SESSION_COOKIE, token, cookieOpts).send({ email: user.email });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const { email, password } = (request.body ?? {}) as { email?: string; password?: string };
    // Limit check BEFORE scrypt — a locked key must not burn CPU per guess (spec 6a §3.4).
    const key = `login:${String(email ?? '').toLowerCase()}:${request.ip}`;
    const limited = loginLimiter.limitedFor(key);
    if (limited !== null) return reply.code(429).header('retry-after', String(limited)).send(LIMIT_BODY);
    const user = email ? deps.store.userByEmail(email.toLowerCase()) : undefined;
    if (!user || !password || !verifyPassword(password, user.passwordHash)) {
      loginLimiter.hit(key);
      return reply.code(401).send({ error: 'Wrong email or password.' });
    }
    loginLimiter.clear(key);
    const token = newSessionToken();
    deps.store.createSession(token, user.id, sessionExpiry());
    return reply.setCookie(SESSION_COOKIE, token, cookieOpts).send({ email: user.email });
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
