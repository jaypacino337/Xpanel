import { RateLimitedError } from './accounts.js';

const WINDOW = 30 * 24 * 60 * 60 * 1000;

export function createMetricsService({ db, x, accounts, log = console }) {
  async function refreshAll() {
    const active = db.prepare("SELECT * FROM accounts WHERE status = 'active'").all();
    const upsert = db.prepare(`INSERT INTO metrics (tweet_id, account_id, impressions, likes, retweets, replies, quotes, updated_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT (tweet_id) DO UPDATE SET impressions = excluded.impressions, likes = excluded.likes,
                               retweets = excluded.retweets, replies = excluded.replies, quotes = excluded.quotes,
                               updated_at = excluded.updated_at`);
    for (const account of active) {
      const ids = db.prepare('SELECT tweet_id FROM sent_log WHERE account_id = ? AND sent_at > ? ORDER BY sent_at DESC')
        .all(account.id, Date.now() - WINDOW).map((r) => r.tweet_id);
      try {
        for (let i = 0; i < ids.length; i += 100) {
          const { items } = await accounts.withToken(account.id, 'tweets.lookup', (token) =>
            x.postMetrics(token, ids.slice(i, i + 100)));
          for (const m of items) {
            upsert.run(m.id, account.id, m.impressions, m.likes, m.retweets, m.replies, m.quotes, Date.now());
          }
        }
      } catch (err) {
        if (!(err instanceof RateLimitedError)) log.warn(`metrics @${account.username}: ${err.message}`);
      }
    }
  }

  function summary() {
    const perAccount = db.prepare(`
      SELECT a.id, a.username, c.name AS client_name,
        (SELECT COUNT(*) FROM sent_log s WHERE s.account_id = a.id AND s.sent_at > ?) AS sent_30d,
        COALESCE(SUM(m.impressions), 0) AS impressions, COALESCE(SUM(m.likes), 0) AS likes,
        COALESCE(SUM(m.retweets), 0) AS retweets, COALESCE(SUM(m.replies), 0) AS replies,
        COALESCE(SUM(m.quotes), 0) AS quotes
      FROM accounts a JOIN clients c ON c.id = a.client_id LEFT JOIN metrics m ON m.account_id = a.id
      GROUP BY a.id ORDER BY c.name, a.username`).all(Date.now() - WINDOW);
    const topPosts = db.prepare(`
      SELECT m.*, a.username,
        (SELECT p.parts FROM posts p WHERE p.account_id = m.account_id AND p.tweet_ids LIKE '%"' || m.tweet_id || '"%' LIMIT 1) AS parts
      FROM metrics m JOIN accounts a ON a.id = m.account_id
      ORDER BY (m.likes + m.retweets * 2 + m.replies * 2 + m.quotes * 2) DESC LIMIT 10`).all()
      .map((r) => ({ ...r, text: r.parts ? JSON.parse(r.parts)[0] : null, parts: undefined }));
    return { perAccount, topPosts };
  }

  return { refreshAll, summary };
}
