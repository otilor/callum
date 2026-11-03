import type { AppState, Brief, OutboxItem, OutKind } from '../../shared/types.js';
import { CHANNELS } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { localParts, startOfLocalDay, zonedTime } from '../engine/time.js';
import { userTz } from './common.js';

const DAY_MS = 86_400_000;
const AUTO_KINDS: OutKind[] = ['hello', 'invite', 'thanks', 'follow_up'];
const NEW_PROJECT_DAYS = 3;

/** What the UI needs to draw everything. Nothing in it is secret: channel sign-ins stay in their own table. */
export function getState(ctx: Ctx, auth: { password: boolean }): AppState {
  const { repo } = ctx;
  const now = ctx.clock.now().getTime();
  const weekAgo = now - 7 * DAY_MS;
  const outbox = repo.listOutbox({ state: ['awaiting_ok', 'scheduled', 'failed', 'blocked'] }).filter((i: OutboxItem) => {
    switch (i.state) {
      case 'awaiting_ok': return true;
      case 'scheduled': return i.origin === 'user' || (i.undoUntil !== null && new Date(i.undoUntil).getTime() > now);
      default: return new Date(i.updatedAt).getTime() >= weekAgo;
    }
  });
  return {
    settings: repo.getSettings(),
    projects: repo.listProjects(),
    channels: repo.listChannels(),
    people: repo.listPeople().filter((p) => p.status !== 'removed'),
    outbox,
    incidents: repo.listIncidents({ open: true }),
    brief: brief(ctx),
    demo: ctx.demo,
    canFind: ctx.finder !== null,
    claudeConnected: ctx.claudeKey !== null,
    claudeEngine: ctx.model?.engine ?? null,
    auth,
  };
}

/** Automatic messages sent in the user's previous local day, across channels. */
function sentYesterday(ctx: Ctx): number {
  const tz = userTz(ctx);
  const today = startOfLocalDay(ctx.clock.now(), tz);
  const p = localParts(today, tz);
  const yesterday = zonedTime(tz, p.year, p.month, p.day - 1, 0);
  let n = 0;
  for (const ch of CHANNELS) {
    n += ctx.repo.countOut(ch, AUTO_KINDS, yesterday.toISOString()) - ctx.repo.countOut(ch, AUTO_KINDS, today.toISOString());
  }
  return n;
}

/** The morning line, across every project. */
export function brief(ctx: Ctx): Brief {
  const { repo } = ctx;
  const now = ctx.clock.now().getTime();
  const people = repo.listPeople();
  const wantToTalk = people.filter((p) => p.status === 'waiting').length;
  const accepted = people.filter((p) => p.status !== 'removed' && p.linkedinState === 'connected' && now - new Date(p.updatedAt).getTime() <= DAY_MS);
  const acceptedRecently = accepted.map((p) => p.firstName);
  const acceptedIds = accepted.map((p) => p.id);
  const nextSendAt = repo.listOutbox({ state: ['scheduled'] })[0]?.sendAfter ?? null;
  const started = repo.listProjects().flatMap((p) => (p.startedAt ? [new Date(p.startedAt).getTime()] : []));
  const startedRecently = started.length > 0 && now - Math.min(...started) < NEW_PROJECT_DAYS * DAY_MS;

  let line: string;
  if (wantToTalk === 1) line = '1 person wants to talk.';
  else if (wantToTalk > 1) line = `${wantToTalk} people want to talk.`;
  else if (startedRecently) line = 'No replies yet, which is normal this early. Callum will tap you the moment someone answers.';
  else line = 'All caught up. Callum keeps the river moving.';
  return { wantToTalk, sentYesterday: sentYesterday(ctx), acceptedRecently, acceptedIds, nextSendAt, line };
}
