import { isIP } from 'node:net';
import { z } from 'zod';
import type { PersonLead } from '../../shared/types.js';
import { ModelError, type Model } from '../ai/model.js';
import { normalizeLinkedinUrl, normalizeXHandle } from '../db/handles.js';
import { cleanEmail } from './parse.js';

/** What the user asked for, in their words. */
export interface FindQuery {
  /** "Heads of finance at fintechs in Lagos". */
  description: string;
  count: number;
  /** People already in Callum, as "Name (Company)", so they are not found again. */
  known?: string[];
}

/** Finds real people from a description. Each one has a way to reach them: an email, a LinkedIn profile or an X handle. */
export interface PeopleFinder {
  find(q: FindQuery): Promise<PersonLead[]>;
}

/** A failed search, in words for the user. */
export class FindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FindError';
  }
}

/** The most people one search looks for. */
export const MAX_FIND = 50;
/** At most this many known people are named in the prompt; the rest are caught when they are added. */
const MAX_KNOWN = 300;

const found = z.object({
  people: z.array(z.object({
    name: z.string(),
    role: z.string().nullable(),
    company: z.string().nullable(),
    location: z.string().nullable(),
    linkedinUrl: z.string().nullable(),
    xHandle: z.string().nullable(),
    email: z.string().nullable(),
    emailSourceUrl: z.string().nullable(),
    sourceUrl: z.string(),
    why: z.string(),
  })),
});
type Found = z.infer<typeof found>['people'][number];

const SYSTEM = [
  'You find real people for Callum, an app that helps one person (the sender) say hello to people they would like to meet.',
  'You get a description of who the sender wants to meet. Use web search, and read pages when you can, to find real people who match it today.',
  '',
  'How to work:',
  '1. Find candidates: news of appointments, team and about pages, conference speaker lists, podcasts, company announcements, and LinkedIn profiles in search results.',
  '2. For each candidate, find a way to reach them. Search site:linkedin.com/in with their name and company: a linkedin.com/in/... address in a search result is their profile when the result names that person. Also look for their own X handle.',
  '3. Keep going until you have the number asked. Expect to make 10 to 25 searches: try other companies, other titles that mean the same job, other cities nearby when the description allows it, and lists such as "top fintech startups in <city>" to find more companies whose leaders you can look up.',
  '4. Report everyone you can reach, up to the number asked.',
  '',
  'Rules, without exception:',
  '- Only report people you saw named on a real page or search result in this session. Never invent a person, role, company, link, handle or email.',
  '- sourceUrl: the page or search result where you found the person.',
  '- linkedinUrl: their own LinkedIn profile address exactly as it appeared in a search result or on a page (any country subdomain is fine). Never build one from a name.',
  '- xHandle: their own X (Twitter) handle, only when you saw it, without the @.',
  '- email: only an address printed on a page you read, with emailSourceUrl set to that page. Never guess one from a pattern such as first@company.com. Most people have none: use null.',
  '- Callum reaches people by email, LinkedIn or X. Someone with none of the three is no use to the sender: keep looking for others instead.',
  '- Leave out anyone on the list of people the sender already knows.',
  '- Prefer people who hold the role now. When a page is old, check that they still do.',
  '- role: their job title only, as written on the page (for example "Head of Finance"). company: the company name only.',
  '- why: one short sentence about the person, from what you read: what they do and why they fit (for example "Leads finance at Kora, a payments company in Lagos."). It is shown to the sender and used when writing to them, so keep notes about your search out of it.',
  '- Stop when you have as many as asked, or when searching stops turning up new people. A shorter list of real people is better than a padded one, but an empty list is only right when you truly found nobody you could reach.',
].join('\n');

function publicPage(raw: string | null | undefined): URL | null {
  try {
    const url = new URL((raw ?? '').trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    // Only pages on the public web are read: no addresses, no names that point back into this computer or network.
    if (isIP(host) !== 0 || host === 'localhost' || !host.includes('.') || /\.(local|localhost|internal|home|lan)$/.test(host)) return null;
    return url;
  } catch {
    return null;
  }
}

const MAX_PAGE = 2_000_000;

/** The text of a public page, or null. */
export async function readPage(url: URL, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Callum (people finder)' } });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_PAGE) {
        await reader.cancel();
        break;
      }
    }
    return text;
  } catch {
    return null;
  }
}

/** Whether a page shows this address, written out plainly or with the @ as an HTML entity. */
export function pageShows(page: string, email: string): boolean {
  const text = page.replace(/&#0*64;|&#x0*40;|&commat;/gi, '@').replace(/%40/g, '@').toLowerCase();
  return text.includes(email.toLowerCase());
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  return t === '' || /^(n\/?a|null|none|unknown)$/i.test(t) ? null : t;
};

/** Claude's search on the web: through Claude Code on this computer, or the API with a key. */
export class ModelFinder implements PeopleFinder {
  constructor(private readonly model: Model, private readonly fetchImpl: typeof fetch = fetch, private readonly today: () => Date = () => new Date()) {}

  /**
   * Two searches start at once from different ends (pages about people, and profiles in search results), and one more
   * looks elsewhere when they found too few. Each knows who the others found, so nobody comes back twice.
   */
  async find(q: FindQuery): Promise<PersonLead[]> {
    const description = q.description.trim();
    if (description === '') throw new FindError('Describe who you want to meet first.');
    const count = Math.max(1, Math.min(MAX_FIND, Math.floor(q.count) || 1));
    const known = (q.known ?? []).slice(0, MAX_KNOWN);
    const people: PersonLead[] = [];
    const seen = new Set<string>();
    const keep = (leads: PersonLead[]) => {
      for (const lead of leads) {
        if (people.length >= count) return;
        const keys = [lead.email, lead.linkedinUrl, lead.xHandle && `x:${lead.xHandle}`, `${lead.name}|${lead.company ?? ''}`.toLowerCase()].filter(Boolean) as string[];
        if (keys.some((k) => seen.has(k))) continue;
        for (const k of keys) seen.add(k);
        people.push(lead);
      }
    };

    const half = Math.ceil(count / 2) + 1;
    const first = await Promise.allSettled([
      this.round(description, half, known, 'Start from pages about people: news of appointments, team and about pages, startup lists, conference speakers.'),
      this.round(description, half, known, 'Start from profiles: LinkedIn profiles (site:linkedin.com/in) and X profiles in search results.'),
    ]);
    const failed = first.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed && first.every((r) => r.status === 'rejected')) throw failed.reason;
    for (const r of first) if (r.status === 'fulfilled') keep(r.value);

    if (people.length < count && people.length > 0) {
      const found = people.map((p) => (p.company ? `${p.name} (${p.company})` : p.name));
      try {
        keep(await this.round(description, count - people.length, [...known, ...found],
          'Other searches already found the people listed as known. Look in places they did not: other companies, other titles for the same job, nearby cities when the description allows it.'));
      } catch {
        // The people already found are still worth showing.
      }
    }
    return people;
  }

  private async round(description: string, count: number, known: string[], angle: string): Promise<PersonLead[]> {
    const user = [
      `Who the sender wants to meet: ${description}`,
      `How many to find: ${count}`,
      `Where to start: ${angle}`,
      `Today: ${this.today().toISOString().slice(0, 10)}`,
      known.length > 0 ? `People the sender already knows (leave them out):\n${known.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    let out: z.infer<typeof found>;
    try {
      out = await this.model.research(found, SYSTEM, user, { maxSearches: Math.min(25, 8 + count) });
    } catch (err) {
      if (err instanceof ModelError) throw new FindError(err.message);
      throw err;
    }
    const leads: PersonLead[] = [];
    for (const raw of out.people) {
      const lead = await this.toLead(raw);
      if (lead) leads.push(lead);
    }
    return leads;
  }

  /** Keeps what can be trusted: links in the right shape, and an email only when its page really shows it. */
  private async toLead(raw: Found): Promise<PersonLead | null> {
    const name = clean(raw.name);
    if (!name || name.length > 80 || !/\p{L}/u.test(name)) return null;
    const source = publicPage(raw.sourceUrl);
    if (!source) return null;
    const linkedinUrl = normalizeLinkedinUrl(raw.linkedinUrl);
    const xHandle = normalizeXHandle(raw.xHandle);
    let email = cleanEmail(raw.email);
    if (email) {
      const page = publicPage(raw.emailSourceUrl) ?? source;
      const text = await readPage(page, this.fetchImpl);
      if (!text || !pageShows(text, email)) email = null;
    }
    if (!email && !linkedinUrl && !xHandle) return null;
    const role = clean(raw.role);
    const company = clean(raw.company);
    const why = clean(raw.why);
    const lead: PersonLead = { name, source: 'web', note: [why, `Found on ${source.hostname.replace(/^www\./, '')}.`].filter(Boolean).join(' ') };
    if (role) lead.role = role.slice(0, 120);
    if (company) lead.company = company.slice(0, 120);
    if (email) lead.email = email;
    if (linkedinUrl) lead.linkedinUrl = linkedinUrl;
    if (xHandle) lead.xHandle = xHandle;
    return lead;
  }
}
