import { describe, expect, it } from 'vitest';
import type { Person, Project, Stage } from '../../shared/types.js';
import { createCtx, type Ctx } from '../context.js';
import { openDb } from '../db/db.js';
import { fixedClock } from '../engine/clock.js';
import { OPT_OUT_LINE, findPlaceholders } from '../engine/guard.js';
import { localParts } from '../engine/time.js';
import { DEMO_PEOPLE, PAYROLL_PEOPLE } from './people.js';
import { seedScene } from './seed.js';

function demoCtx(now = '2026-11-03T08:30:00Z'): Ctx {
  return createCtx({ db: openDb(':memory:'), clock: fixedClock(now), demo: true, env: {} });
}

const project = (ctx: Ctx, name: string): Project => {
  const found = ctx.repo.listProjects().find((p) => p.name === name);
  if (!found) throw new Error(`no project ${name}`);
  return found;
};
const person = (ctx: Ctx, first: string): Person => {
  const found = ctx.repo.listPeople().find((p) => p.firstName === first && p.company);
  if (!found) throw new Error(`no person ${first}`);
  return found;
};
const dock = (ctx: Ctx, projectId: number): Person[] => ctx.repo.listPeople({ projectId, status: ['waiting'] });
const stageCounts = (people: Person[]): Record<Stage, number> => {
  const out: Record<Stage, number> = { stranger: 0, hello: 0, following: 0, talking: 0 };
  for (const p of people) out[p.stage] += 1;
  return out;
};

describe('the people of the demo', () => {
  it('are the 40 from the boards, on example domains, with no address used twice', () => {
    expect(DEMO_PEOPLE).toHaveLength(40);
    expect(PAYROLL_PEOPLE).toHaveLength(10);
    const kemi = DEMO_PEOPLE[0];
    expect(kemi).toMatchObject({ name: 'Kemi Eze', company: 'Oko Pay', email: 'kemi@okopay.example', timezone: 'Africa/Lagos' });
    const emails = [...DEMO_PEOPLE, ...PAYROLL_PEOPLE].flatMap((p) => (p.email ? [p.email] : []));
    expect(new Set(emails).size).toBe(emails.length);
    expect(emails.every((e) => e.endsWith('.example'))).toBe(true);
    expect(DEMO_PEOPLE.filter((p) => p.linkedinUrl).length).toBeGreaterThan(5);
    expect(DEMO_PEOPLE.filter((p) => p.xHandle).length).toBeGreaterThanOrEqual(3);
    for (const p of [...DEMO_PEOPLE, ...PAYROLL_PEOPLE]) {
      const handle = p.channel === 'email' ? p.email : p.channel === 'linkedin' ? p.linkedinUrl : p.xHandle;
      expect(handle, p.name).toBeTruthy();
    }
  });
});

describe('seedScene fresh', () => {
  it('connects the demo channels, imports the people and waits for the first run', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'fresh');
    const settings = ctx.repo.getSettings();
    expect(settings.onboarded).toBe(false);
    expect(ctx.repo.listChannels().map((c) => c.status)).toEqual(['connected', 'connected', 'connected']);
    const projects = ctx.repo.listProjects();
    expect(projects).toHaveLength(1);
    const [reconciliation] = projects;
    expect(reconciliation).toMatchObject({
      name: 'Reconciliation',
      offer: "You help fintech teams take reconciliation off their ops team's plate.",
      startedAt: null,
      approvalsLeft: 10,
    });
    expect(settings.currentProjectId).toBe(reconciliation?.id);
    const people = ctx.repo.listPeople();
    expect(people).toHaveLength(40);
    expect(people.every((p) => p.stage === 'stranger' && p.status === 'active' && p.touches === 0 && p.source === 'demo')).toBe(true);
    expect(ctx.repo.listOutbox()).toEqual([]);
  });

  it('can be run again: the old scene goes and the new one stands alone', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'morning');
    seedScene(ctx, 'fresh');
    expect(ctx.repo.listProjects()).toHaveLength(1);
    expect(ctx.repo.listPeople()).toHaveLength(40);
    expect(ctx.repo.getSettings().onboarded).toBe(false);
  });

  it('forgets the do-not-contact list of the scene it replaces, because that scene was made up', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'morning');
    ctx.repo.suppress({ email: 'ruth@example.com' });
    seedScene(ctx, 'fresh');
    expect(ctx.repo.isSuppressed({ email: 'ruth@example.com' })).toBe(false);
  });

  it('tells the app what changed', () => {
    const ctx = demoCtx();
    const seen = new Set<string>();
    ctx.bus.on((s) => seen.add(s));
    seedScene(ctx, 'fresh');
    expect([...seen].sort()).toEqual(['channels', 'incidents', 'outbox', 'people', 'projects', 'settings']);
  });
});

describe('seedScene morning', () => {
  it('has the river of the board: 16 strangers, 18 hellos, 2 following, 1 talking, and three on the dock', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'morning');
    const reconciliation = project(ctx, 'Reconciliation');
    const people = ctx.repo.listPeople({ projectId: reconciliation.id });
    expect(people).toHaveLength(40);
    const waiting = dock(ctx, reconciliation.id);
    expect(waiting.map((p) => p.firstName).sort()).toEqual(['Femi', 'Kemi', 'Zainab']);
    const rest = people.filter((p) => p.status !== 'waiting');
    expect(stageCounts(rest)).toEqual({ stranger: 16, hello: 18, following: 2, talking: 1 });
    expect(rest.every((p) => p.status === 'active')).toBe(true);
    expect(reconciliation.approvalsLeft).toBe(0);
    expect(ctx.repo.getSettings()).toMatchObject({ onboarded: true, currentProjectId: reconciliation.id, timezone: 'Africa/Lagos' });
  });

  it('started three days ago', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'morning');
    const started = new Date(project(ctx, 'Reconciliation').startedAt ?? '').getTime();
    const threeDays = ctx.clock.now().getTime() - 3 * 86_400_000;
    expect(started).toBeLessThanOrEqual(threeDays);
    expect(started).toBeGreaterThan(threeDays - 2 * 86_400_000);
  });

  it('puts Kemi, Femi and Zainab on the dock with what they wrote and a draft each', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'morning');
    const kemi = person(ctx, 'Kemi');
    expect(kemi).toMatchObject({ status: 'waiting', suggested: 'book', lastInbound: 'Happy to chat. Does Thursday work?', channel: 'email' });
    const femi = person(ctx, 'Femi');
    expect(femi).toMatchObject({ status: 'waiting', suggested: 'reply', lastInbound: 'Can you tell me more about pricing?' });
    expect(femi.draft).toContain('[YOUR PRICE]');
    expect(findPlaceholders(femi.draft ?? '')).toEqual(['[YOUR PRICE]']);
    const zainab = person(ctx, 'Zainab');
    expect(zainab).toMatchObject({ status: 'waiting', suggested: 'snooze', lastInbound: 'Not right now, maybe next quarter.' });
    for (const p of [kemi, femi, zainab]) {
      expect(p.draft, p.name).toBeTruthy();
      expect(p.repliedAt).not.toBeNull();
      expect(p.nextTouchAt).toBeNull();
      expect(p.stage).toBe('hello');
    }
    // Only Femi's draft has a gap for the user to fill; the others can go as they are.
    expect(findPlaceholders(kemi.draft ?? '')).toEqual([]);
    expect(findPlaceholders(zainab.draft ?? '')).toEqual([]);
  });

  it('keeps each history in step with the touches', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'morning');
    for (const p of ctx.repo.listPeople()) {
      const messages = ctx.repo.listMessages(p.id);
      const out = messages.filter((m) => m.direction === 'out');
      const sent = out.filter((m) => m.kind !== 'reply' && m.kind !== 'booking' && m.kind !== 'close');
      expect(sent.length, `${p.name} touches`).toBe(p.touches);
      const inbound = messages.filter((m) => m.direction === 'in');
      expect(inbound.length > 0, `${p.name} replied`).toBe(p.repliedAt !== null);
      if (p.repliedAt) expect(inbound.at(-1)?.body).toBe(p.lastInbound);
      if (p.touches === 0) expect(messages, p.name).toEqual([]);
      for (const m of messages) {
        expect(new Date(m.at).getTime(), `${p.name} ${m.kind}`).toBeLessThanOrEqual(ctx.clock.now().getTime());
        expect(m.body).not.toContain('!');
      }
      if (p.lastTouchAt) expect(sent.at(-1)?.at).toBe(p.lastTouchAt);
      // Every message follows the one before it.
      expect(messages.map((m) => m.at)).toEqual([...messages.map((m) => m.at)].sort());
      const channels = new Set(messages.map((m) => m.channel));
      expect(channels.size <= 1, `${p.name} stays on one channel`).toBe(true);
      if (messages[0]) expect(messages[0].channel).toBe(p.channel);
    }
  });

  it('sends emails with the opt-out line and no placeholders, and keeps hellos inside sending hours', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'morning');
    let hellos = 0;
    for (const p of ctx.repo.listPeople()) {
      for (const m of ctx.repo.listMessages(p.id)) {
        if (m.direction !== 'out') continue;
        expect(findPlaceholders(m.body), `${p.name} ${m.kind}`).toEqual([]);
        if (m.channel === 'email') {
          expect(m.body.endsWith(`\n\n${OPT_OUT_LINE}`)).toBe(true);
          expect(m.subject).toBeTruthy();
        }
        if (m.kind === 'hello' || m.kind === 'invite') {
          hellos += 1;
          const t = localParts(new Date(m.at), p.timezone ?? 'UTC');
          expect(t.weekday >= 1 && t.weekday <= 5, `${p.name} weekday`).toBe(true);
          expect(t.hour >= 9 && t.hour < 17, `${p.name} hour`).toBe(true);
        }
        if (m.kind === 'invite') expect(m.body.length).toBeLessThanOrEqual(280);
      }
    }
    expect(hellos).toBeGreaterThan(20);
  });

  it('shows the LinkedIn path: Ada and Ngozi accepted and were thanked, so they are following', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'morning');
    for (const first of ['Ada', 'Ngozi']) {
      const p = person(ctx, first);
      expect(p).toMatchObject({ stage: 'following', touches: 2, linkedinState: 'connected', channel: 'linkedin' });
      expect(ctx.repo.listMessages(p.id).map((m) => m.kind)).toEqual(['invite', 'thanks']);
      expect(new Date(p.nextTouchAt ?? '').getTime()).toBeGreaterThan(ctx.clock.now().getTime());
    }
  });

  it('opens with no follow-up already due, even on a Tuesday afternoon after a weekend', () => {
    // Bisi's hello went on the Friday at 14:18 Lagos time; four days on is Tuesday 13:18 UTC.
    for (const now of ['2026-11-03T08:30:00Z', '2026-11-03T13:44:00Z', '2026-11-03T22:00:00Z', '2026-11-05T15:00:00Z']) {
      const ctx = demoCtx(now);
      seedScene(ctx, 'morning');
      for (const p of ctx.repo.listPeople()) {
        if (p.nextTouchAt) expect(new Date(p.nextTouchAt).getTime(), `${now} ${p.name}`).toBeGreaterThan(new Date(now).getTime() + 60_000);
      }
    }
  });

  it('has Tunde talking with the user after answering him', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'morning');
    const tunde = person(ctx, 'Tunde');
    expect(tunde).toMatchObject({ stage: 'talking', status: 'active', badge: 'sent', draft: null });
    expect(ctx.repo.listMessages(tunde.id).map((m) => `${m.direction}:${m.kind}`)).toEqual(['out:hello', 'in:inbound', 'out:reply']);
  });

  it('adds the Payroll project: direct voice, its own ten people, and Yaw waiting on the dock', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'morning');
    const payroll = project(ctx, 'Payroll');
    expect(payroll).toMatchObject({
      offer: 'You help growing teams in Lagos and Accra run payroll without spreadsheets.',
      tone: 'direct',
      state: 'running',
    });
    expect(payroll.startedAt).not.toBeNull();
    const people = ctx.repo.listPeople({ projectId: payroll.id });
    expect(people.map((p) => p.firstName)).toEqual(['Yaw', 'Efua', 'Kwame', 'Halima', 'Dayo', 'Ama', 'Kofi', 'Ifeoma', 'Musa', 'Bukola']);
    const yaw = person(ctx, 'Yaw');
    expect(yaw).toMatchObject({
      name: 'Yaw Mensah', company: 'Kumasi Foods', status: 'waiting', projectId: payroll.id,
      lastInbound: 'Happy to look. We run 140 people on a spreadsheet today.',
    });
    expect(yaw.draft).toBeTruthy();
    expect(findPlaceholders(yaw.draft ?? '')).toEqual([]);
    expect(dock(ctx, payroll.id).map((p) => p.firstName)).toEqual(['Yaw']);
    // The hellos already sent were each approved, so some of the ten OKs are left.
    expect(payroll.approvalsLeft).toBe(10 - ctx.repo.listPeople({ projectId: payroll.id }).filter((p) => p.touches > 0).length);
  });

  it('puts nobody in two projects and nobody on two addresses', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'morning');
    const people = ctx.repo.listPeople();
    expect(people).toHaveLength(50);
    const handles = people.flatMap((p) => [p.email, p.linkedinUrl, p.xHandle].filter((h): h is string => h !== null));
    expect(new Set(handles).size).toBe(handles.length);
  });

  it('connects the three demo channels and leaves no incident or queued message', () => {
    const ctx = demoCtx();
    seedScene(ctx, 'morning');
    const channels = ctx.repo.listChannels();
    expect(channels.map((c) => c.status)).toEqual(['connected', 'connected', 'connected']);
    expect(channels[0]?.identity).toBe('gabriel@yourcompany.com');
    expect(ctx.repo.getSettings()).toMatchObject({ senderName: 'Gabriel', senderEmail: 'gabriel@yourcompany.com' });
    expect(ctx.repo.listIncidents()).toEqual([]);
    expect(ctx.repo.listOutbox()).toEqual([]);
  });

  it('holds together on any day of the week, including a Monday before the sending day starts', () => {
    // Monday 06:00, Saturday and Sunday in Lagos.
    for (const now of ['2026-11-02T05:00:00Z', '2026-11-07T10:00:00Z', '2026-11-08T10:00:00Z', '2026-11-09T07:30:00Z']) {
      const ctx = demoCtx(now);
      seedScene(ctx, 'morning');
      for (const p of ctx.repo.listPeople()) {
        for (const m of ctx.repo.listMessages(p.id)) {
          expect(new Date(m.at).getTime(), `${now} ${p.name} ${m.kind}`).toBeLessThanOrEqual(new Date(now).getTime());
        }
        if (p.repliedAt) expect(new Date(p.repliedAt).getTime()).toBeLessThanOrEqual(new Date(now).getTime());
      }
      const started = new Date(project(ctx, 'Reconciliation').startedAt ?? '').getTime();
      for (const p of ctx.repo.listPeople({ projectId: project(ctx, 'Reconciliation').id })) {
        const first = ctx.repo.listMessages(p.id)[0];
        if (first) expect(new Date(first.at).getTime(), `${now} ${p.name} first`).toBeGreaterThan(started);
      }
    }
  });
});
