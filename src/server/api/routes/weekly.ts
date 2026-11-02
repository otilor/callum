import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Ctx } from '../../context.js';
import { markAwaySeen, NoteError, quietSnapshot, realReply, sendReferral } from '../../services/quiet.js';
import { readNoteSettings, writeNoteSettings } from '../../services/noteSettings.js';
import { noteDue, weeklyEmail, weeklyNote } from '../../services/weekly.js';

const BAD_REQUEST = "Callum couldn't read that request.";

async function bodyOf(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    const data: unknown = JSON.parse(text);
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // falls through to the same answer as any other body that is not an object
  }
  throw new NoteError(BAD_REQUEST);
}

const wholeNumber = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : typeof v === 'number' && Number.isInteger(v) ? v : null;
  return n;
};

/**
 * The weekly note and the quiet moments of Home. Paths are relative to /api.
 *  GET  /weekly                       the current note, its email version and whether it should open by itself
 *  POST /weekly/seen                  the person opened the note
 *  GET  /quiet?projectId=             what the quiet moments of Home need
 *  POST /people/:id/real-reply        an auto-reply was a real reply
 *  POST /people/:id/away-seen         Okay on an out-of-office card: it does not come back for that auto-reply
 *  POST /people/:id/referral-hello    the user's hello to a person someone pointed to: { body, subject? }
 */
export function weeklyRoutes(ctx: Ctx): Hono {
  const app = new Hono();

  // A NoteError is something the user can fix: it goes out as { error } with 422, the way every other part of Callum does.
  app.onError((err, c) => {
    if (err instanceof NoteError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
    // Anything nobody expected: say so plainly and leave the details in the log.
    ctx.onError(err);
    return c.json({ error: 'Something went wrong. Callum kept everything as it was.' }, 500);
  });

  app.get('/weekly', (c) => {
    const { noteAt, weekStart } = noteDue(ctx);
    const note = weeklyNote(ctx, weekStart);
    const settings = readNoteSettings(ctx);
    const seen = settings.weeklySeenAt ?? '';
    const hasNews = note.hellos > 0 || note.replied.length > 0;
    return c.json({ note, email: weeklyEmail(note), shouldOpen: settings.onboarded && hasNews && seen < noteAt.toISOString() });
  });

  app.post('/weekly/seen', (c) => {
    const seenAt = ctx.clock.now().toISOString();
    writeNoteSettings(ctx, { weeklySeenAt: seenAt });
    ctx.bus.emit('settings');
    return c.json({ seenAt });
  });

  app.get('/quiet', (c) => {
    const raw = c.req.query('projectId');
    const id = raw === undefined || raw === '' ? undefined : wholeNumber(raw);
    if (id === null || (id !== undefined && !ctx.repo.getProject(id))) return c.json({ error: "Callum can't find that project." }, 404);
    return c.json(quietSnapshot(ctx, id));
  });

  app.post('/people/:id/real-reply', async (c) => {
    const id = wholeNumber(c.req.param('id'));
    if (id === null || !ctx.repo.getPerson(id)) return c.json({ error: "Callum can't find that." }, 404);
    return c.json(await realReply(ctx, id));
  });

  app.post('/people/:id/away-seen', (c) => {
    const id = wholeNumber(c.req.param('id'));
    if (id === null || !ctx.repo.getPerson(id)) return c.json({ error: "Callum can't find that." }, 404);
    markAwaySeen(ctx, id);
    return c.json({ ok: true });
  });

  app.post('/people/:id/referral-hello', async (c) => {
    const id = wholeNumber(c.req.param('id'));
    if (id === null || !ctx.repo.getPerson(id)) return c.json({ error: "Callum can't find that." }, 404);
    const b = await bodyOf(c);
    if (typeof b.body !== 'string') throw new NoteError('Write a line first');
    if (b.subject !== undefined && b.subject !== null && typeof b.subject !== 'string') throw new NoteError(BAD_REQUEST);
    return c.json(sendReferral(ctx, id, b.body, typeof b.subject === 'string' ? b.subject : null));
  });

  return app;
}
