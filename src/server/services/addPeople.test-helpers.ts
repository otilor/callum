import type { Channel, Scope } from '../../shared/types.js';
import { TemplateWriter } from '../ai/templates.js';
import type { AdapterFactory, ChannelAdapter } from '../channels/types.js';
import { createCtx, type Ctx } from '../context.js';
import { openDb } from '../db/db.js';
import { fixedClock } from '../engine/clock.js';
import { FindError, type FindQuery, type PeopleFinder } from '../leads/finder.js';
import type { PersonLead } from '../../shared/types.js';

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

/** A person Claude's search could bring back. */
export function foundPerson(n: number, over: Partial<PersonLead> = {}): PersonLead {
  const first = ['Kemi', 'Femi', 'Tunde', 'Ada'][n] ?? `Sam${n}`;
  const last = ['Eze', 'Ade', 'Bello', 'Obi'][n] ?? 'Xx';
  return {
    name: `${first} ${last}`, role: 'Head of Finance', company: ['Oko Pay', 'Ledgerly', 'Sent Co', 'Pay Co'][n] ?? 'Co',
    linkedinUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-${n}`,
    source: 'web', note: `Leads finance. Found on example.com.`, ...over,
  };
}

/** A people finder that answers from a script and records what it was asked. */
export function fakeFinder(script: { people?: PersonLead[]; fail?: string } = {}): { finder: PeopleFinder; asked: FindQuery[] } {
  const asked: FindQuery[] = [];
  return {
    asked,
    finder: {
      async find(q) {
        asked.push(q);
        if (script.fail) throw new FindError(script.fail);
        return (script.people ?? [0, 1, 2].map((n) => foundPerson(n))).slice(0, q.count);
      },
    },
  };
}
