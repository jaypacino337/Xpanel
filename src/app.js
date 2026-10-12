import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { audit, tx } from './db.js';
import { hmac, safeEqual, randomToken, pkcePair } from './crypto.js';
import { XApiError } from './x/api.js';
import { RateLimitedError, AccountUnavailableError } from './services/accounts.js';
import { ValidationError } from './services/posts.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SESSION_TTL = 12 * 60 * 60 * 1000;
const INVITE_TTL = 7 * 24 * 60 * 60 * 1000;
const STATE_TTL = 10 * 60 * 1000;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/styles.css"></head>
<body class="standalone"><main class="card narrow"><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
}

export function createApp({ db, x, config, accounts, posts, inbox, metrics }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '100kb' }));

  // --- session ---
  const secure = config.baseUrl.startsWith('https://');
  const cookieOpts = { httpOnly: true, sameSite: 'strict', secure, path: '/' };
  const sign = (exp) => `${exp}.${hmac(config.sessionSecret, `session:${exp}`)}`;
  function isAuthed(req) {
    const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('xp_session='));
    if (!raw) return false;
    const value = decodeURIComponent(raw.slice('xp_session='.length));
    const exp = Number(value.split('.')[0]);
    return Number.isFinite(exp) && exp > Date.now() && safeEqual(value, sign(exp));
  }

  const failures = new Map(); // ip -> { count, until }
  app.post('/api/login', (req, res) => {
    const key = req.ip;
    const f = failures.get(key);
    if (f && f.count >= 5 && f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts, try again later' });
    if (!safeEqual(req.body?.password ?? '', config.panelPassword)) {
      const next = f && f.until > Date.now() ? f.count + 1 : 1;
      failures.set(key, { count: next, until: Date.now() + 15 * 60_000 });
      return res.status(401).json({ error: 'Wrong password' });
    }
    failures.delete(key);
    res.cookie('xp_session', sign(Date.now() + SESSION_TTL), { ...cookieOpts, maxAge: SESSION_TTL });
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => { res.clearCookie('xp_session', cookieOpts); res.json({ ok: true }); });
  app.get('/api/session', (req, res) => res.json({ authenticated: isAuthed(req), mock: x.mock }));

  // --- client onboarding (public; protected by the one-time invite token) ---
  const liveInvite = (token) => db.prepare('SELECT * FROM invites WHERE token = ? AND used_at IS NULL AND expires_at > ?')
    .get(String(token), Date.now());

  app.get('/connect/:token', (req, res) => {
    const invite = liveInvite(req.params.token);
    if (!invite) return res.status(404).send(page('Link expired', 'This connect link is invalid or has already been used. Ask your account manager for a new one.'));
    const state = randomToken(24);
    const { verifier, challenge } = pkcePair();
    db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(Date.now() - STATE_TTL);
    db.prepare('INSERT INTO oauth_states (state, code_verifier, invite_token, created_at) VALUES (?, ?, ?, ?)')
      .run(state, verifier, invite.token, Date.now());
    res.redirect(x.authorizeUrl({ state, challenge }));
  });

  app.get('/oauth/callback', async (req, res) => {
    const { state, code, error } = req.query;
    if (error) return res.status(400).send(page('Not connected', 'Access was not granted on X. You can close this window.'));
    const row = state && db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(String(state));
    if (row) db.prepare('DELETE FROM oauth_states WHERE state = ?').run(row.state);
    const invite = row && row.created_at > Date.now() - STATE_TTL && liveInvite(row.invite_token);
    if (!invite || !code) return res.status(400).send(page('Link expired', 'This sign-in attempt expired. Open your connect link again.'));
    try {
      const account = await accounts.connectFromCode({ code: String(code), verifier: row.code_verifier, clientId: invite.client_id });
      db.prepare('UPDATE invites SET used_at = ? WHERE token = ?').run(Date.now(), invite.token);
      res.send(page('Account connected', `@${account.username} is now connected. You can close this window.`));
    } catch (err) {
      res.status(400).send(page('Not connected', err.message));
    }
  });

  // --- everything below needs a panel session ---
  app.use('/api', (req, res, next) => {
    if (!isAuthed(req)) return res.status(401).json({ error: 'Not signed in' });
    // Only JSON bodies are accepted for writes, which plain cross-site forms cannot send.
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
    next();
  });

  const id = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new ValidationError('Invalid id');
    return n;
  };

  app.get('/api/overview', (req, res) => {
    const clients = db.prepare('SELECT * FROM clients ORDER BY name').all();
    const accountRows = db.prepare(`SELECT a.id, a.client_id, a.username, a.name, a.status, a.created_at,
        (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status = 'scheduled') AS queued,
        (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status = 'draft') AS drafts,
        (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status = 'failed') AS failed,
        (SELECT COUNT(*) FROM mentions m WHERE m.account_id = a.id AND m.status = 'new') AS new_mentions
      FROM accounts a ORDER BY a.username`).all()
      .map((a) => ({ ...a, remaining_today: accounts.remainingToday(a.id) }));
    const invites = db.prepare('SELECT token, client_id, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ?').all(Date.now());
    res.json({
      maxAccounts: config.maxAccounts,
      dailyPostCap: config.dailyPostCap,
      mock: x.mock,
      clients: clients.map((c) => ({
        ...c,
        accounts: accountRows.filter((a) => a.client_id === c.id),
        invites: invites.filter((i) => i.client_id === c.id).map((i) => ({ url: `${config.baseUrl}/connect/${i.token}`, expires_at: i.expires_at })),
      })),
    });
  });

  app.post('/api/clients', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 100) throw new ValidationError('Client name is required (max 100 characters)');
    const clientId = Number(db.prepare('INSERT INTO clients (name, created_at) VALUES (?, ?)').run(name, Date.now()).lastInsertRowid);
    audit(db, 'client.created', name);
    res.status(201).json({ id: clientId, name });
  });

  app.delete('/api/clients/:id', async (req, res) => {
    const clientId = id(req.params.id);
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    for (const a of db.prepare('SELECT id FROM accounts WHERE client_id = ?').all(clientId)) await accounts.disconnect(a.id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(clientId);
    audit(db, 'client.deleted', client.name);
    res.json({ ok: true });
  });

  app.post('/api/clients/:id/invites', (req, res) => {
    const clientId = id(req.params.id);
    if (!db.prepare('SELECT 1 FROM clients WHERE id = ?').get(clientId)) return res.status(404).json({ error: 'Client not found' });
    if (accounts.countAccounts() >= config.maxAccounts) throw new ValidationError(`All ${config.maxAccounts} account slots are in use`);
    const token = randomToken(24);
    const expiresAt = Date.now() + INVITE_TTL;
    db.prepare('INSERT INTO invites (token, client_id, expires_at) VALUES (?, ?, ?)').run(token, clientId, expiresAt);
    audit(db, 'invite.created', `client #${clientId}`);
    res.status(201).json({ url: `${config.baseUrl}/connect/${token}`, expires_at: expiresAt });
  });

  app.delete('/api/accounts/:id', async (req, res) => {
    if (!(await accounts.disconnect(id(req.params.id)))) return res.status(404).json({ error: 'Account not found' });
    res.json({ ok: true });
  });

  // --- posts ---
  // Publish right away when something due is approved, instead of waiting for the next scheduler tick.
  const kickIfDue = (post) => {
    if (post.status === 'scheduled' && post.scheduled_at <= Date.now()) {
      setImmediate(() => posts.runDue().catch((err) => console.error(err)));
    }
    return post;
  };
  app.get('/api/posts', (req, res) => {
    res.json(posts.list({ status: req.query.status || undefined, accountId: req.query.accountId ? id(req.query.accountId) : undefined }));
  });
  app.post('/api/posts', (req, res) => {
    const { accountId, parts, scheduledAt, approve } = req.body ?? {};
    const post = tx(db, () => {
      const created = posts.create({ accountId: id(accountId), parts, scheduledAt });
      return approve ? posts.approve(created.id) : created;
    });
    res.status(201).json(kickIfDue(post));
  });
  app.put('/api/posts/:id', (req, res) => {
    const { accountId, parts, scheduledAt } = req.body ?? {};
    res.json(posts.update(id(req.params.id), { accountId: accountId == null ? undefined : id(accountId), parts, scheduledAt }));
  });
  app.post('/api/posts/:id/approve', (req, res) => res.json(kickIfDue(posts.approve(id(req.params.id)))));
  app.post('/api/posts/:id/cancel', (req, res) => res.json(posts.cancel(id(req.params.id))));

  // --- inbox ---
  app.get('/api/mentions', (req, res) => {
    const status = ['new', 'replied', 'dismissed'].includes(req.query.status) ? req.query.status : 'new';
    res.json(inbox.list({ status, accountId: req.query.accountId ? id(req.query.accountId) : undefined }));
  });
  app.post('/api/mentions/poll', async (req, res) => res.json({ fetched: await inbox.pollAll() }));
  app.post('/api/mentions/:accountId/:tweetId/reply', async (req, res) => {
    res.json(await inbox.reply(id(req.params.accountId), String(req.params.tweetId), req.body?.text));
  });
  app.post('/api/mentions/:accountId/:tweetId/dismiss', (req, res) => {
    inbox.dismiss(id(req.params.accountId), String(req.params.tweetId));
    res.json({ ok: true });
  });

  // --- reply templates ---
  app.get('/api/templates', (req, res) => res.json(db.prepare('SELECT * FROM reply_templates ORDER BY name').all()));
  app.post('/api/templates', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const text = String(req.body?.text ?? '').trim();
    if (!name || !text) throw new ValidationError('Name and text are required');
    const tid = Number(db.prepare('INSERT INTO reply_templates (name, text) VALUES (?, ?)').run(name, text).lastInsertRowid);
    res.status(201).json({ id: tid, name, text });
  });
  app.delete('/api/templates/:id', (req, res) => {
    db.prepare('DELETE FROM reply_templates WHERE id = ?').run(id(req.params.id));
    res.json({ ok: true });
  });

  // --- analytics & activity ---
  app.get('/api/analytics', (req, res) => res.json(metrics.summary()));
  app.post('/api/analytics/refresh', async (req, res) => { await metrics.refreshAll(); res.json(metrics.summary()); });
  app.get('/api/activity', (req, res) => res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all()));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(PUBLIC_DIR));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof RateLimitedError) return res.status(429).json({ error: err.message });
    if (err instanceof AccountUnavailableError) return res.status(409).json({ error: err.message });
    if (err instanceof XApiError) return res.status(502).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
