import type { AskAction, AskAnswer, Channel, Person, Tone } from '../../shared/types.js';
import { CHANNELS } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { switchChannel, personTz } from '../engine/lifecycle.js';
import { ApolloError, type ApolloEnrichment, type ApolloQuery } from '../leads/apollo.js';
import { importPeople } from '../leads/import.js';
import { resumeChannel } from '../runner/incidents.js';
import { CHANNEL_NAME, joinList, plural, requireProject, userTz, whenText } from './common.js';
import { UserError } from './errors.js';

const NEEDS_LIST = 'Callum needs a list for that. Bring a CSV or a LinkedIn search link.';
const UNKNOWN = "Callum can find people, pause a channel, change the tone, or tell you who's warming up.";
const TONES: readonly Tone[] = ['warm', 'direct', 'playful'];
const MAX_ASK = 500;
const MAX_FIND = 100;

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
      if (!ctx.apollo) return answer(NEEDS_LIST);
      const count = clampCount(intent.count);
      const like = intent.likePersonId === null ? null : byId.get(intent.likePersonId) ?? null;
      if (like && !like.role?.trim()) {
        return answer(`Callum doesn't know what ${like.firstName} does, so it can't look for more like them. Tell it who to find instead.`, [like.id]);
      }
      const credits = `That uses about ${plural(count, 'Apollo credit', 'Apollo credits')}.`;
      const action: AskAction = {
        kind: 'find_more',
        label: like ? `Find ${count} more like ${like.firstName}` : `Find ${count} people`,
        args: { likePersonId: like?.id ?? null, query: like ? null : intent.query, count },
      };
      const what = like ? `${count} more like ${like.firstName}` : `${count} people`;
      return answer(`Callum can look for ${what}. ${credits}`, like ? [like.id] : [], action);
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

function apolloFailure(e: unknown): unknown {
  if (!(e instanceof ApolloError)) return e;
  const spent = e.partial?.creditsUsed ?? 0;
  return new UserError(spent > 0 ? `${e.message} That used ${plural(spent, 'Apollo credit', 'Apollo credits')}.` : e.message);
}

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
  const apollo = ctx.apollo;
  if (!apollo) throw new UserError(NEEDS_LIST);
  const count = clampCount(args.count);
  const like = args.likePersonId === null || args.likePersonId === undefined ? null : ctx.repo.getPerson(args.likePersonId);
  let query: ApolloQuery;
  if (like) {
    const role = like.role?.trim();
    if (!role) throw new UserError(`${like.firstName} has no role on file, so Callum can't find people like them. Try describing who to find.`);
    query = { query: null, titles: [role], count };
  } else {
    const words = typeof args.query === 'string' ? args.query.trim() : '';
    if (words === '') throw new UserError('Say who to look for.');
    query = { query: words, titles: [], count };
  }

  // Searching is free and shows a preview. Looking people up costs credits, so only the people found are looked up.
  let previews;
  try {
    previews = (await apollo.search(query)).previews;
  } catch (e) {
    throw apolloFailure(e);
  }
  if (previews.length === 0) return answer('Apollo found nobody for that. Try different words.');

  let enriched: ApolloEnrichment;
  let stopped: string | null = null;
  try {
    enriched = await apollo.enrich(previews.map((p) => p.apolloId));
  } catch (e) {
    if (e instanceof ApolloError && e.partial && e.partial.people.length > 0) {
      enriched = e.partial;
      stopped = e.message;
    } else {
      throw apolloFailure(e);
    }
  }

  const result = importPeople(ctx.repo, projectId, enriched.people, { known: await knownEmails(ctx) });
  ctx.bus.emit('people');
  const n = result.added.length;
  const noChannel = result.skipped.filter((s) => s.reason === 'no_channel').length;
  const already = result.skipped.length - noChannel;
  let text = n === 0 ? 'Nobody new was added.' : `Added ${n} ${n === 1 ? 'person' : 'people'}. They start as strangers.`;
  if (noChannel > 0) text += ` ${plural(noChannel, 'person', 'people')} had no email or LinkedIn and ${noChannel === 1 ? 'was' : 'were'} left out.`;
  if (already > 0) text += ` ${already === 1 ? '1 person was' : `${already} people were`} already in Callum or asked not to be contacted.`;
  text += ` That used ${plural(enriched.creditsUsed, 'Apollo credit', 'Apollo credits')}.`;
  if (stopped) text += ` Apollo stopped partway, so only the people it had already looked up were added. ${stopped}`;
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
      ctx.outbox.cancelPending(p.id, ['auto']);
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
