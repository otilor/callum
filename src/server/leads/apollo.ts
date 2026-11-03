import type { PersonLead } from '../../shared/types.js';
import { cleanEmail } from './parse.js';

const APOLLO_URL = 'https://api.apollo.io';
const SEARCH_PATH = '/api/v1/mixed_people/api_search';
const ENRICH_PATH = '/api/v1/people/bulk_match';
/** People API Search returns at most this many people per page. */
const PAGE_MAX = 100;
/** Bulk People Enrichment takes at most this many people per call. */
const ENRICH_BATCH = 10;
/** A search for a few hundred people never needs more requests than this. */
const MAX_PAGES = 10;
const TIMEOUT_MS = 20_000;
/** Emails Apollo stands behind; anything else is a guess and would bounce. */
const TRUSTED_EMAIL_STATUS = new Set(['verified', 'likely_to_engage']);

export type ApolloOperation = 'search' | 'enrich';
export type ApolloErrorCode = 'bad_key' | 'not_allowed' | 'bad_search' | 'rate_limited' | 'failed';

/** A failed Apollo call, with a message that is already plain words and never contains the key. */
export class ApolloError extends Error {
  /** For `enrich`: what earlier batches already found and cost before this one failed. */
  partial?: ApolloEnrichment;
  constructor(readonly code: ApolloErrorCode, readonly status: number | null, op: ApolloOperation = 'search') {
    super(op === 'enrich' ? ENRICH_MESSAGES[code] : MESSAGES[code]);
    this.name = 'ApolloError';
  }
}

const MESSAGES: Record<ApolloErrorCode, string> = {
  bad_key: "Apollo didn't accept the API key. Check it in Your Callum.",
  not_allowed: "This Apollo key can't search people. Use a master key or allow People Search.",
  bad_search: "Apollo couldn't understand that search. Try fewer words.",
  rate_limited: "Apollo's hourly search limit is reached. Try again in an hour.",
  failed: 'Apollo search failed.',
};

/** The same failures, as they read when looking up the people the user kept. */
const ENRICH_MESSAGES: Record<ApolloErrorCode, string> = {
  ...MESSAGES,
  bad_search: "Apollo couldn't look up the people you chose. Search again and pick them from the new results.",
  rate_limited: "Apollo's lookup limit is reached. Try again in an hour.",
  not_allowed: "This Apollo key can't look up people. Check its permissions in Apollo.",
  failed: 'Apollo lookup failed. Try again in a minute.',
};

const CODE_BY_STATUS: Record<number, ApolloErrorCode> = { 401: 'bad_key', 403: 'not_allowed', 422: 'bad_search', 429: 'rate_limited' };

/** A free search result: enough to choose from, not enough to write to. */
export interface ApolloPreview {
  apolloId: string;
  firstName: string;
  /** Apollo hides most of the last name, for example "Ez***". */
  lastNameObfuscated: string;
  title: string | null;
  company: string | null;
  hasEmail: boolean;
}
export interface ApolloQuery {
  query: string | null; titles: string[]; count: number;
  /** Company sizes as Apollo writes them, `21,200`. */
  employeeRanges?: string[];
  /** Where the person is, `Accra`. */
  personLocations?: string[];
  /** True for an Apollo id Callum has already looked up. Those people are left out and later pages are read for new ones. */
  exclude?: (apolloId: string) => boolean;
}
/** `skippedKnown` counts the people Apollo found who were left out because `exclude` knew them. */
export interface ApolloSearchResult { total: number; previews: ApolloPreview[]; skippedKnown: number }
export interface ApolloEnrichment { people: PersonLead[]; creditsUsed: number }

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function toPreview(raw: unknown): ApolloPreview | null {
  const p = record(raw);
  const apolloId = text(p.id);
  if (!apolloId) return null;
  return {
    apolloId,
    firstName: text(p.first_name) ?? '',
    lastNameObfuscated: text(p.last_name_obfuscated) ?? '',
    title: text(p.title),
    company: text(record(p.organization).name),
    hasEmail: p.has_email === true,
  };
}

/** One entry of `matches` from bulk_match. Null when Apollo knows no such person. */
function toLead(raw: unknown): PersonLead | null {
  const p = record(raw);
  const first = text(p.first_name);
  const last = text(p.last_name);
  const name = text(p.name) ?? ([first, last].filter(Boolean).join(' ') || null);
  if (!name) return null;
  const lead: PersonLead = { name, source: 'apollo' };
  const apolloId = text(p.id);
  if (apolloId) lead.apolloId = apolloId;
  if (first) lead.firstName = first;
  const role = text(p.title);
  if (role) lead.role = role;
  const company = text(record(p.organization).name);
  if (company) lead.company = company;
  const linkedin = text(p.linkedin_url);
  if (linkedin) lead.linkedinUrl = linkedin;
  const status = text(p.email_status);
  const email = status && TRUSTED_EMAIL_STATUS.has(status) ? cleanEmail(text(p.email)) : null;
  if (email) lead.email = email;
  return lead;
}

/**
 * Apollo (api.apollo.io). `search` is People API Search: free, returns previews with no email or LinkedIn.
 * `enrich` is Bulk People Enrichment: about one credit per person found, returns the email and LinkedIn.
 * The key goes in the `x-api-key` header and is never part of an error.
 */
export class ApolloSource {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly apiKey: string, fetchImpl?: typeof fetch, private readonly baseUrl: string = APOLLO_URL) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async search(q: ApolloQuery): Promise<ApolloSearchResult> {
    const want = Math.max(1, Math.floor(q.count));
    const perPage = Math.min(want, PAGE_MAX);
    const previews: ApolloPreview[] = [];
    const seen = new Set<string>();
    let skippedKnown = 0;
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      // Apollo's examples write the brackets of array parameters as they are, so this is built by hand.
      const params: string[] = [];
      if (q.query) params.push(`q_keywords=${encodeURIComponent(q.query)}`);
      for (const t of q.titles) params.push(`person_titles[]=${encodeURIComponent(t)}`);
      for (const r of q.employeeRanges ?? []) params.push(`organization_num_employees_ranges[]=${encodeURIComponent(r)}`);
      for (const l of q.personLocations ?? []) params.push(`person_locations[]=${encodeURIComponent(l)}`);
      params.push(`per_page=${perPage}`, `page=${page}`);
      const data = await this.post('search', `${SEARCH_PATH}?${params.join('&')}`);
      const found = Array.isArray(data.people) ? data.people : [];
      const pagination = record(data.pagination);
      const entries = pagination.total_entries ?? data.total_entries;
      const pages = pagination.total_pages;
      for (const raw of found) {
        const preview = toPreview(raw);
        if (!preview || seen.has(preview.apolloId)) continue;
        seen.add(preview.apolloId);
        if (q.exclude?.(preview.apolloId)) skippedKnown++;
        else previews.push(preview);
      }
      total = typeof entries === 'number' ? entries : previews.length;
      const lastPage = typeof pages === 'number' && page >= pages;
      if (previews.length >= want || found.length < perPage || lastPage) break;
    }
    return { total, previews: previews.slice(0, want), skippedKnown };
  }

  /** Looks the chosen people up by their Apollo id, ten at a time. Spends credits. */
  async enrich(ids: string[]): Promise<ApolloEnrichment> {
    // An id that is not text can never be looked up; say so in words rather than failing with a TypeError.
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new ApolloError('bad_search', null, 'enrich');
    const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))];
    const result: ApolloEnrichment = { people: [], creditsUsed: 0 };
    for (let i = 0; i < unique.length; i += ENRICH_BATCH) {
      let data: Record<string, unknown>;
      try {
        data = await this.post('enrich', ENRICH_PATH, { details: unique.slice(i, i + ENRICH_BATCH).map((id) => ({ id })) });
      } catch (e) {
        if (e instanceof ApolloError) e.partial = { people: [...result.people], creditsUsed: result.creditsUsed };
        throw e;
      }
      for (const m of Array.isArray(data.matches) ? data.matches : []) {
        const lead = toLead(m);
        if (lead) result.people.push(lead);
      }
      if (typeof data.credits_consumed === 'number') result.creditsUsed += data.credits_consumed;
    }
    return result;
  }

  private async post(op: ApolloOperation, pathAndQuery: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
        method: 'POST',
        headers: {
          accept: 'application/json', 'cache-control': 'no-cache', 'x-api-key': this.apiKey,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ApolloError('failed', null, op);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new ApolloError(CODE_BY_STATUS[res.status] ?? 'failed', res.status, op);
    }
    try {
      return record(await res.json());
    } catch {
      throw new ApolloError('failed', res.status, op);
    }
  }
}
