import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrations.js';

const LATEST = 6;
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);

describe('migrations', () => {
  it('builds a new database from nothing, one version at a time with no gap', () => {
    const db = new DatabaseSync(':memory:');
    expect(version(db)).toBe(0);
    for (let v = 1; v <= LATEST; v++) {
      migrate(db, v);
      expect(version(db)).toBe(v);
    }
    expect(tables(db)).toEqual(expect.arrayContaining(['settings', 'projects', 'people', 'messages', 'outbox', 'incidents', 'channels', 'channel_secrets', 'inbound_failed']));
    expect(columns(db, 'outbox')).toEqual(expect.arrayContaining(['claimed_at', 'detail']));
    expect(columns(db, 'people')).not.toContain('apollo_id');
    expect(columns(db, 'channels')).toContain('ramp_identity');
    expect(columns(db, 'suppressions')).toEqual(['kind', 'hash', 'created_at']);
    expect(tables(db)).not.toContain('apollo_seen');
    expect(columns(db, 'inbound_failed')).toEqual(expect.arrayContaining(['channel', 'external_id', 'person_id', 'event', 'error', 'attempts']));
  });

  it('builds the same database in one go', () => {
    const stepwise = new DatabaseSync(':memory:');
    for (let v = 1; v <= LATEST; v++) migrate(stepwise, v);
    const once = new DatabaseSync(':memory:');
    migrate(once);
    expect(version(once)).toBe(LATEST);
    expect(tables(once).sort()).toEqual(tables(stepwise).sort());
    for (const t of tables(once)) expect(columns(once, t)).toEqual(columns(stepwise, t));
  });

  it('brings a database one version behind up to date and keeps its rows', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, LATEST - 1);
    db.prepare("INSERT INTO people (name, first_name, email, source, created_at, updated_at) VALUES ('Kemi Eze', 'Kemi', 'kemi@okopay.com', 'csv', '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z')").run();
    db.prepare("INSERT INTO channel_secrets (channel, data) VALUES ('email', '{\"password\":\"x\"}')").run();
    migrate(db);
    expect(version(db)).toBe(LATEST);
    expect((db.prepare('SELECT name FROM people').get() as { name: string }).name).toBe('Kemi Eze');
    expect((db.prepare('SELECT data FROM channel_secrets').get() as { data: string }).data).toBe('{"password":"x"}');
    expect(columns(db, 'outbox')).toEqual(expect.arrayContaining(['claimed_at', 'detail']));
  });

  it('does nothing when it is run again', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(version(db)).toBe(LATEST);
  });

  it('takes the Claude key in the secrets table', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare("INSERT INTO channel_secrets (channel, data) VALUES ('anthropic', '{}')").run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM channel_secrets').get() as { n: number }).n).toBe(1);
  });

  it('forgets Apollo when it brings a version 5 database up to date, and keeps the people it found', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, 5);
    db.prepare("INSERT INTO people (name, first_name, email, source, apollo_id, created_at, updated_at) VALUES ('Kemi Eze', 'Kemi', 'kemi@okopay.com', 'apollo', 'a1', '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z')").run();
    db.prepare("INSERT INTO apollo_seen (apollo_id, created_at) VALUES ('a1', '2026-10-01T09:00:00.000Z')").run();
    db.prepare("INSERT INTO channel_secrets (channel, data) VALUES ('apollo', '{\"key\":\"k\"}'), ('anthropic', '{\"key\":\"c\"}')").run();
    migrate(db);
    expect(version(db)).toBe(6);
    expect(db.prepare('SELECT name, email, source FROM people').get()).toEqual({ name: 'Kemi Eze', email: 'kemi@okopay.com', source: 'apollo' });
    expect(columns(db, 'people')).not.toContain('apollo_id');
    expect(tables(db)).not.toContain('apollo_seen');
    expect(db.prepare('SELECT channel FROM channel_secrets').all()).toEqual([{ channel: 'anthropic' }]);
  });

  it('brings a version 4 database that has people and a connected mailbox up to date without losing or inventing anything', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, 4);
    db.prepare("INSERT INTO channels (channel, status, identity, connected_at) VALUES ('email', 'connected', 'ada@example.com', '2026-10-01T09:00:00.000Z')").run();
    db.prepare("INSERT INTO people (name, first_name, email, source, created_at, updated_at) VALUES ('Kemi Eze', 'Kemi', 'kemi@okopay.com', 'apollo', '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z')").run();
    migrate(db);
    expect(version(db)).toBe(LATEST);
    // The mailbox already connected is the one the ramp counts for; nobody is on the stop list.
    expect(db.prepare('SELECT ramp_identity, connected_at FROM channels').get()).toEqual({ ramp_identity: 'ada@example.com', connected_at: '2026-10-01T09:00:00.000Z' });
    expect(db.prepare('SELECT name, email FROM people').get()).toEqual({ name: 'Kemi Eze', email: 'kemi@okopay.com' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM suppressions').get() as { n: number }).n).toBe(0);
  });
});
