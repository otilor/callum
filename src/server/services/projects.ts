import type { Person, Project, Tone } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { DuplicateProjectName } from '../db/repo.js';
import { canMoveProject, moveProject } from '../engine/lifecycle.js';
import { cancelPendingRefunding, parseWhen, plural, requirePerson, requireProject } from './common.js';
import { UserError } from './errors.js';
import { offerSaysEnough, offerSettled } from '../runner/offer.js';

const TONES: readonly Tone[] = ['warm', 'direct', 'playful'];
const MAX_NAME = 60;
const FALLBACK_NAME = 'My first project';

const duplicateCopy = (name: string): string => new DuplicateProjectName(name).message;

function cleanName(raw: string): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (name === '') throw new UserError('Give the project a name.');
  if (name.length > MAX_NAME) throw new UserError(`A project name can be ${MAX_NAME} characters at most.`);
  return name;
}

function cleanTone(tone: unknown): Tone {
  if (!TONES.includes(tone as Tone)) throw new UserError('Pick warm, direct or playful.');
  return tone as Tone;
}

function cleanCalendar(raw: string | null): string | null {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (url === '') return null;
  let ok = false;
  try {
    const u = new URL(url);
    ok = u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    ok = false;
  }
  if (!ok) throw new UserError('That calendar link needs to start with http:// or https://');
  return url;
}

const textOrNull = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function wrapped(project: Project): UserError {
  return new UserError(`${project.name} is wrapped up.`);
}

/** A name nobody has: the suggestion as it is, else with 2, 3 and so on. */
function freeName(ctx: Ctx, base: string): string {
  if (!ctx.repo.projectNameTaken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!ctx.repo.projectNameTaken(candidate)) return candidate;
  }
}

/** Starts a project. Callum suggests the name from the offer unless the user gave one. It is not started yet: Start does that. */
export async function createProject(
  ctx: Ctx,
  input: { offer: string; name?: string; audience?: string; tone?: Tone },
): Promise<Project> {
  const offer = textOrNull(input.offer);
  const tone = input.tone === undefined ? 'warm' : cleanTone(input.tone);
  let name: string;
  if (input.name !== undefined && input.name.trim() !== '') {
    name = cleanName(input.name);
    if (ctx.repo.projectNameTaken(name)) throw new UserError(duplicateCopy(name));
  } else {
    let suggested = '';
    if (offer) {
      try {
        suggested = (await ctx.writer.projectName(offer)).trim();
      } catch {
        suggested = '';
      }
    }
    name = freeName(ctx, cleanName(suggested.slice(0, MAX_NAME) || FALLBACK_NAME));
  }
  let project: Project;
  try {
    project = ctx.repo.insertProject({ name, offer, audience: textOrNull(input.audience), tone });
  } catch (e) {
    if (e instanceof DuplicateProjectName) throw new UserError(e.message);
    throw e;
  }
  if (ctx.repo.getSettings().currentProjectId === null) ctx.repo.updateSettings({ currentProjectId: project.id });
  ctx.bus.emit('projects');
  ctx.bus.emit('settings');
  return project;
}

export function renameProject(ctx: Ctx, id: number, rawName: string): Project {
  const project = requireProject(ctx, id);
  const name = cleanName(rawName);
  if (ctx.repo.projectNameTaken(name, id)) throw new UserError(duplicateCopy(name));
  try {
    const next = ctx.repo.updateProject(project.id, { name });
    ctx.bus.emit('projects');
    return next;
  } catch (e) {
    if (e instanceof DuplicateProjectName) throw new UserError(e.message);
    throw e;
  }
}

export type ProjectPatch = Partial<Pick<Project, 'offer' | 'audience' | 'tone' | 'sample' | 'calendarUrl'>>;

export function updateProject(ctx: Ctx, id: number, patch: ProjectPatch): Project {
  const before = requireProject(ctx, id);
  const next: Partial<Project> = {};
  if (patch.offer !== undefined) next.offer = textOrNull(patch.offer);
  if (patch.audience !== undefined) next.audience = textOrNull(patch.audience);
  if (patch.sample !== undefined) next.sample = textOrNull(patch.sample);
  if (patch.tone !== undefined) next.tone = cleanTone(patch.tone);
  if (patch.calendarUrl !== undefined) next.calendarUrl = cleanCalendar(patch.calendarUrl);
  const project = ctx.repo.updateProject(id, next);
  ctx.bus.emit('projects');
  if (offerSaysEnough(project.offer)) offerSettled(ctx, id);
  // First hellos still waiting for an OK were written with the old words: they are written again with the new ones.
  if (project.offer !== before.offer || project.tone !== before.tone) rewriteWaitingHellos(ctx, id);
  return project;
}

/** Takes back the project's first hellos that wait for the user's OK, so the next pass writes them again. Returns how many. */
export function rewriteWaitingHellos(ctx: Ctx, projectId: number): number {
  const ofProject = new Set(ctx.repo.listPeople({ projectId }).map((p) => p.id));
  let n = 0;
  for (const item of ctx.repo.listOutbox({ state: ['awaiting_ok'] })) {
    if (item.origin !== 'auto' || !ofProject.has(item.personId)) continue;
    ctx.repo.updateOutbox(item.id, { state: 'cancelled' });
    n++;
  }
  if (n > 0) ctx.bus.emit('outbox');
  return n;
}

/** Its automatic sends stay put until the date (or until Resume). Replies the user sends still go. */
export function pauseProject(ctx: Ctx, id: number, until: string | null): Project {
  const project = requireProject(ctx, id);
  if (project.state === 'wrapped') throw wrapped(project);
  let pausedUntil: string | null = null;
  if (until !== null) {
    const end = parseWhen(until);
    if (end.getTime() <= ctx.clock.now().getTime()) throw new UserError('Pick a date in the future.');
    pausedUntil = end.toISOString();
  }
  const next = ctx.repo.updateProject(id, { state: 'paused', pausedUntil });
  ctx.bus.emit('projects');
  return next;
}

export function resumeProject(ctx: Ctx, id: number): Project {
  const project = requireProject(ctx, id);
  if (project.state === 'wrapped') throw wrapped(project);
  const next = ctx.repo.updateProject(id, { state: 'running', pausedUntil: null });
  ctx.bus.emit('projects');
  return next;
}

const STARTING_KINDS = new Set(['hello', 'invite']);

/**
 * Cancels the project's automatic messages that have not gone out. People who are waiting or talking stay on the dock,
 * and a reply the user queued still goes.
 */
export function wrapProject(ctx: Ctx, id: number): { cancelledFollowUps: number; cancelledHellos: number; summary: string } {
  const project = requireProject(ctx, id);
  const ofProject = new Set(ctx.repo.listPeople({ projectId: id }).map((p) => p.id));
  let hellos = 0;
  let followUps = 0;
  ctx.repo.transaction(() => {
    for (const item of ctx.repo.listOutbox({ state: ['awaiting_ok', 'scheduled'] })) {
      if (item.origin !== 'auto' || !ofProject.has(item.personId)) continue;
      ctx.repo.updateOutbox(item.id, { state: 'cancelled' });
      if (STARTING_KINDS.has(item.kind)) hellos++;
      else followUps++;
    }
    ctx.repo.updateProject(id, { state: 'wrapped', pausedUntil: null });
    if (ctx.repo.getSettings().currentProjectId === id) {
      const next = ctx.repo.listProjects({ state: ['running', 'paused'] })[0];
      ctx.repo.updateSettings({ currentProjectId: next?.id ?? null });
    }
  });
  offerSettled(ctx, id);
  ctx.bus.emit('outbox');
  ctx.bus.emit('projects');
  ctx.bus.emit('settings');
  return {
    cancelledFollowUps: followUps,
    cancelledHellos: hellos,
    summary: `Nobody else in ${project.name} hears from you. ${plural(followUps, 'follow-up', 'follow-ups')} and ${plural(hellos, 'first hello', 'first hellos')} are cancelled.`,
  };
}

/** The project the user is looking at. Remembered between visits. */
export function setCurrentProject(ctx: Ctx, id: number): void {
  const project = requireProject(ctx, id);
  if (project.state === 'wrapped') throw wrapped(project);
  ctx.repo.updateSettings({ currentProjectId: id });
  ctx.bus.emit('settings');
}

/** Only strangers and resting people can move. Anyone else gets the reason in plain words. */
export function moveToProject(ctx: Ctx, personId: number, projectId: number): Person {
  const person = requirePerson(ctx, personId);
  const target = requireProject(ctx, projectId);
  if (target.state === 'wrapped') throw wrapped(target);
  if (person.projectId === projectId) return person;
  const verdict = canMoveProject(person);
  if (!verdict.ok) {
    const from = ctx.repo.getProject(person.projectId)?.name ?? 'another project';
    switch (verdict.reason) {
      case 'talking':
      case 'waiting':
        throw new UserError(`${person.firstName} is talking with you about ${from}. Finish that conversation first.`);
      case 'in_progress':
        throw new UserError(`${person.firstName} has already heard from you about ${from}. Callum can move them once they're resting.`);
      case 'stopped':
        throw new UserError(`${person.firstName} asked not to be contacted.`);
      case 'closed':
        throw new UserError(`${person.firstName}'s conversation is closed.`);
    }
  }
  // A hello the user just approved is still inside its undo window: let it settle (or be undone) first.
  const now = ctx.clock.now().getTime();
  if (ctx.outbox.pendingFor(person.id).some((i) => i.state === 'scheduled' && i.undoUntil !== null && new Date(i.undoUntil).getTime() > now)) {
    throw new UserError(`${person.firstName}'s hello is about to go out. Try again in a few seconds.`);
  }
  const moved = ctx.repo.transaction(() => {
    cancelPendingRefunding(ctx, person, ['auto']);
    return ctx.repo.updatePerson(person.id, moveProject(person, projectId));
  });
  ctx.bus.emit('people');
  ctx.bus.emit('outbox');
  return moved;
}
