import type { Db } from './db.js';

const V1 = `
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);

CREATE TABLE channels (
  channel TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'disconnected',
  identity TEXT,
  connected_at TEXT,
  paused_until TEXT,
  half_pace_until TEXT,
  invites_blocked_until TEXT,
  last_polled_at TEXT
);

CREATE TABLE channel_secrets (
  channel TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  company TEXT,
  role TEXT,
  email TEXT,
  linkedin_url TEXT,
  x_handle TEXT,
  timezone TEXT,
  channel TEXT,
  stage TEXT NOT NULL DEFAULT 'stranger',
  status TEXT NOT NULL DEFAULT 'active',
  touches INTEGER NOT NULL DEFAULT 0,
  last_touch_at TEXT,
  next_touch_at TEXT,
  linkedin_state TEXT NOT NULL DEFAULT 'none',
  invited_at TEXT,
  snoozed_until TEXT,
  rest_until TEXT,
  badge TEXT,
  reply_kind TEXT,
  suggested TEXT,
  draft TEXT,
  last_inbound TEXT,
  replied_at TEXT,
  source TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_people_email ON people(email);
CREATE INDEX idx_people_linkedin_url ON people(linkedin_url);
CREATE INDEX idx_people_x_handle ON people(x_handle);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  at TEXT NOT NULL,
  external_id TEXT
);
CREATE INDEX idx_messages_person_id ON messages(person_id);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  origin TEXT NOT NULL,
  send_after TEXT NOT NULL,
  undo_until TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_outbox_state_send_after ON outbox(state, send_after);

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  message TEXT NOT NULL,
  detail TEXT,
  person_id INTEGER,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
`;

const V2 = `
ALTER TABLE outbox ADD COLUMN approval_counted INTEGER NOT NULL DEFAULT 0;
`;

const V3_SCHEMA = `
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  offer TEXT,
  audience TEXT,
  tone TEXT NOT NULL DEFAULT 'warm',
  sample TEXT,
  calendar_url TEXT,
  approvals_left INTEGER NOT NULL DEFAULT 10,
  started_at TEXT,
  state TEXT NOT NULL DEFAULT 'running',
  paused_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_projects_name ON projects(name COLLATE NOCASE);
ALTER TABLE people ADD COLUMN project_id INTEGER REFERENCES projects(id);
CREATE INDEX idx_people_project_id ON people(project_id);
`;

/** Settings keys that moved onto the project. */
const MOVED_SETTINGS = ['offer', 'audience', 'tone', 'sample', 'calendarUrl', 'startedAt', 'approvalsLeft'] as const;
const TONES = ['warm', 'direct', 'playful'];

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * Projects arrive. An install with an offer or with people gets one project built from its settings that holds
 * everyone; a fresh install gets none (the first run creates it). The moved keys leave the settings either way.
 */
function v3(db: Db): void {
  db.exec(V3_SCHEMA);
  const row = db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
  const stored = row ? (JSON.parse(row.data) as Record<string, unknown>) : {};
  const earliest = (db.prepare('SELECT MIN(created_at) AS at FROM people').get() as { at: string | null }).at;
  const hasPeople = earliest !== null;
  let currentProjectId: number | undefined;
  if (text(stored.offer) !== null || hasPeople) {
    const approvals = typeof stored.approvalsLeft === 'number' ? stored.approvalsLeft : 10;
    const startedAt = text(stored.startedAt);
    // The project is as old as the install's first record; the clock is read only when there is none.
    const created = startedAt ?? earliest ?? new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (id, name, offer, audience, tone, sample, calendar_url, approvals_left, started_at, created_at, updated_at)
       VALUES (1, 'My first project', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      text(stored.offer), text(stored.audience),
      typeof stored.tone === 'string' && TONES.includes(stored.tone) ? stored.tone : 'warm',
      text(stored.sample), text(stored.calendarUrl), approvals, startedAt, created, created,
    );
    db.exec('UPDATE people SET project_id = 1');
    currentProjectId = 1;
  }
  if (row || currentProjectId !== undefined) {
    const next = { ...stored };
    for (const k of MOVED_SETTINGS) delete next[k];
    if (currentProjectId !== undefined) next.currentProjectId = currentProjectId;
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(JSON.stringify(next));
  }
}

const V4 = `
ALTER TABLE outbox ADD COLUMN claimed_at TEXT;
ALTER TABLE outbox ADD COLUMN detail TEXT;
CREATE INDEX idx_messages_channel_external_id ON messages(channel, external_id);
CREATE TABLE inbound_failed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  external_id TEXT,
  person_id INTEGER,
  event TEXT NOT NULL,
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

type Step = string | ((db: Db) => void);
const STEPS: Step[] = [V1, V2, v3, V4];

/** Bring the database up to date, or up to version `upTo` (tests build older databases this way). */
export function migrate(db: Db, upTo: number = STEPS.length): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < Math.min(upTo, STEPS.length); v++) {
    db.exec('BEGIN');
    try {
      const step = STEPS[v] as Step;
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
