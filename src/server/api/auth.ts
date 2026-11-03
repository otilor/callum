import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Clock } from '../engine/clock.js';

export const SESSION_COOKIE = 'callum_session';
export const MAX_WRONG_TRIES = 5;
export const LOCKOUT_MS = 60_000;
const SESSION_DAYS = 30;
const MAX_SESSIONS = 1000;
/** Wrong passwords, from anyone, that Callum takes in a minute before it asks everyone to wait. */
export const MAX_WRONG_PER_MINUTE = 30;

export const WRONG_PASSWORD = "That's not the password. Ask whoever set up this Callum, or check CALLUM_PASSWORD on the server.";

/** Compares two strings in constant time, whatever their lengths. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Who is asking, for the lockout. Behind a reverse proxy every request comes from the proxy itself, so with
 * CALLUM_TRUST_PROXY the address the proxy appended to X-Forwarded-For is used instead (the last one: anything
 * earlier in that header was written by the client). Without it the header is ignored, so nobody can pick their own address.
 */
function clientOf(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    if (forwarded) return forwarded;
  }
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
 * The access gate. Signing in hands out a random token that Callum remembers until sign-out or restart. Five wrong
 * tries from one address lock that address out of the sign-in for a minute, and 30 from anyone in a minute lock
 * everyone out for the rest of it.
 */
export function createAuth(opts: { password: string | null; clock: Clock; trustProxy?: boolean }): Auth {
  const { password, clock } = opts;
  const trustProxy = opts.trustProxy === true;
  const sessions = new Set<string>();
  let wrongAt: number[] = [];
  const tries = new Map<string, { wrong: number; lockedUntil: number; lastAt: number }>();

  const signedIn = (c: Context): boolean => {
    if (password === null) return true;
    const cookie = getCookie(c, SESSION_COOKIE);
    return cookie !== undefined && sessions.has(cookie);
  };

  const gate: MiddlewareHandler = async (c, next) => {
    if (c.req.path === '/api/login' || signedIn(c)) return next();
    return c.json({ error: 'Sign in first' }, 401);
  };

  const login = async (c: Context): Promise<Response> => {
    if (password === null) return c.json({ ok: true });
    const now = clock.now().getTime();
    // Old tries are forgotten, so a slip last week does not count towards today's five.
    for (const [who, t] of tries) if (t.lockedUntil <= now && now - t.lastAt >= LOCKOUT_MS) tries.delete(who);

    wrongAt = wrongAt.filter((t) => now - t < LOCKOUT_MS);
    if (wrongAt.length >= MAX_WRONG_PER_MINUTE) {
      const retryAfter = Math.ceil((wrongAt[0]! + LOCKOUT_MS - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: `Too many tries. Try again in ${retryAfter} s.`, retryAfter }, 429);
    }

    const who = clientOf(c, trustProxy);
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
      wrongAt.push(now);
      if (state.wrong >= MAX_WRONG_TRIES) state.lockedUntil = now + LOCKOUT_MS;
      tries.set(who, state);
      return c.json({ error: WRONG_PASSWORD }, 401);
    }

    tries.delete(who);
    const token = randomBytes(32).toString('hex');
    sessions.add(token);
    // Oldest first: a Set remembers the order it was filled in.
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.values().next().value as string);
    const secure = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_DAYS * 86_400,
    });
    return c.json({ ok: true });
  };

  const logout = (c: Context): Response => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) sessions.delete(token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  };

  return { gate, login, logout };
}
