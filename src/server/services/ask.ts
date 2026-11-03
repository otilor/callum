import type { AskAction, AskAnswer, Channel, Person, Tone } from '../../shared/types.js';
import { CHANNELS } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { switchChannel, personTz } from '../engine/lifecycle.js';
import { FindError, MAX_FIND as FINDER_MAX } from '../leads/finder.js';
import { importPeople } from '../leads/import.js';
import { resumeChannel } from '../runner/incidents.js';
import { assertCanResume } from './channels.js';
import { CHANNEL_NAME, cancelPendingRefunding, joinList, plural, requireProject, userTz, whenText } from './common.js';
import { UserError } from './errors.js';

const NEEDS_CLAUDE = 'Finding people needs Claude. Sign in to Claude Code on this computer, or add a Claude key in Your Callum.';
const UNKNOWN = "Callum can find people, pause a channel, change the tone, or tell you who's warming up.";
const TONES: readonly Tone[] = ['warm', 'direct', 'playful'];
const MAX_ASK = 500;
const MAX_FIND = FINDER_MAX;

/** The channel at the start of a sentence. */
const Cap = (ch: Channel): string => (ch === 'email' ? 'Email' : CHANNEL_NAME[ch]);

const hasHandle = (p: Person, ch: Channel): boolean =>
  ch === 'email' ? Boolean(p.email) : ch === 'linkedin' ? Boolean(p.linkedinUrl) : Boolean(p.xHandle);

const answer = (text: string, personIds: number[] = [], action: AskAction | null = null): AskAnswer => ({ text, personIds, action });

const clampCount = (n: unknown): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 20;
  return Math.max(1, Math.min(MAX_FIND, v));
};

/** The people Callum can move to this channel: still on their way, not talking, with a handle there, not already there. */
function movable(p: Person, ch: Channel): boolean {
  return p.status === 'active' && p.stage !== 'talking' && p.channel !== ch && hasHandle(p, ch);
}

function whyText(ctx: Ctx): string {
  const incident = ctx.repo.listIncidents({ open: true })[0];
  if (incident) return incident.message;
  const settings = ctx.repo.getSettings();
  const tz = userTz(ctx);
  const now = ctx.clock.now();
  if (settings.pauseState === 'paused') {
    return settings.pausedUntil
      ? `Callum is on a break until ${whenText(new Date(settings.pausedUntil), tz, now)}. Nothing goes out on its own until then.`
      : 'Callum is on a break. Nothing goes out on its own until you resume.';
  }
  if (settings.pauseState === 'wrapped') return 'Callum is wrapped up. Nobody hears from you until you start again.';
  const paused = ctx.repo.listProjects({ state: ['paused'] })[0];
  if (paused) {
    return paused.pausedUntil
      ? `${paused.name} is paused until ${whenText(new Date(paused.pausedUntil), tz, now)}. Nothing goes out on its own there until then.`
      : `${paused.name} is paused. Nothing goes out on its own there until you resume.`;
  }
  for (const account of ctx.repo.listChannels()) {
    if (account.status === 'paused') return `${Cap(account.channel)} is paused. Resume it from Ask or Your Callum.`;
    if (account.status === 'error') return `${Cap(account.channel)} needs to be connected again from Your Callum.`;
  }
  return 'Nothing is paused. Callum is running.';
}

/** A question or request typed in the Ask bar. Nothing changes until the user presses the action it offers. */
export async function ask(ctx: Ctx, projectId: number, text: string): Promise<AskAnswer> {
  requireProject(ctx, projectId);
  const people = ctx.repo.listPeople({ projectId }).filter((p) => p.status !== 'removed');
  const typed = typeof text === 'string' ? text.slice(0, MAX_ASK) : '';
  const intent = await ctx.writer.parseAsk(typed, people.map((p) => ({ id: p.id, name: p.name })));
  const byId = new Map(people.map((p) => [p.id, p]));

  switch (intent.intent) {
    case 'warm': {
      const warm = people.filter((p) => p.status === 'active' && (p.stage === 'following' || p.linkedinState === 'connected'));
      const n = warm.length;
      return answer(`${n === 1 ? '1 person is' : `${n} people are`} warming up.`, warm.map((p) => p.id));
    }
    case 'why':
      return answer(whyText(ctx));
    case 'find': {
      if (!ctx.finder) return answer(NEEDS_CLAUDE);
      const count = clampCount(intent.count);
      const like = intent.likePersonId === null ? null : byId.get(intent.likePersonId) ?? null;
      const query = typeof intent.query === 'string' ? intent.query.trim() : '';
      if (!like && query === '') return answer(UNKNOWN);
      if (like && !like.role?.trim()) {
        return answer(`Callum doesn't know what ${like.firstName} does, so it can't look for more like them. Tell it who to find instead.`, [like.id]);
      }
      const action: AskAction = {
        kind: 'find_more',
        label: like ? `Find ${count} more like ${like.firstName}` : `Find ${count} people`,
        args: { likePersonId: like?.id ?? null, query: like ? null : query, count },
      };
      const what = like ? `${count} more like ${like.firstName}` : `${count} people`;
      return answer(`Callum can look for ${what} on the web. It takes a few minutes.`, like ? [like.id] : [], action);
    }
    case 'pause':
    case 'resume': {
      const ch = intent.channel;
      const name = CHANNEL_NAME[ch];
      const status = ctx.repo.getChannel(ch).status;
      if (status === 'disconnected') return answer(`${Cap(ch)} isn't connected yet.`);
      if (intent.intent === 'pause') {
        if (status === 'paused') return answer(`${Cap(ch)} is already paused.`);
        return answer(`Callum can pause ${name}. Nothing new goes out there until you resume.`, [], { kind: 'pause_channel', label: `Pause ${name}`, args: { channel: ch } });
      }
      if (status === 'connected') return answer(`${Cap(ch)} is already running.`);
      if (status === 'error') return answer(`${Cap(ch)} needs to be connected again from Your Callum.`);
      return answer(`Callum can resume ${name}.`, [], { kind: 'resume_channel', label: `Resume ${name}`, args: { channel: ch } });
    }
    case 'tone': {
      const tone = intent.tone;
      if (ctx.repo.getProject(projectId)?.tone === tone) return answer(`Callum already writes in a ${tone} tone.`);
      return answer(
        `Callum can write in a ${tone} tone from now on. Hellos already waiting keep their words.`, [],
        { kind: 'set_tone', label: `Use a ${tone} tone`, args: { tone } },
      );
    }
    case 'switch': {
      const ch = intent.channel;
      const named = intent.personIds.map((id) => byId.get(id)).filter((p): p is Person => p !== undefined);
      const names = joinList(named.map((p) => p.firstName));
      const connected = ctx.repo.getChannel(ch).status === 'connected';
      const ok = connected ? named.filter((p) => movable(p, ch)) : [];
      if (ok.length === 0) {
        if (!connected) return answer(`${Cap(ch)} isn't connected yet.`);
        return answer(`Callum can't move ${names} to ${CHANNEL_NAME[ch]} right now.`, named.map((p) => p.id));
      }
      const first = joinList(ok.map((p) => p.firstName));
      return answer(
        `Callum can move ${first} to ${CHANNEL_NAME[ch]}. The first note there goes out at least a week after the last one.`,
        ok.map((p) => p.id),
        { kind: 'switch_channel', label: `Move ${first} to ${CHANNEL_NAME[ch]}`, args: { personIds: ok.map((p) => p.id), channel: ch } },
      );
    }
    case 'unknown':
      return answer(UNKNOWN);
  }
}

// ---- act ---------------------------------------------------------------------

/** Addresses the mailbox has already written to, so nobody is written to twice. A mailbox that does not answer is not a reason to stop. */
async function knownEmails(ctx: Ctx): Promise<Set<string>> {
  try {
    const adapter = ctx.adapters.get('email');
    return new Set((await adapter?.knownAddresses?.()) ?? []);
  } catch {
    return new Set();
  }
}

async function findMore(ctx: Ctx, projectId: number, args: { likePersonId: number | null; query: string | null; count: number }): Promise<AskAnswer> {
  const finder = ctx.finder;
  if (!finder) throw new UserError(NEEDS_CLAUDE);
  const project = requireProject(ctx, projectId);
  if (project.state === 'wrapped') throw new UserError(`${project.name} is wrapped up.`);
  const count = clampCount(args.count);
  const like = args.likePersonId === null || args.likePersonId === undefined ? null : ctx.repo.getPerson(args.likePersonId);
  if (args.likePersonId !== null && args.likePersonId !== undefined && (!like || like.projectId !== projectId || like.status === 'removed')) {
    throw new UserError("Callum can't find that person in this project.");
  }
  let description: string;
  if (like) {
    const role = like.role?.trim();
    if (!role) throw new UserError(`${like.firstName} has no role on file, so Callum can't find people like them. Try describing who to find.`);
    description = `People in the same kind of role as ${like.name}: ${role}${like.company ? `, at companies like ${like.company}` : ''}. Not ${like.name}.`;
  } else {
    const words = typeof args.query === 'string' ? args.query.trim() : '';
    if (words === '') throw new UserError(UNKNOWN);
    description = words;
  }

  let found;
  try {
    const known = ctx.repo.listPeople().slice().reverse().map((p) => (p.company ? `${p.name} (${p.company})` : p.name));
    found = await finder.find({ description, count, known });
  } catch (e) {
    if (e instanceof FindError) throw new UserError(e.message);
    throw e;
  }
  if (found.length === 0) return answer('Callum found nobody it could reach for that. Try different words.');

  const result = importPeople(ctx.repo, projectId, found, { known: await knownEmails(ctx) });
  if (result.added.length > 0) ctx.bus.emit('people');
  const n = result.added.length;
  const already = result.skipped.filter((s) => s.reason !== 'no_channel').length;
  let text = n === 0 ? 'Nobody new was added.' : `Added ${n} ${n === 1 ? 'person' : 'people'}. They start as strangers.`;
  if (already > 0) text += ` ${already === 1 ? '1 person was' : `${already} people were`} already in Callum or asked not to be contacted.`;
  return answer(text, result.added.map((p) => p.id));
}

function channelArg(v: unknown): Channel {
  if (!CHANNELS.includes(v as Channel)) throw new UserError('Pick email, LinkedIn or X.');
  return v as Channel;
}

function switchPeople(ctx: Ctx, projectId: number, ch: Channel, ids: number[]): AskAnswer {
  if (ctx.repo.getChannel(ch).status !== 'connected') throw new UserError(`${Cap(ch)} isn't connected yet.`);
  const now = ctx.clock.now();
  const settings = ctx.repo.getSettings();
  const moved: Person[] = [];
  const stayed: Person[] = [];
  ctx.repo.transaction(() => {
    for (const id of ids) {
      const p = ctx.repo.getPerson(id);
      if (!p || p.projectId !== projectId) continue;
      if (!movable(p, ch)) {
        stayed.push(p);
        continue;
      }
      cancelPendingRefunding(ctx, p, ['auto']);
      moved.push(ctx.repo.updatePerson(p.id, switchChannel(p, ch, now, personTz(p, settings.timezone))));
    }
  });
  if (moved.length === 0) {
    const who = joinList(stayed.map((p) => p.firstName));
    throw new UserError(who ? `Callum can't move ${who} to ${CHANNEL_NAME[ch]} right now.` : 'Callum can\'t find those people.');
  }
  ctx.bus.emit('people');
  ctx.bus.emit('outbox');
  const soonest = moved.map((p) => p.nextTouchAt).filter((t): t is string => t !== null).sort()[0];
  let text = `Moved ${joinList(moved.map((p) => p.firstName))} to ${CHANNEL_NAME[ch]}.`;
  if (soonest) text += ` The first note there goes out from ${whenText(new Date(soonest), userTz(ctx), now)}.`;
  if (stayed.length > 0) text += ` ${joinList(stayed.map((p) => p.firstName))} stayed where they are.`;
  return answer(text, moved.map((p) => p.id));
}

/** Does what an answer offered. */
export async function act(ctx: Ctx, projectId: number, action: AskAction): Promise<AskAnswer> {
  requireProject(ctx, projectId);
  switch (action?.kind) {
    case 'find_more':
      return findMore(ctx, projectId, action.args);
    case 'pause_channel': {
      const ch = channelArg(action.args.channel);
      const name = CHANNEL_NAME[ch] === 'email' ? 'Email' : CHANNEL_NAME[ch];
      if (ctx.repo.getChannel(ch).status !== 'connected') throw new UserError(`${name} isn't running, so there is nothing to pause.`);
      ctx.repo.updateChannel(ch, { status: 'paused', pausedUntil: null });
      ctx.bus.emit('channels');
      return answer(`Paused ${CHANNEL_NAME[ch]}. Nothing new goes out there until you resume.`);
    }
    case 'resume_channel': {
      const ch = channelArg(action.args.channel);
      // Whatever stopped the channel has to be dealt with first: Ask cannot skip a check, a limit or a sign-in.
      assertCanResume(ctx, ch);
      if (ctx.repo.getChannel(ch).status !== 'paused') throw new UserError(`${Cap(ch)} isn't paused.`);
      resumeChannel(ctx, ch, 'full');
      return answer(`Resumed ${CHANNEL_NAME[ch]}.`);
    }
    case 'set_tone': {
      if (!TONES.includes(action.args.tone)) throw new UserError('Pick warm, direct or playful.');
      ctx.repo.updateProject(projectId, { tone: action.args.tone });
      ctx.bus.emit('projects');
      return answer(`Callum writes in a ${action.args.tone} tone now.`);
    }
    case 'switch_channel': {
      const ids = Array.isArray(action.args.personIds) ? action.args.personIds.filter((n) => Number.isInteger(n)) : [];
      return switchPeople(ctx, projectId, channelArg(action.args.channel), ids);
    }
    default:
      throw new UserError('Callum does not know how to do that.');
  }
}
