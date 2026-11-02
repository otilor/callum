import { Hono, type Context } from 'hono';
import type { Tone } from '../../../shared/types.js';
import type { Ctx } from '../../context.js';
import { commit, connectApollo, describe, discardProject, preview, sampleHello, undoBatch, type AddSource } from '../../services/addPeople.js';
import type { ApolloSource } from '../../leads/apollo.js';
import { UserError } from '../../services/errors.js';

type Body = Record<string, unknown>;

async function bodyOf(c: Context): Promise<Body> {
  try {
    const data: unknown = await c.req.json();
    return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Body) : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** A project id, `null` for a project that does not exist yet, or nothing for the current one. */
function projectOf(v: unknown): number | null | undefined {
  if (v === null) return null;
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/** Adding people after day one, the New project flow, and connecting Apollo. Paths are relative to `/api`. */
export function peopleRoutes(ctx: Ctx, opts: { makeApollo?: (key: string) => ApolloSource } = {}): Hono {
  const routes = new Hono();

  // A message for the person leaves as it is; anything else goes on to the app's own error handling.
  const answer = (run: (body: Body) => Promise<unknown> | unknown) => async (c: Context) => {
    try {
      return c.json(await run(await bodyOf(c)));
    } catch (e) {
      if (e instanceof UserError) {
        return c.json({ error: e.message, ...(e.detail === undefined ? {} : { detail: e.detail }) }, e.status as 422);
      }
      throw e;
    }
  };

  routes.post('/people/preview', answer((b) => {
    const source: AddSource = {};
    const csv = text(b.csv);
    const csvBase64 = text(b.csvBase64);
    const paste = text(b.paste);
    const link = text(b.linkedinSearchUrl);
    if (csv !== undefined) source.csv = csv;
    if (csvBase64 !== undefined) source.csvBase64 = csvBase64;
    if (paste !== undefined) source.paste = paste;
    if (link !== undefined) source.linkedinSearchUrl = link;
    const projectId = projectOf(b.projectId);
    return preview(ctx, source, projectId === undefined ? {} : { projectId });
  }));

  routes.post('/people/commit', answer((b) => {
    const projectId = projectOf(b.projectId);
    return commit(ctx, text(b.batchId) ?? '', {
      ...(typeof projectId === 'number' ? { projectId } : {}),
      drop: texts(b.drop),
    });
  }));

  routes.post('/people/undo', answer((b) => undoBatch(ctx, text(b.batchId) ?? '')));

  routes.post('/people/discard-project', answer((b) => {
    const projectId = projectOf(b.projectId);
    return discardProject(ctx, typeof projectId === 'number' ? projectId : -1);
  }));

  routes.post('/people/describe', answer((b) => {
    const projectId = projectOf(b.projectId);
    return describe(ctx, { query: text(b.query) ?? '', filters: texts(b.filters), ...(projectId === undefined ? {} : { projectId }) });
  }));

  routes.post('/people/sample', answer((b) => {
    const batchId = text(b.batchId);
    const key = text(b.key);
    return sampleHello(ctx, {
      offer: text(b.offer) ?? '', tone: text(b.tone) as Tone,
      ...(batchId === undefined ? {} : { batchId }), ...(key === undefined ? {} : { key }),
    });
  }));

  routes.post('/apollo/connect', answer((b) => connectApollo(ctx, text(b.key) ?? '', opts.makeApollo)));

  return routes;
}
