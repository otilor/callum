import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createCtx } from '../../context.js';
import { openDb } from '../../db/db.js';
import { fixedClock } from '../../engine/clock.js';
import { channelsRoutes } from './channels.js';
import { keysRoutes } from './keys.js';
import { personRoutes } from './person.js';
import { weeklyRoutes } from './weekly.js';

const BROKEN = 'Something went wrong. Callum kept everything as it was.';

/** A context whose database is gone: every read fails with an error nobody planned for. */
function broken() {
  const db = openDb(':memory:');
  const onError = vi.fn();
  const ctx = createCtx({ db, clock: fixedClock('2026-11-02T10:00:00Z'), demo: true, env: {}, onError });
  db.close();
  return { ctx, onError };
}

describe('feature routers report what nobody expected', () => {
  it('person routes hand an unexpected error to the app reporter and answer in plain words', async () => {
    const { ctx, onError } = broken();
    const res = await new Hono().route('/api', personRoutes(ctx)).request('/api/people/1');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: BROKEN });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('channel routes do the same', async () => {
    const { ctx, onError } = broken();
    const res = await new Hono().route('/', channelsRoutes(ctx, { env: {} })).request('/channels/email/summary');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: BROKEN });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('key routes do the same', async () => {
    const { ctx, onError } = broken();
    const app = new Hono().route('/', keysRoutes(ctx, { verify: async () => { throw new Error('boom'); } }));
    const res = await app.request('/settings/claude-key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'sk-ant-abc' }) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: BROKEN });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('weekly routes do the same, and no longer print to the console themselves', async () => {
    const { ctx, onError } = broken();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await new Hono().route('/api', weeklyRoutes(ctx)).request('/api/weekly');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: BROKEN });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it('an error the person can fix is not reported', async () => {
    const { ctx, onError } = broken();
    const res = await new Hono().route('/', channelsRoutes(ctx, { env: {} })).request('/channels/fax/summary');
    expect(res.status).toBe(404);
    expect(onError).not.toHaveBeenCalled();
  });
});
