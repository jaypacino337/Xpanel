import { audit } from '../db.js';
import { RateLimitedError } from './accounts.js';
import { ValidationError, validateParts } from './posts.js';

// Mentions are pulled into an inbox; replies are only ever sent by a person from the panel.
export function createInboxService({ db, x, accounts, log = console }) {
  async function pollAccount(account) {
    const { items } = await accounts.withToken(account.id, 'mentions', (token) =>
      x.mentions(token, account.x_user_id, { sinceId: account.last_mention_id || undefined }));
    const insert = db.prepare(`INSERT OR IGNORE INTO mentions (tweet_id, account_id, author_id, author_username, text, created_at)
                               VALUES (?, ?, ?, ?, ?, ?)`);
    let newest = account.last_mention_id;
    for (const m of items) {
      insert.run(m.id, account.id, m.authorId, m.authorUsername, m.text, m.createdAt);
      if (!newest || BigInt(m.id) > BigInt(newest)) newest = m.id;
    }
    if (newest !== account.last_mention_id) {
      db.prepare('UPDATE accounts SET last_mention_id = ? WHERE id = ?').run(newest, account.id);
    }
    return items.length;
  }

  async function pollAll() {
    const active = db.prepare("SELECT * FROM accounts WHERE status = 'active'").all();
    let total = 0;
    for (const account of active) {
      try {
        total += await pollAccount(account);
      } catch (err) {
        if (!(err instanceof RateLimitedError)) log.warn(`mentions @${account.username}: ${err.message}`);
      }
    }
    return total;
  }

  function list({ accountId, status = 'new' } = {}) {
    const where = ['m.status = ?'];
    const args = [status];
    if (accountId) { where.push('m.account_id = ?'); args.push(accountId); }
    return db.prepare(`SELECT m.*, a.username AS account_username FROM mentions m JOIN accounts a ON a.id = m.account_id
                       WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT 300`).all(...args);
  }

  function getMention(accountId, tweetId) {
    return db.prepare('SELECT * FROM mentions WHERE account_id = ? AND tweet_id = ?').get(accountId, tweetId);
  }

  async function reply(accountId, tweetId, text) {
    const mention = getMention(accountId, tweetId);
    if (!mention) throw new ValidationError('Mention not found');
    if (mention.status === 'replied') throw new ValidationError('Already replied');
    const [clean] = validateParts([text]);
    if (accounts.remainingToday(accountId) < 1) throw new ValidationError('Daily post cap reached for this account');
    const { id } = await accounts.withToken(accountId, 'tweets.create', (token) =>
      x.createPost(token, { text: clean, replyTo: tweetId }));
    accounts.logSent(accountId, id, 'reply');
    db.prepare("UPDATE mentions SET status = 'replied', reply_tweet_id = ? WHERE account_id = ? AND tweet_id = ?")
      .run(id, accountId, tweetId);
    audit(db, 'mention.replied', `@${mention.author_username ?? mention.author_id} via account #${accountId}`);
    return { id };
  }

  function dismiss(accountId, tweetId) {
    const res = db.prepare("UPDATE mentions SET status = 'dismissed' WHERE account_id = ? AND tweet_id = ? AND status = 'new'")
      .run(accountId, tweetId);
    if (res.changes !== 1) throw new ValidationError('Mention not found');
  }

  return { pollAll, pollAccount, list, reply, dismiss };
}
