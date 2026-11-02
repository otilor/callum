import type {
  Channel, ChannelAccount, Incident, Message, NewIncident, NewMessage, NewOutboxItem, NewPerson,
  OutboxItem, OutboxState, OutKind, Person, PersonStatus, Settings, Stage,
} from '../../shared/types.js';
import { CHANNELS } from '../../shared/types.js';
import type { Db } from './db.js';
import { normalizeEmail, normalizeLinkedinUrl, normalizeXHandle } from './handles.js';

type Row = Record<string, unknown>;
type Param = string | number | null;

/** SQLite stores approvalCounted as 0/1; the rest of the app sees a boolean. */
function outboxOut(item: OutboxItem): OutboxItem {
  return { ...item, approvalCounted: Boolean(item.approvalCounted) };
}
function outboxIn<T extends { approvalCounted?: boolean }>(o: T): Row {
  const { approvalCounted, ...rest } = o;
  return approvalCounted === undefined ? rest : { ...rest, approvalCounted: approvalCounted ? 1 : 0 };
}

const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k: string): string => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function fromRow<T>(row: Row): T {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[camel(k)] = v;
  return out as T;
}

const PERSON_KEYS = [
  'name', 'firstName', 'company', 'role', 'email', 'linkedinUrl', 'xHandle', 'timezone', 'channel',
  'stage', 'status', 'touches', 'lastTouchAt', 'nextTouchAt', 'linkedinState', 'invitedAt',
  'snoozedUntil', 'restUntil', 'badge', 'replyKind', 'suggested', 'draft', 'lastInbound', 'repliedAt',
  'source', 'note',
] as const;
const MESSAGE_KEYS = ['personId', 'channel', 'direction', 'kind', 'subject', 'body', 'at', 'externalId'] as const;
const OUTBOX_KEYS = [
  'personId', 'channel', 'kind', 'subject', 'body', 'state', 'origin', 'sendAfter', 'undoUntil', 'error', 'approvalCounted',
] as const;
const INCIDENT_KEYS = ['channel', 'kind', 'state', 'message', 'detail', 'personId', 'resolvedAt'] as const;
const CHANNEL_KEYS = [
  'status', 'identity', 'connectedAt', 'pausedUntil', 'halfPaceUntil', 'invitesBlockedUntil', 'lastPolledAt',
] as const;

const DEFAULT_SETTINGS: Settings = {
  senderName: null, senderEmail: null, offer: null, audience: null, tone: 'warm', sample: null,
  calendarUrl: null, timezone: 'UTC', onboarded: false, startedAt: null, approvalsLeft: 10,
  pauseState: 'running', pausedUntil: null, notifications: null,
};

function defaultChannel(channel: Channel): ChannelAccount {
  return {
    channel, status: 'disconnected', identity: null, connectedAt: null,
    pausedUntil: null, halfPaceUntil: null, invitesBlockedUntil: null, lastPolledAt: null,
  };
}

function normalizeHandles<T extends { email?: string | null; linkedinUrl?: string | null; xHandle?: string | null }>(p: T): T {
  const out = { ...p };
  if (out.email !== undefined) out.email = normalizeEmail(out.email);
  if (out.linkedinUrl !== undefined) out.linkedinUrl = normalizeLinkedinUrl(out.linkedinUrl);
  if (out.xHandle !== undefined) out.xHandle = normalizeXHandle(out.xHandle);
  return out;
}

export class Repo {
  constructor(
    private readonly db: Db,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  // ---- helpers -----------------------------------------------------------

  private insertRow(table: string, keys: readonly string[], values: Row): number {
    const cols = keys.filter((k) => values[k] !== undefined);
    const sql = `INSERT INTO ${table} (${cols.map(snake).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    const res = this.db.prepare(sql).run(...cols.map((k) => values[k] as Param));
    return Number(res.lastInsertRowid);
  }

  private updateRow(table: string, keys: readonly string[], id: number, patch: Row): void {
    const cols = keys.filter((k) => patch[k] !== undefined);
    if (cols.length === 0) return;
    const sql = `UPDATE ${table} SET ${cols.map((k) => `${snake(k)} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...cols.map((k) => patch[k] as Param), id);
  }

  private select<T>(sql: string, params: Param[] = []): T[] {
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => fromRow<T>(r));
  }

  private selectOne<T>(sql: string, params: Param[] = []): T | null {
    const row = this.db.prepare(sql).get(...params) as Row | undefined;
    return row ? fromRow<T>(row) : null;
  }

  private require<T>(found: T | null, what: string, id: number): T {
    if (!found) throw new Error(`${what} ${id} not found`);
    return found;
  }

  // ---- settings ----------------------------------------------------------

  getSettings(): Settings {
    const row = this.db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
    const stored = row ? (JSON.parse(row.data) as Partial<Settings>) : {};
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = { ...this.getSettings(), ...defined } as Settings;
    this.db
      .prepare('INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(JSON.stringify(next));
    return next;
  }

  // ---- channels ----------------------------------------------------------

  getChannel(ch: Channel): ChannelAccount {
    const found = this.selectOne<ChannelAccount>('SELECT * FROM channels WHERE channel = ?', [ch]);
    return found ?? defaultChannel(ch);
  }

  listChannels(): ChannelAccount[] {
    return CHANNELS.map((c) => this.getChannel(c));
  }

  updateChannel(ch: Channel, patch: Partial<ChannelAccount>): ChannelAccount {
    const next: ChannelAccount = { ...this.getChannel(ch) };
    for (const k of CHANNEL_KEYS) {
      if (patch[k] !== undefined) (next as unknown as Row)[k] = patch[k];
    }
    const cols: readonly string[] = ['channel', ...CHANNEL_KEYS];
    const sql = `INSERT OR REPLACE INTO channels (${cols.map(snake).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    this.db.prepare(sql).run(...cols.map((k) => (next as unknown as Row)[k] as Param));
    return next;
  }

  getChannelSecret(ch: Channel): Record<string, string> | null {
    const row = this.db.prepare('SELECT data FROM channel_secrets WHERE channel = ?').get(ch) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Record<string, string>) : null;
  }

  setChannelSecret(ch: Channel, data: Record<string, string> | null): void {
    if (data === null) {
      this.db.prepare('DELETE FROM channel_secrets WHERE channel = ?').run(ch);
      return;
    }
    this.db
      .prepare('INSERT INTO channel_secrets (channel, data) VALUES (?, ?) ON CONFLICT(channel) DO UPDATE SET data = excluded.data')
      .run(ch, JSON.stringify(data));
  }

  // ---- people ------------------------------------------------------------

  insertPerson(p: NewPerson): Person {
    const t = this.now();
    const n = normalizeHandles(p);
    const values: Row = {
      ...n,
      firstName: n.firstName ?? (n.name.trim().split(/\s+/)[0] || n.name),
      stage: n.stage ?? 'stranger',
      status: n.status ?? 'active',
      touches: n.touches ?? 0,
      linkedinState: n.linkedinState ?? 'none',
      createdAt: t,
      updatedAt: t,
    };
    const id = this.insertRow('people', [...PERSON_KEYS, 'createdAt', 'updatedAt'], values);
    return this.require(this.getPerson(id), 'person', id);
  }

  getPerson(id: number): Person | null {
    return this.selectOne<Person>('SELECT * FROM people WHERE id = ?', [id]);
  }

  updatePerson(id: number, patch: Partial<Person>): Person {
    this.require(this.getPerson(id), 'person', id);
    this.updateRow('people', [...PERSON_KEYS, 'updatedAt'], id, { ...normalizeHandles(patch), updatedAt: this.now() });
    return this.require(this.getPerson(id), 'person', id);
  }

  listPeople(filter: { status?: PersonStatus[]; stage?: Stage[] } = {}): Person[] {
    const where: string[] = [];
    const params: Param[] = [];
    const inList = (col: string, vals: readonly string[] | undefined) => {
      if (!vals) return;
      where.push(vals.length === 0 ? '0' : `${col} IN (${vals.map(() => '?').join(', ')})`);
      params.push(...vals);
    };
    inList('status', filter.status);
    inList('stage', filter.stage);
    return this.select<Person>(`SELECT * FROM people${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id`, params);
  }

  findPersonByHandle(h: { email?: string | null; linkedinUrl?: string | null; xHandle?: string | null }): Person | null {
    const clauses: string[] = [];
    const params: Param[] = [];
    const email = normalizeEmail(h.email);
    const linkedin = normalizeLinkedinUrl(h.linkedinUrl);
    const x = normalizeXHandle(h.xHandle);
    if (email) { clauses.push('email = ?'); params.push(email); }
    if (linkedin) { clauses.push('linkedin_url = ?'); params.push(linkedin); }
    if (x) { clauses.push('x_handle = ?'); params.push(x); }
    if (clauses.length === 0) return null;
    return this.selectOne<Person>(`SELECT * FROM people WHERE ${clauses.join(' OR ')} ORDER BY id LIMIT 1`, params);
  }

  // ---- messages ----------------------------------------------------------

  insertMessage(m: NewMessage): Message {
    const id = this.insertRow('messages', MESSAGE_KEYS, m as unknown as Row);
    return this.require(this.selectOne<Message>('SELECT * FROM messages WHERE id = ?', [id]), 'message', id);
  }

  listMessages(personId: number): Message[] {
    return this.select<Message>('SELECT * FROM messages WHERE person_id = ? ORDER BY at, id', [personId]);
  }

  /** Outbound messages on a channel sent at or after `sinceIso`; `kinds` null means any kind. */
  countOut(channel: Channel, kinds: OutKind[] | null, sinceIso: string): number {
    if (kinds && kinds.length === 0) return 0;
    const params: Param[] = [channel, sinceIso];
    let sql = "SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND channel = ? AND at >= ?";
    if (kinds) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(', ')})`;
      params.push(...kinds);
    }
    return Number((this.db.prepare(sql).get(...params) as { n: number }).n);
  }

  // ---- outbox ------------------------------------------------------------

  insertOutbox(o: NewOutboxItem): OutboxItem {
    const t = this.now();
    const id = this.insertRow('outbox', [...OUTBOX_KEYS, 'createdAt', 'updatedAt'], { ...outboxIn(o), createdAt: t, updatedAt: t });
    return this.require(this.getOutbox(id), 'outbox item', id);
  }

  getOutbox(id: number): OutboxItem | null {
    const item = this.selectOne<OutboxItem>('SELECT * FROM outbox WHERE id = ?', [id]);
    return item && outboxOut(item);
  }

  updateOutbox(id: number, patch: Partial<OutboxItem>): OutboxItem {
    this.require(this.getOutbox(id), 'outbox item', id);
    this.updateRow('outbox', [...OUTBOX_KEYS, 'updatedAt'], id, { ...outboxIn(patch), updatedAt: this.now() });
    return this.require(this.getOutbox(id), 'outbox item', id);
  }

  /** `dueBefore` is inclusive: items whose sendAfter is at or before that instant. */
  listOutbox(filter: { state?: OutboxState[]; personId?: number; dueBefore?: string } = {}): OutboxItem[] {
    const where: string[] = [];
    const params: Param[] = [];
    if (filter.state) {
      where.push(filter.state.length === 0 ? '0' : `state IN (${filter.state.map(() => '?').join(', ')})`);
      params.push(...filter.state);
    }
    if (filter.personId !== undefined) { where.push('person_id = ?'); params.push(filter.personId); }
    if (filter.dueBefore !== undefined) { where.push('send_after <= ?'); params.push(filter.dueBefore); }
    return this.select<OutboxItem>(
      `SELECT * FROM outbox${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY send_after, id`,
      params,
    ).map(outboxOut);
  }

  // ---- incidents ---------------------------------------------------------

  insertIncident(i: NewIncident): Incident {
    const id = this.insertRow('incidents', [...INCIDENT_KEYS, 'createdAt'], {
      ...i, state: 'open', createdAt: this.now(),
    });
    return this.require(this.selectOne<Incident>('SELECT * FROM incidents WHERE id = ?', [id]), 'incident', id);
  }

  updateIncident(id: number, patch: Partial<Incident>): Incident {
    this.require(this.selectOne<Incident>('SELECT * FROM incidents WHERE id = ?', [id]), 'incident', id);
    this.updateRow('incidents', INCIDENT_KEYS, id, patch as unknown as Row);
    return this.require(this.selectOne<Incident>('SELECT * FROM incidents WHERE id = ?', [id]), 'incident', id);
  }

  listIncidents(filter: { open?: boolean } = {}): Incident[] {
    if (filter.open === undefined) return this.select<Incident>('SELECT * FROM incidents ORDER BY id');
    return this.select<Incident>('SELECT * FROM incidents WHERE state = ? ORDER BY id', [filter.open ? 'open' : 'resolved']);
  }

  // ---- transactions ------------------------------------------------------

  /** Run `fn` so that all of its writes land together or not at all. Nests as a savepoint. */
  transaction<T>(fn: () => T): T {
    const nested = this.db.isTransaction;
    const mark = 'repo_tx';
    this.db.exec(nested ? `SAVEPOINT ${mark}` : 'BEGIN');
    try {
      const result = fn();
      this.db.exec(nested ? `RELEASE ${mark}` : 'COMMIT');
      return result;
    } catch (e) {
      this.db.exec(nested ? `ROLLBACK TO ${mark}; RELEASE ${mark}` : 'ROLLBACK');
      throw e;
    }
  }

  // ---- reset -------------------------------------------------------------

  deleteAll(): void {
    this.db.exec('BEGIN');
    try {
      for (const t of ['messages', 'outbox', 'incidents', 'people', 'channels', 'channel_secrets', 'settings']) {
        this.db.exec(`DELETE FROM ${t}`);
      }
      this.db.exec("DELETE FROM sqlite_sequence WHERE name IN ('messages','outbox','incidents','people')");
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
