import { RateLimitedError } from '../lib/errors.js';
import { mapLimit } from '../lib/util.js';
import { toCsv } from '../lib/csv.js';

const WINDOW = 30 * 24 * 60 * 60 * 1000;

export function createMetricsService({ db, x, accounts, config, log = console }) {
  const upsert = db.prepare(`INSERT INTO metrics (tweet_id, account_id, impressions, likes, retweets, replies, quotes, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                             ON CONFLICT (tweet_id) DO UPDATE SET impressions = excluded.impressions, likes = excluded.likes,
                             retweets = excluded.retweets, replies = excluded.replies, quotes = excluded.quotes,
                             updated_at = excluded.updated_at`);

  async function refreshAccount(account) {
    db.prepare('UPDATE accounts SET last_metrics_at = ? WHERE id = ?').run(Date.now(), account.id);
    const ids = db.prepare('SELECT tweet_id FROM sent_log WHERE account_id = ? AND sent_at > ? ORDER BY sent_at DESC')
      .all(account.id, Date.now() - WINDOW).map((r) => r.tweet_id);
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const { items } = await accounts.withToken(account.id, 'tweets.lookup', (token) =>
          x.postMetrics(token, ids.slice(i, i + 100)));
        for (const m of items) upsert.run(m.id, account.id, m.impressions, m.likes, m.retweets, m.replies, m.quotes, Date.now());
      }
    } catch (err) {
      if (!(err instanceof RateLimitedError)) log.warn(`metrics @${account.username}: ${err.message}`);
    }
  }

  const refreshMany = (list) => mapLimit(list, config?.concurrency ?? 5, refreshAccount);
  const refreshAll = () => refreshMany(db.prepare("SELECT * FROM accounts WHERE status = 'active'").all());
  const refreshDue = (intervalMs, batch = 25) => refreshMany(db.prepare(`SELECT * FROM accounts WHERE status = 'active'
      AND (last_metrics_at IS NULL OR last_metrics_at < ?) ORDER BY COALESCE(last_metrics_at, 0) LIMIT ?`)
    .all(Date.now() - intervalMs, batch));

  function summary({ clientId } = {}) {
    const clientFilter = clientId ? 'WHERE a.client_id = ?' : '';
    const args = clientId ? [clientId] : [];
    const perAccount = db.prepare(`
      SELECT a.id, a.username, c.id AS client_id, c.name AS client_name,
        (SELECT COUNT(*) FROM sent_log s WHERE s.account_id = a.id AND s.sent_at > ?) AS sent_30d,
        COALESCE(SUM(m.impressions), 0) AS impressions, COALESCE(SUM(m.likes), 0) AS likes,
        COALESCE(SUM(m.retweets), 0) AS retweets, COALESCE(SUM(m.replies), 0) AS replies,
        COALESCE(SUM(m.quotes), 0) AS quotes
      FROM accounts a JOIN clients c ON c.id = a.client_id LEFT JOIN metrics m ON m.account_id = a.id
      ${clientFilter}
      GROUP BY a.id ORDER BY c.name, a.username`).all(Date.now() - WINDOW, ...args);
    const topPosts = db.prepare(`
      SELECT m.*, a.username, s.text, s.kind
      FROM metrics m JOIN accounts a ON a.id = m.account_id LEFT JOIN sent_log s ON s.tweet_id = m.tweet_id
      ${clientFilter}
      ORDER BY (m.likes + m.retweets * 2 + m.replies * 2 + m.quotes * 2) DESC LIMIT 10`).all(...args);
    return { perAccount, topPosts };
  }

  // One row per post or reply sent from the panel in the last 30 days.
  function exportCsv({ clientId } = {}) {
    const rows = db.prepare(`
      SELECT s.sent_at, c.name AS client, a.username, s.kind, s.tweet_id, s.text,
        m.impressions, m.likes, m.retweets, m.replies, m.quotes
      FROM sent_log s JOIN accounts a ON a.id = s.account_id JOIN clients c ON c.id = a.client_id
      LEFT JOIN metrics m ON m.tweet_id = s.tweet_id
      WHERE s.sent_at > ? ${clientId ? 'AND a.client_id = ?' : ''}
      ORDER BY s.sent_at DESC`).all(Date.now() - WINDOW, ...(clientId ? [clientId] : []));
    return toCsv([
      ['sent_at', 'client', 'account', 'type', 'url', 'text', 'impressions', 'likes', 'reposts', 'replies', 'quotes'],
      ...rows.map((r) => [new Date(r.sent_at).toISOString(), r.client, `@${r.username}`, r.kind,
        `https://x.com/${r.username}/status/${r.tweet_id}`, r.text, r.impressions, r.likes, r.retweets, r.replies, r.quotes]),
    ]);
  }

  return { refreshAll, refreshDue, summary, exportCsv };
}
