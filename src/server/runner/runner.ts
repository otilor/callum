import type { Channel, OutboxItem, OutKind, Person, Project } from '../../shared/types.js';
import { CHANNELS } from '../../shared/types.js';
import type { ChannelAdapter } from '../channels/types.js';
import { ConnectError } from '../channels/types.js';
import type { Ctx } from '../context.js';
import { chooseChannel, nextKind, nextTouchTime, personTz, rest, restDue, unsnooze, wake } from '../engine/lifecycle.js';
import { capFor } from '../engine/pacing.js';
import { addLocalDays, startOfLocalDay } from '../engine/time.js';
import { firstSlotAfterStart, isSendingTime, nextSendingTime } from '../engine/windows.js';
import { capKinds, createSpacer, dispatchDue, type Spacer } from './dispatch.js';
import { handleInbound, heldBackPeople, retryFailedInbound } from './inbound.js';
import { INCIDENT_COPY, channelSignedOut, openIncident, refreshSignedOutCount, resolveChannelIncidents, syncAutoIncidents } from './incidents.js';
import { isHeldReferral, trackPause } from '../services/quiet.js';
import { maybeSendWeekly } from '../services/weekly.js';

export const POLL_EVERY_MS: Record<Channel, number> = { email: 120_000, x: 300_000, linkedin: 900_000 };
export const DEFAULT_TICK_MS = 5_000;
/** Real time one planning pass may spend writing; what is left waits for the next tick. */
export const PLAN_BUDGET_MS = 25_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;

export interface PlanOptions {
  /** Only this project (Start and skipping a hello plan one project on the spot). */
  projectId?: number;
  /**
   * First hellos that need an OK are written ahead of their slot, which is how Start fills Day one. They wait in the
   * outbox with their send time and go only once approved, so neither the time budget nor the daily room applies.
   */
  early?: boolean;
  budgetMs?: number;
  /** Wall time in ms. Only the budget reads it; tests replace it. */
  wallNow?: () => number;
  onError?: (err: unknown) => void;
}

export interface RunnerOptions {
  pollEveryMs?: Partial<Record<Channel, number>>;
  /** How long a tick waits for one poll. The poll itself is never dropped: its events are handled when it finishes. */
  pollTimeoutMs?: number;
  planBudgetMs?: number;
  wallNow?: () => number;
  /**
   * How Callum's own messages are spaced out on a channel (see `SEND_GAP_MS`): one at a time with a random gap.
   * `random` replaces the dice in tests; `false` sends everything due at once, which only tests that are not about
   * spacing ask for.
   */
  spacing?: false | { random?: () => number };
  /** Where problems that do not stop the run are reported. Defaults to the console. */
  onError?: (err: unknown) => void;
}

const at = (iso: string | null): number => (iso === null ? Number.NaN : new Date(iso).getTime());
/** True when the instant is set and not in the future. */
const reached = (iso: string | null, now: Date): boolean => at(iso) <= now.getTime();

/** Something is already waiting for this person, or stopped on a problem the user has to look at. */
function holdsUp(person: Person, items: OutboxItem[]): boolean {
  return items.some((i) => {
    if (i.state === 'awaiting_ok' || i.state === 'scheduled' || i.state === 'sending') return true;
    // Blocked and failed messages need the user. Ones from before the last real touch are history.
    return (i.state === 'blocked' || i.state === 'failed') && (person.lastTouchAt === null || i.createdAt >= person.lastTouchAt);
  });
}

function isAuthFailure(err: unknown): boolean {
  if (err instanceof ConnectError && err.code === 'auth') return true;
  return err instanceof Error && err.message === 'auth';
}

interface Candidate {
  person: Person; project: Project; channel: Channel; kind: OutKind; due: Date; needsOk: boolean;
}

/**
 * Writes the next message for everyone who is due, in the order they became due whatever their project, so the shared
 * daily limits go to whoever has waited longest. A channel gets no more drafts than it can send today, and a pass stops
 * after its time budget; what is left is picked up by the next tick. Returns how many messages were queued.
 */
export async function planDue(ctx: Ctx, opts: PlanOptions = {}): Promise<number> {
  const { repo } = ctx;
  const report = opts.onError ?? ctx.onError;
  const settings = repo.getSettings();
  const alone = opts.projectId !== undefined;
  const early = opts.early === true;
  if (!alone && settings.pauseState !== 'running') return 0;
  const wall = opts.wallNow ?? Date.now;
  const began = wall();
  const budget = early ? Infinity : (opts.budgetMs ?? PLAN_BUDGET_MS);
  const now = ctx.clock.now();
  const accounts = repo.listChannels();
  const reachable = accounts.filter((c) => c.status === 'connected').map((c) => c.channel);
  const open = repo.listOutbox({ state: ['awaiting_ok', 'scheduled', 'sending', 'blocked', 'failed'] });
  const itemsOf = new Map<number, OutboxItem[]>();
  for (const i of open) itemsOf.set(i.personId, [...(itemsOf.get(i.personId) ?? []), i]);
  const held = heldBackPeople(ctx);

  // Who is due, in every running project that has started.
  const candidates: Candidate[] = [];
  const awaiting = new Map<number, number>();
  for (const project of repo.listProjects({ state: ['running'] })) {
    if (project.startedAt === null || (alone && project.id !== opts.projectId)) continue;
    const startedAt = new Date(project.startedAt);
    const ofProject = new Set(repo.listPeople({ projectId: project.id }).map((p) => p.id));
    awaiting.set(project.id, open.filter((i) => i.state === 'awaiting_ok' && ofProject.has(i.personId)).length);
    for (const listed of repo.listPeople({ status: ['active'], projectId: project.id })) {
      try {
        let person = listed;
        if (!person.channel) {
          const channel = chooseChannel(person, reachable);
          if (!channel) continue;
          person = repo.updatePerson(person.id, { channel });
        }
        const channel = person.channel;
        if (!channel || accounts.find((a) => a.channel === channel)?.status === 'disconnected') continue;
        const kind = nextKind(person);
        if (kind === null || held.has(person.id) || holdsUp(person, itemsOf.get(person.id) ?? [])) continue;
        // The user gets the first chance to write to someone a referral named.
        if (isHeldReferral(person, now)) continue;

        const tz = personTz(person, settings.timezone);
        let due: Date | null = person.nextTouchAt === null ? null : new Date(person.nextTouchAt);
        if (due === null) {
          if (person.stage === 'stranger' && person.touches === 0) {
            const first = firstSlotAfterStart(startedAt, tz);
            due = first.getTime() > now.getTime() ? first : nextSendingTime(now, tz);
          } else {
            due = nextTouchTime(person, now, tz);
          }
          if (due === null) continue;
          person = repo.updatePerson(person.id, { nextTouchAt: due.toISOString() });
        }
        const needsOk = project.approvalsLeft > 0 && (kind === 'hello' || kind === 'invite');
        if (due.getTime() > now.getTime() && !(early && needsOk)) continue;
        candidates.push({ person, project, channel, kind, due, needsOk });
      } catch (err) {
        report(err);
      }
    }
  }
  candidates.sort((a, b) => a.due.getTime() - b.due.getTime() || a.person.id - b.person.id);

  // Room left today per cap group: the cap, less what went out, less what is already lined up to go today.
  const userTz = settings.timezone;
  const dayStart = startOfLocalDay(now, userTz);
  const nextDay = addLocalDays(dayStart, 1, userTz).toISOString();
  const room = new Map<string, number>();
  const takeable = (i: OutboxItem): boolean => {
    const owner = repo.getPerson(i.personId);
    return owner !== null && owner.status === 'active' && !held.has(owner.id) && repo.getProject(owner.projectId)?.state === 'running';
  };
  const roomFor = (c: Candidate): { key: string; left: number } => {
    const kinds = capKinds(c.channel, c.kind);
    const key = `${c.channel}:${kinds.join(',')}`;
    if (!room.has(key)) {
      const account = accounts.find((a) => a.channel === c.channel);
      const cap = account ? capFor(c.channel, c.kind, account, now) : 0;
      const sent = repo.countOut(c.channel, kinds, dayStart.toISOString());
      // Only what dispatch would really send today: not a paused or wrapped project's, nor a person who is held or not active.
      const lined = open.filter((i) => i.state === 'scheduled' && i.origin === 'auto' && i.channel === c.channel && kinds.includes(i.kind)
        && i.sendAfter < nextDay && account?.status === 'connected' && takeable(i)).length;
      room.set(key, Math.max(0, cap - sent - lined));
    }
    return { key, left: room.get(key) ?? 0 };
  };

  let queued = 0;
  for (const c of candidates) {
    if (wall() - began >= budget) break;
    try {
      let spend: string | null = null;
      if (c.needsOk) {
        // First hellos wait for an OK, only as many as there are OKs left; people added later join the same stack.
        if ((awaiting.get(c.project.id) ?? 0) >= c.project.approvalsLeft) continue;
      } else {
        const r = roomFor(c);
        if (!early && r.left <= 0) continue;
        spend = r.key;
      }
      const written = await ctx.writer.write(c.kind, {
        person: c.person, project: c.project, settings, channel: c.channel, history: repo.listMessages(c.person.id),
      });
      // Writing takes a while: look again before putting it in the outbox.
      const fresh = repo.getPerson(c.person.id);
      if (!fresh || fresh.status !== 'active' || holdsUp(fresh, repo.listOutbox({ personId: fresh.id })) || heldBackPeople(ctx).has(fresh.id)) continue;
      if (repo.getProject(c.project.id)?.state !== 'running' || (!alone && repo.getSettings().pauseState !== 'running')) continue;
      // Due time, not now: when more is due than may go, the one who has waited longest goes first.
      ctx.outbox.queueAuto(c.person.id, c.kind, written.body, written.subject, c.due, c.needsOk);
      queued++;
      if (c.needsOk) awaiting.set(c.project.id, (awaiting.get(c.project.id) ?? 0) + 1);
      if (spend) room.set(spend, (room.get(spend) ?? 1) - 1);
    } catch (err) {
      report(err);
    }
  }
  return queued;
}

export class Runner {
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly every: Record<Channel, number>;
  private readonly pollTimeoutMs: number;
  private readonly planBudgetMs: number;
  private readonly wallNow: () => number;
  private readonly onError: (err: unknown) => void;
  private readonly spacer: Spacer | undefined;
  /** When each channel was last asked, so a poll that fails is not retried every tick. */
  private readonly asked = new Map<Channel, number>();
  /** The poll under way per channel. A new one does not start until it has settled, and its events are never dropped. */
  private readonly inflight = new Map<Channel, Promise<void>>();

  constructor(private readonly ctx: Ctx, opts: RunnerOptions = {}) {
    this.every = { ...POLL_EVERY_MS, ...opts.pollEveryMs };
    this.pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.planBudgetMs = opts.planBudgetMs ?? PLAN_BUDGET_MS;
    this.wallNow = opts.wallNow ?? Date.now;
    this.onError = opts.onError ?? ctx.onError;
    this.spacer = opts.spacing === false ? undefined : createSpacer(opts.spacing?.random);
  }

  /** One pass. A second call while one is running gets the same promise, so nothing is done twice. */
  tick(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  start(intervalMs: number = DEFAULT_TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err: unknown) => this.onError(err));
    }, intervalMs);
  }

  /**
   * Stops ticking and resolves once the tick and the polls under way have settled (a poll that never answers is waited
   * for no longer than `timeoutMs`, by default the poll timeout), so the caller can close the database after it.
   */
  async stop(opts: { timeoutMs?: number } = {}): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const settled = Promise.allSettled([this.running, ...this.inflight.values()].filter((p): p is Promise<void> => p !== null));
    let timer: NodeJS.Timeout | undefined;
    const giveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, opts.timeoutMs ?? this.pollTimeoutMs);
    });
    await Promise.race([settled, giveUp]);
    clearTimeout(timer);
  }

  /**
   * Writes what is due for one project. With `early`, first hellos that need an OK are written ahead of their slot
   * (they wait in the outbox with their send time), which is how Start fills Day one.
   */
  async planProject(projectId: number, opts: { early?: boolean } = {}): Promise<void> {
    await planDue(this.ctx, { projectId, early: opts.early === true, onError: this.onError });
  }

  private async run(): Promise<void> {
    // Each step stands alone: a failure in one is reported and the rest still run.
    await this.step(() => this.housekeeping());
    await this.step(() => this.poll());
    await this.step(() => retryFailedInbound(this.ctx, this.onError));
    // The user's own messages go before anything slow, so a long planning pass never holds up a reply.
    await this.step(async () => {
      await dispatchDue(this.ctx, { origin: 'user', onError: this.onError });
    });
    await this.step(async () => {
      await planDue(this.ctx, { budgetMs: this.planBudgetMs, wallNow: this.wallNow, onError: this.onError });
    });
    await this.step(async () => {
      await dispatchDue(this.ctx, { onError: this.onError, ...(this.spacer ? { spacer: this.spacer } : {}) });
    });
    await this.step(() => syncAutoIncidents(this.ctx));
    await this.step(() => refreshSignedOutCount(this.ctx));
    await this.step(() => {
      trackPause(this.ctx);
    });
    await this.step(async () => {
      await maybeSendWeekly(this.ctx);
    });
  }

  private async step(fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.onError(err);
    }
  }

  // ---- 1. housekeeping ---------------------------------------------------

  private housekeeping(): void {
    const { repo, bus, outbox } = this.ctx;
    const now = this.ctx.clock.now();
    const settings = repo.getSettings();
    if (settings.pauseState === 'paused' && reached(settings.pausedUntil, now)) {
      repo.updateSettings({ pauseState: 'running', pausedUntil: null });
      bus.emit('settings');
    }

    for (const project of repo.listProjects({ state: ['paused'] })) {
      if (!reached(project.pausedUntil, now)) continue;
      repo.updateProject(project.id, { state: 'running', pausedUntil: null });
      bus.emit('projects');
    }

    // X comes back by itself at its next day. LinkedIn waits for the user, who has to finish the check.
    const x = repo.getChannel('x');
    if (x.status === 'paused' && reached(x.pausedUntil, now)) {
      repo.updateChannel('x', { status: 'connected', pausedUntil: null });
      resolveChannelIncidents(this.ctx, 'x', ['x_limit']);
      bus.emit('channels');
    }
    const linkedin = repo.getChannel('linkedin');
    if (reached(linkedin.invitesBlockedUntil, now)) {
      repo.updateChannel('linkedin', { invitesBlockedUntil: null });
      resolveChannelIncidents(this.ctx, 'linkedin', ['linkedin_weekly_limit']);
      bus.emit('channels');
    }

    let changed = false;
    let outboxChanged = false;
    for (const person of repo.listPeople({ status: ['snoozed', 'active', 'resting'] })) {
      if (person.status === 'snoozed' && reached(person.snoozedUntil, now)) {
        repo.updatePerson(person.id, unsnooze(person));
        changed = true;
      } else if (person.status === 'resting' && reached(person.restUntil, now)) {
        repo.updatePerson(person.id, wake(person));
        changed = true;
      } else if (restDue(person, now)) {
        repo.updatePerson(person.id, rest(person, now));
        if (outbox.cancelPending(person.id, ['auto']) > 0) outboxChanged = true;
        changed = true;
      }
    }
    if (changed) bus.emit('people');
    if (outboxChanged) bus.emit('outbox');
  }

  // ---- 2. polling --------------------------------------------------------

  private async poll(): Promise<void> {
    const { repo } = this.ctx;
    for (const ch of CHANNELS) {
      const now = this.ctx.clock.now();
      const account = repo.getChannel(ch);
      if (account.status !== 'connected') continue;
      if (ch === 'linkedin' && !isSendingTime(now, repo.getSettings().timezone)) continue;
      // One poll per channel at a time: a slow one is left to finish and is not asked again over the top of it.
      if (this.inflight.has(ch)) continue;
      const last = Math.max(at(account.lastPolledAt) || -Infinity, this.asked.get(ch) ?? -Infinity);
      if (now.getTime() - last < this.every[ch]) continue;
      const adapter = this.ctx.adapters.get(ch);
      if (!adapter) continue;

      this.asked.set(ch, now.getTime());
      const work = this.pollOnce(ch, adapter, account.lastPolledAt, now);
      this.inflight.set(ch, work);
      void work.finally(() => {
        if (this.inflight.get(ch) === work) this.inflight.delete(ch);
        // It answered after all: the notice that it was not answering is settled.
        try {
          resolveChannelIncidents(this.ctx, ch, ['not_answering']);
        } catch (err) {
          this.onError(err);
        }
      });
      await this.waitFor(work, ch);
    }
  }

  /**
   * Asks the channel and handles what it says, whenever that happens. The adapter marks events seen as it returns them,
   * so they are never dropped; `lastPolledAt` moves to the start of this poll only after they are handled.
   */
  private async pollOnce(ch: Channel, adapter: ChannelAdapter, lastPolledAt: string | null, startedAt: Date): Promise<void> {
    try {
      const events = await adapter.poll(lastPolledAt ? new Date(lastPolledAt) : null);
      await handleInbound(this.ctx, ch, events, this.onError);
      this.ctx.repo.updateChannel(ch, { lastPolledAt: startedAt.toISOString() });
    } catch (err) {
      if (isAuthFailure(err)) channelSignedOut(this.ctx, ch);
      else this.onError(err);
    }
  }

  /** Waits for a poll up to the timeout. Running out of patience reports it; the poll carries on. */
  private async waitFor(work: Promise<void>, ch: Channel): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const name = ch === 'email' ? 'The mailbox' : ch === 'x' ? 'X' : 'LinkedIn';
    const timedOut = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), this.pollTimeoutMs);
    });
    const result = await Promise.race([work.then(() => 'done' as const), timedOut]);
    clearTimeout(timer);
    if (result === 'late') {
      this.onError(new Error(`${name} took too long to answer`));
      // The user hears about it once; it closes by itself when the poll finally settles.
      openIncident(this.ctx, { channel: ch, kind: 'not_answering', message: INCIDENT_COPY.not_answering(ch === 'email' ? 'Email' : ch === 'x' ? 'X' : 'LinkedIn') });
    }
  }
}

/**
 * Plans one project now, outside the timer, and says so if it went wrong. Used by Start and by skipping a hello,
 * which both have to fill the stack of hellos waiting for an OK straight away.
 */
export async function planProjectNow(ctx: Ctx, projectId: number, opts: { early?: boolean } = {}): Promise<void> {
  const problems: unknown[] = [];
  await new Runner(ctx, { onError: (err) => problems.push(err) }).planProject(projectId, opts);
  if (problems.length > 0) throw problems[0];
}
