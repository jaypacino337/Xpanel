import { audit } from '../db.js';
import { RateLimitedError } from './accounts.js';

export class ValidationError extends Error {}

const MAX_LEN = 280;
const MAX_THREAD = 25;
const URL_RE = /https?:\/\/\S+/g;
const EDITABLE = new Set(['draft', 'scheduled', 'failed']);

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

const parseRow = (r) => r && { ...r, parts: JSON.parse(r.parts), tweet_ids: r.tweet_ids ? JSON.parse(r.tweet_ids) : [] };

export function createPostService({ db, x, accounts }) {
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

  function parseWhen(scheduledAt) {
    if (scheduledAt == null || scheduledAt === '') return null;
    const t = typeof scheduledAt === 'number' ? scheduledAt : Date.parse(scheduledAt);
    if (!Number.isFinite(t)) throw new ValidationError('Invalid schedule time');
    return t;
  }

  function create({ accountId, parts, scheduledAt }) {
    const acc = assertAccount(accountId);
    const clean = validateParts(parts);
    const when = parseWhen(scheduledAt);
    const now = Date.now();
    const id = Number(db.prepare(`INSERT INTO posts (account_id, parts, status, scheduled_at, created_at, updated_at)
                                  VALUES (?, ?, 'draft', ?, ?, ?)`)
      .run(acc.id, JSON.stringify(clean), when, now, now).lastInsertRowid);
    audit(db, 'post.drafted', `#${id} for @${acc.username}`);
    return get(id);
  }

  function update(id, { accountId, parts, scheduledAt }) {
    const post = get(id);
    if (!post) throw new ValidationError('Post not found');
    if (!EDITABLE.has(post.status)) throw new ValidationError(`Cannot edit a ${post.status} post`);
    const acc = assertAccount(accountId ?? post.account_id);
    const clean = parts ? validateParts(parts) : post.parts;
    const when = scheduledAt === undefined ? post.scheduled_at : parseWhen(scheduledAt);
    // Editing sends the post back to draft so it is approved again.
    db.prepare(`UPDATE posts SET account_id = ?, parts = ?, scheduled_at = ?, status = 'draft', error = NULL,
                next_attempt_at = NULL, updated_at = ? WHERE id = ?`)
      .run(acc.id, JSON.stringify(clean), when, Date.now(), id);
    audit(db, 'post.edited', `#${id}`);
    return get(id);
  }

  // Approval moves a draft into the publishing queue.
  function approve(id) {
    const post = get(id);
    if (!post) throw new ValidationError('Post not found');
    if (!['draft', 'failed'].includes(post.status)) throw new ValidationError(`Cannot approve a ${post.status} post`);
    if (post.tweet_ids.length) throw new ValidationError('Part of this thread is already live; edit or cancel it instead');
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

  function list({ status, accountId } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('p.status = ?'); args.push(status); }
    if (accountId) { where.push('p.account_id = ?'); args.push(accountId); }
    return db.prepare(`SELECT p.*, a.username FROM posts p JOIN accounts a ON a.id = p.account_id
                       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                       ORDER BY COALESCE(p.scheduled_at, p.created_at) DESC LIMIT 500`)
      .all(...args).map(parseRow);
  }

  function setState(id, fields) {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE posts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), Date.now(), id);
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
        const { id } = await accounts.withToken(post.account_id, 'tweets.create', (token) =>
          x.createPost(token, { text: post.parts[i], replyTo: ids[i - 1] }));
        ids.push(id);
        accounts.logSent(post.account_id, id, 'post');
        setState(post.id, { tweet_ids: JSON.stringify(ids) });
      }
      setState(post.id, { status: 'posted', posted_at: Date.now(), error: null, next_attempt_at: null });
      audit(db, 'post.published', `#${post.id} (${ids.length} part${ids.length > 1 ? 's' : ''})`);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        setState(post.id, { status: 'scheduled', next_attempt_at: err.resetAt, error: err.message });
      } else {
        setState(post.id, { status: 'failed', error: err.message });
        audit(db, 'post.failed', `#${post.id}: ${err.message}`);
      }
    }
  }

  async function runDue(now = Date.now()) {
    const due = db.prepare(`SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ?
                            AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY scheduled_at LIMIT 50`)
      .all(now, now);
    for (const { id } of due) {
      // Claim the row so overlapping runs never publish it twice.
      const claimed = db.prepare("UPDATE posts SET status = 'posting' WHERE id = ? AND status = 'scheduled'").run(id);
      if (claimed.changes === 1) await publish(get(id));
    }
    return due.length;
  }

  // A crash mid-publish leaves rows in 'posting'; put them back in the queue on startup.
  function recoverStuck() {
    db.prepare("UPDATE posts SET status = 'scheduled' WHERE status = 'posting'").run();
  }

  return { get, create, update, approve, cancel, list, runDue, recoverStuck };
}
