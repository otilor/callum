import { lookup as lookupCallback, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
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
  /** What the sender offers, so nobody is found at a company that sells the same thing. */
  offer?: string | null;
  /** The sender's own company website, so nobody is found who works there. */
  ownSite?: string | null;
  /** Called with the new people each time a search brings some, so they can be shown before the others are found. */
  onFound?: (people: PersonLead[]) => void;
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
    role: z.string().nullish(),
    company: z.string().nullish(),
    location: z.string().nullish(),
    linkedinUrl: z.string().nullish(),
    xHandle: z.string().nullish(),
    email: z.string().nullish(),
    emailSourceUrl: z.string().nullish(),
    sourceUrl: z.string(),
    why: z.string().nullish(),
  })),
});
type Found = z.infer<typeof found>['people'][number];

/** How many people each search is asked for: small, so each answers within a minute. */
const PER_ROUND = 5;
const MAX_ROUNDS = 6;
/** Where each search starts. Later ones reuse the last, told who was already found. */
const ANGLES = [
  'Start from pages about people: news of appointments, team and about pages, conference speakers.',
  'Start from profiles: LinkedIn profiles (site:linkedin.com/in) and X profiles in search results.',
  'Start from lists of companies: startup lists, accelerator batches, funding news. Then look up who leads them.',
  'Other searches already found the people listed as known. Look in places they did not: other companies, other titles for the same job, nearby cities when the description allows it.',
];

const SYSTEM = [
  'You find real people for Callum, an app that helps one person (the sender) say hello to people they would like to meet.',
  'You get a description of who the sender wants to meet. Use web search, and read pages when you can, to find real people who match it today.',
  '',
  'How to work:',
  '1. Find candidates: news of appointments, team and about pages, conference speaker lists, podcasts, company announcements, and LinkedIn profiles in search results.',
  '2. For each candidate, find a way to reach them. Search site:linkedin.com/in with their name and company: a linkedin.com/in/... address in a search result is their profile when the result names that person. Also look for their own X handle.',
  '3. Keep going until you have the number asked. Try other companies, other titles that mean the same job, other cities nearby when the description allows it, and lists such as "top fintech startups in <city>" to find more companies whose leaders you can look up. Do not read a page when a search result already shows what you need.',
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
  '- When you are told what the sender offers, find people who could buy or use it. Leave out anyone at a company that sells the same thing or competes with the sender, and anyone at the sender\'s own company: the sender never wants to write to a competitor.',
  '- Prefer people who hold the role now. When a page is old, check that they still do.',
  '- role: their job title only, as written on the page (for example "Head of Finance"). company: the company name only.',
  '- why: one short sentence about the person, from what you read: what they do and why they fit (for example "Leads finance at Kora, a payments company in Lagos."). It is shown to the sender and used when writing to them, so keep notes about your search out of it.',
  '- Stop when you have as many as asked, or when searching stops turning up new people. A shorter list of real people is better than a padded one, but an empty list is only right when you truly found nobody you could reach.',
].join('\n');

function publicPage(raw: string | null | undefined): URL | null {
  try {
    const url = new URL((raw ?? '').trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    const host = hostOf(url);
    // Only pages on the public web are read: no addresses, no names that point back into this computer or network.
    if (isIP(host) !== 0 || host === 'localhost' || !host.includes('.') || /\.(local|localhost|internal|home|lan|arpa)$/.test(host)) return null;
    return url;
  } catch {
    return null;
  }
}

const hostOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();

/** Addresses that are not on the public internet: this computer, the local network, and the ranges kept for special use. */
const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

export function privateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return PRIVATE.check(mapped[1], 'ipv4');
  const family = isIP(address);
  if (family === 0) return true;
  return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Looks a host name up. Tests replace it. */
export type Resolve = (host: string) => Promise<string[]>;
const resolveHost: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * The address lookup for page reads. It runs when the connection is made, so the address checked is the address
 * used: a name that answers with a public address first and a private one later cannot slip through.
 */
const publicLookup: LookupFunction = (host, options, callback) => {
  lookupCallback(host, { all: true, verbatim: true }, (err, found) => {
    const list = (found ?? []) as LookupAddress[];
    if (err || list.length === 0) return callback(err ?? new Error('no address'), '', 4);
    if (list.some((a) => privateAddress(a.address))) return callback(new Error('That page is not on the public internet.'), '', 4);
    if (options.all) return (callback as unknown as (e: null, all: LookupAddress[]) => void)(null, list);
    const first = list[0] as LookupAddress;
    callback(null, first.address, first.family);
  });
};

/** A fetch for page reads that never follows a redirect and connects only to public addresses. */
export const publicFetch = ((input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const req = send(url, { method: 'GET', headers, lookup: publicLookup, ...(init?.signal ? { signal: init.signal } : {}) }, (res: IncomingMessage) => {
    const status = res.statusCode ?? 502;
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(', ') : v);
    const empty = status < 200 || status === 204 || status === 205 || status === 304 || (status >= 300 && status < 400);
    if (empty) res.resume();
    try {
      resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status: status < 200 || status > 599 ? 502 : status, headers: out }));
    } catch (e) {
      reject(e);
    }
  });
  req.on('error', reject);
  req.end();
})) as typeof fetch;

const MAX_PAGE = 2_000_000;
const MAX_HOPS = 5;

/**
 * The text of a public page, and the address it ended at, or null. Every hop of a redirect is checked again, and a
 * name whose address is on this computer or its network is never fetched.
 */
export async function readPage(start: URL, fetchImpl: typeof fetch = publicFetch, resolve: Resolve = resolveHost): Promise<{ text: string; url: URL; hops: URL[] } | null> {
  try {
    let url: URL | null = start;
    const hops: URL[] = [];
    for (let hop = 0; hop <= MAX_HOPS && url; hop++) {
      const page = publicPage(url.href);
      if (!page) return null;
      hops.push(page);
      const addresses = await resolve(hostOf(page));
      if (addresses.length === 0 || addresses.some(privateAddress)) return null;
      const res = await fetchImpl(page, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Callum (people finder)' } });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location');
        await res.body?.cancel();
        url = next ? new URL(next, page) : null;
        continue;
      }
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
      return { text, url: page, hops };
    }
    return null;
  } catch {
    return null;
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a page shows this address as a whole address (not inside a longer one), written out plainly or with the @
 * as an HTML entity or escaped in a mailto link.
 */
export function pageShows(page: string, email: string): boolean {
  const text = page.replace(/&#0*64;|&#x0*40;|&commat;/gi, '@').replace(/%40/g, '@').toLowerCase();
  const re = new RegExp(`(^|[^a-z0-9._%+-])${escapeRe(email.toLowerCase())}(?![a-z0-9_-]|\\.[a-z0-9])`);
  return re.test(text);
}

/** Whether an address of a page carries this email, in any spelling: such a page could show it only because it was asked to. */
function urlCarries(url: URL, email: string): boolean {
  let text = url.href.toLowerCase();
  try {
    text = decodeURIComponent(text);
  } catch {
    // Left as it is.
  }
  return text.replace(/%40/g, '@').includes(email.toLowerCase()) || text.includes(email.toLowerCase().replace('@', '%40'));
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  return t === '' || /^(n\/?a|null|none|unknown)$/i.test(t) ? null : t;
};

/** Claude's search on the web: through Claude Code on this computer, or the API with a key. */
export class ModelFinder implements PeopleFinder {
  constructor(
    private readonly model: Model,
    private readonly fetchImpl: typeof fetch = publicFetch,
    private readonly today: () => Date = () => new Date(),
    private readonly resolve: Resolve = resolveHost,
  ) {}

  /**
   * Small searches from different ends, two at a time: pages about people, profiles in search results, lists of
   * companies, then elsewhere. Each one's people go to `onFound` as soon as it answers, so the first faces show in under
   * a minute while the rest are still being looked for. Later searches are told who the earlier ones found. It stops
   * once it has `count`, or when the first two found nobody. Anyone found twice is kept once.
   */
  async find(q: FindQuery): Promise<PersonLead[]> {
    const description = q.description.trim();
    if (description === '') throw new FindError('Describe who you want to meet first.');
    const count = Math.max(1, Math.min(MAX_FIND, Math.floor(q.count) || 1));
    const known = (q.known ?? []).slice(0, MAX_KNOWN);
    const people: PersonLead[] = [];
    const seen = new Set<string>();
    const keep = (leads: PersonLead[]): PersonLead[] => {
      const fresh: PersonLead[] = [];
      for (const lead of leads) {
        if (people.length >= count) break;
        const keys = [lead.email, lead.linkedinUrl, lead.xHandle && `x:${lead.xHandle}`, `${lead.name}|${lead.company ?? ''}`.toLowerCase()].filter(Boolean) as string[];
        if (keys.some((k) => seen.has(k))) continue;
        for (const k of keys) seen.add(k);
        people.push(lead);
        fresh.push(lead);
      }
      return fresh;
    };

    // Two searches start at once; at least one more looks elsewhere when they come back short.
    const rounds = Math.min(MAX_ROUNDS, Math.max(3, Math.ceil(count / PER_ROUND) + 1));
    const errors: unknown[] = [];
    let settled = 0;
    const run = async (i: number): Promise<void> => {
      const found = people.map((p) => (p.company ? `${p.name} (${p.company})` : p.name));
      let fresh: PersonLead[] = [];
      try {
        // One to spare, since a found person can still be dropped for a bad link or a repeat.
        const want = Math.min(PER_ROUND, count - people.length + 1);
        fresh = keep(await this.round(q, description, want, [...known, ...found], ANGLES[Math.min(i, ANGLES.length - 1)] as string));
      } catch (err) {
        errors.push(err);
      } finally {
        settled++;
      }
      // Outside the try: a problem showing people is not a failed search.
      if (fresh.length > 0) q.onFound?.(fresh);
    };
    // The first two start at once from different ends, and each shows its people as soon as it is back.
    await Promise.all([run(0), run(1)]);
    // When neither found anybody, more of the same will not either. Otherwise two at a time until there are enough.
    let next = 2;
    const worker = async (): Promise<void> => {
      while (people.length > 0 && people.length < count && next < rounds) await run(next++);
    };
    await Promise.all([worker(), worker()]);
    // Every search failed: say why. Some found people: those are worth showing.
    if (people.length === 0 && errors.length > 0 && errors.length === settled) throw errors[0];
    return people;
  }

  private async round(q: FindQuery, description: string, count: number, known: string[], angle: string): Promise<PersonLead[]> {
    const offer = q.offer?.replace(/\s+/g, ' ').trim().slice(0, 400);
    const own = q.ownSite?.trim();
    const user = [
      `Who the sender wants to meet: ${description}`,
      offer ? `What the sender offers (leave out their competitors): ${offer}` : '',
      own ? `The sender's own company: ${own} (leave out people who work there)` : '',
      `How many to find: ${count}`,
      `Where to start: ${angle}`,
      `Today: ${this.today().toISOString().slice(0, 10)}`,
      known.length > 0 ? `People the sender already knows (leave them out):\n${known.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    let out: z.infer<typeof found>;
    try {
      out = await this.model.research(found, SYSTEM, user, { maxSearches: Math.min(16, 6 + count) });
    } catch (err) {
      if (err instanceof ModelError) throw new FindError(err.message);
      throw err;
    }
    // Emails are checked against their pages all at once, not one page after another. An answer
    // longer than asked for is cut first, so it can't send Callum to an unbounded number of pages.
    const leads = await Promise.all(out.people.slice(0, count * 2).map((raw) => this.toLead(raw)));
    return leads.filter((l): l is PersonLead => l !== null);
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
      const read = urlCarries(page, email) ? null : await readPage(page, this.fetchImpl, this.resolve);
      if (!read || read.hops.some((u) => urlCarries(u, email as string)) || !pageShows(read.text, email)) email = null;
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
