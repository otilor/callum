import type { PersonLead } from '../../shared/types.js';
import { cleanEmail } from './parse.js';

const APOLLO_URL = 'https://api.apollo.io';
const SEARCH_PATH = '/api/v1/mixed_people/api_search';
/** Apollo returns at most this many people per page. */
const PAGE_MAX = 100;
/** A search for a few hundred people never needs more requests than this. */
const MAX_PAGES = 10;
const TIMEOUT_MS = 20_000;

export interface ApolloQuery { query: string | null; titles: string[]; count: number }
export interface ApolloResult { total: number; people: PersonLead[] }

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** One entry of Apollo's `people` list. Apollo hides the last name (`last_name_obfuscated`) on search-only results; that is never used. */
function toLead(raw: unknown): PersonLead | null {
  const p = record(raw);
  const first = text(p.first_name);
  const last = text(p.last_name);
  const name = text(p.name) ?? ([first, last].filter(Boolean).join(' ') || null);
  if (!name) return null;
  const lead: PersonLead = { name, source: 'apollo' };
  if (first) lead.firstName = first;
  const role = text(p.title);
  if (role) lead.role = role;
  const company = text(record(p.organization).name);
  if (company) lead.company = company;
  const linkedin = text(p.linkedin_url);
  if (linkedin) lead.linkedinUrl = linkedin;
  const email = cleanEmail(text(p.email));
  if (email) lead.email = email;
  return lead;
}

/** Apollo's people search (api.apollo.io). The key goes in the `x-api-key` header and is never part of an error message. */
export class ApolloSource {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly apiKey: string, fetchImpl?: typeof fetch, private readonly baseUrl: string = APOLLO_URL) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async search(q: ApolloQuery): Promise<ApolloResult> {
    const want = Math.max(1, Math.floor(q.count));
    const perPage = Math.min(want, PAGE_MAX);
    const people: PersonLead[] = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.request({
        ...(q.query ? { q_keywords: q.query } : {}),
        ...(q.titles.length > 0 ? { person_titles: q.titles } : {}),
        per_page: perPage,
        page,
      });
      const found = Array.isArray(data.people) ? data.people : [];
      const pagination = record(data.pagination);
      const entries = pagination.total_entries ?? data.total_entries;
      const pages = pagination.total_pages;
      for (const raw of found) {
        const lead = toLead(raw);
        if (lead) people.push(lead);
      }
      total = typeof entries === 'number' ? entries : people.length;
      const lastPage = typeof pages === 'number' && page >= pages;
      if (people.length >= want || found.length < perPage || lastPage) break;
    }
    return { total, people: people.slice(0, want) };
  }

  private async request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${SEARCH_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'cache-control': 'no-cache', 'x-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`Apollo search failed: ${e instanceof Error && e.name === 'TimeoutError' ? 'no answer in time' : 'could not reach Apollo'}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Apollo search failed: ${res.status}`);
    }
    try {
      return record(await res.json());
    } catch {
      throw new Error('Apollo search failed: unreadable answer');
    }
  }
}
