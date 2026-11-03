import type { Person, PersonLead } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { FindError, MAX_FIND as FINDER_MAX } from '../leads/finder.js';
import { importPeople } from '../leads/import.js';
import { parseCsv, parsePaste, type Skipped } from '../leads/parse.js';
import { UserError } from '../services/errors.js';

export const NEEDS_A_LIST = 'Finding people needs Claude. Sign in to Claude Code on this computer, or add a Claude key in Your Callum. You can bring a CSV or a LinkedIn search link instead.';
export const DEFAULT_FIND = 10;
export const MAX_FIND = FINDER_MAX;
const LINKEDIN_RESULTS = 100;

export interface Imported { added: Person[]; skipped: Skipped[] }

/** Addresses the user has already written to from their own mailbox, so Callum does not say hello twice. */
async function alreadyWrittenTo(ctx: Ctx): Promise<Set<string>> {
  try {
    return new Set((await ctx.adapters.get('email')?.knownAddresses?.()) ?? []);
  } catch {
    // The mailbox being slow or busy is not a reason to refuse a list.
    return new Set();
  }
}

function linkedinSearchUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new UserError("That doesn't look like a LinkedIn search link.");
  }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) throw new UserError("That doesn't look like a LinkedIn search link.");
  return url.toString();
}

/** Adds the people in a CSV, a pasted list or a LinkedIn search to a project. They start as strangers. */
export async function importLeads(
  ctx: Ctx,
  projectId: number,
  source: { csv?: string; paste?: string; linkedinSearchUrl?: string },
): Promise<Imported> {
  const leads: PersonLead[] = [];
  const skipped: Skipped[] = [];
  const take = (r: { people: PersonLead[]; skipped: Skipped[] }) => {
    leads.push(...r.people);
    skipped.push(...r.skipped);
  };
  const csv = source.csv?.trim() ? source.csv : undefined;
  const paste = source.paste?.trim() ? source.paste : undefined;
  const search = source.linkedinSearchUrl?.trim() ? source.linkedinSearchUrl.trim() : undefined;
  if (csv === undefined && paste === undefined && search === undefined) {
    throw new UserError('Paste some names or a LinkedIn link first, or bring a CSV.');
  }
  if (csv !== undefined) take(parseCsv(csv));
  if (paste !== undefined) take(parsePaste(paste));
  if (search !== undefined) {
    const url = linkedinSearchUrl(search);
    const adapter = ctx.adapters.get('linkedin');
    if (!adapter?.searchPeople) throw new UserError('Connect LinkedIn first, then Callum can read that search.');
    take({ people: await adapter.searchPeople(url, LINKEDIN_RESULTS), skipped: [] });
  }
  const result = importPeople(ctx.repo, projectId, leads, { known: await alreadyWrittenTo(ctx) });
  ctx.bus.emit('people');
  return { added: result.added, skipped: [...skipped, ...result.skipped] };
}

export interface Searched extends Imported {
  /** How many people Claude found, before anyone already in Callum was left out. */
  total: number;
}

/** People already in Callum, as "Name (Company)", newest first, so a search doesn't bring them back. */
function knownNames(ctx: Ctx): string[] {
  return ctx.repo.listPeople().slice().reverse().map((p) => (p.company ? `${p.name} (${p.company})` : p.name));
}

/** Asks Claude to find people from a description on the web, and adds the ones it can reach to a project. */
export async function searchLeads(ctx: Ctx, projectId: number, query: string, count: number = DEFAULT_FIND): Promise<Searched> {
  if (!ctx.finder) throw new UserError(NEEDS_A_LIST, 422, { code: 'no_claude' });
  const want = Math.min(Math.max(Math.floor(count) || DEFAULT_FIND, 1), MAX_FIND);
  let found: PersonLead[];
  try {
    found = await ctx.finder.find({ description: query.trim(), count: want, known: knownNames(ctx) });
  } catch (e) {
    if (e instanceof FindError) throw new UserError(e.message);
    throw e;
  }
  const result = importPeople(ctx.repo, projectId, found, { known: await alreadyWrittenTo(ctx) });
  if (result.added.length > 0) ctx.bus.emit('people');
  return { total: found.length, added: result.added, skipped: result.skipped };
}
