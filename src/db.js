import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// All timestamps are epoch milliseconds.
const SCHEMA = `
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
  action TEXT NOT NULL,
  detail TEXT
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function audit(db, action, detail) {
  db.prepare('INSERT INTO audit_log (at, action, detail) VALUES (?, ?, ?)')
    .run(Date.now(), action, detail == null ? null : String(detail));
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
