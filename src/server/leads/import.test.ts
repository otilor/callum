import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PersonLead } from '../../shared/types.js';
import { openDb } from '../db/db.js';
import { Repo } from '../db/repo.js';
import { makeProject } from '../db/testing.test-helpers.js';
import { importPeople } from './import.js';
import { parseCsv } from './parse.js';

let repo: Repo;
let tick: number;
let projectId: number;
beforeEach(() => {
  tick = 0;
  repo = new Repo(openDb(':memory:'), () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString());
  projectId = makeProject(repo, { name: 'Payroll' }).id;
});

const messy =
  '﻿First Name;Last Name;Work Email;Company;LinkedIn\r\n' +
  'Kemi;Eze;kemi@okopay.com;Oko Pay;\r\n' +
  ';;;;\r\n' +
  'Femi;Ade;;Ledgerly;linkedin.com/in/femi-ade\r\n' +
  'Kemi;Eze;KEMI@okopay.com;Oko Pay;\r\n' +
  'Tunde;Bakare;;Paystack Partners;\r\n';

describe('importPeople with real exports', () => {
  const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

  it('imports LinkedIn, Apollo, HubSpot and Google files in turn: new people join, repeats are named', () => {
    const run = (file: string) => {
      const parsed = parseCsv(fixture(file));
      const result = importPeople(repo, projectId, parsed.people);
      return { added: result.added.map((p) => p.name), skipped: result.skipped.map((s) => `${s.name}:${s.reason}`), unreadable: parsed.skipped.map((s) => `${s.name}:${s.reason}`) };
    };
    expect(run('linkedin-connections.csv')).toEqual({
      added: ['Kemi Eze', 'Femi Ade', 'Zoë Müller', 'Ada Okafor'], skipped: [], unreadable: ['Tunde Bakare:no_channel'],
    });
    // Kemi (LinkedIn URL) and Femi (LinkedIn URL) are already here; Amaka is new; Sade has no way to be reached.
    expect(run('apollo-export.csv')).toEqual({
      added: ['Amaka Obi'], skipped: ['Kemi Eze:duplicate', 'Femi Ade:duplicate'], unreadable: ['Sade Bello:no_channel'],
    });
    // HubSpot knows Kemi only by email. The Apollo file already gave her email to the Kemi Callum has, so she is recognised.
    expect(run('hubspot-contacts.csv')).toEqual({
      added: ['Tomás Rivera', 'Priya Nair'], skipped: ['Kemi Eze:duplicate'], unreadable: ['Nobody:no_channel'],
    });
    expect(run('google-contacts.csv')).toEqual({
      added: ['sade'], skipped: ['Kemi Eze:duplicate', 'Femi Ade:duplicate'], unreadable: ['Mum:no_channel'],
    });
    expect(repo.listPeople().map((p) => p.name)).toEqual(['Kemi Eze', 'Femi Ade', 'Zoë Müller', 'Ada Okafor', 'Amaka Obi', 'Tomás Rivera', 'Priya Nair', 'sade']);
    // The LinkedIn-only Kemi learned her email from the Apollo file, and her X handle from HubSpot.
    expect(repo.listPeople()[0]).toMatchObject({ email: 'kemi@okopay.com', linkedinUrl: 'https://www.linkedin.com/in/kemi-eze-5a2b1c', xHandle: 'kemieze', source: 'csv' });
  });
});

describe('importPeople', () => {
  it('adds people to the project as strangers and reports nothing skipped', () => {
    const { people } = parseCsv(messy);
    const { added, skipped } = importPeople(repo, projectId, people);
    expect(skipped).toEqual([]);
    expect(added.map((p) => [p.name, p.projectId, p.stage, p.status, p.source, p.email, p.linkedinUrl])).toEqual([
      ['Kemi Eze', projectId, 'stranger', 'active', 'csv', 'kemi@okopay.com', null],
      ['Femi Ade', projectId, 'stranger', 'active', 'csv', null, 'https://www.linkedin.com/in/femi-ade'],
    ]);
    expect(repo.listPeople({ projectId })).toHaveLength(2);
  });

  it('review focus 5: the messy file end to end, with one person already stopped, then imported again', () => {
    const parsed = parseCsv(messy);
    expect(parsed.people).toHaveLength(2);
    expect(parsed.skipped.map((s) => s.reason)).toEqual(['duplicate', 'no_channel']);

    const kemi = repo.insertPerson({ name: 'Kemi Eze', source: 'referral', projectId, email: 'kemi@okopay.com' });
    repo.updatePerson(kemi.id, { status: 'stopped' });

    const first = importPeople(repo, projectId, parsed.people);
    expect(first.added.map((p) => p.name)).toEqual(['Femi Ade']);
    expect(first.skipped).toEqual([{ name: 'Kemi Eze', reason: 'stopped' }]);

    const second = importPeople(repo, projectId, parsed.people);
    expect(second.added).toEqual([]);
    expect(second.skipped).toEqual([
      { name: 'Kemi Eze', reason: 'stopped' },
      { name: 'Femi Ade', reason: 'duplicate' },
    ]);
    expect(repo.listPeople()).toHaveLength(2);
  });

  it('a second import of the same file is all duplicates', () => {
    const { people } = parseCsv(messy);
    importPeople(repo, projectId, people);
    const again = importPeople(repo, projectId, people);
    expect(again.added).toEqual([]);
    expect(again.skipped).toEqual([
      { name: 'Kemi Eze', reason: 'duplicate' },
      { name: 'Femi Ade', reason: 'duplicate' },
    ]);
  });

  it('skips someone with no email, LinkedIn or X, and anything that does not normalise into one', () => {
    const lead = (o: Partial<PersonLead> & { name: string }): PersonLead => ({ source: 'csv', ...o });
    const { added, skipped } = importPeople(repo, projectId, [
      lead({ name: 'Tunde Bakare', company: 'Paystack' }),
      lead({ name: 'Bad Link', linkedinUrl: 'https://example.com/in/bad', email: '' }),
      lead({ name: 'Ok Person', xHandle: '@okperson' }),
    ]);
    expect(skipped).toEqual([
      { name: 'Tunde Bakare', reason: 'no_channel' },
      { name: 'Bad Link', reason: 'no_channel' },
    ]);
    expect(added.map((p) => [p.name, p.xHandle])).toEqual([['Ok Person', 'okperson']]);
  });

  it('skips emails the user has already written to (known), whatever the case', () => {
    const { added, skipped } = importPeople(
      repo, projectId,
      [
        { name: 'Kemi Eze', email: 'Kemi@OkoPay.com', source: 'csv' },
        { name: 'Femi Ade', email: 'femi@ledgerly.io', source: 'csv' },
      ],
      { known: new Set(['kemi@okopay.com']) },
    );
    expect(skipped).toEqual([{ name: 'Kemi Eze', reason: 'known' }]);
    expect(added.map((p) => p.name)).toEqual(['Femi Ade']);
  });

  it('matches an existing person by LinkedIn or X as well as email', () => {
    repo.insertPerson({ name: 'Femi Ade', source: 'csv', projectId, linkedinUrl: 'https://www.linkedin.com/in/femi-ade' });
    repo.insertPerson({ name: 'Ada', source: 'csv', projectId, xHandle: 'adaokafor' });
    const { added, skipped } = importPeople(repo, projectId, [
      { name: 'F. Ade', email: 'new@ledgerly.io', linkedinUrl: 'linkedin.com/in/Femi-Ade/', source: 'csv' },
      { name: 'Ada O', email: 'ada@okafor.dev', xHandle: 'https://twitter.com/AdaOkafor', source: 'csv' },
    ]);
    expect(added).toEqual([]);
    expect(skipped).toEqual([
      { name: 'F. Ade', reason: 'duplicate' },
      { name: 'Ada O', reason: 'duplicate' },
    ]);
  });

  it('treats a person who closed, rested or was removed as a duplicate, not as new', () => {
    for (const [i, status] of (['closed', 'resting', 'removed', 'held', 'snoozed'] as const).entries()) {
      const p = repo.insertPerson({ name: `P${i}`, source: 'csv', projectId, email: `p${i}@x.example` });
      repo.updatePerson(p.id, { status });
    }
    const { added, skipped } = importPeople(repo, projectId, [0, 1, 2, 3, 4].map((i) => ({ name: `P${i}`, email: `p${i}@x.example`, source: 'csv' as const })));
    expect(added).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
  });

  it('skips repeats inside one batch by any shared handle, keeping the first', () => {
    const { added, skipped } = importPeople(repo, projectId, [
      { name: 'Kemi Eze', email: 'kemi@okopay.com', source: 'paste' },
      { name: 'Kemi E', email: 'KEMI@okopay.com', source: 'paste' },
      { name: 'K Eze', linkedinUrl: 'https://www.linkedin.com/in/kemi-eze', source: 'paste' },
      { name: 'Kemi again', email: 'other@okopay.com', linkedinUrl: 'linkedin.com/in/kemi-eze', source: 'paste' },
    ]);
    expect(added.map((p) => p.name)).toEqual(['Kemi Eze', 'K Eze']);
    expect(skipped).toEqual([
      { name: 'Kemi E', reason: 'duplicate' },
      { name: 'Kemi again', reason: 'duplicate' },
    ]);
  });

  it('keeps the details it was given', () => {
    const { added } = importPeople(repo, projectId, [
      { name: 'Kemi Eze', firstName: 'Kemi', email: 'kemi@okopay.com', company: 'Oko Pay', role: 'Head of Finance', timezone: 'Africa/Lagos', source: 'referral', note: 'Via Femi' },
    ]);
    expect(added[0]).toMatchObject({
      name: 'Kemi Eze', firstName: 'Kemi', company: 'Oko Pay', role: 'Head of Finance', timezone: 'Africa/Lagos', source: 'referral', note: 'Via Femi',
    });
  });

  describe('a skipped repeat teaches Callum the person\'s other handles', () => {
    it('fills in a missing email, LinkedIn or X on the person already there', () => {
      const kemi = repo.insertPerson({ name: 'Kemi Eze', source: 'csv', projectId, linkedinUrl: 'https://www.linkedin.com/in/kemi-eze' });
      const { skipped } = importPeople(repo, projectId, [
        { name: 'Kemi Eze', email: 'Kemi@OkoPay.com', linkedinUrl: 'linkedin.com/in/kemi-eze', xHandle: '@KemiEze', company: 'Other Co', source: 'apollo' },
      ]);
      expect(skipped).toEqual([{ name: 'Kemi Eze', reason: 'duplicate' }]);
      expect(repo.getPerson(kemi.id)).toMatchObject({ email: 'kemi@okopay.com', xHandle: 'kemieze', company: null, source: 'csv' });
      // Later, a list that only has her email finds her.
      expect(importPeople(repo, projectId, [{ name: 'K Eze', email: 'kemi@okopay.com', source: 'csv' }]).skipped).toEqual([{ name: 'K Eze', reason: 'duplicate' }]);
    });

    it('lets a stop on one handle hold for the others, so a different list cannot bring her back', () => {
      const kemi = repo.insertPerson({ name: 'Kemi Eze', source: 'csv', projectId, linkedinUrl: 'https://www.linkedin.com/in/kemi-eze' });
      repo.updatePerson(kemi.id, { status: 'stopped' });
      importPeople(repo, projectId, [{ name: 'Kemi Eze', email: 'kemi@okopay.com', linkedinUrl: 'linkedin.com/in/kemi-eze', source: 'apollo' }]);
      const later = importPeople(repo, projectId, [{ name: 'Kemi', email: 'kemi@okopay.com', source: 'paste' }]);
      expect(later.added).toEqual([]);
      expect(later.skipped).toEqual([{ name: 'Kemi', reason: 'stopped' }]);
      expect(repo.getPerson(kemi.id)?.status).toBe('stopped');
    });

    it('never overwrites a handle the person already has, or takes one that belongs to someone else', () => {
      const kemi = repo.insertPerson({ name: 'Kemi Eze', source: 'csv', projectId, email: 'kemi@okopay.com' });
      const other = repo.insertPerson({ name: 'Femi Ade', source: 'csv', projectId, xHandle: 'shared' });
      importPeople(repo, projectId, [{ name: 'Kemi Eze', email: 'kemi@okopay.com', xHandle: 'shared', source: 'csv' }]);
      // Both Kemi (by email) and Femi (by X) matched: the row links two people, so nothing is filled in.
      expect(repo.getPerson(kemi.id)?.xHandle).toBeNull();
      expect(repo.getPerson(other.id)?.email).toBeNull();
      importPeople(repo, projectId, [{ name: 'K', email: 'kemi@okopay.com', linkedinUrl: 'linkedin.com/in/kemi', source: 'csv' }]);
      importPeople(repo, projectId, [{ name: 'K', email: 'kemi.new@okopay.com', linkedinUrl: 'linkedin.com/in/kemi', source: 'csv' }]);
      expect(repo.getPerson(kemi.id)).toMatchObject({ email: 'kemi@okopay.com', linkedinUrl: 'https://www.linkedin.com/in/kemi' });
    });

    it('also teaches the person in another project', () => {
      const second = makeProject(repo, { name: 'Reconciliation' });
      const kemi = repo.insertPerson({ name: 'Kemi Eze', source: 'csv', projectId, linkedinUrl: 'https://www.linkedin.com/in/kemi-eze' });
      importPeople(repo, second.id, [{ name: 'Kemi Eze', email: 'kemi@okopay.com', linkedinUrl: 'linkedin.com/in/kemi-eze', source: 'csv' }]);
      expect(repo.getPerson(kemi.id)?.email).toBe('kemi@okopay.com');
      expect(repo.listPeople({ projectId: second.id })).toEqual([]);
    });
  });

  describe('projects', () => {
    it('someone in another project is skipped as other_project, with that project\'s name', () => {
      const second = makeProject(repo, { name: 'Reconciliation' });
      importPeople(repo, projectId, [{ name: 'Kemi Eze', email: 'kemi@okopay.com', source: 'csv' }]);
      const { added, skipped } = importPeople(repo, second.id, [
        { name: 'Kemi Eze', email: 'kemi@okopay.com', source: 'csv' },
        { name: 'Femi Ade', email: 'femi@ledgerly.io', source: 'csv' },
      ]);
      expect(skipped).toEqual([{ name: 'Kemi Eze', reason: 'other_project', projectName: 'Payroll' }]);
      expect(added.map((p) => [p.name, p.projectId])).toEqual([['Femi Ade', second.id]]);
      expect(repo.listPeople({ projectId: second.id })).toHaveLength(1);
    });

    it('the same project is a duplicate, and stop is global', () => {
      const second = makeProject(repo, { name: 'Reconciliation' });
      const kemi = repo.insertPerson({ name: 'Kemi Eze', source: 'csv', projectId, email: 'kemi@okopay.com' });
      repo.updatePerson(kemi.id, { status: 'stopped' });
      repo.insertPerson({ name: 'Femi Ade', source: 'csv', projectId, email: 'femi@ledgerly.io' });

      const intoSecond = importPeople(repo, second.id, [
        { name: 'Kemi Eze', email: 'kemi@okopay.com', source: 'csv' },
        { name: 'Femi Ade', email: 'femi@ledgerly.io', source: 'csv' },
      ]);
      expect(intoSecond.skipped).toEqual([
        { name: 'Kemi Eze', reason: 'stopped' },
        { name: 'Femi Ade', reason: 'other_project', projectName: 'Payroll' },
      ]);
      const intoFirst = importPeople(repo, projectId, [{ name: 'Femi Ade', email: 'femi@ledgerly.io', source: 'csv' }]);
      expect(intoFirst.skipped).toEqual([{ name: 'Femi Ade', reason: 'duplicate' }]);
    });

    it('stopped wins when different handles match different people', () => {
      const second = makeProject(repo, { name: 'Reconciliation' });
      repo.insertPerson({ name: 'Kemi Eze', source: 'csv', projectId: second.id, email: 'kemi@okopay.com' });
      const stopped = repo.insertPerson({ name: 'K Eze', source: 'csv', projectId, linkedinUrl: 'https://www.linkedin.com/in/kemi-eze' });
      repo.updatePerson(stopped.id, { status: 'stopped' });
      const { skipped } = importPeople(repo, second.id, [
        { name: 'Kemi Eze', email: 'kemi@okopay.com', linkedinUrl: 'linkedin.com/in/kemi-eze', source: 'csv' },
      ]);
      expect(skipped).toEqual([{ name: 'Kemi Eze', reason: 'stopped' }]);
    });

    it('same project beats another project when a person matches in both', () => {
      const second = makeProject(repo, { name: 'Reconciliation' });
      repo.insertPerson({ name: 'Kemi Eze', source: 'csv', projectId, email: 'kemi@okopay.com' });
      repo.insertPerson({ name: 'K Eze', source: 'csv', projectId: second.id, linkedinUrl: 'https://www.linkedin.com/in/kemi-eze' });
      const { skipped } = importPeople(repo, second.id, [
        { name: 'Kemi Eze', email: 'kemi@okopay.com', linkedinUrl: 'linkedin.com/in/kemi-eze', source: 'csv' },
      ]);
      expect(skipped).toEqual([{ name: 'Kemi Eze', reason: 'duplicate' }]);
    });

    it('refuses a project that does not exist, and adds nobody', () => {
      expect(() => importPeople(repo, 99, [{ name: 'Kemi Eze', email: 'kemi@okopay.com', source: 'csv' }])).toThrow('No such project');
      expect(repo.listPeople()).toEqual([]);
    });
  });

  it('adds everyone or no one: a failure part way rolls the batch back', () => {
    const real = repo.insertPerson.bind(repo);
    let calls = 0;
    repo.insertPerson = (p) => { if (++calls === 2) throw new Error('disk full'); return real(p); };
    expect(() => importPeople(repo, projectId, [
      { name: 'Kemi Eze', email: 'kemi@okopay.com', source: 'csv' },
      { name: 'Femi Ade', email: 'femi@ledgerly.io', source: 'csv' },
    ])).toThrow('disk full');
    expect(repo.listPeople()).toEqual([]);
  });
});
