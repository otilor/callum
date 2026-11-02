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

const STEPS: string[] = [V1, V2];

export function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < STEPS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(STEPS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
