import type { Incident, OutKind, Project } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { findPlaceholders } from '../engine/guard.js';

/** The messages that say what the sender offers, and so are not written until Callum knows it. */
export const SAYS_OFFER = new Set<OutKind>(['hello', 'invite', 'thanks']);

/** Enough words to say what the sender does: not empty, no blank to fill in, and more than a link or a name. */
export function offerSaysEnough(offer: string | null): boolean {
  const text = offer?.trim() ?? '';
  if (!text || findPlaceholders(text).length > 0) return false;
  const words = text
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\b[\w-]+(?:\.[\w-]+)+(?:\/\S*)?/g, ' ')
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w));
  return words.length >= 3;
}

interface Detail { projectId: number; question: string }

function detailOf(i: Incident): Detail | null {
  try {
    const d = JSON.parse(i.detail ?? 'null') as Partial<Detail> | null;
    return typeof d?.projectId === 'number' && typeof d.question === 'string' ? { projectId: d.projectId, question: d.question } : null;
  } catch {
    return null;
  }
}

function openAsk(ctx: Ctx, projectId: number): Incident | undefined {
  return ctx.repo.listIncidents({ open: true }).find((i) => i.kind === 'needs_offer' && detailOf(i)?.projectId === projectId);
}

/** Asks the user, once for each project, for the line Callum needs before it writes to anyone there. */
export function askForOffer(ctx: Ctx, project: Project, question?: string): void {
  if (openAsk(ctx, project.id)) return;
  const q = question?.trim() || `What does ${project.name} do, and for whom, in one line?`;
  ctx.repo.insertIncident({
    // Not about a channel; email is where the card would be filed if it had to be.
    channel: 'email',
    kind: 'needs_offer',
    message: `Callum won't write to anyone in ${project.name} until it can say what you do. Nothing has been sent.`,
    detail: JSON.stringify({ projectId: project.id, question: q } satisfies Detail),
  });
  ctx.bus.emit('incidents');
}

/** The user said what they offer, or the project is over: the ask is settled. */
export function offerSettled(ctx: Ctx, projectId: number): void {
  const open = openAsk(ctx, projectId);
  if (!open) return;
  ctx.repo.updateIncident(open.id, { state: 'resolved', resolvedAt: ctx.clock.now().toISOString() });
  ctx.bus.emit('incidents');
}

/**
 * First hellos still waiting for the user's OK with a blank in them, written before Callum stopped writing blanks, are
 * taken back: the person is written to again once Callum knows what to say. Returns how many. (A message that reached
 * its send time with a blank is stopped there and waits for the user's edit, so nothing with a blank ever goes.)
 */
export function takeBackBlankDrafts(ctx: Ctx): number {
  let n = 0;
  for (const item of ctx.repo.listOutbox({ state: ['awaiting_ok'] })) {
    if (item.origin !== 'auto') continue;
    if (findPlaceholders(item.body).length === 0 && (!item.subject || findPlaceholders(item.subject).length === 0)) continue;
    ctx.repo.updateOutbox(item.id, { state: 'cancelled' });
    n++;
    const person = ctx.repo.getPerson(item.personId);
    const project = person ? ctx.repo.getProject(person.projectId) : null;
    // With a good offer the hello is simply written again; without one, the user is asked for it.
    if (project && project.state !== 'wrapped' && !offerSaysEnough(project.offer)) askForOffer(ctx, project);
  }
  if (n > 0) ctx.bus.emit('outbox');
  return n;
}
