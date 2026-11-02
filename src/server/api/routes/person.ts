import { Hono } from 'hono';
import { CHANNELS, type Channel } from '../../../shared/types.js';
import type { Ctx } from '../../context.js';
import { UserError } from '../../services/errors.js';
import { moveTo, personDetail, restAgain, wakeEarly } from '../../services/person.js';

const BAD_REQUEST = "Callum couldn't read that request.";
const BROKEN = 'Something went wrong. Callum kept everything as it was.';

async function readBody(c: { req: { text(): Promise<string> } }): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UserError(BAD_REQUEST, 400);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new UserError(BAD_REQUEST, 400);
  return data as Record<string, unknown>;
}

function wholeNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function idOf(raw: string | undefined): number {
  const id = wholeNumber(raw);
  if (id === null) throw new UserError("Callum can't find that person.", 404);
  return id;
}

/**
 * The person page: the whole picture of one person, switching their channel, and waking a resting
 * person early (with a 10 second way back). Paths are relative to `/api`.
 */
export function personRoutes(ctx: Ctx): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof UserError) return c.json({ error: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}) }, err.status as 400 | 404 | 409 | 422);
    return c.json({ error: BROKEN }, 500);
  });

  app.get('/people/:id', (c) => c.json(personDetail(ctx, idOf(c.req.param('id')))));

  // Another channel. (Moving to another project is `POST /people/:id/move { projectId }`, Task 11's.)
  app.post('/people/:id/switch-channel', async (c) => {
    const id = idOf(c.req.param('id'));
    const body = await readBody(c);
    const channel = CHANNELS.find((ch): ch is Channel => ch === body.channel);
    if (!channel) throw new UserError('Pick email, LinkedIn or X.');
    if (body.handle !== undefined && body.handle !== null && typeof body.handle !== 'string') throw new UserError(BAD_REQUEST, 400);
    return c.json(moveTo(ctx, id, channel, typeof body.handle === 'string' ? body.handle : undefined));
  });

  app.post('/people/:id/wake', (c) => c.json(wakeEarly(ctx, idOf(c.req.param('id')))));
  app.post('/people/:id/rest', (c) => c.json(restAgain(ctx, idOf(c.req.param('id')))));

  return app;
}
