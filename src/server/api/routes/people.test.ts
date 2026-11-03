import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AddCommit, AddPreview, Described } from '../../../shared/types.js';
import { NO_CLAUDE } from '../../services/addPeople.js';
import { fakeFinder, setup, type Setup } from '../../services/addPeople.test-helpers.js';
import { peopleRoutes } from './people.js';

let s: Setup;
let app: Hono;

beforeEach(() => {
  s = setup();
  app = new Hono().route('/api', peopleRoutes(s.ctx));
});

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(`/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('people routes', () => {
  it('previews, commits and undoes a paste', async () => {
    const pre = await post('/people/preview', { paste: 'Kemi Eze, kemi@okopay.com\nBola' });
    expect(pre.status).toBe(200);
    const preview = pre.json as unknown as AddPreview;
    expect(preview.added.map((a) => a.name)).toEqual(['Kemi Eze']);
    expect(preview.groups.map((g) => g.line)).toEqual(['1 has no email or LinkedIn']);
    expect(s.ctx.repo.listPeople()).toEqual([]);

    const done = await post('/people/commit', { batchId: preview.batchId, drop: [] });
    expect(done.status).toBe(200);
    expect((done.json as unknown as AddCommit).line).toBe('1 person joins the river. First hellos from tomorrow at 9:00.');
    expect(s.ctx.repo.listPeople()).toHaveLength(1);

    const undone = await post('/people/undo', { batchId: preview.batchId });
    expect(undone.json).toEqual({ removed: 1 });
    expect(s.ctx.repo.listPeople()).toEqual([]);
  });

  it('previews for a project that does not exist yet and commits into the one just made', async () => {
    const pre = (await post('/people/preview', { paste: 'Kemi Eze, kemi@okopay.com', projectId: null })).json as unknown as AddPreview;
    const other = s.ctx.repo.insertProject({ name: 'Invoicing' });
    const done = await post('/people/commit', { batchId: pre.batchId, projectId: other.id });
    expect((done.json as unknown as AddCommit).added[0]?.projectId).toBe(other.id);
  });

  it('answers a message for the person with 422 and the words', async () => {
    const none = await post('/people/preview', {});
    expect(none.status).toBe(422);
    expect(none.json.error).toMatch(/^Bring a list first/);
    const gone = await post('/people/commit', { batchId: 'nope' });
    expect(gone.status).toBe(410);
    expect(gone.json).toEqual({ error: 'That list is no longer here. Bring it again.' });
    const garbage = await app.request('/api/people/preview', { method: 'POST', body: 'not json' });
    expect(garbage.status).toBe(422);
  });

  it('describes with Claude, and says what is missing without it', async () => {
    s.ctx.finder = null;
    const without = await post('/people/describe', { query: 'heads of finance in Accra', filters: [] });
    expect(without.status).toBe(422);
    expect(without.json).toEqual({ error: NO_CLAUDE, detail: { code: 'no_claude' } });
    s.ctx.finder = fakeFinder().finder;
    const found = await post('/people/describe', { query: 'heads of finance in Accra', filters: [] });
    expect(found.status).toBe(200);
    const d = found.json as unknown as Described;
    expect(d.narrow).toBeNull();
    expect(d.people).toHaveLength(3);

    // The keys the screen got back are what Add sends: the server's own row places, end to end.
    const seen = d.people.slice(0, 2).map((p) => p.key);
    const status = (await post('/people/describe/status', { batchId: d.batchId })).json as unknown as Described;
    expect(status.people.map((p) => p.key)).toEqual(d.people.map((p) => p.key));
    const added = (await post('/people/commit', { batchId: d.batchId, only: seen })).json as unknown as AddCommit;
    expect(added.added).toHaveLength(2);
  });

  it('adds nobody when the list of who was shown is not a list, rather than everyone', async () => {
    s.ctx.finder = fakeFinder().finder;
    const d = (await post('/people/describe', { query: 'cfo' })).json as unknown as Described;
    for (const only of [null, 'all', { a: 1 }]) {
      const res = (await post('/people/commit', { batchId: d.batchId, only })).json as unknown as AddCommit;
      expect(res.added, JSON.stringify(only)).toEqual([]);
    }
    expect(s.ctx.repo.listPeople()).toEqual([]);
  });

  it('discards a project that never started and got nobody', async () => {
    const idle = s.ctx.repo.insertProject({ name: 'Invoicing' });
    expect((await post('/people/discard-project', { projectId: idle.id })).json).toEqual({ discarded: true });
    expect((await post('/people/discard-project', { projectId: idle.id })).json).toEqual({ discarded: false });
    expect((await post('/people/discard-project', {})).json).toEqual({ discarded: false });
  });

  it('writes a sample hello for a project that is still being set up', async () => {
    const res = await post('/people/sample', { offer: 'You help teams run payroll.', tone: 'direct' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ body: expect.stringContaining('Kemi'), to: { name: 'Kemi Eze' } });
    expect((await post('/people/sample', { offer: '', tone: 'direct' })).status).toBe(422);
  });

  it('has no Apollo route any more', async () => {
    expect((await app.request('/api/apollo/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
  });
});
