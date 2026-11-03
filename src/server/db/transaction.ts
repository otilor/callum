import type { Db } from './db.js';

// How many transactions are open on each connection. `DatabaseSync.isTransaction` would answer the same
// question, but it only exists from Node 22.16 and this app supports 22.13.
const depths = new WeakMap<Db, number>();

/**
 * Runs `fn` so that its writes land together or not at all. The outermost call is a real
 * transaction; a call made inside another one is a savepoint, so a caught inner failure
 * undoes only the inner writes.
 *
 * If the rollback itself fails (SQLite already rolled the transaction back on its own, as it does
 * for a full disk), that failure is dropped and the error from `fn` is the one that surfaces.
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  const depth = depths.get(db) ?? 0;
  const mark = `callum_tx_${depth}`;
  db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${mark}`);
  depths.set(db, depth + 1);
  let result: T;
  try {
    result = fn();
  } catch (e) {
    depths.set(db, depth);
    try {
      db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${mark}; RELEASE ${mark}`);
    } catch {
      // SQLite already ended the transaction; the original error is the one to report.
    }
    throw e;
  }
  depths.set(db, depth);
  try {
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${mark}`);
  } catch (e) {
    if (depth === 0) {
      try { db.exec('ROLLBACK'); } catch { /* nothing left to roll back */ }
    }
    throw e;
  }
  return result;
}
