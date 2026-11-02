import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from './migrations.js';

const LATEST = 4;
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

  it('takes the Apollo and Claude keys in the secrets table', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.prepare("INSERT INTO channel_secrets (channel, data) VALUES ('apollo', '{}'), ('anthropic', '{}')").run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM channel_secrets').get() as { n: number }).n).toBe(2);
  });
});
