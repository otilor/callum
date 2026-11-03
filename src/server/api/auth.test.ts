import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../engine/clock.js';
import { createAuth, SESSION_COOKIE, WRONG_PASSWORD } from './auth.js';

function setup(password: string | null) {
  const clock = fixedClock('2026-11-02T10:00:00Z');
  const auth = createAuth({ password, clock });
  const app = new Hono();
  app.use('/api/*', auth.gate);
  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);
  app.get('/api/secret', (c) => c.json({ ok: true }));
  const from = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
  const login = (password: unknown, address = '10.0.0.1') =>
    app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) }, from(address));
  const cookieOf = (res: Response): string => {
    const header = res.headers.get('set-cookie') ?? '';
    return header.split(';')[0] ?? '';
  };
  return { app, clock, login, cookieOf, from };
}

describe('access gate', () => {
  it('lets everything through when there is no password', async () => {
    const { app, login } = setup(null);
    expect((await app.request('/api/secret')).status).toBe(200);
    expect((await login('anything')).status).toBe(200);
  });

  it('refuses a request with no cookie', async () => {
    const { app } = setup('open sesame');
    const res = await app.request('/api/secret');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Sign in first' });
  });

  it('refuses a wrong password with the sign-in copy', async () => {
    const { login } = setup('open sesame');
    const res = await login('nope');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: WRONG_PASSWORD });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('sets an http-only same-site cookie for the right password, which then opens the door', async () => {
    const { app, login, cookieOf } = setup('open sesame');
    const res = await login('open sesame');
    expect(res.status).toBe(200);
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toContain(`${SESSION_COOKIE}=`);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).not.toContain('open sesame');
    const ok = await app.request('/api/secret', { headers: { cookie: cookieOf(res) } });
    expect(ok.status).toBe(200);
  });

  it('does not accept a made-up cookie', async () => {
    const { app } = setup('open sesame');
    for (const value of ['', 'abc', 'open sesame']) {
      const res = await app.request('/api/secret', { headers: { cookie: `${SESSION_COOKIE}=${value}` } });
      expect(res.status).toBe(401);
    }
  });

  it('forgets the session on a new boot', async () => {
    const first = setup('open sesame');
    const cookie = first.cookieOf(await first.login('open sesame'));
    const second = setup('open sesame');
    expect((await second.app.request('/api/secret', { headers: { cookie } })).status).toBe(401);
  });

  it('signs out by clearing the cookie, and the old cookie stops working', async () => {
    const { app, login, cookieOf } = setup('open sesame');
    const cookie = cookieOf(await login('open sesame'));
    const res = await app.request('/api/logout', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0|Expires=/i);
    expect((await app.request('/api/secret', { headers: { cookie } })).status).toBe(401);
  });

  it('gives every sign-in its own random token', async () => {
    const { login, cookieOf } = setup('open sesame');
    const a = cookieOf(await login('open sesame'));
    const b = cookieOf(await login('open sesame'));
    expect(a).not.toBe(b);
    expect(a.split('=')[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('marks the cookie Secure over https, directly or through a proxy, and not over http', async () => {
    const { app, from } = setup('open sesame');
    const body = JSON.stringify({ password: 'open sesame' });
    const secure = async (url: string, headers: Record<string, string> = {}) =>
      /;\s*Secure/i.test((await app.request(url, { method: 'POST', body, headers }, from('10.1.1.1'))).headers.get('set-cookie') ?? '');
    expect(await secure('http://localhost/api/login')).toBe(false);
    expect(await secure('https://callum.example.com/api/login')).toBe(true);
    expect(await secure('http://localhost/api/login', { 'x-forwarded-proto': 'https' })).toBe(true);
  });

  it('turns everyone away for a minute after 30 wrong passwords from anywhere', async () => {
    const { login, clock } = setup('open sesame');
    for (let i = 0; i < 30; i++) expect((await login('wrong', `10.0.${Math.floor(i / 4)}.${i % 4}`)).status).toBe(401);
    const locked = await login('open sesame', '10.9.9.9');
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as { retryAfter: number }).retryAfter).toBe(60);
    clock.advance(60_000);
    expect((await login('open sesame', '10.9.9.9')).status).toBe(200);
  });

  it('locks an address out for a minute after five wrong tries', async () => {
    const { login, clock } = setup('open sesame');
    for (let i = 0; i < 5; i++) expect((await login('wrong')).status).toBe(401);
    const locked = await login('open sesame');
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: 'Too many tries. Try again in 60 s.', retryAfter: 60 });
    clock.advance(42_000);
    expect(await (await login('open sesame')).json()).toEqual({ error: 'Too many tries. Try again in 18 s.', retryAfter: 18 });
    clock.advance(18_000);
    expect((await login('open sesame')).status).toBe(200);
  });

  it('keeps the lockout to the address that earned it', async () => {
    const { login } = setup('open sesame');
    for (let i = 0; i < 5; i++) await login('wrong', '10.0.0.1');
    expect((await login('open sesame', '10.0.0.1')).status).toBe(429);
    expect((await login('open sesame', '10.0.0.2')).status).toBe(200);
  });

  it('forgets wrong tries after a quiet minute', async () => {
    const { login, clock } = setup('open sesame');
    for (let i = 0; i < 4; i++) await login('wrong');
    clock.advance(61_000);
    expect((await login('wrong')).status).toBe(401);
    expect((await login('open sesame')).status).toBe(200);
  });

  it('counts a missing password as a wrong one', async () => {
    const { login } = setup('open sesame');
    expect((await login(undefined)).status).toBe(401);
    expect((await login(42)).status).toBe(401);
  });
});
