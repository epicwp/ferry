import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth.js';
import { makeApp, signup } from './helpers/testApp.js';

describe('password hashing', () => {
  it('verifies correct passwords and rejects wrong ones', () => {
    const stored = hashPassword('hunter22');
    expect(verifyPassword('hunter22', stored)).toBe(true);
    expect(verifyPassword('hunter23', stored)).toBe(false);
    expect(verifyPassword('hunter22', 'garbage')).toBe(false);
  });
});

describe('auth routes', () => {
  it('signs up, reads /api/me, logs out', async () => {
    const { app } = makeApp();
    const cookie = await signup(app);
    let res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: 'user@example.com' });
    res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(204);
    res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects duplicate signup, bad login, missing session', async () => {
    const { app } = makeApp();
    await signup(app);
    let res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'user@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(409);
    res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'wrong-password' } });
    expect(res.statusCode).toBe(401);
    res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('validates signup input', async () => {
    const { app } = makeApp();
    let res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'not-an-email', password: 'password1' } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'ok@example.com', password: 'short' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('auth rate limits', () => {
  it('locks login after 10 failures per account+IP, even with the right password', async () => {
    const { app } = makeApp();
    await signup(app); // user@example.com / password1
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'wrong' } });
      expect(res.statusCode).toBe(401);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'password1' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json()).toEqual({ error: 'Too many attempts. Try again later.' });
  });

  it('clears the failure count on successful login', async () => {
    const { app } = makeApp();
    await signup(app);
    for (let i = 0; i < 9; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'wrong' } });
    }
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'password1' } });
    expect(ok.statusCode).toBe(200);
    const after = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'user@example.com', password: 'wrong' } });
    expect(after.statusCode).toBe(401); // 401, not 429 — the counter restarted
  });

  it('limits signup attempts per IP', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 10; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: `u${i}@example.com`, password: 'password1' } });
    }
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'u11@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(429);
  });

  it('signup limit is injectable for test servers', async () => {
    const { app } = makeApp({ authLimits: { signupMax: 1 } });
    await signup(app); // first attempt consumes the budget of 1
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'b@example.com', password: 'password1' } });
    expect(res.statusCode).toBe(429);
  });
});

describe('application/json body parsing', () => {
  it('accepts an empty body on a bodyless route (content-type sent, no payload)', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(204); // not 400/500 from the JSON parser
  });

  it('rejects malformed JSON with 400, not 500, and does not leak the parser message', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'content-type': 'application/json' },
      payload: '{not valid json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('Unexpected token');
  });
});
