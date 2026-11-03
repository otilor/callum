import { randomUUID } from 'node:crypto';
import type {
  AddCommit, AddPreview, Described, Person, PersonLead, PreviewPerson, Project, SkipGroup, SkipReason, Tone,
} from '../../shared/types.js';
import { ConnectError } from '../channels/types.js';
import type { Ctx } from '../context.js';
import { chooseChannel, personTz } from '../engine/lifecycle.js';
import { localParts } from '../engine/time.js';
import { firstSlotAfterStart } from '../engine/windows.js';
import { FindError } from '../leads/finder.js';
import { importPeople, sketchPerson } from '../leads/import.js';
import { decodeLeadFile, ImportFileError, parseCsv, parsePaste, type Skipped } from '../leads/parse.js';
import { UserError } from './errors.js';
import { domainOf } from '../leads/site.js';

/** A preview waits this long for the user to press Add, and an added batch can be undone for as long. Each use starts it again. */
export const BATCH_MS = 10 * 60_000;
/** Previews kept at once. The oldest make room for new ones. */
export const MAX_BATCHES = 20;
/** The most people one list can bring. */
export const MAX_ROWS = 5000;
const TOO_MANY = `That's a lot of people. Add up to ${MAX_ROWS} at a time.`;
/** How many people a described search brings back to look at. */
/** How many people a description looks for. They show as they are found, so this is how far the search goes, not a wait. */
export const DESCRIBE_COUNT = 25;
/** A LinkedIn search link is read up to this many people. */
export const LINKEDIN_COUNT = 100;

export const NO_CLAUDE = 'Finding people needs Claude. Sign in to Claude Code on this computer, or add a Claude key in Your Callum. You can bring a list instead.';
export const NOT_A_SEARCH = "That isn't a LinkedIn people search. It should start with linkedin.com/search/results/people.";
const LINKEDIN_SEARCH = /linkedin\.com\/search\/results\/people/i;

export interface AddSource {
  csv?: string;
  /** A CSV as the bytes of the file, in base64, so Excel's encodings are read the way the file was saved. */
  csvBase64?: string;
  paste?: string;
  linkedinSearchUrl?: string;
}

interface Batch {
  projectId: number | null;
  expires: number;
  /** People from a list, a paste or a LinkedIn search, in the order the batch shows them. */
  leads: PersonLead[];
  /** Rows that could not be read as people. */
  unreadable: Skipped[];
  known: Set<string>;
  committing: boolean;
  /** Everyone added so far from this batch, for undo. */
  added: number[] | null;
  /** The project they were added to, and what was said, so pressing Add again gets the same answer. */
  addedTo: number | null;
  result: AddCommit | null;
  /** A description search: what was typed, whether Claude is still looking, and why it stopped when it failed. */
  search?: { query: string; looking: boolean; failure: string | null; mailboxRead: boolean };
}

const stores = new WeakMap<Ctx, Map<string, Batch>>();

function storeOf(ctx: Ctx): Map<string, Batch> {
  let store = stores.get(ctx);
  if (!store) {
    store = new Map();
    stores.set(ctx, store);
  }
  const now = ctx.clock.now().getTime();
  for (const [id, batch] of store) if (batch.expires <= now) store.delete(id);
  return store;
}

function keep(ctx: Ctx, batch: Pick<Batch, 'projectId' | 'leads' | 'unreadable' | 'known'>): string {
  const id = randomUUID();
  const store = storeOf(ctx);
  while (store.size >= MAX_BATCHES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  store.set(id, {
    ...batch, expires: ctx.clock.now().getTime() + BATCH_MS, committing: false, added: null, addedTo: null, result: null,
  });
  return id;
}

/** A batch still waiting. Using it gives it another ten minutes. */
function liveBatch(ctx: Ctx, id: unknown): Batch | undefined {
  const batch = typeof id === 'string' ? storeOf(ctx).get(id) : undefined;
  if (batch) batch.expires = ctx.clock.now().getTime() + BATCH_MS;
  return batch;
}

function batchOf(ctx: Ctx, id: string): Batch {
  const batch = liveBatch(ctx, id);
  if (!batch) throw new UserError('That list is no longer here. Bring it again.', 410);
  return batch;
}

// ---- who is joining ---------------------------------------------------------------------------------------

/** The project the people go to unless the caller says otherwise: the one last viewed, else the first that is not wrapped. */
function resolveProject(ctx: Ctx, requested: number | null | undefined): number | null {
  if (requested === null) return null;
  const projects = ctx.repo.listProjects();
  if (requested !== undefined) {
    if (!projects.some((p) => p.id === requested)) throw new UserError("Callum can't find that project.", 404);
    return requested;
  }
  const current = ctx.repo.getSettings().currentProjectId;
  const found = projects.find((p) => p.id === current) ?? projects.find((p) => p.state !== 'wrapped') ?? null;
  return found?.id ?? null;
}

/** Everyone the user has already emailed, from the Sent folder. A mailbox that cannot be read adds nobody to the list. */
async function emailedBefore(ctx: Ctx): Promise<Set<string>> {
  try {
    const list = (await ctx.adapters.get('email')?.knownAddresses?.()) ?? [];
    return new Set(list);
  } catch {
    return new Set();
  }
}

async function read(ctx: Ctx, source: AddSource): Promise<{ people: PersonLead[]; skipped: Skipped[] }> {
  try {
    if (typeof source.csvBase64 === 'string' && source.csvBase64 !== '') return parseCsv(decodeLeadFile(Buffer.from(source.csvBase64, 'base64')));
    if (typeof source.csv === 'string' && source.csv.trim() !== '') return parseCsv(source.csv);
    if (typeof source.paste === 'string' && source.paste.trim() !== '') return parsePaste(source.paste);
  } catch (e) {
    if (e instanceof ImportFileError) throw new UserError(e.message);
    throw e;
  }
  const url = typeof source.linkedinSearchUrl === 'string' ? source.linkedinSearchUrl.trim() : '';
  if (url === '') throw new UserError('Bring a list first: a CSV, some names, or a LinkedIn search link.');
  if (!LINKEDIN_SEARCH.test(url)) throw new UserError(NOT_A_SEARCH);
  const adapter = ctx.adapters.get('linkedin');
  if (!adapter?.searchPeople) throw new UserError('Connect LinkedIn first, and Callum can read that search for you.');
  try {
    return { people: await adapter.searchPeople(url, LINKEDIN_COUNT), skipped: [] };
  } catch (e) {
    if (e instanceof ConnectError) throw new UserError(e.message);
    throw e;
  }
}

const REASON_ORDER: SkipReason[] = ['known', 'duplicate', 'other_project', 'stopped', 'no_channel'];

function lineFor(reason: SkipReason, n: number, projectName: string | undefined): string {
  switch (reason) {
    case 'known': return `${n} you've emailed before`;
    case 'duplicate': return `${n} already in Callum`;
    case 'stopped': return `${n} asked not to be contacted`;
    case 'no_channel': return `${n} ${n === 1 ? 'has' : 'have'} no email or LinkedIn`;
    case 'other_project': return `${n} ${n === 1 ? 'is' : 'are'} already in ${projectName ?? 'another project'}`;
  }
}

/** Skipped people, grouped by why, each group already worded. People in other projects are grouped by project. */
export function groupSkips(skipped: Skipped[]): SkipGroup[] {
  const groups = new Map<string, { reason: SkipReason; names: string[]; projectName?: string }>();
  for (const s of skipped) {
    const projectName = s.reason === 'other_project' ? (s.projectName ?? 'another project') : undefined;
    const key = projectName === undefined ? s.reason : `${s.reason}\u0000${projectName}`;
    const group = groups.get(key) ?? { reason: s.reason, names: [], ...(projectName === undefined ? {} : { projectName }) };
    group.names.push(s.name || (s.row === undefined ? 'Someone' : `Row ${s.row}`));
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason))
    .map((g) => ({ reason: g.reason, line: lineFor(g.reason, g.names.length, g.projectName), names: g.names, ...(g.projectName === undefined ? {} : { projectName: g.projectName }) }));
}

function previewOf(p: Person, key: string): PreviewPerson {
  const { id: _id, createdAt: _created, updatedAt: _updated, ...rest } = p;
  return { ...rest, key };
}

/**
 * Reads a list, a paste or a LinkedIn search and says who would join and who would be skipped, and why. Nothing is
 * written. The batch waits for ten minutes for `commit`. `projectId: null` is a project that does not exist yet.
 */
export async function preview(ctx: Ctx, source: AddSource, opts: { projectId?: number | null } = {}): Promise<AddPreview> {
  const projectId = resolveProject(ctx, opts.projectId);
  const { people, skipped: unreadable } = await read(ctx, source);
  if (people.length === 0 && unreadable.length === 0) {
    throw new UserError("Callum didn't find anyone in that. Each person needs a name and an email, a LinkedIn link or an X handle.");
  }
  if (people.length + unreadable.length > MAX_ROWS) throw new UserError(TOO_MANY);
  const known = await emailedBefore(ctx);
  const dry = importPeople(ctx.repo, projectId, people, { dryRun: true, known, at: ctx.clock.now().toISOString() });
  const batchId = keep(ctx, { projectId, leads: people, unreadable, known });
  const places = dry.addedAt ?? [];
  return {
    batchId,
    added: dry.added.map((p, i) => previewOf(p, String(places[i] ?? i))),
    groups: groupSkips([...unreadable, ...dry.skipped]),
  };
}

// ---- describing people (Claude, on the web) --------------------------------------------------------------

/** A chip the user pressed, as words added to what they typed. */
function chipWords(chip: string): string {
  const t = chip.trim().slice(0, 80);
  if (t === '20 to 200 people') return 'at companies of 20 to 200 people';
  const city = /^(\p{L}[\p{L}'. -]*) only$/u.exec(t)?.[1];
  return city ? `in ${city} only` : t;
}

/** What the sender offers and their own company's site, so a search leaves out competitors and colleagues. */
export function sender(ctx: Ctx, projectId: number | null, typed?: string | null): { offer: string | null; ownSite: string | null } {
  const email = ctx.repo.getSettings().senderEmail;
  // A project still being set up has no offer saved yet: the words typed for it stand in.
  const saved = projectId === null ? null : ctx.repo.getProject(projectId)?.offer ?? null;
  return {
    offer: saved?.trim() ? saved : typed?.trim() ? typed.trim().slice(0, 1000) : null,
    ownSite: email ? domainOf(email) : null,
  };
}

/** People already in Callum, as "Name (Company)", newest first, so a search doesn't bring them back. */
function knownNames(ctx: Ctx): string[] {
  return ctx.repo.listPeople()
    .slice()
    .reverse()
    .map((p) => (p.company ? `${p.name} (${p.company})` : p.name));
}

/**
 * Looks for real people from words. Claude searches the web (through Claude Code on this computer, or the API with a
 * key) and brings back people with an email, a LinkedIn profile or an X handle it saw on a page. Nothing is added
 * until the user presses Add; people already in Callum are left out.
 *
 * With `live`, it answers at once with an empty batch that fills as Claude finds people: `describeStatus` says who is
 * there so far and whether it is still looking. Without it, the answer waits for the whole search.
 */
export async function describe(
  ctx: Ctx,
  q: { query: string; filters?: string[]; projectId?: number | null; live?: boolean; offer?: string | null },
): Promise<Described> {
  const finder = ctx.finder;
  if (!finder) throw new UserError(NO_CLAUDE, 422, { code: 'no_claude' });
  const query = typeof q.query === 'string' ? q.query.trim() : '';
  if (query === '') throw new UserError('Describe who you want to meet first.');
  const filters = (q.filters ?? []).filter((f): f is string => typeof f === 'string' && f.trim() !== '');
  const projectId = resolveProject(ctx, q.projectId);
  const description = [query.slice(0, 500), ...filters.map(chipWords)].join(', ');
  const batchId = keep(ctx, { projectId, leads: [], unreadable: [], known: new Set() });
  const batch = batchOf(ctx, batchId);
  const search = { query, looking: true, failure: null as string | null, mailboxRead: false };
  batch.search = search;
  // The Sent folder is read while Claude looks, not before: a slow mailbox does not hold up the first people.
  const mailbox = emailedBefore(ctx).then((known) => {
    batch.known = known;
    search.mailboxRead = true;
  });
  const shown = new Set<string>();
  const take = (people: PersonLead[]) => {
    // Once the user pressed Add, people who turn up later are not slipped into what they added.
    if (batch.added || batch.committing) return;
    for (const p of people) {
      // The finder's last answer repeats who it already showed: the same person is one row.
      const keys = [p.email, p.linkedinUrl, p.xHandle && `x:${p.xHandle}`, `${p.name}|${p.company ?? ''}`.toLowerCase()].filter(Boolean) as string[];
      if (keys.some((k) => shown.has(k))) continue;
      for (const k of keys) shown.add(k);
      batch.leads.push(p);
    }
    // A long search keeps its batch: it is not forgotten while people are still turning up.
    batch.expires = Math.max(batch.expires, ctx.clock.now().getTime() + BATCH_MS);
  };
  const found = finder.find({ description, count: DESCRIBE_COUNT, known: knownNames(ctx), ...sender(ctx, projectId, q.offer), onFound: take })
    .then(take, (e: unknown) => {
      search.failure = e instanceof FindError ? e.message : 'Callum could not finish looking. Try again.';
      if (!(e instanceof FindError)) ctx.onError(e);
    })
  const done = Promise.all([found, mailbox]).finally(() => {
    search.looking = false;
  });
  if (!q.live) {
    await done;
    if (search.failure && batch.leads.length === 0) throw new UserError(search.failure);
  }
  return describeStatus(ctx, batchId);
}

/** Who a description search has found so far, and whether Claude is still looking. Keys stay the same as more arrive. */
export function describeStatus(ctx: Ctx, batchId: string): Described {
  const batch = batchOf(ctx, batchId);
  const search = batch.search;
  if (!search) throw new UserError('That list is no longer here. Bring it again.', 410);
  const looking = search.looking && !batch.added;
  if (!looking && search.failure && batch.leads.length === 0) throw new UserError(search.failure);
  // Until the Sent folder is read, nobody is shown: a row must not appear and then vanish as someone already emailed.
  const ready = search.mailboxRead ? batch.leads : [];
  const dry = importPeople(ctx.repo, batch.projectId, ready, { dryRun: true, known: batch.known, at: ctx.clock.now().toISOString() });
  const places = dry.addedAt ?? [];
  const rows = dry.added.map((p, i) => previewOf(p, String(places[i] ?? i)));
  if (!looking && rows.length === 0) {
    const line = batch.leads.length === 0
      ? `Callum found nobody for '${search.query}' it could reach. Try a wider role or a nearby city.`
      : `Everyone Callum found for '${search.query}' is already in Callum. Try a wider role or a nearby city.`;
    return { batchId: null, total: 0, people: [], narrow: null, line, searching: false };
  }
  return { batchId, total: rows.length, people: rows, narrow: null, line: `Callum found ${rows.length}`, searching: looking };
}

// ---- adding -----------------------------------------------------------------------------------------------

const fmt = (n: number): string => n.toLocaleString('en-US');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** `tomorrow at 9:00`, `Monday at 9:00`: when the first hellos can go out, in the user's own words. */
function slotWords(at: Date, tz: string, now: Date): string {
  const p = localParts(at, tz);
  const here = localParts(now, tz);
  const ahead = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(here.year, here.month - 1, here.day)) / 86_400_000);
  const time = `${p.hour}:${String(p.minute).padStart(2, '0')}`;
  if (ahead <= 0) return `today at ${time}`;
  if (ahead === 1) return `tomorrow at ${time}`;
  return `${DAY_NAMES[p.weekday]} at ${time}`;
}

/** Where the first hellos stand, in words: when they go out, or what has to happen first. */
function whenWords(project: Project, now: Date, tz: string): string {
  if (project.startedAt === null) return `They'll get hellos once ${project.name} starts.`;
  if (project.state === 'paused') return `They'll get hellos once you resume ${project.name}.`;
  return `First hellos from ${slotWords(firstSlotAfterStart(now, tz), tz, now)}.`;
}

/**
 * Adds the batch to a project as strangers. `drop` names the people the user said were not a fit. In a project that
 * has started, the new people get their first slot at once. Pressing Add a second time for the same project gives the
 * same answer and adds nobody.
 */
export async function commit(ctx: Ctx, batchId: string, opts: { projectId?: number; drop?: string[]; only?: string[] } = {}): Promise<AddCommit> {
  const batch = batchOf(ctx, batchId);
  const projectId = opts.projectId ?? batch.projectId;
  if (batch.added) {
    if (batch.result && batch.addedTo === projectId) return batch.result;
    throw new UserError('Those people are already in.');
  }
  if (batch.committing) throw new UserError('Callum is still adding them.');
  const project = projectId === null ? null : ctx.repo.getProject(projectId);
  if (!project) throw new UserError('Choose the project they join first.');
  if (project.state === 'wrapped') throw new UserError(`${project.name} is wrapped up.`);
  const drop = new Set(opts.drop ?? []);

  batch.committing = true;
  try {
    // A live search may have found more since the screen last asked: only the people the user saw are added.
    const only = opts.only ? new Set(opts.only) : null;
    const leads = batch.leads.filter((_, i) => !drop.has(String(i)) && (!only || only.has(String(i))));
    // Someone emailed since the batch was made (a search takes minutes) is not said hello to again.
    const known = new Set([...batch.known, ...(await emailedBefore(ctx))]);
    // The project may have been wrapped up while the mailbox was read.
    if (ctx.repo.getProject(project.id)?.state === 'wrapped') throw new UserError(`${project.name} is wrapped up.`);
    const result = importPeople(ctx.repo, project.id, leads, { known });
    const now = ctx.clock.now();
    const settings = ctx.repo.getSettings();
    const added = project.startedAt === null ? result.added : result.added.map((p) => scheduleFirst(ctx, p, settings.timezone, now));
    batch.added = added.map((p) => p.id);
    batch.addedTo = project.id;
    if (added.length > 0 || result.updated.length > 0) ctx.bus.emit('people');

    const line = added.length === 0
      ? 'Nobody new joined.'
      : `${added.length === 1 ? '1 person joins' : `${fmt(added.length)} people join`} the river. ${whenWords(project, now, settings.timezone)}`;
    const answer: AddCommit = { added, line, groups: groupSkips([...batch.unreadable, ...result.skipped]) };
    batch.result = answer;
    return answer;
  } finally {
    batch.committing = false;
  }
}

/** A new person in a project that is already running: a channel and their first slot, so Callum plans their hello at once. */
function scheduleFirst(ctx: Ctx, person: Person, userTz: string, now: Date): Person {
  const connected = ctx.repo.listChannels().filter((c) => c.status === 'connected').map((c) => c.channel);
  const channel = chooseChannel(person, connected);
  if (!channel) return person;
  return ctx.repo.updatePerson(person.id, { channel, nextTouchAt: firstSlotAfterStart(now, personTz(person, userTz)).toISOString() });
}

/** Takes back what `commit` added, for everyone Callum has not written to and has not heard from. */
export function undoBatch(ctx: Ctx, batchId: string): { removed: number } {
  const batch = batchOf(ctx, batchId);
  if (!batch.added) throw new UserError('Nobody was added from that list.');
  let removed = 0;
  ctx.repo.transaction(() => {
    for (const id of batch.added ?? []) {
      if (ctx.repo.deletePerson(id)) removed++;
    }
  });
  // The batch stays, so the same people can be added again: for people Claude found, without searching again.
  batch.added = null;
  batch.addedTo = null;
  batch.result = null;
  if (removed > 0) {
    ctx.bus.emit('people');
    ctx.bus.emit('outbox');
  }
  return { removed };
}

/**
 * Removes a project that was made for a list and then got nobody: it never started and has nobody in it. Anything
 * else is left alone. Returns whether it was removed.
 */
export function discardProject(ctx: Ctx, projectId: number): { discarded: boolean } {
  const discarded = ctx.repo.deleteEmptyProject(projectId);
  if (discarded) {
    if (ctx.repo.getSettings().currentProjectId === projectId) {
      const next = ctx.repo.listProjects({ state: ['running', 'paused'] })[0];
      ctx.repo.updateSettings({ currentProjectId: next?.id ?? null });
    }
    ctx.bus.emit('projects');
    ctx.bus.emit('settings');
  }
  return { discarded };
}

// ---- the voice of a project that does not exist yet -------------------------------------------------------

const TONES: readonly Tone[] = ['warm', 'direct', 'playful'];

/**
 * A first hello as Callum would write it for a project the user is still setting up: from the offer and the tone,
 * to the first person of the batch they are looking at (or Kemi Eze at Oko Pay when there is none yet).
 */
export async function sampleHello(
  ctx: Ctx,
  input: { offer: string; tone: Tone; batchId?: string; key?: string },
): Promise<{ body: string; to: { name: string; company: string | null } }> {
  const offer = typeof input.offer === 'string' ? input.offer.trim() : '';
  if (offer === '') throw new UserError('Say what you offer first.');
  if (!TONES.includes(input.tone)) throw new UserError('Pick warm, direct or playful.');
  const at = ctx.clock.now().toISOString();
  const batch = input.batchId ? liveBatch(ctx, input.batchId) : undefined;
  let lead: PersonLead | undefined;
  if (batch && input.key !== undefined) {
    lead = batch.leads[Number(input.key)];
  }
  const person: Person = lead
    ? sketchPerson(lead, lead.name, 0, at)
    : sketchPerson({ name: 'Kemi Eze', firstName: 'Kemi', company: 'Oko Pay', email: 'kemi@okopay.com', source: 'demo' }, 'Kemi Eze', 0, at);
  const connected = ctx.repo.listChannels().filter((c) => c.status === 'connected').map((c) => c.channel);
  const channel = chooseChannel(person, connected) ?? 'email';
  const project: Project = {
    id: 0, name: 'New project', offer, audience: null, tone: input.tone, sample: null, calendarUrl: null, approvalsLeft: 10,
    startedAt: null, state: 'running', pausedUntil: null, createdAt: at, updatedAt: at,
  };
  const written = await ctx.writer.write(channel === 'linkedin' ? 'invite' : 'hello', {
    person: { ...person, channel }, project, settings: ctx.repo.getSettings(), channel, history: [],
  });
  return { body: written.body, to: { name: person.name, company: person.company } };
}
