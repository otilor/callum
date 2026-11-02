import type { Channel, Scope } from '../../shared/types.js';
import { TemplateWriter } from '../ai/templates.js';
import type { AdapterFactory, ChannelAdapter } from '../channels/types.js';
import { createCtx, type Ctx } from '../context.js';
import { openDb } from '../db/db.js';
import { fixedClock } from '../engine/clock.js';
import { ApolloSource } from '../leads/apollo.js';

/** Monday, 11:00 in Lagos. */
export const MONDAY = '2026-11-02T10:00:00.000Z';

export interface Setup {
  ctx: Ctx;
  clock: ReturnType<typeof fixedClock>;
  scopes: Scope[];
  projectId: number;
  sentTo: string[];
  linkedin: { searched: string[]; people: Awaited<ReturnType<NonNullable<ChannelAdapter['searchPeople']>>>; fail: Error | null };
}

export function adapter(channel: Channel, extra: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    channel, connect: async () => ({ identity: 'x', secret: {} }), send: async () => ({ ok: true, externalId: null }),
    poll: async () => [], close: async () => undefined, ...extra,
  };
}

export function setup(opts: { connected?: Channel[]; started?: boolean } = {}): Setup {
  const clock = fixedClock(MONDAY);
  const sentTo: string[] = [];
  const linkedin: Setup['linkedin'] = { searched: [], people: [], fail: null };
  const factory: AdapterFactory = (channel) => {
    if (channel === 'email') return adapter('email', { knownAddresses: async () => sentTo });
    if (channel === 'linkedin') {
      return adapter('linkedin', {
        searchPeople: async (url) => {
          linkedin.searched.push(url);
          if (linkedin.fail) throw linkedin.fail;
          return linkedin.people;
        },
      });
    }
    return adapter(channel);
  };
  const ctx = createCtx({ db: openDb(':memory:'), clock, writer: new TemplateWriter(clock), factory, env: {}, dataDir: '/tmp/callum-test' });
  ctx.repo.updateSettings({ senderName: 'Ada Obi', senderEmail: 'ada@example.com', timezone: 'Africa/Lagos', onboarded: true });
  for (const ch of opts.connected ?? (['email'] as Channel[])) {
    ctx.repo.updateChannel(ch, { status: 'connected', identity: 'x', connectedAt: '2026-11-02T08:00:00.000Z' });
  }
  const project = ctx.repo.insertProject({ name: 'Payroll', offer: 'You help teams run payroll' });
  if (opts.started !== false) ctx.repo.updateProject(project.id, { startedAt: '2026-11-01T09:00:00.000Z' });
  ctx.repo.updateSettings({ currentProjectId: project.id });
  const scopes: Scope[] = [];
  ctx.bus.on((s) => scopes.push(s));
  return { ctx, clock, scopes, projectId: project.id, sentTo, linkedin };
}

export interface Calls { search: URL[]; enrich: string[][]; keys: (string | undefined)[] }

export function previewRow(n: number) {
  return {
    id: `apollo-${n}`, first_name: ['Kemi', 'Femi', 'Tunde', 'Ada'][n] ?? 'Sam', last_name_obfuscated: ['Ez***', 'Ad*', 'Be***', 'Ob*'][n] ?? 'Xx*',
    title: 'Head of Finance', has_email: true, organization: { name: ['Oko Pay', 'Ledgerly', 'Sent Co', 'Pay Co'][n] ?? 'Co' },
  };
}

export function matchRow(id: string, over: Record<string, unknown> = {}) {
  const n = Number(id.replace('apollo-', ''));
  const first = ['Kemi', 'Femi', 'Tunde', 'Ada'][n] ?? 'Sam';
  const last = ['Eze', 'Ade', 'Bello', 'Obi'][n] ?? 'Xx';
  return {
    id, first_name: first, last_name: last, name: `${first} ${last}`, title: 'Head of Finance', email_status: 'verified',
    email: `${first.toLowerCase()}@co${n}.com`, linkedin_url: `http://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-${n}`,
    organization: { name: 'Co' }, ...over,
  };
}

/** An Apollo that answers from a script and records what it was asked. */
export function fakeApollo(script: {
  total?: number; rows?: number; enrich?: (ids: string[]) => Record<string, unknown>[]; failEnrichAt?: number; failStatus?: number; failSearch?: number;
}): { source: ApolloSource; calls: Calls } {
  const calls: Calls = { search: [], enrich: [], keys: [] };
  let enrichCalls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.keys.push((init?.headers as Record<string, string> | undefined)?.['x-api-key']);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('api_search')) {
      calls.search.push(url);
      if (script.failSearch) return json(script.failSearch, {});
      const rows = Array.from({ length: script.rows ?? 3 }, (_, n) => previewRow(n));
      return json(200, { people: rows, pagination: { total_entries: script.total ?? rows.length, total_pages: 1 } });
    }
    const ids = (JSON.parse(String(init?.body)) as { details: { id: string }[] }).details.map((d) => d.id);
    calls.enrich.push(ids);
    enrichCalls++;
    if (script.failEnrichAt === enrichCalls) return json(script.failStatus ?? 429, {});
    const matches = (script.enrich ?? ((i) => i.map((id) => matchRow(id))))(ids);
    return json(200, { matches, credits_consumed: matches.length });
  }) as typeof fetch;
  return { source: new ApolloSource('key-123', fetchImpl, 'https://apollo.test'), calls };
}

