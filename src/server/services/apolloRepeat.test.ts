import { describe, expect, it } from 'vitest';
import { searchLeads } from '../api/leads.js';
import { ApolloSource } from '../leads/apollo.js';
import { act } from './ask.js';
import { commit, describe as describePeople } from './addPeople.js';
import { setup } from './addPeople.test-helpers.js';
import { harness } from './testing.test-helpers.js';

// Apollo charges a credit for each person it looks up. Nobody is looked up, or paid for, twice.

interface Pool { source: ApolloSource; searched: string[]; billed: string[][] }

/** An Apollo with `n` people, paged the way the real one is, whose search is free and whose look-up is billed. */
function apolloWith(n: number, opts: { noEmail?: (i: number) => boolean } = {}): Pool {
  const searched: string[] = [];
  const billed: string[][] = [];
  const row = (i: number) => ({ id: `ap${i}`, first_name: `F${i}`, last_name: `L${i}`, title: 'Head of Payments', organization: { name: `Co${i}` } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('api_search')) {
      const page = Number(url.searchParams.get('page') ?? 1);
      const perPage = Number(url.searchParams.get('per_page') ?? 100);
      searched.push(`page ${page}`);
      const slice = Array.from({ length: n }, (_, i) => i).slice((page - 1) * perPage, page * perPage);
      return json({
        people: slice.map((i) => ({ ...row(i), last_name_obfuscated: 'L***', has_email: true })),
        pagination: { page, per_page: perPage, total_entries: n, total_pages: Math.ceil(n / perPage) },
      });
    }
    const ids = (JSON.parse(String(init?.body)) as { details: { id: string }[] }).details.map((d) => d.id);
    billed.push(ids);
    return json({
      matches: ids.map((id) => {
        const i = Number(id.slice(2));
        const bare = opts.noEmail?.(i) === true;
        return { ...row(i), name: `F${i} L${i}`, email: bare ? null : `f${i}@co${i}.com`, email_status: bare ? 'unavailable' : 'verified', linkedin_url: null };
      }),
      credits_consumed: ids.length,
    });
  }) as typeof fetch;
  return { source: new ApolloSource('key', fetchImpl, 'https://apollo.test'), searched, billed };
}
const totalBilled = (p: Pool) => p.billed.flat().length;

describe('"Find 20 more like Kemi" pressed twice', () => {
  it('looks up 20 new people the second time and pays for nobody twice', async () => {
    const h = harness();
    const pool = apolloWith(500);
    h.ctx.apollo = pool.source;
    const kemi = h.person({ name: 'Kemi Eze', role: 'Head of Payments' });
    const action = { kind: 'find_more' as const, label: '', args: { likePersonId: kemi.id, query: null, count: 20 } };
    await act(h.ctx, h.project.id, action);
    expect(totalBilled(pool)).toBe(20);
    const first = h.ctx.repo.listPeople().filter((p) => p.source === 'apollo');
    expect(first).toHaveLength(20);
    expect(first.every((p) => p.apolloId?.startsWith('ap'))).toBe(true);

    await act(h.ctx, h.project.id, action);
    const all = pool.billed.flat();
    expect(all).toHaveLength(40);
    expect(new Set(all).size).toBe(40);
    expect(h.ctx.repo.listPeople().filter((p) => p.source === 'apollo')).toHaveLength(40);
  });

  it('spends nothing when everyone Apollo has for those words is already in, and says so', async () => {
    const h = harness();
    const pool = apolloWith(5);
    h.ctx.apollo = pool.source;
    const action = { kind: 'find_more' as const, label: '', args: { likePersonId: null, query: 'head of payments', count: 5 } };
    await act(h.ctx, h.project.id, action);
    expect(totalBilled(pool)).toBe(5);
    const again = await act(h.ctx, h.project.id, action);
    expect(totalBilled(pool)).toBe(5);
    expect(again.text).toMatch(/already in Callum/);
    expect(again.text).not.toContain('!');
  });

  it('does not pay again for someone Callum looked up but had no email or LinkedIn for', async () => {
    const h = harness();
    const pool = apolloWith(5, { noEmail: (i) => i < 2 });
    h.ctx.apollo = pool.source;
    const action = { kind: 'find_more' as const, label: '', args: { likePersonId: null, query: 'head of payments', count: 5 } };
    await act(h.ctx, h.project.id, action);
    expect(h.ctx.repo.listPeople().filter((p) => p.source === 'apollo')).toHaveLength(3);
    await act(h.ctx, h.project.id, action);
    expect(totalBilled(pool)).toBe(5);
  });

  it('reads only a bounded number of pages when everyone it can reach is known', async () => {
    const h = harness();
    const pool = apolloWith(100_000);
    h.ctx.apollo = pool.source;
    h.ctx.repo.markApolloSeen(Array.from({ length: 100_000 }, (_, i) => `ap${i}`));
    await act(h.ctx, h.project.id, { kind: 'find_more', label: '', args: { likePersonId: null, query: 'anyone', count: 20 } });
    expect(totalBilled(pool)).toBe(0);
    expect(pool.searched.length).toBeLessThanOrEqual(10);
  });
});

describe('the first-run search', () => {
  it('run twice on the same words adds new people and spends nothing on the known ones', async () => {
    const h = harness();
    const pool = apolloWith(200);
    h.ctx.apollo = pool.source;
    const a = await searchLeads(h.ctx, h.project.id, 'head of payments', 20);
    const b = await searchLeads(h.ctx, h.project.id, 'head of payments', 20);
    expect([a.added.length, a.creditsUsed]).toEqual([20, 20]);
    expect([b.added.length, b.creditsUsed]).toEqual([20, 20]);
    expect(new Set(pool.billed.flat()).size).toBe(40);
  });

  it('with nobody new says nothing was spent', async () => {
    const h = harness();
    const pool = apolloWith(3);
    h.ctx.apollo = pool.source;
    await searchLeads(h.ctx, h.project.id, 'head of payments', 3);
    const again = await searchLeads(h.ctx, h.project.id, 'head of payments', 3);
    expect(again).toMatchObject({ added: [], creditsUsed: 0 });
    expect(totalBilled(pool)).toBe(3);
  });
});

describe('adding people by description', () => {
  it('shows only people not looked up before, and a second batch of the same names costs nothing', async () => {
    const s = setup();
    const pool = apolloWith(6);
    s.ctx.apollo = pool.source;
    const first = await describePeople(s.ctx, { query: 'heads of payments', filters: [] });
    expect(first.people).toHaveLength(6);
    // A second list is made before the first is added: both hold the same six.
    const second = await describePeople(s.ctx, { query: 'heads of payments', filters: [] });
    await commit(s.ctx, first.batchId!);
    expect(totalBilled(pool)).toBe(6);
    await expect(commit(s.ctx, second.batchId!)).rejects.toThrow('Those people are already in Callum, so nothing more was spent.');
    expect(totalBilled(pool)).toBe(6);
    // A search after that shows nobody new, and says it is because they are all in.
    const third = await describePeople(s.ctx, { query: 'heads of payments', filters: [] });
    expect(third.people).toEqual([]);
    expect(third.line).toContain('already in Callum');
  });

  it('pages forward past known people to show new ones', async () => {
    const s = setup();
    const pool = apolloWith(400);
    s.ctx.apollo = pool.source;
    s.ctx.repo.markApolloSeen(Array.from({ length: 100 }, (_, i) => `ap${i}`));
    const d = await describePeople(s.ctx, { query: 'heads of payments', filters: [] });
    expect(d.people.length).toBeGreaterThan(0);
    expect(totalBilled(pool)).toBe(0);
    await commit(s.ctx, d.batchId!);
    const ids = pool.billed.flat().map((id) => Number(id.slice(2)));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((n) => n >= 100)).toBe(true);
  });
});
