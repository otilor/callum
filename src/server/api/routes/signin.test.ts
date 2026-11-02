import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../engine/clock.js';
import { createLoginLimiter, loginLockout } from './signin.js';

const clock = fixedClock('2026-11-02T10:00:00Z');
let app: Hono;
let looked: number;

beforeEach(() => {
  clock.set('2026-11-02T10:00:00Z');
  looked = 0;
  app = new Hono();
  app.use('/login', loginLockout(createLoginLimiter(clock)));
  app.post('/login', async (c) => {
    looked += 1;
    const { password } = (await c.req.json()) as { password: string };
    return password === 'reconcile' ? c.json({ ok: true }) : c.json({ error: 'Sign in first' }, 401);
  });
});

const login = (password: string, ip = '10.0.0.1') =>
  app.request('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) }, { incoming: { socket: { remoteAddress: ip } } });

describe('login lockout', () => {
  it('answers 401 for four wrong tries and 429 with retryAfter on the fifth', async () => {
    for (let i = 0; i < 4; i++) expect((await login('nope')).status).toBe(401);
    const res = await login('nope');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many tries. Try again in 60 s.', retryAfter: 60 });
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it('does not look at the password while locked, even a right one, and counts down', async () => {
    for (let i = 0; i < 5; i++) await login('nope');
    const seenBefore = looked;
    clock.advance(20_000);
    const res = await login('reconcile');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many tries. Try again in 40 s.', retryAfter: 40 });
    expect(looked).toBe(seenBefore);
  });

  it('unlocks after 60 seconds and starts the count again', async () => {
    for (let i = 0; i < 5; i++) await login('nope');
    clock.advance(60_000);
    expect((await login('nope')).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await login('nope')).status).toBe(401);
    expect((await login('nope')).status).toBe(429);
  });

  it('a right password clears the count', async () => {
    for (let i = 0; i < 4; i++) await login('nope');
    expect((await login('reconcile')).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login('nope')).status).toBe(401);
  });

  it('keeps each address on its own count', async () => {
    for (let i = 0; i < 5; i++) await login('nope', '10.0.0.1');
    expect((await login('reconcile', '10.0.0.2')).status).toBe(200);
    expect((await login('reconcile', '10.0.0.1')).status).toBe(429);
  });

  it('ignores a forwarded-for header, which anyone can write', async () => {
    const forged = (n: number) =>
      app.request('/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `9.9.9.${n}` }, body: JSON.stringify({ password: 'nope' }) }, { incoming: { socket: { remoteAddress: '10.0.0.1' } } });
    for (let i = 0; i < 4; i++) await forged(i);
    expect((await forged(9)).status).toBe(429);
  });
});
