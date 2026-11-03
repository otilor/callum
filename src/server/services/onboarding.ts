import type { Channel, Person, Tone } from '../../shared/types.js';
import { CHANNELS } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { chooseChannel, personTz } from '../engine/lifecycle.js';
import { findPlaceholders } from '../engine/guard.js';
import { X_DAILY_CAP, emailDailyCap, linkedinInviteCap } from '../engine/pacing.js';
import { localParts, startOfLocalDay, zonedTime } from '../engine/time.js';
import { firstSlotAfterStart, SEND_START_HOUR } from '../engine/windows.js';
import { domainOf, fetchSiteText } from '../leads/site.js';
import { planProjectNow } from '../runner/runner.js';
import { CHANNEL_NAME, CHANNEL_PHRASE, FIRST_OKS, afterSaved, joinList, plural, requireProject, userTz, weekdayName } from './common.js';
import { UserError } from './errors.js';

/** What the user's work email says about what they offer. Null when the address is free mail or nothing could be read. */
export async function suggestOffer(ctx: Ctx): Promise<string | null> {
  const email = ctx.repo.getSettings().senderEmail;
  const domain = email ? domainOf(email) : null;
  if (!domain) return null;
  try {
    const text = await fetchSiteText(domain);
    if (!text) return null;
    const line = (await ctx.writer.offerLine(text, domain)).trim();
    // A line with a blank still to fill in is no suggestion.
    return line === '' || findPlaceholders(line).length > 0 ? null : line;
  } catch {
    return null;
  }
}

function connectedChannels(ctx: Ctx): Channel[] {
  return ctx.repo.listChannels().filter((c) => c.status === 'connected').map((c) => c.channel);
}

const hasHandle = (p: Person, ch: Channel): boolean =>
  ch === 'email' ? Boolean(p.email) : ch === 'linkedin' ? Boolean(p.linkedinUrl) : Boolean(p.xHandle);

/** The channel a person would be written on: the one they have if Callum can use it, else the first that works. */
function channelFor(p: Person, connected: Channel[]): Channel | null {
  if (p.channel && connected.includes(p.channel) && hasHandle(p, p.channel)) return p.channel;
  return chooseChannel(p, connected);
}

const isStranger = (p: Person): boolean => p.status === 'active' && p.stage === 'stranger' && p.touches === 0;

/** A hello (or an invite) as Callum would write it for the first stranger in the project, in this tone. */
/** A first hello in this voice, and who it was written to: the first stranger of the project, or a made-up person when there is none. */
export async function sample(ctx: Ctx, projectId: number, tone: Tone): Promise<{ body: string; to: { name: string; company: string | null } }> {
  const project = requireProject(ctx, projectId);
  const settings = ctx.repo.getSettings();
  const connected = connectedChannels(ctx);
  const now = ctx.clock.now().toISOString();
  const first = ctx.repo.listPeople({ projectId }).find(isStranger);
  const person: Person = first ?? {
    id: 0, projectId, name: 'Kemi Eze', firstName: 'Kemi', company: 'Oko Pay', role: null, email: 'kemi@okopay.com',
    linkedinUrl: null, xHandle: null, timezone: null, channel: 'email', stage: 'stranger', status: 'active', touches: 0,
    lastTouchAt: null, nextTouchAt: null, linkedinState: 'none', invitedAt: null, snoozedUntil: null, restUntil: null,
    badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null, source: 'demo',
    note: null, createdAt: now, updatedAt: now,
  };
  const channel = first ? channelFor(first, connected) ?? first.channel ?? 'email' : 'email';
  const kind = channel === 'linkedin' ? 'invite' : 'hello';
  const written = await ctx.writer.write(kind, {
    person: { ...person, channel }, project: { ...project, tone }, settings, channel, history: [],
  });
  return { body: written.body, to: { name: person.name, company: person.company } };
}

export interface PlanPreview {
  firstSendAt: string;
  total: number;
  byChannel: Record<Channel, number>;
  line: string;
  /** Strangers who can only be reached on a channel that is not connected yet. */
  waiting: { count: number; line: string | null };
}

const orList = (items: string[]): string => (items.length <= 1 ? items[0] ?? '' : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`);

/** How many of this kind of message other projects already have lined up (or waiting for an OK) on a channel in the day starting at `from`. */
function usedByOthers(ctx: Ctx, projectId: number, ch: Channel, from: Date, tz: string): number {
  const day = localParts(from, tz);
  const next = zonedTime(tz, day.year, day.month, day.day + 1, 0).getTime();
  const ofProject = new Set(ctx.repo.listPeople({ projectId }).map((p) => p.id));
  return ctx.repo
    .listOutbox({ state: ['scheduled', 'awaiting_ok'] })
    .filter((i) => {
      const when = new Date(i.sendAfter).getTime();
      const counts = i.origin === 'auto' && i.channel === ch && (ch !== 'linkedin' || i.kind === 'invite');
      return counts && !ofProject.has(i.personId) && when >= from.getTime() && when < next;
    }).length;
}

/** What the first day looks like, inside the daily limits. Nothing goes out on the day the user presses Start. */
export function planPreview(ctx: Ctx, projectId: number): PlanPreview {
  requireProject(ctx, projectId);
  const tz = userTz(ctx);
  const now = ctx.clock.now();
  const first = firstSlotAfterStart(now, tz);
  const dayStart = startOfLocalDay(first, tz);
  const connected = connectedChannels(ctx);
  const accounts = ctx.repo.listChannels();
  const wanted: Record<Channel, number> = { email: 0, linkedin: 0, x: 0 };
  const missing = new Set<Channel>();
  let waiting = 0;
  for (const p of ctx.repo.listPeople({ projectId }).filter(isStranger)) {
    const ch = channelFor(p, connected);
    if (ch) {
      wanted[ch]++;
      continue;
    }
    const via = CHANNELS.filter((c) => hasHandle(p, c));
    if (via.length === 0) continue;
    waiting++;
    for (const c of via) missing.add(c);
  }
  const account = (ch: Channel) => accounts.find((a) => a.channel === ch);
  const cap: Record<Channel, number> = {
    email: emailDailyCap(new Date(account('email')?.connectedAt ?? now), first),
    linkedin: linkedinInviteCap(account('linkedin') ?? ctx.repo.getChannel('linkedin'), first),
    x: X_DAILY_CAP,
  };
  const byChannel: Record<Channel, number> = { email: 0, linkedin: 0, x: 0 };
  // The limits are shared: what another project already has lined up that day is not available again.
  for (const ch of CHANNELS) byChannel[ch] = Math.min(wanted[ch], Math.max(0, cap[ch] - usedByOthers(ctx, projectId, ch, dayStart, tz)));
  const total = CHANNELS.reduce((sum, ch) => sum + byChannel[ch], 0);

  const tomorrow = localParts(new Date(now.getTime() + 86_400_000), tz);
  const slot = localParts(first, tz);
  const day = tomorrow.year === slot.year && tomorrow.month === slot.month && tomorrow.day === slot.day ? 'Tomorrow' : weekdayName(slot.weekday);
  const parts = CHANNELS.filter((ch) => byChannel[ch] > 0).map((ch) => `${byChannel[ch]} ${CHANNEL_PHRASE[ch]}`);
  const line = total === 0
    ? 'Nobody is ready for a first hello yet. Nothing goes out today.'
    : `${day} from ${SEND_START_HOUR}:00 their time: ${plural(total, 'hello', 'hellos')}, ${joinList(parts)}. Nothing goes out today.`;

  const names = CHANNELS.filter((c) => missing.has(c)).map((c) => CHANNEL_NAME[c]);
  const waitingLine = waiting === 0
    ? null
    : `${waiting === 1 ? '1 person waits' : `${waiting} people wait`} for ${orList(names)}. Connect ${names.length === 1 ? 'it' : 'one'} to reach them.`;
  return { firstSendAt: first.toISOString(), total, byChannel, line, waiting: { count: waiting, line: waitingLine } };
}

/**
 * Presses Start for a project. Strangers get a channel, the first hellos are written and wait for the user's OK, and
 * nothing goes out before the next sending slot. Someone Callum cannot reach yet stays as they are, and is planned
 * as soon as a channel they can be reached on is connected.
 */
export async function start(ctx: Ctx, projectId: number): Promise<{ firstSendAt: string }> {
  const project = requireProject(ctx, projectId);
  if (ctx.repo.getSettings().pauseState === 'wrapped') throw new UserError('Callum is wrapped up. Start again first.');
  if (project.state === 'wrapped') throw new UserError(`${project.name} is wrapped up.`);
  if (project.startedAt !== null) throw new UserError(`${project.name} has already started.`);
  const connected = connectedChannels(ctx);
  if (connected.length === 0) throw new UserError('Connect a channel first');
  const people = ctx.repo.listPeople({ projectId }).filter((p) => p.status !== 'removed');
  if (people.length === 0) throw new UserError('Add some people first');

  const now = ctx.clock.now();
  const settings = ctx.repo.getSettings();
  ctx.repo.transaction(() => {
    ctx.repo.updateProject(projectId, { startedAt: now.toISOString(), approvalsLeft: FIRST_OKS, state: 'running', pausedUntil: null });
    ctx.repo.updateSettings({ onboarded: true, currentProjectId: projectId });
    for (const p of people.filter(isStranger)) {
      const channel = channelFor(p, connected);
      if (!channel) continue;
      const slot = firstSlotAfterStart(now, personTz(p, settings.timezone));
      ctx.repo.updatePerson(p.id, { channel, nextTouchAt: slot.toISOString() });
    }
  });
  ctx.bus.emit('projects');
  ctx.bus.emit('settings');
  ctx.bus.emit('people');

  // The same planning the runner does, a little early: the first hellos wait in the outbox for their slot.
  // Start is saved by now, so a writer that fails here is reported, not thrown at the user.
  await afterSaved(ctx, () => planProjectNow(ctx, projectId, { early: true }));
  ctx.bus.emit('outbox');
  return { firstSendAt: firstSlotAfterStart(now, userTz(ctx)).toISOString() };
}
