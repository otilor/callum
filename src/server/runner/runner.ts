import type { Channel, OutboxItem, Person } from '../../shared/types.js';
import { CHANNELS } from '../../shared/types.js';
import { ConnectError } from '../channels/types.js';
import type { Ctx } from '../context.js';
import { chooseChannel, nextKind, nextTouchTime, personTz, rest, restDue, unsnooze, wake } from '../engine/lifecycle.js';
import { firstSlotAfterStart, isSendingTime, nextSendingTime } from '../engine/windows.js';
import { dispatchDue } from './dispatch.js';
import { handleInbound } from './inbound.js';
import { channelSignedOut, refreshSignedOutCount, resolveChannelIncidents } from './incidents.js';

export const POLL_EVERY_MS: Record<Channel, number> = { email: 120_000, x: 300_000, linkedin: 900_000 };
export const DEFAULT_TICK_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;

export interface RunnerOptions {
  pollEveryMs?: Partial<Record<Channel, number>>;
  /** How long one poll may take before Callum gives up on it for now. */
  pollTimeoutMs?: number;
  /** Where problems that do not stop the run are reported. Defaults to the console. */
  onError?: (err: unknown) => void;
}

/** Something is already waiting for this person, or stopped on a problem the user has to look at. */
function holdsUp(person: Person, items: OutboxItem[]): boolean {
  return items.some((i) => {
    if (i.state === 'awaiting_ok' || i.state === 'scheduled') return true;
    // Blocked and failed messages need the user. Ones from before the last real touch are history.
    return (i.state === 'blocked' || i.state === 'failed') && (person.lastTouchAt === null || i.createdAt >= person.lastTouchAt);
  });
}

const at = (iso: string | null): number => (iso === null ? Number.NaN : new Date(iso).getTime());
/** True when the instant is set and not in the future. */
const reached = (iso: string | null, now: Date): boolean => at(iso) <= now.getTime();

function isAuthFailure(err: unknown): boolean {
  if (err instanceof ConnectError && err.code === 'auth') return true;
  return err instanceof Error && err.message === 'auth';
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took too long to answer`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class Runner {
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly every: Record<Channel, number>;
  private readonly pollTimeoutMs: number;
  private readonly onError: (err: unknown) => void;
  /** When each channel was last asked, so a poll that fails is not retried every tick. */
  private readonly asked = new Map<Channel, number>();

  constructor(private readonly ctx: Ctx, opts: RunnerOptions = {}) {
    this.every = { ...POLL_EVERY_MS, ...opts.pollEveryMs };
    this.pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.onError = opts.onError ?? ((err) => console.error(`[callum] ${err instanceof Error ? err.message : String(err)}`));
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

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    // Each step stands alone: a failure in one is reported and the rest still run.
    await this.step(() => this.housekeeping());
    await this.step(() => this.poll());
    await this.step(() => this.plan());
    await this.step(async () => {
      await dispatchDue(this.ctx);
    });
    await this.step(() => refreshSignedOutCount(this.ctx));
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
      const last = Math.max(at(account.lastPolledAt) || -Infinity, this.asked.get(ch) ?? -Infinity);
      if (now.getTime() - last < this.every[ch]) continue;
      const adapter = this.ctx.adapters.get(ch);
      if (!adapter) continue;

      this.asked.set(ch, now.getTime());
      try {
        // Ask from where the last poll began, not where it ended: nothing that arrived in between is missed.
        const since = account.lastPolledAt ? new Date(account.lastPolledAt) : null;
        const events = await withTimeout(adapter.poll(since), this.pollTimeoutMs, ch === 'email' ? 'The mailbox' : ch === 'x' ? 'X' : 'LinkedIn');
        await handleInbound(this.ctx, ch, events);
        // Only now: if an event could not be handled, the next poll brings it again.
        repo.updateChannel(ch, { lastPolledAt: now.toISOString() });
      } catch (err) {
        if (isAuthFailure(err)) channelSignedOut(this.ctx, ch, err instanceof Error ? err.message : null);
        else this.onError(err);
      }
    }
  }

  // ---- 3. planning -------------------------------------------------------

  private async plan(): Promise<void> {
    const { repo } = this.ctx;
    if (repo.getSettings().pauseState !== 'running') return;
    for (const running of repo.listProjects({ state: ['running'] })) {
      if (running.startedAt !== null) await this.planProject(running.id);
    }
  }

  private async planProject(projectId: number): Promise<void> {
    const { repo } = this.ctx;
    const project = repo.getProject(projectId);
    if (!project || project.state !== 'running' || project.startedAt === null) return;
    const settings = repo.getSettings();
    const now = this.ctx.clock.now();
    const startedAt = new Date(project.startedAt);
    const accounts = repo.listChannels();
    const reachable = accounts.filter((c) => c.status === 'connected').map((c) => c.channel);

    // First hellos wait for an OK. People added later join the same stack, so count what is already waiting.
    const people = repo.listPeople({ status: ['active'], projectId });
    const ofProject = new Set(repo.listPeople({ projectId }).map((p) => p.id));
    const open = repo.listOutbox({ state: ['awaiting_ok', 'scheduled', 'blocked', 'failed'] });
    let awaiting = open.filter((i) => i.state === 'awaiting_ok' && ofProject.has(i.personId)).length;
    const itemsOf = new Map<number, OutboxItem[]>();
    for (const i of open) itemsOf.set(i.personId, [...(itemsOf.get(i.personId) ?? []), i]);

    for (const listed of people) {
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
        if (kind === null || holdsUp(person, itemsOf.get(person.id) ?? [])) continue;

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
        if (due.getTime() > now.getTime()) continue;

        const needsOk = project.approvalsLeft > 0 && (kind === 'hello' || kind === 'invite');
        if (needsOk && awaiting >= project.approvalsLeft) continue;

        const written = await this.ctx.writer.write(kind, {
          person, project, settings, channel, history: repo.listMessages(person.id),
        });
        // Writing takes a while: look again before putting it in the outbox.
        const fresh = repo.getPerson(person.id);
        if (!fresh || fresh.status !== 'active' || holdsUp(fresh, repo.listOutbox({ personId: fresh.id })) || repo.getProject(projectId)?.state !== 'running') continue;
        this.ctx.outbox.queueAuto(person.id, kind, written.body, written.subject, new Date(Math.max(now.getTime(), due.getTime())), needsOk);
        if (needsOk) awaiting++;
      } catch (err) {
        this.onError(err);
      }
    }
  }
}
