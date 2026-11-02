import type { Person, PersonLead } from '../../shared/types.js';
import type { Ctx } from '../context.js';
import { ApolloError, type ApolloEnrichment } from '../leads/apollo.js';
import { importPeople } from '../leads/import.js';
import { parseCsv, parsePaste, type Skipped } from '../leads/parse.js';
import { UserError } from '../services/errors.js';

export const NEEDS_A_LIST = 'Callum needs a list for that. Bring a CSV or a LinkedIn search link.';
export const DEFAULT_FIND = 25;
export const MAX_FIND = 200;
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
  total: number;
  /** Apollo credits the lookup used. */
  creditsUsed: number;
  /** Set when Apollo stopped part of the way: the people already looked up were still added. */
  error?: string;
}

/** Describes people to Apollo, looks up the ones it finds and adds them to a project. */
export async function searchLeads(ctx: Ctx, projectId: number, query: string, count: number = DEFAULT_FIND): Promise<Searched> {
  if (!ctx.apollo) throw new UserError(NEEDS_A_LIST);
  const want = Math.min(Math.max(Math.floor(count) || DEFAULT_FIND, 1), MAX_FIND);
  const found = await ctx.apollo.search({ query: query.trim(), titles: [], count: want });
  if (found.previews.length === 0) return { total: found.total, added: [], skipped: [], creditsUsed: 0 };
  let enriched: ApolloEnrichment;
  let error: string | undefined;
  try {
    enriched = await ctx.apollo.enrich(found.previews.map((p) => p.apolloId));
  } catch (e) {
    if (!(e instanceof ApolloError) || !e.partial) throw e;
    enriched = e.partial;
    error = `${e.message} Callum added the ${enriched.people.length} it had already looked up.`;
  }
  const result = importPeople(ctx.repo, projectId, enriched.people, { known: await alreadyWrittenTo(ctx) });
  ctx.bus.emit('people');
  return {
    total: found.total, added: result.added, skipped: result.skipped, creditsUsed: enriched.creditsUsed,
    ...(error ? { error } : {}),
  };
}
