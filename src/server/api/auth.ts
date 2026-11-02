import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Clock } from '../engine/clock.js';

export const SESSION_COOKIE = 'callum_session';
export const MAX_WRONG_TRIES = 5;
export const LOCKOUT_MS = 60_000;
const SESSION_DAYS = 30;

export const WRONG_PASSWORD = "That's not the password. Ask whoever set up this Callum, or check CALLUM_PASSWORD on the server.";

/** Compares two strings in constant time, whatever their lengths. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function clientOf(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface Auth {
  /** Lets a request through when there is no password or the cookie is good. */
  gate: MiddlewareHandler;
  login: (c: Context) => Promise<Response>;
  logout: (c: Context) => Response;
}

/**
 * The access gate. The session cookie holds an HMAC of the password under a key made at boot, so it cannot be
 * forged without the key and stops working when Callum restarts. Five wrong tries from one address lock that
 * address out of the sign-in for a minute.
 */
export function createAuth(opts: { password: string | null; clock: Clock }): Auth {
  const { password, clock } = opts;
  const key = randomBytes(32);
  const expected = password === null ? null : createHmac('sha256', key).update(password).digest('hex');
  const tries = new Map<string, { wrong: number; lockedUntil: number; lastAt: number }>();

  const signedIn = (c: Context): boolean => {
    if (expected === null) return true;
    const cookie = getCookie(c, SESSION_COOKIE);
    return cookie !== undefined && safeEqual(cookie, expected);
  };

  const gate: MiddlewareHandler = async (c, next) => {
    if (c.req.path === '/api/login' || signedIn(c)) return next();
    return c.json({ error: 'Sign in first' }, 401);
  };

  const login = async (c: Context): Promise<Response> => {
    if (password === null || expected === null) return c.json({ ok: true });
    const now = clock.now().getTime();
    // Old tries are forgotten, so a slip last week does not count towards today's five.
    for (const [who, t] of tries) if (t.lockedUntil <= now && now - t.lastAt >= LOCKOUT_MS) tries.delete(who);

    const who = clientOf(c);
    const state = tries.get(who) ?? { wrong: 0, lockedUntil: 0, lastAt: now };
    if (state.lockedUntil > now) {
      const retryAfter = Math.ceil((state.lockedUntil - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: `Too many tries. Try again in ${retryAfter} s.`, retryAfter }, 429);
    }

    const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
    const given = typeof body?.password === 'string' ? body.password : '';
    if (!safeEqual(given, password)) {
      state.wrong += 1;
      state.lastAt = now;
      if (state.wrong >= MAX_WRONG_TRIES) state.lockedUntil = now + LOCKOUT_MS;
      tries.set(who, state);
      return c.json({ error: WRONG_PASSWORD }, 401);
    }

    tries.delete(who);
    setCookie(c, SESSION_COOKIE, expected, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_DAYS * 86_400,
    });
    return c.json({ ok: true });
  };

  const logout = (c: Context): Response => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  };

  return { gate, login, logout };
}
