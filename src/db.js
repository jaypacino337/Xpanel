import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';

// Carries the signed-in user through a request so audit entries record who did what.
export const requestContext = new AsyncLocalStorage();

// All timestamps are epoch milliseconds.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL,           -- admin | editor
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  invite_token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  x_user_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  name TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  expires_at INTEGER,
  scopes TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | reauth_required
  last_mention_id TEXT,
  timezone TEXT,
  voice TEXT,                   -- brand voice notes used for AI drafts
  last_mentions_poll_at INTEGER,
  last_metrics_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS slots (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL,     -- 0 = Sunday
  minute INTEGER NOT NULL,      -- minutes after local midnight
  PRIMARY KEY (account_id, weekday, minute)
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  parts TEXT NOT NULL,          -- JSON array of strings (one item = single post, more = thread)
  status TEXT NOT NULL,         -- draft | scheduled | posting | posted | failed | cancelled
  scheduled_at INTEGER,
  next_attempt_at INTEGER,
  posted_at INTEGER,
  tweet_ids TEXT,               -- JSON array
  media TEXT,                   -- JSON array of media ids, attached to the first part
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_due ON posts(status, scheduled_at);

CREATE TABLE IF NOT EXISTS mentions (
  tweet_id TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  author_id TEXT,
  author_username TEXT,
  text TEXT NOT NULL,
  created_at INTEGER,
  status TEXT NOT NULL DEFAULT 'new', -- new | replied | dismissed
  reply_tweet_id TEXT,
  PRIMARY KEY (account_id, tweet_id)
);

CREATE TABLE IF NOT EXISTS sent_log (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tweet_id TEXT NOT NULL,
  kind TEXT NOT NULL,           -- post | reply
  text TEXT,
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sent_log_account ON sent_log(account_id, sent_at);

CREATE TABLE IF NOT EXISTS metrics (
  tweet_id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  impressions INTEGER, likes INTEGER, retweets INTEGER, replies INTEGER, quotes INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  account_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  remaining INTEGER,
  reset_at INTEGER,
  PRIMARY KEY (account_id, endpoint)
);

CREATE TABLE IF NOT EXISTS reply_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  user TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
`;

// Columns added after the first release; added in place to databases created by older versions.
const ADDED_COLUMNS = [
  ['accounts', 'timezone', 'TEXT'],
  ['accounts', 'voice', 'TEXT'],
  ['accounts', 'last_mentions_poll_at', 'INTEGER'],
  ['accounts', 'last_metrics_at', 'INTEGER'],
  ['posts', 'media', 'TEXT'],
  ['sent_log', 'text', 'TEXT'],
  ['audit_log', 'user', 'TEXT'],
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, column, type] of ADDED_COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  return db;
}

// db.onAudit, when set, is called for every entry (used for alerts).
export function audit(db, action, detail) {
  const user = requestContext.getStore()?.username ?? 'system';
  const text = detail == null ? null : String(detail);
  db.prepare('INSERT INTO audit_log (at, user, action, detail) VALUES (?, ?, ?, ?)')
    .run(Date.now(), user, action, text);
  db.onAudit?.(action, text, user);
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
