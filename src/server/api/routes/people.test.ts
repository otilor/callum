import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AddCommit, AddPreview, Described } from '../../../shared/types.js';
import { fakeApollo, setup, type Setup } from '../../services/addPeople.test-helpers.js';
import { peopleRoutes } from './people.js';

let s: Setup;
let app: Hono;

beforeEach(() => {
  s = setup();
  app = new Hono().route('/api', peopleRoutes(s.ctx, { makeApollo: () => fakeApollo({ failSearch: 401 }).source }));
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

  it('describes with Apollo, and says what is missing without it', async () => {
    const without = await post('/people/describe', { query: 'heads of finance in Accra', filters: [] });
    expect(without.status).toBe(422);
    expect(without.json).toEqual({
      error: 'Describing people needs a people search connected. Bring a list instead, or connect Apollo in Your Callum.',
      detail: { code: 'no_apollo' },
    });
    s.ctx.apollo = fakeApollo({ total: 2300 }).source;
    const found = await post('/people/describe', { query: 'heads of finance in Accra', filters: [] });
    expect(found.status).toBe(200);
    const d = found.json as unknown as Described;
    expect(d.narrow).toEqual(['20 to 200 people', 'Accra only']);
    expect(d.people).toHaveLength(3);
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

  it('connects Apollo and never sends the key back', async () => {
    const bad = await post('/apollo/connect', { key: 'a-key-that-fails' });
    expect(bad.status).toBe(422);
    expect(bad.json).toEqual({ error: "Apollo didn't accept the API key. Check it in Your Callum." });
    expect(s.ctx.repo.getChannelSecret('apollo')).toBeNull();
    expect(JSON.stringify(bad.json)).not.toContain('a-key-that-fails');
    expect((await post('/apollo/connect', {})).json).toEqual({ error: 'Paste your Apollo API key first.' });
  });
});
