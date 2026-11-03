import type { Incident, Project } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { findPlaceholders, offerSaysEnough } from '../../shared/placeholders.js';
import { publicFetch } from '../leads/finder.js';
import { fetchSiteText } from '../leads/site.js';

export { SAYS_OFFER } from '../ai/writer.js';
export { offerSaysEnough } from '../../shared/placeholders.js';

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
export function takeBackBlankDrafts(ctx: Ctx, projectId?: number): number {
  let n = 0;
  for (const item of ctx.repo.listOutbox({ state: ['awaiting_ok'] })) {
    if (item.origin !== 'auto') continue;
    const blank = item.body.trim() === '' || findPlaceholders(item.body).length > 0 || (item.subject !== null && findPlaceholders(item.subject).length > 0);
    if (!blank) continue;
    const person = ctx.repo.getPerson(item.personId);
    // Planning one project leaves the others' drafts to their own pass.
    if (projectId !== undefined && person?.projectId !== projectId) continue;
    ctx.repo.updateOutbox(item.id, { state: 'cancelled' });
    n++;
    const project = person ? ctx.repo.getProject(person.projectId) : null;
    // With a good offer the hello is simply written again; without one, the user is asked for it.
    if (project && project.state !== 'wrapped' && !offerSaysEnough(project.offer)) askForOffer(ctx, project);
  }
  if (n > 0) ctx.bus.emit('outbox');
  return n;
}

const SITE = /\b(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s)]*)?/i;

/** Reads a company's site: the text its home page gives about itself, or '' when it can't be read. */
export type SiteReader = (domain: string) => Promise<string>;
const readSite: SiteReader = (domain) => fetchSiteText(domain, publicFetch, { timeoutMs: 8000 });

/**
 * What the user typed as their offer, with a website in it read for them: "tethers.com" becomes "You help ... (tethers.com)".
 * Left as typed when it already says enough in words, has no website, is the demo, or the site can't be read or says too little.
 */
export async function offerWithSite(ctx: Ctx, typed: string | null, read: SiteReader = readSite): Promise<string | null> {
  const text = typed?.replace(/\s+/g, ' ').trim() ?? '';
  const site = SITE.exec(text);
  if (!text || !site?.[1] || ctx.demo || /@/.test(site.input.slice(Math.max(0, site.index - 1), site.index))) return typed;
  const words = text.replace(site[0], ' ').split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length >= 8) return typed;
  const domain = site[1].toLowerCase();
  try {
    const page = await read(domain);
    if (!page.trim()) return typed;
    const line = (await ctx.writer.offerLine(page, domain)).replace(/\s+/g, ' ').trim();
    if (!line || findPlaceholders(line).length > 0 || !offerSaysEnough(line)) return typed;
    return `${line.replace(/\.?$/, '.')} (${text})`;
  } catch {
    return typed;
  }
}
