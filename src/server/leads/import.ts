import type { Person, PersonLead } from '../../shared/types.js';
import { normalizeEmail, normalizeLinkedinUrl, normalizeXHandle } from '../db/handles.js';
import type { Repo } from '../db/repo.js';
import { fallbackName, identityKeys, type Skipped } from './parse.js';

export interface ImportResult {
  added: Person[];
  skipped: Skipped[];
  /** People already in Callum who gained a handle (email, LinkedIn or X) from a skipped row. */
  updated: Person[];
  /** Dry run only: for each person in `added`, the place of their row in the list given. */
  addedAt?: number[];
}

export interface ImportOptions {
  known?: Set<string>;
  /**
   * Work out who would be added and who skipped, and write nothing. Added people come back with `id: 0`, and the
   * project may be null (a project that does not exist yet): then everyone Callum already has is in another project.
   */
  dryRun?: boolean;
  /** The time stamped on the people of a dry run. */
  at?: string;
}

const NO_PROJECT = 0;

/** The person a dry run reports for a row: what `insertPerson` would store, with no id. */
export function sketchPerson(lead: PersonLead, name: string, projectId: number, at: string): Person {
  return {
    id: 0, projectId, name, firstName: lead.firstName ?? (name.split(/\s+/)[0] || name),
    company: lead.company ?? null, role: lead.role ?? null,
    email: normalizeEmail(lead.email), linkedinUrl: normalizeLinkedinUrl(lead.linkedinUrl), xHandle: normalizeXHandle(lead.xHandle),
    timezone: lead.timezone ?? null, channel: lead.channel ?? null, stage: lead.stage ?? 'stranger', status: lead.status ?? 'active',
    touches: lead.touches ?? 0, lastTouchAt: null, nextTouchAt: null, linkedinState: lead.linkedinState ?? 'none', invitedAt: null,
    snoozedUntil: null, restUntil: null, badge: null, replyKind: null, suggested: null, draft: null, lastInbound: null, repliedAt: null,
    source: lead.source, note: lead.note ?? null, apolloId: lead.apolloId ?? null, createdAt: at, updatedAt: at,
  };
}

/**
 * Adds people to a project as strangers. Someone is skipped when there is no way to reach them, when the user has
 * already written to their email (`known`), when they asked to stop (in any project), when they are already in this
 * project, or when they are already in another project. A batch is all or nothing.
 */
export function importPeople(repo: Repo, projectId: number | null, people: PersonLead[], opts: ImportOptions = {}): ImportResult {
  const dry = opts.dryRun === true;
  if (projectId === null ? !dry : !repo.getProject(projectId)) throw new Error('No such project');
  const here = projectId ?? NO_PROJECT;
  const stamp = opts.at ?? new Date(0).toISOString();
  const known = new Set<string>();
  for (const e of opts.known ?? []) {
    const n = normalizeEmail(e);
    if (n) known.add(n);
  }

  return repo.transaction(() => {
    // Every look-up Apollo charged for is remembered, whether or not the person could be written to.
    if (!dry) repo.markApolloSeen(people.flatMap((l) => (l.apolloId ? [l.apolloId] : [])));
    // Everyone Callum already has, by email, LinkedIn and X, so a match on any handle is found.
    const index = new Map<string, Person[]>();
    const remember = (p: Person) => {
      for (const k of identityKeys(p)) index.set(k, [...(index.get(k) ?? []).filter((q) => q.id !== p.id), p]);
    };
    const updated = new Map<number, Person>();
    const added: Person[] = [];
    const addedAt: number[] = [];
    const skipped: Skipped[] = [];
    // A repeat may carry a handle Callum does not have yet. Keeping it means a stop, or a later list that knows the
    // person only by that handle, still finds them. Never overwrites, and never takes a handle someone else holds.
    const learnHandles = (person: Person, lead: PersonLead) => {
      if (dry) return;
      const patch: Partial<Person> = {};
      const email = normalizeEmail(lead.email);
      const linkedin = normalizeLinkedinUrl(lead.linkedinUrl);
      const x = normalizeXHandle(lead.xHandle);
      if (!person.email && email && !index.has(`email:${email}`)) patch.email = email;
      if (!person.linkedinUrl && linkedin && !index.has(`linkedin:${linkedin}`)) patch.linkedinUrl = linkedin;
      if (!person.xHandle && x && !index.has(`x:${x}`)) patch.xHandle = x;
      if (Object.keys(patch).length === 0) return;
      const next = repo.updatePerson(person.id, patch);
      remember(next);
      // Someone added earlier in this same import is reported once, as added, with the fresh record.
      const at = added.findIndex((a) => a.id === next.id);
      if (at >= 0) added[at] = next;
      else updated.set(next.id, next);
    };
    repo.listPeople().forEach(remember);
    const projectNames = new Map<number, string>();
    const projectName = (id: number): string => {
      let name = projectNames.get(id);
      if (name === undefined) {
        name = repo.getProject(id)?.name ?? '';
        projectNames.set(id, name);
      }
      return name;
    };

    for (const [place, { row, ...lead }] of people.entries()) {
      const at = row === undefined ? {} : { row };
      const name = lead.name.trim() || fallbackName(lead) || '';
      const keys = identityKeys(lead);
      if (keys.length === 0) {
        skipped.push({ name, reason: 'no_channel', ...at });
        continue;
      }
      const email = normalizeEmail(lead.email);
      if (email && known.has(email)) {
        skipped.push({ name, reason: 'known', ...at });
        continue;
      }
      const matches = keys.flatMap((k) => index.get(k) ?? []);
      if (matches.length > 0) {
        const ids = new Set(matches.map((m) => m.id));
        const only = ids.size === 1 ? matches[0]! : null;
        // Already looked up in Apollo: remembering the id keeps the next search from paying for them again.
        if (only && !only.apolloId && lead.apolloId && !dry) remember(repo.updatePerson(only.id, { apolloId: lead.apolloId }));
        // The person gains the handles this row adds when they are stopped (so the stop holds on every handle) or
        // in this project. Someone in another project is left alone. A row that links two people changes neither.
        if (only && (only.status === 'stopped' || only.projectId === here)) learnHandles(only, lead);
        if (matches.some((m) => m.status === 'stopped')) skipped.push({ name, reason: 'stopped', ...at });
        else if (matches.some((m) => m.projectId === here)) skipped.push({ name, reason: 'duplicate', ...at });
        else skipped.push({ name, reason: 'other_project', projectName: projectName(matches[0]!.projectId), ...at });
        continue;
      }
      // Someone who asked to stop is never added again, even after the user deleted everything Callum held.
      if (repo.isSuppressed(lead)) {
        skipped.push({ name, reason: 'stopped', ...at });
        continue;
      }
      const person = dry ? sketchPerson(lead, name, here, stamp) : repo.insertPerson({ ...lead, name, projectId: here });
      remember(person);
      added.push(person);
      addedAt.push(place);
    }
    return { added, skipped, updated: [...updated.values()], ...(dry ? { addedAt } : {}) };
  });
}
