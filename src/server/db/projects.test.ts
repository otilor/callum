import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Settings } from '../../shared/types.js';
import { openDb } from './db.js';
import { migrate } from './migrations.js';
import { DuplicateProjectName, Repo } from './repo.js';
import { makeProject } from './testing.js';

let repo: Repo;
let tick: number;
beforeEach(() => {
  tick = 0;
  repo = new Repo(openDb(':memory:'), () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString());
});

describe('projects', () => {
  it('inserts with defaults and lists by id', () => {
    const a = repo.insertProject({ name: 'Payroll' });
    const b = repo.insertProject({
      name: 'Reconciliation', offer: 'You help fintech teams close the books faster.', audience: 'Finance leads',
      tone: 'direct', sample: 'Hi Kemi', calendarUrl: 'https://cal.example.com/ada',
    });
    expect(a).toMatchObject({
      id: 1, name: 'Payroll', offer: null, audience: null, tone: 'warm', sample: null, calendarUrl: null,
      approvalsLeft: 10, startedAt: null, state: 'running', pausedUntil: null,
    });
    expect(a.createdAt).toBe(a.updatedAt);
    expect(b).toMatchObject({ id: 2, tone: 'direct', calendarUrl: 'https://cal.example.com/ada', approvalsLeft: 10 });
    expect(repo.getProject(2)).toEqual(b);
    expect(repo.getProject(99)).toBeNull();
    expect(repo.listProjects().map((p) => p.id)).toEqual([1, 2]);
  });

  it('filters by state', () => {
    const a = makeProject(repo);
    const b = makeProject(repo);
    const c = makeProject(repo);
    repo.updateProject(b.id, { state: 'paused', pausedUntil: '2026-02-01T09:00:00.000Z' });
    repo.updateProject(c.id, { state: 'wrapped' });
    expect(repo.listProjects({ state: ['running', 'paused'] }).map((p) => p.id)).toEqual([a.id, b.id]);
    expect(repo.listProjects({ state: ['wrapped'] }).map((p) => p.id)).toEqual([c.id]);
    expect(repo.listProjects({ state: [] })).toEqual([]);
  });

  it('updates, ignores undefined and bumps updatedAt', () => {
    const p = repo.insertProject({ name: 'Payroll', offer: 'Run payroll' });
    const u = repo.updateProject(p.id, { offer: undefined, audience: 'Founders', approvalsLeft: 4, startedAt: '2026-01-05T09:00:00.000Z' });
    expect(u).toMatchObject({ offer: 'Run payroll', audience: 'Founders', approvalsLeft: 4, startedAt: '2026-01-05T09:00:00.000Z' });
    expect(u.updatedAt).not.toBe(p.updatedAt);
    expect(u.createdAt).toBe(p.createdAt);
    expect(repo.updateProject(p.id, { offer: null }).offer).toBeNull();
    expect(() => repo.updateProject(99, { name: 'Nope' })).toThrow('project 99 not found');
  });

  it('refuses a taken name in any case, with the exact copy', () => {
    repo.insertProject({ name: 'Payroll' });
    const b = repo.insertProject({ name: 'Reconciliation' });
    let err: unknown;
    try { repo.insertProject({ name: 'PAYROLL' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DuplicateProjectName);
    expect((err as Error).message).toBe('You already have a project called PAYROLL. Pick another name.');
    expect(() => repo.updateProject(b.id, { name: 'payroll' })).toThrow(DuplicateProjectName);
    expect(() => repo.updateProject(b.id, { name: 'payroll' })).toThrow('You already have a project called payroll. Pick another name.');
    expect(repo.getProject(b.id)?.name).toBe('Reconciliation');
    expect(repo.listProjects()).toHaveLength(2);
  });

  it('lets a project rename itself by case and keeps other errors as they are', () => {
    const a = repo.insertProject({ name: 'Payroll' });
    expect(repo.updateProject(a.id, { name: 'payroll' }).name).toBe('payroll');
  });

  it('reports whether a name is taken, optionally ignoring one project', () => {
    const a = repo.insertProject({ name: 'Payroll' });
    expect(repo.projectNameTaken('payroll')).toBe(true);
    expect(repo.projectNameTaken('Payroll', a.id)).toBe(false);
    expect(repo.projectNameTaken('Payroll', a.id + 1)).toBe(true);
    expect(repo.projectNameTaken('Reconciliation')).toBe(false);
  });

  it('wrapped projects keep their name', () => {
    const a = repo.insertProject({ name: 'Payroll' });
    repo.updateProject(a.id, { state: 'wrapped' });
    expect(() => repo.insertProject({ name: 'Payroll' })).toThrow(DuplicateProjectName);
  });
});

describe('people and projects', () => {
  it('insertPerson needs a project that exists', () => {
    expect(() => repo.insertPerson({ name: 'Kemi Eze', source: 'csv', projectId: 1 })).toThrow('No such project');
    const p = makeProject(repo);
    expect(repo.insertPerson({ name: 'Kemi Eze', source: 'csv', projectId: p.id }).projectId).toBe(p.id);
    expect(() => repo.insertPerson({ name: 'Ada Obi', source: 'csv', projectId: p.id + 1 })).toThrow('No such project');
    expect(repo.listPeople()).toHaveLength(1);
  });

  it('can move a person to another project', () => {
    const a = makeProject(repo);
    const b = makeProject(repo);
    const kemi = repo.insertPerson({ name: 'Kemi Eze', source: 'csv', projectId: a.id });
    expect(repo.updatePerson(kemi.id, { projectId: b.id }).projectId).toBe(b.id);
  });

  it('lists and counts per project', () => {
    const a = makeProject(repo);
    const b = makeProject(repo);
    const k = repo.insertPerson({ name: 'Kemi Eze', source: 'csv', projectId: a.id });
    const o = repo.insertPerson({ name: 'Ola Bode', source: 'csv', projectId: b.id, stage: 'hello', touches: 1 });
    const f = repo.insertPerson({ name: 'Femi Ade', source: 'csv', projectId: b.id, status: 'stopped' });
    expect(repo.listPeople({ projectId: a.id }).map((p) => p.id)).toEqual([k.id]);
    expect(repo.listPeople({ projectId: b.id }).map((p) => p.id)).toEqual([o.id, f.id]);
    expect(repo.listPeople({ projectId: b.id, status: ['active'] }).map((p) => p.id)).toEqual([o.id]);
    expect(repo.listPeople({ projectId: 99 })).toEqual([]);
    expect(repo.countPeople(a.id)).toBe(1);
    expect(repo.countPeople(b.id)).toBe(2);
    expect(repo.countPeople(b.id, { status: ['stopped'] })).toBe(1);
    expect(repo.countPeople(b.id, { stage: ['hello'], status: ['active'] })).toBe(1);
    expect(repo.countPeople(b.id, { stage: ['talking'] })).toBe(0);
    expect(repo.countPeople(b.id, { status: [] })).toBe(0);
    expect(repo.countPeople(99)).toBe(0);
  });

  it('deleteAll clears projects and restarts their ids', () => {
    const p = makeProject(repo);
    repo.insertPerson({ name: 'Kemi Eze', source: 'csv', projectId: p.id });
    repo.deleteAll();
    expect(repo.listProjects()).toEqual([]);
    expect(repo.listPeople()).toEqual([]);
    expect(makeProject(repo).id).toBe(1);
  });
});

describe('settings and the current project', () => {
  it('remembers the project last viewed and no longer holds project fields', () => {
    const s = repo.getSettings();
    expect(s.currentProjectId).toBeNull();
    for (const gone of ['offer', 'audience', 'tone', 'sample', 'calendarUrl', 'startedAt', 'approvalsLeft']) {
      expect(s).not.toHaveProperty(gone);
    }
    const p = makeProject(repo);
    expect(repo.updateSettings({ currentProjectId: p.id }).currentProjectId).toBe(p.id);
  });
});

describe('migration V3', () => {
  const V3 = 3;
  function dbAt(version: number): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, version);
    return db;
  }
  const putSettings = (db: DatabaseSync, data: Record<string, unknown>) =>
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify(data));
  const addPerson = (db: DatabaseSync, name: string, email: string) =>
    db.prepare("INSERT INTO people (name, first_name, email, source, created_at, updated_at) VALUES (?, ?, ?, 'csv', '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z')")
      .run(name, name.split(' ')[0] as string, email);

  it('builds one project from the settings and moves every person into it', () => {
    const db = dbAt(2);
    putSettings(db, {
      senderName: 'Ada', senderEmail: 'ada@x.com', offer: 'You help fintech teams take reconciliation off their ops team.',
      audience: 'Finance leads at fintechs', tone: 'direct', sample: 'Hi Kemi, quick one.', calendarUrl: 'https://cal.example.com/ada',
      timezone: 'Africa/Lagos', onboarded: true, startedAt: '2026-10-20T09:00:00.000Z', approvalsLeft: 7,
      pauseState: 'running', pausedUntil: null, notifications: true,
    });
    addPerson(db, 'Kemi Eze', 'kemi@okopay.com');
    addPerson(db, 'Ola Bode', 'ola@x.com');
    migrate(db);

    const migrated = new Repo(db);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: V3 });
    expect(migrated.listProjects()).toEqual([
      {
        id: 1, name: 'My first project', offer: 'You help fintech teams take reconciliation off their ops team.',
        audience: 'Finance leads at fintechs', tone: 'direct', sample: 'Hi Kemi, quick one.',
        calendarUrl: 'https://cal.example.com/ada', approvalsLeft: 7, startedAt: '2026-10-20T09:00:00.000Z',
        state: 'running', pausedUntil: null,
        createdAt: expect.any(String), updatedAt: expect.any(String),
      },
    ]);
    expect(migrated.listPeople().map((p) => p.projectId)).toEqual([1, 1]);
    const settings = migrated.getSettings();
    expect(settings).toEqual<Settings>({
      senderName: 'Ada', senderEmail: 'ada@x.com', timezone: 'Africa/Lagos', onboarded: true,
      pauseState: 'running', pausedUntil: null, notifications: true, currentProjectId: 1,
    });
    const raw = JSON.parse((db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string }).data) as Record<string, unknown>;
    for (const gone of ['offer', 'audience', 'tone', 'sample', 'calendarUrl', 'startedAt', 'approvalsLeft']) {
      expect(raw).not.toHaveProperty(gone);
    }
    expect(migrated.insertPerson({ name: 'New One', source: 'csv', projectId: 1 }).projectId).toBe(1);
  });

  it('builds a project from people alone, with default fields', () => {
    const db = dbAt(2);
    addPerson(db, 'Kemi Eze', 'kemi@okopay.com');
    migrate(db);
    const migrated = new Repo(db);
    expect(migrated.listProjects()).toHaveLength(1);
    expect(migrated.getProject(1)).toMatchObject({ name: 'My first project', offer: null, tone: 'warm', approvalsLeft: 10, startedAt: null });
    expect(migrated.listPeople()[0]?.projectId).toBe(1);
    expect(migrated.getSettings().currentProjectId).toBe(1);
  });

  it('builds a project from an offer with nobody imported yet', () => {
    const db = dbAt(2);
    putSettings(db, { offer: 'Run payroll for you', tone: 'playful' });
    migrate(db);
    expect(new Repo(db).getProject(1)).toMatchObject({ offer: 'Run payroll for you', tone: 'playful', approvalsLeft: 10 });
  });

  it('makes no project for settings without an offer and no people, but still tidies the settings', () => {
    const db = dbAt(2);
    putSettings(db, { senderName: 'Ada', tone: 'warm', approvalsLeft: 10, offer: null, onboarded: false });
    migrate(db);
    const migrated = new Repo(db);
    expect(migrated.listProjects()).toEqual([]);
    expect(migrated.getSettings().senderName).toBe('Ada');
    expect(migrated.getSettings().currentProjectId).toBeNull();
    const raw = JSON.parse((db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string }).data) as Record<string, unknown>;
    expect(raw).not.toHaveProperty('approvalsLeft');
  });

  it('migrates a fresh database to no projects', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: V3 });
  });

  it('is safe to run again', () => {
    const db = dbAt(2);
    addPerson(db, 'Kemi Eze', 'kemi@okopay.com');
    migrate(db);
    migrate(db);
    expect(new Repo(db).listProjects()).toHaveLength(1);
  });

  it('upTo stops early', () => {
    const db = dbAt(1);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(() => db.prepare('SELECT approval_counted FROM outbox').all()).toThrow();
  });
});
