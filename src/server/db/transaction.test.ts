import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { inTransaction } from './transaction.js';

function open() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  const names = () => (db.prepare('SELECT name FROM t ORDER BY id').all() as { name: string }[]).map((r) => r.name);
  const add = (name: string) => db.prepare('INSERT INTO t (name) VALUES (?)').run(name);
  return { db, names, add };
}

describe('inTransaction', () => {
  it('never reads DatabaseSync.isTransaction, which older Node 22 releases lack', () => {
    const { db, names, add } = open();
    const guarded = new Proxy(db, {
      get(target, prop) {
        if (prop === 'isTransaction') throw new Error('isTransaction is not available on Node 22.13');
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    inTransaction(guarded, () => {
      add('a');
      inTransaction(guarded, () => add('b'));
    });
    expect(names()).toEqual(['a', 'b']);
  });

  it('commits, returns the result, and rolls back on a throw', () => {
    const { db, names, add } = open();
    expect(inTransaction(db, () => { add('a'); return 7; })).toBe(7);
    expect(() => inTransaction(db, () => { add('b'); throw new Error('nope'); })).toThrow('nope');
    expect(names()).toEqual(['a']);
  });

  it('undoes only the inner writes when a nested failure is caught, at any depth', () => {
    const { db, names, add } = open();
    inTransaction(db, () => {
      add('outer');
      try {
        inTransaction(db, () => {
          add('inner');
          inTransaction(db, () => add('deepest'));
          throw new Error('inner');
        });
      } catch { /* expected */ }
      inTransaction(db, () => add('after'));
    });
    expect(names()).toEqual(['outer', 'after']);
  });

  it('keeps the original error when SQLite already rolled the transaction back', () => {
    const { db, names, add } = open();
    add('a');
    expect(() => inTransaction(db, () => {
      add('b');
      db.exec("INSERT OR ROLLBACK INTO t (name) VALUES ('a')");
    })).toThrow(/UNIQUE/);
    expect(names()).toEqual(['a']);
    // The connection is usable again and the depth counter was reset.
    inTransaction(db, () => add('c'));
    expect(names()).toEqual(['a', 'c']);
  });

  it('keeps the original error when the rollback happens inside a savepoint', () => {
    const { db, names, add } = open();
    add('a');
    expect(() => inTransaction(db, () => {
      add('b');
      inTransaction(db, () => db.exec("INSERT OR ROLLBACK INTO t (name) VALUES ('a')"));
    })).toThrow(/UNIQUE/);
    expect(names()).toEqual(['a']);
    inTransaction(db, () => add('d'));
    expect(names()).toEqual(['a', 'd']);
  });
});
