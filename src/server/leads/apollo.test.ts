import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApolloSource } from './apollo.js';

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: string }

/** Apollo's people API search response, in the shape the API documents. */
function apolloPerson(o: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '66a1f0c2b7c3d90001e4a111', email_status: 'verified', photo_url: null, twitter_url: null, github_url: null, facebook_url: null,
    headline: null, state: null, seniority: 'head', departments: ['finance'], employment_history: [], ...o,
  };
}

const KEMI = apolloPerson({
  name: 'Kemi Eze', first_name: 'Kemi', last_name: 'Eze', title: 'Head of Finance Operations',
  email: 'kemi@okopay.com', email_status: 'verified', linkedin_url: 'http://www.linkedin.com/in/kemi-eze-5a2b1c',
  city: 'Lagos', country: 'Nigeria',
  organization: { id: '5e66b6381e05b4008c8331b8', name: 'Oko Pay', website_url: 'http://www.okopay.com', primary_domain: 'okopay.com', linkedin_url: 'http://www.linkedin.com/company/oko-pay' },
});
const FEMI = apolloPerson({
  name: 'Femi Ade', first_name: 'Femi', last_name: 'Ade', title: 'VP Engineering',
  email: 'email_not_unlocked@ledgerly.io', email_status: 'unavailable', linkedin_url: 'http://www.linkedin.com/in/femi-ade',
  city: 'London', country: 'United Kingdom',
  organization: { id: '5e66b6381e05b4008c8331b9', name: 'Ledgerly', website_url: 'http://ledgerly.io', primary_domain: 'ledgerly.io' },
});
const SADE = apolloPerson({
  name: 'Sade Bello', first_name: 'Sade', last_name: 'Bello', title: 'Finance Lead', email: null, email_status: null,
  linkedin_url: null, organization: null,
});

let server: Server;
let base: string;
let seen: Seen[];
let respond: (req: Seen) => { status: number; body: unknown; raw?: string };

beforeEach(async () => {
  seen = [];
  respond = () => ({ status: 200, body: { people: [KEMI, FEMI, SADE], pagination: { page: 1, per_page: 25, total_entries: 1432, total_pages: 58 } } });
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(s);
      const r = respond(s);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.raw ?? JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('ApolloSource against a local Apollo-shaped server (real fetch)', () => {
  it('sends Apollo\'s people API search request: POST, x-api-key, JSON body', async () => {
    await new ApolloSource('key-123', undefined, base).search({ query: 'reconciliation', titles: ['Head of Finance', 'CFO'], count: 25 });
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/mixed_people/api_search');
    expect(req.headers['x-api-key']).toBe('key-123');
    expect(req.headers['content-type']).toMatch(/^application\/json/);
    expect(req.headers['accept']).toMatch(/application\/json/);
    expect(JSON.parse(req.body)).toEqual({ q_keywords: 'reconciliation', person_titles: ['Head of Finance', 'CFO'], per_page: 25, page: 1 });
  });

  it('leaves out an empty keyword search and an empty titles list', async () => {
    await new ApolloSource('k', undefined, base).search({ query: null, titles: [], count: 10 });
    expect(JSON.parse(seen[0]!.body)).toEqual({ per_page: 10, page: 1 });
  });

  it('maps people: name, role, company, LinkedIn, email; drops locked emails; total from pagination', async () => {
    const { total, people } = await new ApolloSource('k', undefined, base).search({ query: 'finance', titles: [], count: 25 });
    expect(total).toBe(1432);
    expect(people).toEqual([
      { name: 'Kemi Eze', firstName: 'Kemi', role: 'Head of Finance Operations', company: 'Oko Pay', linkedinUrl: 'http://www.linkedin.com/in/kemi-eze-5a2b1c', email: 'kemi@okopay.com', source: 'apollo' },
      { name: 'Femi Ade', firstName: 'Femi', role: 'VP Engineering', company: 'Ledgerly', linkedinUrl: 'http://www.linkedin.com/in/femi-ade', source: 'apollo' },
      { name: 'Sade Bello', firstName: 'Sade', role: 'Finance Lead', source: 'apollo' },
    ]);
    expect(people[1]).not.toHaveProperty('email');
  });

  it('builds the name from first and last when "name" is missing, and skips an entry with no name at all', async () => {
    respond = () => ({ status: 200, body: { people: [apolloPerson({ first_name: 'Amaka', last_name: 'Obi', linkedin_url: 'http://www.linkedin.com/in/amaka-obi' }), apolloPerson({ title: 'CFO' })], pagination: { total_entries: 2 } } });
    const { people } = await new ApolloSource('k', undefined, base).search({ query: null, titles: [], count: 5 });
    expect(people.map((p) => p.name)).toEqual(['Amaka Obi']);
  });

  it('copes with the search-only shape, where the last name is hidden and email and LinkedIn are not returned', async () => {
    respond = () => ({
      status: 200,
      body: {
        total_entries: 90,
        people: [{ id: 'abc', first_name: 'Kemi', last_name_obfuscated: 'Ez***', title: 'Head of Finance', has_email: true, organization: { name: 'Oko Pay', has_industry: true } }],
      },
    });
    const { total, people } = await new ApolloSource('k', undefined, base).search({ query: null, titles: [], count: 5 });
    expect(total).toBe(90);
    expect(people).toEqual([{ name: 'Kemi', firstName: 'Kemi', role: 'Head of Finance', company: 'Oko Pay', source: 'apollo' }]);
  });

  it('falls back to the number of people when Apollo gives no total', async () => {
    respond = () => ({ status: 200, body: { people: [KEMI] } });
    expect((await new ApolloSource('k', undefined, base).search({ query: null, titles: [], count: 5 })).total).toBe(1);
    respond = () => ({ status: 200, body: {} });
    expect(await new ApolloSource('k', undefined, base).search({ query: null, titles: [], count: 5 })).toEqual({ total: 0, people: [] });
  });

  it('asks for more pages, 100 at a time, when more than 100 people are wanted, and stops at the count', async () => {
    const page = (n: number, size: number) => Array.from({ length: size }, (_, i) => apolloPerson({ name: `Person ${n}-${i}`, email: `p${n}-${i}@x.example` }));
    respond = (req) => {
      const { page: n } = JSON.parse(req.body) as { page: number };
      return { status: 200, body: { people: page(n, 100), pagination: { page: n, per_page: 100, total_entries: 4000, total_pages: 40 } } };
    };
    const { total, people } = await new ApolloSource('k', undefined, base).search({ query: 'finance', titles: [], count: 150 });
    expect(total).toBe(4000);
    expect(people).toHaveLength(150);
    expect(seen.map((s) => JSON.parse(s.body))).toEqual([
      { q_keywords: 'finance', per_page: 100, page: 1 },
      { q_keywords: 'finance', per_page: 100, page: 2 },
    ]);
  });

  it('stops paging when Apollo runs out of people', async () => {
    respond = () => ({ status: 200, body: { people: [KEMI], pagination: { page: 1, per_page: 100, total_entries: 1, total_pages: 1 } } });
    const { people } = await new ApolloSource('k', undefined, base).search({ query: null, titles: [], count: 250 });
    expect(people).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it.each([401, 403, 422, 429, 500])('throws "Apollo search failed: %i"', async (status) => {
    respond = () => ({ status, body: { error: 'nope' } });
    await expect(new ApolloSource('k', undefined, base).search({ query: 'x', titles: [], count: 5 })).rejects.toThrow(`Apollo search failed: ${status}`);
  });

  it('never puts the key in an error message', async () => {
    respond = () => ({ status: 401, body: { error: 'invalid key super-secret-key' } });
    const err = await new ApolloSource('super-secret-key', undefined, base).search({ query: 'x', titles: [], count: 5 }).catch((e: Error) => e);
    expect((err as Error).message).toBe('Apollo search failed: 401');
  });

  it('throws a plain error when the answer is not JSON or Apollo cannot be reached', async () => {
    respond = () => ({ status: 200, body: null, raw: '<html>maintenance</html>' });
    await expect(new ApolloSource('k', undefined, base).search({ query: 'x', titles: [], count: 5 })).rejects.toThrow('Apollo search failed: unreadable answer');
    await expect(new ApolloSource('k', undefined, 'http://127.0.0.1:1').search({ query: 'x', titles: [], count: 5 })).rejects.toThrow(/^Apollo search failed: /);
  });

  it('defaults to Apollo\'s own address and the global fetch, and accepts a fake fetch', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fake: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ people: [KEMI], pagination: { total_entries: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { people } = await new ApolloSource('k', fake).search({ query: 'x', titles: [], count: 5 });
    expect(people).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.apollo.io/api/v1/mixed_people/api_search');
    expect(calls[0]?.init?.method).toBe('POST');
  });
});
