import type { Channel, NewPerson, OutKind, Person, Project, Scope } from '../../shared/types.js';
import { TemplateWriter } from '../ai/templates.js';
import type { AdapterFactory, ChannelAdapter, InboundEvent, OutboundMessage, SendResult } from '../channels/types.js';
import { createCtx, type Ctx } from '../context.js';
import { openDb } from '../db/db.js';
import { makeProject } from '../db/testing.test-helpers.js';
import { fixedClock } from '../engine/clock.js';

/** A channel adapter whose answers the test scripts. */
export interface FakeAdapter extends ChannelAdapter {
  sent: OutboundMessage[];
  polls: (Date | null)[];
  /** Results for the next sends, in order; once empty every send succeeds. */
  results: SendResult[];
  /** Events for the next polls, in order; once empty polls return nothing. */
  inbox: InboundEvent[][];
  /** Throw this from the next poll. */
  pollError: Error | null;
  /** Runs inside `send`, before it answers. */
  onSend: ((msg: OutboundMessage) => Promise<void> | void) | null;
}

export function fakeAdapter(channel: Channel): FakeAdapter {
  const a: FakeAdapter = {
    channel,
    sent: [],
    polls: [],
    results: [],
    inbox: [],
    pollError: null,
    onSend: null,
    async connect() {
      return { identity: 'fake', secret: {} };
    },
    async send(msg) {
      a.sent.push(msg);
      await a.onSend?.(msg);
      return a.results.shift() ?? { ok: true as const, externalId: `<${channel}-${a.sent.length}@fake>` };
    },
    async poll(since) {
      a.polls.push(since);
      if (a.pollError) {
        const err = a.pollError;
        a.pollError = null;
        throw err;
      }
      return a.inbox.shift() ?? [];
    },
    async close() {},
  };
  return a;
}

export const NOW = '2026-11-03T08:30:00.000Z'; // Tuesday, 9:30 in Lagos

export interface Harness {
  ctx: Ctx;
  clock: ReturnType<typeof fixedClock>;
  adapters: Record<Channel, FakeAdapter>;
  scopes: Scope[];
  project: Project;
  person(overrides?: Partial<NewPerson>): Person;
  /** An auto item due now for the person. */
  due(personId: number, kind: OutKind, body?: string, subject?: string | null): number;
}

/** A ctx on an in-memory database with all three channels connected to fake adapters and one started project. */
export function harness(opts: { now?: string; timezone?: string; connected?: Channel[]; approvalsLeft?: number } = {}): Harness {
  const clock = fixedClock(opts.now ?? NOW);
  const adapters: Record<Channel, FakeAdapter> = { email: fakeAdapter('email'), linkedin: fakeAdapter('linkedin'), x: fakeAdapter('x') };
  const factory: AdapterFactory = (channel) => adapters[channel];
  const ctx = createCtx({ db: openDb(':memory:'), clock, writer: new TemplateWriter(clock), factory, env: {}, dataDir: '/tmp/callum-test' });
  const scopes: Scope[] = [];
  ctx.bus.on((s) => scopes.push(s));
  ctx.repo.updateSettings({
    senderName: 'Ada Obi', senderEmail: 'ada@example.com', timezone: opts.timezone ?? 'Africa/Lagos', onboarded: true,
  });
  for (const ch of opts.connected ?? (['email', 'linkedin', 'x'] as Channel[])) {
    ctx.repo.updateChannel(ch, { status: 'connected', identity: ch === 'email' ? 'ada@example.com' : 'ada', connectedAt: '2026-11-02T08:00:00.000Z' });
  }
  const project = makeProject(ctx.repo, {
    name: 'Reconciliation', offer: "You help fintech teams take reconciliation off their ops team's plate",
    calendarUrl: 'https://cal.example.com/ada',
  });
  const started = ctx.repo.updateProject(project.id, { startedAt: '2026-11-02T10:00:00.000Z', approvalsLeft: opts.approvalsLeft ?? 0 });
  let n = 0;
  return {
    ctx, clock, adapters, scopes, project: started,
    person(overrides = {}) {
      n++;
      return ctx.repo.insertPerson({
        projectId: started.id, name: `Person${n} Test`, source: 'csv', email: `p${n}@okopay.com`, channel: 'email', ...overrides,
      });
    },
    due(personId, kind, body = 'Hi, a quick note.', subject = 'Quick question') {
      return ctx.outbox.queueAuto(personId, kind, body, subject, clock.now(), false).id;
    },
  };
}
