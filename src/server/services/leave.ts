import type { Channel, Message, Person, Settings } from '../../shared/types.js';
import { CHANNELS } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { parseWhen, plural } from './common.js';
import { UserError } from './errors.js';

const STARTING_KINDS = new Set(['hello', 'invite']);

/** Take a break: nothing automatic goes out until the date (or until Resume). Replies the user sends still go. */
export function pauseUntil(ctx: Ctx, until: string | null): Settings {
  let pausedUntil: string | null = null;
  if (until !== null) {
    const end = parseWhen(until);
    if (end.getTime() <= ctx.clock.now().getTime()) throw new UserError('Pick a date in the future.');
    pausedUntil = end.toISOString();
  }
  if (ctx.repo.getSettings().pauseState === 'wrapped') throw new UserError('Callum is wrapped up. Start again first.');
  const next = ctx.repo.updateSettings({ pauseState: 'paused', pausedUntil });
  ctx.bus.emit('settings');
  return next;
}

export function resumeAll(ctx: Ctx): Settings {
  if (ctx.repo.getSettings().pauseState === 'wrapped') throw new UserError('Callum is wrapped up. Start again first.');
  const next = ctx.repo.updateSettings({ pauseState: 'running', pausedUntil: null });
  ctx.bus.emit('settings');
  return next;
}

/**
 * Cancels every message that has not gone out and marks Callum wrapped up. With `deleteData` everything is wiped
 * afterwards (the caller offers the export first, and calls `forgetChannels` before this so saved sign-ins go too).
 */
export function wrapUp(ctx: Ctx, opts: { deleteData: boolean }): { cancelledFollowUps: number; cancelledHellos: number; summary: string } {
  let hellos = 0;
  let followUps = 0;
  ctx.repo.transaction(() => {
    for (const item of ctx.repo.listOutbox({ state: ['awaiting_ok', 'scheduled'] })) {
      ctx.repo.updateOutbox(item.id, { state: 'cancelled' });
      if (STARTING_KINDS.has(item.kind)) hellos++;
      else followUps++;
    }
    ctx.repo.updateSettings({ pauseState: 'wrapped', pausedUntil: null });
  });
  if (opts.deleteData) {
    ctx.repo.deleteAll();
    // The wipe resets settings too; the wrap-up still stands.
    ctx.repo.updateSettings({ pauseState: 'wrapped' });
  }
  for (const scope of ['outbox', 'settings', 'people', 'projects', 'channels', 'incidents'] as const) ctx.bus.emit(scope);
  return {
    cancelledFollowUps: followUps,
    cancelledHellos: hellos,
    summary: `Nobody else hears from you. ${plural(followUps, 'follow-up', 'follow-ups')} and ${plural(hellos, 'first hello', 'first hellos')} are cancelled.`,
  };
}

/** Signs every channel out and drops what Callum keeps for it on this computer (a saved LinkedIn session). Call before deleting data. */
export async function forgetChannels(ctx: Ctx): Promise<void> {
  const channels: Channel[] = CHANNELS.filter((ch) => ctx.repo.getChannel(ch).status !== 'disconnected');
  for (const ch of channels) await ctx.adapters.disconnect(ch);
}

export interface PersonExport extends Person { messages: Message[] }

function exportedPeople(ctx: Ctx, projectId?: number): PersonExport[] {
  return ctx.repo
    .listPeople(projectId === undefined ? {} : { projectId })
    .filter((p) => p.status !== 'removed')
    .map((p) => ({ ...p, messages: ctx.repo.listMessages(p.id) }));
}

/** People with every message, for a project or (without one) for all projects. */
export function exportJson(ctx: Ctx, projectId?: number): { exportedAt: string; people: PersonExport[] } {
  return { exportedAt: ctx.clock.now().toISOString(), people: exportedPeople(ctx, projectId) };
}

/** A cell for a spreadsheet: quoted when needed, and never able to run as a formula. */
function csvCell(value: string | null | undefined): string {
  let s = value ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS = ['name', 'email', 'company', 'role', 'linkedin', 'x', 'channel', 'stage', 'status', 'last_message', 'last_message_at', 'project'];

/** One line per person (RFC 4180): who they are, where they stand and the last thing said. */
export function exportCsv(ctx: Ctx, projectId?: number): string {
  const projects = new Map(ctx.repo.listProjects().map((p) => [p.id, p.name]));
  const rows = exportedPeople(ctx, projectId).map((p) => {
    const last = p.messages[p.messages.length - 1];
    return [
      p.name, p.email, p.company, p.role, p.linkedinUrl, p.xHandle, p.channel, p.stage, p.status,
      last?.body ?? null, last?.at ?? null, projects.get(p.projectId) ?? null,
    ].map((v) => csvCell(v));
  });
  return [CSV_COLUMNS, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
}

/** The one line the wrap-up screen ends on. */
export function wrapSummaryLine(ctx: Ctx): string {
  let hellos = 0;
  let replied = 0;
  let booked = 0;
  for (const p of ctx.repo.listPeople()) {
    const messages = ctx.repo.listMessages(p.id);
    if (messages.some((m) => m.direction === 'out' && STARTING_KINDS.has(m.kind))) hellos++;
    if (messages.some((m) => m.direction === 'in')) replied++;
    if (p.badge === 'booked') booked++;
  }
  return `Callum said hello to ${plural(hellos, 'person', 'people')} for you. ${replied} replied, and ${plural(booked, 'call', 'calls')} got booked.`;
}

/** Back to the first run. Channels, people and their history stay. */
export function startAgain(ctx: Ctx): void {
  ctx.repo.transaction(() => {
    ctx.repo.updateSettings({ onboarded: false, pauseState: 'running', pausedUntil: null });
    for (const project of ctx.repo.listProjects()) {
      ctx.repo.updateProject(project.id, { startedAt: null, approvalsLeft: 10, state: 'running', pausedUntil: null });
    }
  });
  ctx.bus.emit('settings');
  ctx.bus.emit('projects');
}
