import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApolloError, ApolloSource } from './apollo.js';

interface Seen { method: string; url: string; path: string; query: URLSearchParams; headers: IncomingHttpHeaders; body: string }
type Reply = { status: number; body: unknown; raw?: string };

/** One entry of Apollo's `people` list from the People API Search: no email, no LinkedIn, last name hidden. */
function searchPerson(o: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '66a1f0c2b7c3d90001e4a111', first_name: 'Kemi', last_name_obfuscated: 'Ez***', title: 'Head of Finance Operations',
    last_refreshed_at: '2026-10-20T08:11:03.000+00:00', has_email: true, has_city: true, has_state: false, has_country: true,
    has_direct_phone: 'Maybe: please request direct dial via people/bulk_match',
    organization: { name: 'Oko Pay', has_industry: true, has_phone: false, has_city: true, has_state: false, has_country: true, has_zip_code: false, has_revenue: true, has_employee_count: true },
    ...o,
  };
}

/** One entry of `matches` from Bulk People Enrichment. */
function match(o: Record<string, unknown>): Record<string, unknown> {
  return {
    id: '66a1f0c2b7c3d90001e4a111', first_name: 'Kemi', last_name: 'Eze', name: 'Kemi Eze', linkedin_url: 'http://www.linkedin.com/in/kemi-eze-5a2b1c',
    title: 'Head of Finance Operations', email_status: 'verified', email: 'kemi@okopay.com', headline: 'Finance at Oko Pay',
    organization: { id: '5e66b6381e05b4008c8331b8', name: 'Oko Pay', website_url: 'http://www.okopay.com', primary_domain: 'okopay.com' },
    city: 'Lagos', state: null, country: 'Nigeria', match_confidence: 'high', ...o,
  };
}

let server: Server;
let base: string;
let seen: Seen[];
let respond: (req: Seen) => Reply;

beforeEach(async () => {
  seen = [];
  respond = () => ({ status: 200, body: { people: [searchPerson({})], pagination: { page: 1, per_page: 25, total_entries: 1432, total_pages: 58 } } });
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://apollo.test');
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
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

const apollo = (key = 'key-123') => new ApolloSource(key, undefined, base);
const find = (o: Partial<{ query: string | null; titles: string[]; count: number }> = {}) => ({ query: null, titles: [], count: 25, ...o });

describe('ApolloSource.search against a local Apollo-shaped server (real fetch)', () => {
  it('sends the People API Search request: POST, every parameter in the query string, x-api-key, no body', async () => {
    await apollo().search(find({ query: 'reconciliation', titles: ['Head of Finance', 'CFO & Co'], count: 25 }));
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/api/v1/mixed_people/api_search');
    expect(req.headers['x-api-key']).toBe('key-123');
    expect(req.headers['accept']).toMatch(/application\/json/);
    expect(req.body).toBe('');
    expect(req.query.get('q_keywords')).toBe('reconciliation');
    expect(req.query.getAll('person_titles[]')).toEqual(['Head of Finance', 'CFO & Co']);
    expect(req.query.get('per_page')).toBe('25');
    expect(req.query.get('page')).toBe('1');
    expect([...new Set(req.query.keys())].sort()).toEqual(['page', 'per_page', 'person_titles[]', 'q_keywords']);
    // Brackets are written the way Apollo's own examples write them.
    expect(req.url).toContain('person_titles[]=Head%20of%20Finance&person_titles[]=CFO%20%26%20Co');
  });

  it('leaves out an empty keyword search and an empty titles list', async () => {
    await apollo().search(find({ count: 10 }));
    expect([...seen[0]!.query.entries()]).toEqual([['per_page', '10'], ['page', '1']]);
  });

  it('returns free previews: id, first name, hidden last name, title, company, hasEmail; total from the pagination', async () => {
    respond = () => ({
      status: 200,
      body: {
        people: [
          searchPerson({}),
          searchPerson({ id: 'b2', first_name: 'Femi', last_name_obfuscated: 'A**', title: null, has_email: false, organization: null }),
          searchPerson({ id: 'c3', first_name: null, last_name_obfuscated: null, title: 'CFO', organization: { name: '  ' } }),
        ],
        pagination: { page: 1, per_page: 25, total_entries: 1432, total_pages: 58 },
      },
    });
    const { total, previews } = await apollo().search(find());
    expect(total).toBe(1432);
    expect(previews).toEqual([
      { apolloId: '66a1f0c2b7c3d90001e4a111', firstName: 'Kemi', lastNameObfuscated: 'Ez***', title: 'Head of Finance Operations', company: 'Oko Pay', hasEmail: true },
      { apolloId: 'b2', firstName: 'Femi', lastNameObfuscated: 'A**', title: null, company: null, hasEmail: false },
      { apolloId: 'c3', firstName: '', lastNameObfuscated: '', title: 'CFO', company: null, hasEmail: true },
    ]);
  });

  it('skips an entry with no id, since it could not be enriched', async () => {
    respond = () => ({ status: 200, body: { people: [searchPerson({ id: undefined }), searchPerson({})], total_entries: 2 } });
    expect((await apollo().search(find())).previews).toHaveLength(1);
  });

  it('falls back to the number of previews when Apollo gives no total, and to nothing for an empty answer', async () => {
    respond = () => ({ status: 200, body: { people: [searchPerson({})] } });
    expect((await apollo().search(find())).total).toBe(1);
    respond = () => ({ status: 200, body: { total_entries: 90, people: [searchPerson({})] } });
    expect((await apollo().search(find())).total).toBe(90);
    respond = () => ({ status: 200, body: {} });
    expect(await apollo().search(find())).toEqual({ total: 0, previews: [] });
  });

  it('asks for more pages, 100 at a time, when more than 100 people are wanted, and stops at the count', async () => {
    respond = (req) => {
      const n = Number(req.query.get('page'));
      return { status: 200, body: { people: Array.from({ length: 100 }, (_, i) => searchPerson({ id: `p${n}-${i}` })), pagination: { page: n, per_page: 100, total_entries: 4000, total_pages: 40 } } };
    };
    const { total, previews } = await apollo().search(find({ query: 'finance', count: 150 }));
    expect(total).toBe(4000);
    expect(previews).toHaveLength(150);
    expect(seen.map((s) => [s.query.get('page'), s.query.get('per_page'), s.query.get('q_keywords')])).toEqual([['1', '100', 'finance'], ['2', '100', 'finance']]);
  });

  it('stops paging when Apollo runs out of people', async () => {
    respond = () => ({ status: 200, body: { people: [searchPerson({})], pagination: { page: 1, per_page: 100, total_entries: 1, total_pages: 1 } } });
    expect((await apollo().search(find({ count: 250 }))).previews).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it.each([
    [401, 'bad_key', "Apollo didn't accept the API key. Check it in Your Callum."],
    [403, 'not_allowed', "This Apollo key can't search people. Use a master key or allow People Search."],
    [422, 'bad_search', "Apollo couldn't understand that search. Try fewer words."],
    [429, 'rate_limited', "Apollo's hourly search limit is reached. Try again in an hour."],
    [500, 'failed', 'Apollo search failed.'],
    [503, 'failed', 'Apollo search failed.'],
  ] as const)('maps status %i to a plain sentence', async (status, code, message) => {
    respond = () => ({ status, body: { error: 'invalid key super-secret-key' } });
    const err = await apollo('super-secret-key').search(find()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApolloError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ code, status, message });
    expect((err as Error).message).not.toContain('super-secret-key');
  });

  it('says "Apollo search failed." when the answer is not JSON or Apollo cannot be reached', async () => {
    respond = () => ({ status: 200, body: null, raw: '<html>maintenance</html>' });
    await expect(apollo().search(find())).rejects.toMatchObject({ code: 'failed', status: 200, message: 'Apollo search failed.' });
    await expect(new ApolloSource('k', undefined, 'http://127.0.0.1:1').search(find())).rejects.toMatchObject({ code: 'failed', status: null, message: 'Apollo search failed.' });
  });

  it('defaults to Apollo\'s own address and accepts a fake fetch', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fake: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ people: [searchPerson({})], pagination: { total_entries: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { previews } = await new ApolloSource('k', fake).search(find({ query: 'x' }));
    expect(previews).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.apollo.io/api/v1/mixed_people/api_search?q_keywords=x&per_page=25&page=1');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
  });
});

describe('ApolloSource.enrich against a local Apollo-shaped server (real fetch)', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
  /** Answers each batch with one match per id, 1 credit each, as bulk_match does. */
  const enrichAll = (make: (id: string, i: number) => Record<string, unknown> | null = (id) => match({ id, name: `Person ${id}`, email: `${id}@x.example` })) => {
    respond = (req) => {
      const details = (JSON.parse(req.body) as { details: Array<{ id: string }> }).details;
      const matches = details.map((d, i) => make(d.id, i));
      return { status: 200, body: { status: 'success', total_requested_enrichments: details.length, unique_enriched_records: matches.filter(Boolean).length, missing_records: matches.filter((m) => m === null).length, credits_consumed: matches.filter(Boolean).length, matches } };
    };
  };

  it('sends bulk_match: POST, x-api-key, JSON body {details:[{id}]}, no query string and so no reveal flags', async () => {
    enrichAll();
    await apollo().enrich(['a1', 'b2']);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/people/bulk_match');
    expect(req.headers['x-api-key']).toBe('key-123');
    expect(req.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(req.body)).toEqual({ details: [{ id: 'a1' }, { id: 'b2' }] });
  });

  it('works in batches of 10: 23 ids make 3 calls, and credits are summed', async () => {
    enrichAll();
    const { people, creditsUsed } = await apollo().enrich(ids(23));
    expect(seen.map((s) => (JSON.parse(s.body) as { details: unknown[] }).details.length)).toEqual([10, 10, 3]);
    expect(seen.flatMap((s) => (JSON.parse(s.body) as { details: Array<{ id: string }> }).details.map((d) => d.id))).toEqual(ids(23));
    expect(people).toHaveLength(23);
    expect(creditsUsed).toBe(23);
  });

  it('maps a match: full name, first name, role, company, LinkedIn, verified email, source apollo', async () => {
    respond = () => ({ status: 200, body: { matches: [match({})], credits_consumed: 1 } });
    expect(await apollo().enrich(['x'])).toEqual({
      people: [{ name: 'Kemi Eze', firstName: 'Kemi', role: 'Head of Finance Operations', company: 'Oko Pay', linkedinUrl: 'http://www.linkedin.com/in/kemi-eze-5a2b1c', email: 'kemi@okopay.com', source: 'apollo' }],
      creditsUsed: 1,
    });
  });

  it('skips unmatched entries (null) without losing the ones around them', async () => {
    respond = () => ({ status: 200, body: { matches: [match({ name: 'First One' }), null, match({ name: 'Third One' })], credits_consumed: 2, missing_records: 1 } });
    const { people, creditsUsed } = await apollo().enrich(['a', 'b', 'c']);
    expect(people.map((p) => p.name)).toEqual(['First One', 'Third One']);
    expect(creditsUsed).toBe(2);
  });

  it.each([
    ['verified', true], ['likely_to_engage', true], ['extrapolated', false], ['unavailable', false], ['guessed', false], [null, false], [undefined, false],
  ])('email_status %s: email kept = %s', async (email_status, kept) => {
    respond = () => ({ status: 200, body: { matches: [match({ email_status })], credits_consumed: 1 } });
    const person = (await apollo().enrich(['x'])).people[0]!;
    if (kept) expect(person.email).toBe('kemi@okopay.com');
    else expect(person).not.toHaveProperty('email');
    expect(person.linkedinUrl).toBe('http://www.linkedin.com/in/kemi-eze-5a2b1c');
  });

  it('drops the locked placeholder email even when the status says verified', async () => {
    respond = () => ({ status: 200, body: { matches: [match({ email: 'email_not_unlocked@okopay.com', email_status: 'verified' })], credits_consumed: 1 } });
    expect(await apollo().enrich(['x'])).toMatchObject({ people: [{ name: 'Kemi Eze' }] });
    expect((await apollo().enrich(['x'])).people[0]).not.toHaveProperty('email');
  });

  it('builds the name from first and last when "name" is missing, and skips a match with no name at all', async () => {
    respond = () => ({ status: 200, body: { matches: [match({ name: undefined, first_name: 'Amaka', last_name: 'Obi' }), match({ name: undefined, first_name: undefined, last_name: undefined })], credits_consumed: 2 } });
    expect((await apollo().enrich(['a', 'b'])).people.map((p) => p.name)).toEqual(['Amaka Obi']);
  });

  it('does nothing, and asks nothing, for an empty list', async () => {
    expect(await apollo().enrich([])).toEqual({ people: [], creditsUsed: 0 });
    expect(seen).toEqual([]);
  });

  it('drops repeated ids so a credit is not spent twice', async () => {
    enrichAll();
    await apollo().enrich(['a', 'b', 'a']);
    expect(JSON.parse(seen[0]!.body)).toEqual({ details: [{ id: 'a' }, { id: 'b' }] });
  });

  it.each([
    [401, 'bad_key', "Apollo didn't accept the API key. Check it in Your Callum."],
    [403, 'not_allowed', "This Apollo key can't look up people. Check its permissions in Apollo."],
    [422, 'bad_search', "Apollo couldn't understand that search. Try fewer words."],
    [429, 'rate_limited', "Apollo's hourly search limit is reached. Try again in an hour."],
    [500, 'failed', 'Apollo lookup failed. Try again in a minute.'],
  ] as const)('maps status %i to a plain sentence in lookup words, never showing the key', async (status, code, message) => {
    respond = () => ({ status, body: { error: 'bad key super-secret-key' } });
    const err = await apollo('super-secret-key').enrich(['x']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApolloError);
    expect(err).toMatchObject({ code, status, message });
    expect((err as Error).message).not.toContain('super-secret-key');
  });

  it('keeps what earlier batches already enriched (and cost) when a later batch fails', async () => {
    let call = 0;
    respond = (req) => {
      call++;
      if (call === 2) return { status: 429, body: {} };
      const details = (JSON.parse(req.body) as { details: Array<{ id: string }> }).details;
      return { status: 200, body: { matches: details.map((d) => match({ id: d.id, name: `P ${d.id}` })), credits_consumed: details.length } };
    };
    const err = (await apollo().enrich(ids(25)).catch((e: unknown) => e)) as ApolloError;
    expect(err.code).toBe('rate_limited');
    expect(err.partial?.creditsUsed).toBe(10);
    expect(err.partial?.people).toHaveLength(10);
    expect(seen).toHaveLength(2);
  });

  it('says "Apollo lookup failed. Try again in a minute." for an answer that is not JSON, or when Apollo cannot be reached', async () => {
    respond = () => ({ status: 200, body: null, raw: 'nope' });
    await expect(apollo().enrich(['x'])).rejects.toMatchObject({ code: 'failed', status: 200, message: 'Apollo lookup failed. Try again in a minute.' });
    await expect(new ApolloSource('k', undefined, 'http://127.0.0.1:1').enrich(['x'])).rejects.toMatchObject({ code: 'failed', status: null, message: 'Apollo lookup failed. Try again in a minute.' });
  });

  it('drops empty and blank ids before batching, and asks nothing when none are left', async () => {
    enrichAll();
    await apollo().enrich(['', '  ', 'a', ' b ', '\n']);
    expect(JSON.parse(seen[0]!.body)).toEqual({ details: [{ id: 'a' }, { id: 'b' }] });
    expect(await apollo().enrich(['', '   '])).toEqual({ people: [], creditsUsed: 0 });
    expect(seen).toHaveLength(1);
  });

  it('keeps the search wording for search failures', async () => {
    respond = () => ({ status: 403, body: {} });
    await expect(apollo().search(find())).rejects.toMatchObject({ message: "This Apollo key can't search people. Use a master key or allow People Search." });
  });
});
