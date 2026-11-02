import type { Person, PersonLead } from '../../shared/types.js';
import { normalizeEmail, normalizeLinkedinUrl, normalizeXHandle } from '../db/handles.js';
import type { Repo } from '../db/repo.js';
import { fallbackName, identityKeys, type Skipped } from './parse.js';

export interface ImportResult {
  added: Person[];
  skipped: Skipped[];
  /** People already in Callum who gained a handle (email, LinkedIn or X) from a skipped row. */
  updated: Person[];
}

/**
 * Adds people to a project as strangers. Someone is skipped when there is no way to reach them, when the user has
 * already written to their email (`known`), when they asked to stop (in any project), when they are already in this
 * project, or when they are already in another project. A batch is all or nothing.
 */
export function importPeople(repo: Repo, projectId: number, people: PersonLead[], opts: { known?: Set<string> } = {}): ImportResult {
  if (!repo.getProject(projectId)) throw new Error('No such project');
  const known = new Set<string>();
  for (const e of opts.known ?? []) {
    const n = normalizeEmail(e);
    if (n) known.add(n);
  }

  return repo.transaction(() => {
    // Everyone Callum already has, by email, LinkedIn and X, so a match on any handle is found.
    const index = new Map<string, Person[]>();
    const remember = (p: Person) => {
      for (const k of identityKeys(p)) index.set(k, [...(index.get(k) ?? []).filter((q) => q.id !== p.id), p]);
    };
    const updated = new Map<number, Person>();
    // A repeat may carry a handle Callum does not have yet. Keeping it means a stop, or a later list that knows the
    // person only by that handle, still finds them. Never overwrites, and never takes a handle someone else holds.
    const learnHandles = (person: Person, lead: PersonLead) => {
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
      updated.set(next.id, next);
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

    const added: Person[] = [];
    const skipped: Skipped[] = [];
    for (const { row, ...lead } of people) {
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
        // The person gains the handles this row adds when they are stopped (so the stop holds on every handle) or
        // in this project. Someone in another project is left alone. A row that links two people changes neither.
        if (only && (only.status === 'stopped' || only.projectId === projectId)) learnHandles(only, lead);
        if (matches.some((m) => m.status === 'stopped')) skipped.push({ name, reason: 'stopped', ...at });
        else if (matches.some((m) => m.projectId === projectId)) skipped.push({ name, reason: 'duplicate', ...at });
        else skipped.push({ name, reason: 'other_project', projectName: projectName(matches[0]!.projectId), ...at });
        continue;
      }
      const person = repo.insertPerson({ ...lead, name, projectId });
      remember(person);
      added.push(person);
    }
    return { added, skipped, updated: [...updated.values()] };
  });
}
