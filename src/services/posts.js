import fs from 'node:fs';
import { audit } from '../db.js';
import { RateLimitedError, ValidationError } from '../lib/errors.js';
import { mapLimit } from '../lib/util.js';
import { nextSlot, parseLocalDateTime } from '../lib/time.js';
import { parseCsv } from '../lib/csv.js';

export { ValidationError };

const MAX_LEN = 280;
const MAX_THREAD = 25;
const MAX_MEDIA = 4;
const MAX_IMPORT_ROWS = 500;
const URL_RE = /https?:\/\/\S+/g;
const EDITABLE = new Set(['draft', 'scheduled', 'failed']);
export const NEXT_SLOT = 'next-slot';

// Approximates X's weighted count: links count as 23 characters.
export function postLength(text) {
  return [...text.replace(URL_RE, 'x'.repeat(23))].length;
}

const normalize = (t) => t.trim().toLowerCase().replace(/\s+/g, ' ');

export function validateParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) throw new ValidationError('Post text is required');
  if (parts.length > MAX_THREAD) throw new ValidationError(`Threads are limited to ${MAX_THREAD} posts`);
  const clean = parts.map((p) => String(p ?? '').trim());
  clean.forEach((p, i) => {
    if (!p) throw new ValidationError(`Post ${i + 1} is empty`);
    if (postLength(p) > MAX_LEN) throw new ValidationError(`Post ${i + 1} is over ${MAX_LEN} characters`);
  });
  return clean;
}

const parseRow = (r) => r && {
  ...r,
  parts: JSON.parse(r.parts),
  tweet_ids: r.tweet_ids ? JSON.parse(r.tweet_ids) : [],
  media: r.media ? JSON.parse(r.media) : [],
};

export function createPostService({ db, x, accounts, media, config }) {
  const get = (id) => parseRow(db.prepare('SELECT * FROM posts WHERE id = ?').get(id));

  // X's rules forbid posting identical or substantially similar content across multiple accounts.
  function assertNotDuplicated(accountId, parts, excludeId = 0) {
    const wanted = new Set(parts.map(normalize));
    const rows = db.prepare(`SELECT p.id, p.parts, a.username FROM posts p JOIN accounts a ON a.id = p.account_id
                             WHERE p.account_id != ? AND p.id != ? AND p.status IN ('scheduled', 'posting', 'posted')`)
      .all(accountId, excludeId);
    for (const row of rows) {
      if (JSON.parse(row.parts).some((p) => wanted.has(normalize(p)))) {
        throw new ValidationError(`Same text is already queued or posted on @${row.username}. X does not allow the same content across multiple accounts.`);
      }
    }
  }

  function assertAccount(accountId) {
    const acc = accounts.getAccount(accountId);
    if (!acc) throw new ValidationError('Pick a connected account');
    return acc;
  }

  function validateMedia(ids) {
    if (ids == null) return [];
    if (!Array.isArray(ids) || ids.length > MAX_MEDIA) throw new ValidationError(`Up to ${MAX_MEDIA} images per post`);
    for (const id of ids) if (!media.get(id)) throw new ValidationError('An attached image no longer exists; remove it and upload again');
    return ids.map(String);
  }

  // Times already used by this account's queue, so "next slot" never double-books.
  function takenTimes(accountId, excludeId = 0) {
    return new Set(db.prepare(`SELECT scheduled_at FROM posts WHERE account_id = ? AND id != ?
                               AND status IN ('draft', 'scheduled', 'posting') AND scheduled_at IS NOT NULL`)
      .all(accountId, excludeId).map((r) => r.scheduled_at));
  }

  function resolveWhen(account, scheduledAt, excludeId = 0) {
    if (scheduledAt == null || scheduledAt === '') return null;
    if (scheduledAt === NEXT_SLOT) {
      const slots = accounts.getSlots(account.id);
      if (!slots.length) throw new ValidationError(`@${account.username} has no posting slots yet. Add them under Schedules.`);
      const t = nextSlot(slots, accounts.timezoneOf(account), { taken: takenTimes(account.id, excludeId) });
      if (!t) throw new ValidationError(`No free posting slot for @${account.username} in the next 4 weeks`);
      return t;
    }
    const t = typeof scheduledAt === 'number' ? scheduledAt : parseLocalDateTime(scheduledAt, accounts.timezoneOf(account));
    if (!Number.isFinite(t)) throw new ValidationError('Invalid schedule time');
    return t;
  }

  function create({ accountId, parts, scheduledAt, mediaIds }) {
    const acc = assertAccount(accountId);
    const clean = validateParts(parts);
    const mids = validateMedia(mediaIds);
    const when = resolveWhen(acc, scheduledAt);
    const now = Date.now();
    const id = Number(db.prepare(`INSERT INTO posts (account_id, parts, media, status, scheduled_at, created_at, updated_at)
                                  VALUES (?, ?, ?, 'draft', ?, ?, ?)`)
      .run(acc.id, JSON.stringify(clean), mids.length ? JSON.stringify(mids) : null, when, now, now).lastInsertRowid);
    audit(db, 'post.drafted', `#${id} for @${acc.username}`);
    return get(id);
  }

  function update(id, { accountId, parts, scheduledAt, mediaIds }) {
    const post = get(id);
    if (!post) throw new ValidationError('Post not found');
    if (!EDITABLE.has(post.status)) throw new ValidationError(`Cannot edit a ${post.status} post`);
    if (post.tweet_ids.length) throw new ValidationError('Part of this thread is already live; cancel it instead');
    const acc = assertAccount(accountId ?? post.account_id);
    const clean = parts ? validateParts(parts) : post.parts;
    const mids = mediaIds === undefined ? post.media : validateMedia(mediaIds);
    const when = scheduledAt === undefined ? post.scheduled_at : resolveWhen(acc, scheduledAt, id);
    // Editing sends the post back to draft so it is approved again.
    db.prepare(`UPDATE posts SET account_id = ?, parts = ?, media = ?, scheduled_at = ?, status = 'draft', error = NULL,
                next_attempt_at = NULL, updated_at = ? WHERE id = ?`)
      .run(acc.id, JSON.stringify(clean), mids.length ? JSON.stringify(mids) : null, when, Date.now(), id);
    audit(db, 'post.edited', `#${id}`);
    return get(id);
  }

  // Approval moves a draft into the publishing queue.
  function approve(id) {
    const post = get(id);
    if (!post) throw new ValidationError('Post not found');
    if (!['draft', 'failed'].includes(post.status)) throw new ValidationError(`Cannot approve a ${post.status} post`);
    if (post.tweet_ids.length) throw new ValidationError('Part of this thread is already live; cancel it instead');
    assertNotDuplicated(post.account_id, post.parts, id);
    const when = post.scheduled_at ?? Date.now();
    db.prepare(`UPDATE posts SET status = 'scheduled', scheduled_at = ?, error = NULL, next_attempt_at = NULL,
                updated_at = ? WHERE id = ?`).run(when, Date.now(), id);
    audit(db, 'post.approved', `#${id}`);
    return get(id);
  }

  function cancel(id) {
    const post = get(id);
    if (!post) throw new ValidationError('Post not found');
    if (!EDITABLE.has(post.status)) throw new ValidationError(`Cannot cancel a ${post.status} post`);
    db.prepare("UPDATE posts SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), id);
    audit(db, 'post.cancelled', `#${id}`);
    return get(id);
  }

  // Applies approve/cancel to many posts; one bad post does not stop the rest.
  function bulk(ids, action) {
    const fn = { approve, cancel }[action];
    if (!fn) throw new ValidationError('Unknown bulk action');
    if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw new ValidationError('Select 1-500 posts');
    return ids.map((id) => {
      // Approving something already in the queue is a no-op, not an error.
      if (action === 'approve' && get(Number(id))?.status === 'scheduled') return { id, ok: true };
      try { fn(Number(id)); return { id, ok: true }; } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        return { id, ok: false, error: err.message };
      }
    });
  }

  // CSV columns: account, text, scheduled_at. A line with only "---" inside text splits a thread.
  // scheduled_at: "YYYY-MM-DD HH:MM" in the account's time zone, an ISO time, "next" for the next slot, or empty.
  function importCsv(csv, { approve: approveRows = false } = {}) {
    const rows = parseCsv(String(csv ?? ''));
    if (rows.length < 2) throw new ValidationError('The CSV needs a header row and at least one post');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (name) => header.indexOf(name);
    if (col('account') < 0 || col('text') < 0) throw new ValidationError('The CSV needs "account" and "text" columns');
    const body = rows.slice(1).filter((r) => r.some((c) => c.trim()));
    if (body.length > MAX_IMPORT_ROWS) throw new ValidationError(`Import up to ${MAX_IMPORT_ROWS} posts at a time`);

    const byName = new Map(db.prepare('SELECT id, username FROM accounts').all().map((a) => [a.username.toLowerCase(), a.id]));
    const created = [];
    const errors = [];
    body.forEach((r, i) => {
      const line = i + 2;
      try {
        const name = (r[col('account')] ?? '').trim().replace(/^@/, '').toLowerCase();
        const accountId = byName.get(name);
        if (!accountId) throw new ValidationError(`Unknown account "${name}"`);
        const parts = (r[col('text')] ?? '').split(/\r?\n---\r?\n/);
        const rawWhen = col('scheduled_at') >= 0 ? (r[col('scheduled_at')] ?? '').trim() : '';
        const post = create({ accountId, parts, scheduledAt: rawWhen.toLowerCase() === 'next' ? NEXT_SLOT : rawWhen });
        created.push(approveRows ? approve(post.id) : post);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        errors.push({ line, error: err.message });
      }
    });
    audit(db, 'post.imported', `${created.length} posts, ${errors.length} errors`);
    return { created: created.length, errors };
  }

  function list({ status, accountId, clientId } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('p.status = ?'); args.push(status); }
    if (accountId) { where.push('p.account_id = ?'); args.push(accountId); }
    if (clientId) { where.push('a.client_id = ?'); args.push(clientId); }
    return db.prepare(`SELECT p.*, a.username FROM posts p JOIN accounts a ON a.id = p.account_id
                       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                       ORDER BY COALESCE(p.scheduled_at, p.created_at) DESC LIMIT 1000`)
      .all(...args).map(parseRow);
  }

  function setState(id, fields) {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE posts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), Date.now(), id);
  }

  async function uploadMedia(post) {
    const ids = [];
    for (const mid of post.media) {
      const m = media.get(mid);
      if (!m) throw new Error('An attached image is missing from storage');
      const data = fs.readFileSync(m.path);
      const { id } = await accounts.withToken(post.account_id, 'media.upload', (token) =>
        x.uploadMedia(token, { data, mime: m.mime }));
      ids.push(id);
    }
    return ids;
  }

  async function publish(post) {
    const ids = [...post.tweet_ids]; // resume a thread that was cut off part-way
    const remaining = post.parts.length - ids.length;
    if (accounts.remainingToday(post.account_id) < remaining) {
      setState(post.id, { status: 'scheduled', next_attempt_at: Date.now() + 60 * 60_000,
        error: 'Daily post cap reached for this account; will retry in an hour' });
      return;
    }
    try {
      for (let i = ids.length; i < post.parts.length; i++) {
        const mediaIds = i === 0 && post.media.length ? await uploadMedia(post) : undefined;
        const { id } = await accounts.withToken(post.account_id, 'tweets.create', (token) =>
          x.createPost(token, { text: post.parts[i], replyTo: ids[i - 1], mediaIds }));
        ids.push(id);
        accounts.logSent(post.account_id, id, 'post', post.parts[i]);
        setState(post.id, { tweet_ids: JSON.stringify(ids) });
      }
      setState(post.id, { status: 'posted', posted_at: Date.now(), error: null, next_attempt_at: null });
      audit(db, 'post.published', `#${post.id} on @${post.username ?? post.account_id} (${ids.length} part${ids.length > 1 ? 's' : ''})`);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        setState(post.id, { status: 'scheduled', next_attempt_at: err.resetAt, error: err.message });
      } else {
        setState(post.id, { status: 'failed', error: err.message });
        audit(db, 'post.failed', `#${post.id} on @${post.username ?? post.account_id}: ${err.message}`);
      }
    }
  }

  // Accounts are published in parallel; each account's posts go out one at a time, oldest first.
  async function runDue(now = Date.now()) {
    const due = db.prepare(`SELECT id, account_id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ?
                            AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY scheduled_at LIMIT 500`)
      .all(now, now);
    const byAccount = new Map();
    for (const row of due) byAccount.set(row.account_id, [...(byAccount.get(row.account_id) || []), row.id]);
    await mapLimit([...byAccount.values()], config?.concurrency ?? 5, async (postIds) => {
      for (const id of postIds) {
        // Claim the row so overlapping runs never publish it twice.
        const claimed = db.prepare("UPDATE posts SET status = 'posting' WHERE id = ? AND status = 'scheduled'").run(id);
        if (claimed.changes !== 1) continue;
        const post = parseRow(db.prepare('SELECT p.*, a.username FROM posts p JOIN accounts a ON a.id = p.account_id WHERE p.id = ?').get(id));
        await publish(post);
      }
    });
    return due.length;
  }

  // A crash mid-publish leaves rows in 'posting'; put them back in the queue on startup.
  function recoverStuck() {
    db.prepare("UPDATE posts SET status = 'scheduled' WHERE status = 'posting'").run();
  }

  return { get, create, update, approve, cancel, bulk, importCsv, list, runDue, recoverStuck };
}
