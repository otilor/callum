import type { Context } from 'hono';
import type { Channel, Tone } from '../../shared/types.js';
import { CHANNELS } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { UserError } from '../services/errors.js';

export type Body = Record<string, unknown>;

const BAD_REQUEST = "Callum couldn't read that request.";

/** The JSON object a request carries. A request with no body is an empty object. */
export async function readBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new UserError(BAD_REQUEST, 400);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new UserError(BAD_REQUEST, 400);
  return data as Body;
}

/** A text field that must be there. */
export function needText(b: Body, key: string, what = key): string {
  const v = b[key];
  if (typeof v !== 'string' || v.trim() === '') throw new UserError(`Callum needs ${what} for that.`);
  return v;
}

export function optText(b: Body, key: string): string | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new UserError(BAD_REQUEST, 400);
  return v;
}

export function optBool(b: Body, key: string): boolean | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new UserError(BAD_REQUEST, 400);
  return v;
}

/** A whole number from a URL part, query or body field. */
export function wholeNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

export function idParam(c: Context, name = 'id'): number {
  const n = wholeNumber(c.req.param(name));
  if (n === null) throw new UserError("Callum can't find that.", 404);
  return n;
}

export function channelParam(c: Context): Channel {
  const ch = c.req.param('ch');
  const found = CHANNELS.find((x) => x === ch);
  if (!found) throw new UserError("Callum can't find that channel.", 404);
  return found;
}

const TONES: Tone[] = ['warm', 'direct', 'playful'];
export function toneOf(v: unknown): Tone {
  const found = TONES.find((t) => t === v);
  if (!found) throw new UserError('Pick warm, direct or playful.');
  return found;
}

/**
 * The project a request is about: the one it names, else the one last viewed, else the first there is.
 * `raw` is the `projectId` from the query or the body.
 */
export function projectIdOf(ctx: Ctx, raw: unknown): number {
  if (raw !== undefined && raw !== null && raw !== '') {
    const id = wholeNumber(raw);
    if (id === null || !ctx.repo.getProject(id)) throw new UserError("Callum can't find that project.", 404);
    return id;
  }
  const current = ctx.repo.getSettings().currentProjectId;
  if (current !== null && ctx.repo.getProject(current)) return current;
  const first = ctx.repo.listProjects()[0];
  if (!first) throw new UserError('Start a project first.', 409);
  return first.id;
}

/** The project a request names, or none for "all projects". */
export function optionalProjectId(ctx: Ctx, raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return projectIdOf(ctx, raw);
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
