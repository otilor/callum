import type { Channel, NewPerson, Person, Project, Scope } from '../../shared/types.js';
import { TemplateWriter } from '../ai/templates.js';
import { createCtx, type Ctx } from '../context.js';
import { openDb } from '../db/db.js';
import { fixedClock } from '../engine/clock.js';

/** Monday, 11:00 in Lagos. */
export const MONDAY = '2026-11-02T10:00:00.000Z';
export const OFFER = "You help fintech teams take reconciliation off their ops team's plate";

export interface Harness {
  ctx: Ctx;
  clock: ReturnType<typeof fixedClock>;
  scopes: Scope[];
  project: Project;
  /** A person in the harness project (or another) who can be reached by email. */
  person(overrides?: Partial<NewPerson>): Person;
  /** `n` strangers with an email each. */
  strangers(n: number, overrides?: Partial<NewPerson>): Person[];
}

/** A ctx on an in-memory database: demo adapters, the template writer, a fixed Monday, user time zone Lagos, one project not yet started. */
export function harness(opts: { now?: string; connected?: Channel[]; calendarUrl?: string | null; offer?: string | null } = {}): Harness {
  const clock = fixedClock(opts.now ?? MONDAY);
  const ctx = createCtx({ db: openDb(':memory:'), clock, writer: new TemplateWriter(clock), demo: true, env: {}, dataDir: '/tmp/callum-test' });
  const scopes: Scope[] = [];
  ctx.bus.on((s) => scopes.push(s));
  ctx.repo.updateSettings({ senderName: 'Ada Obi', senderEmail: 'ada@example.com', timezone: 'Africa/Lagos' });
  for (const ch of opts.connected ?? (['email'] as Channel[])) {
    ctx.repo.updateChannel(ch, { status: 'connected', identity: ch === 'email' ? 'ada@example.com' : 'ada', connectedAt: '2026-11-02T08:00:00.000Z' });
  }
  const project = ctx.repo.insertProject({
    name: 'Reconciliation',
    offer: opts.offer === undefined ? OFFER : opts.offer,
    calendarUrl: opts.calendarUrl === undefined ? 'https://cal.example.com/ada' : opts.calendarUrl,
  });
  ctx.repo.updateSettings({ currentProjectId: project.id });
  let n = 0;
  const person = (overrides: Partial<NewPerson> = {}): Person => {
    n++;
    return ctx.repo.insertPerson({
      projectId: project.id, name: `Person${n} Test`, source: 'csv', email: `p${n}@okopay.com`, company: `Co ${n}`, ...overrides,
    });
  };
  scopes.length = 0;
  return { ctx, clock, scopes, project, person, strangers: (count, overrides) => Array.from({ length: count }, () => person(overrides)) };
}
