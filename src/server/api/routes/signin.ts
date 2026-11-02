import type { Context, MiddlewareHandler } from 'hono';
import type { Clock } from '../../engine/clock.js';

export const MAX_WRONG_TRIES = 5;
export const LOCK_SECONDS = 60;
const MAX_REMEMBERED = 1000;

export interface LoginLimiter {
  /** Seconds left of this address's lockout, or 0 when it may try. */
  lockedFor(ip: string): number;
  /** Records a wrong password. Returns the seconds of lockout it caused, or 0. */
  fail(ip: string): number;
  /** A right password clears the count. */
  succeed(ip: string): void;
}

interface Entry { wrong: number; lockedUntil: number }

/** Counts wrong passwords per address: five in a row lock that address out for 60 seconds. */
export function createLoginLimiter(clock: Clock, opts: { max?: number; lockSeconds?: number } = {}): LoginLimiter {
  const max = opts.max ?? MAX_WRONG_TRIES;
  const lockMs = (opts.lockSeconds ?? LOCK_SECONDS) * 1000;
  const entries = new Map<string, Entry>();

  const forget = (now: number) => {
    for (const [ip, e] of entries) if (e.lockedUntil <= now && e.wrong === 0) entries.delete(ip);
  };
  const left = (e: Entry | undefined, now: number) => (e && e.lockedUntil > now ? Math.ceil((e.lockedUntil - now) / 1000) : 0);

  return {
    lockedFor(ip) {
      const now = clock.now().getTime();
      const e = entries.get(ip);
      // A finished lockout starts the count again.
      if (e && e.lockedUntil !== 0 && e.lockedUntil <= now) entries.delete(ip);
      return left(entries.get(ip), now);
    },
    fail(ip) {
      const now = clock.now().getTime();
      const current = entries.get(ip);
      if (left(current, now) > 0) return left(current, now);
      if (entries.size >= MAX_REMEMBERED) forget(now);
      const wrong = (current && current.lockedUntil <= now && current.lockedUntil !== 0 ? 0 : (current?.wrong ?? 0)) + 1;
      if (wrong >= max) {
        entries.set(ip, { wrong: 0, lockedUntil: now + lockMs });
        return Math.ceil(lockMs / 1000);
      }
      entries.set(ip, { wrong, lockedUntil: 0 });
      return 0;
    },
    succeed(ip) {
      entries.delete(ip);
    },
  };
}

/** Who is knocking: the address of the connection itself. A forwarded-for header is not trusted, since anyone can write it. */
export function clientIp(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'local';
}

export function lockedMessage(seconds: number): string {
  return `Too many tries. Try again in ${seconds} s.`;
}

/**
 * Put this in front of the login route. A locked address gets 429 with `retryAfter` and its password is not even
 * looked at; the answer to the fifth wrong password is already that 429. A 2xx from the login clears the count.
 */
export function loginLockout(limiter: LoginLimiter): MiddlewareHandler {
  const tooMany = (c: Context, seconds: number) => {
    c.header('Retry-After', String(seconds));
    return c.json({ error: lockedMessage(seconds), retryAfter: seconds }, 429);
  };
  return async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const ip = clientIp(c);
    const locked = limiter.lockedFor(ip);
    if (locked > 0) return tooMany(c, locked);
    await next();
    if (c.res.status === 401) {
      const seconds = limiter.fail(ip);
      if (seconds > 0) c.res = tooMany(c, seconds);
    } else if (c.res.status >= 200 && c.res.status < 300) {
      limiter.succeed(ip);
    }
    return undefined;
  };
}
