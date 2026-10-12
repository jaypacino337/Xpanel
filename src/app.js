import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { audit, requestContext, tx } from './db.js';
import { hmac, safeEqual, randomToken, pkcePair } from './crypto.js';
import { XApiError } from './x/api.js';
import { AccountUnavailableError, RateLimitedError, ValidationError } from './lib/errors.js';
import { MEDIA_TYPES } from './services/media.js';

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

export function createApp({ db, x, config, accounts, posts, inbox, metrics, media, users, ai }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 'loopback');

  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });
  app.use('/api/media', express.raw({ type: MEDIA_TYPES, limit: '15mb' }));
  app.use(express.json({ limit: '2mb' }));

  // --- session: cookie = userId.expiry.signature ---
  const secure = config.baseUrl.startsWith('https://');
  const cookieOpts = { httpOnly: true, sameSite: 'strict', secure, path: '/' };
  const sign = (uid, exp) => `${uid}.${exp}.${hmac(config.sessionSecret, `session:${uid}:${exp}`)}`;
  function sessionUser(req) {
    const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('xp_session='));
    if (!raw) return null;
    const value = decodeURIComponent(raw.slice('xp_session='.length));
    const [uid, exp] = value.split('.').map(Number);
    if (!Number.isInteger(uid) || !(exp > Date.now()) || !safeEqual(value, sign(uid, exp))) return null;
    return users.get(uid) ?? null;
  }

  const failures = new Map(); // ip -> { count, until }
  app.post('/api/login', (req, res) => {
    const key = req.ip;
    const f = failures.get(key);
    if (f && f.count >= 5 && f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts, try again later' });
    const user = users.authenticate(req.body?.username || 'admin', req.body?.password);
    if (!user) {
      const next = f && f.until > Date.now() ? f.count + 1 : 1;
      failures.set(key, { count: next, until: Date.now() + 15 * 60_000 });
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    failures.delete(key);
    res.cookie('xp_session', sign(user.id, Date.now() + SESSION_TTL), { ...cookieOpts, maxAge: SESSION_TTL });
    requestContext.run({ username: user.username }, () => audit(db, 'user.login', user.username));
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => { res.clearCookie('xp_session', cookieOpts); res.json({ ok: true }); });
  app.get('/api/session', (req, res) => {
    const user = sessionUser(req);
    res.json({ authenticated: Boolean(user), user, mock: x.mock, aiEnabled: ai.enabled });
  });

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
      const account = await requestContext.run({ username: 'client' }, () =>
        accounts.connectFromCode({ code: String(code), verifier: row.code_verifier, clientId: invite.client_id }));
      db.prepare('UPDATE invites SET used_at = ? WHERE token = ?').run(Date.now(), invite.token);
      res.send(page('Account connected', `@${account.username} is now connected. You can close this window.`));
    } catch (err) {
      res.status(400).send(page('Not connected', err.message));
    }
  });

  // --- everything below needs a signed-in user ---
  app.use('/api', (req, res, next) => {
    const user = sessionUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    // Writes must be JSON (or an image upload); plain cross-site forms cannot send either.
    const okBody = req.is('application/json') || (req.path === '/media' && req.is(MEDIA_TYPES));
    if (req.method !== 'GET' && !okBody) {
      return res.status(415).json({ error: req.path === '/media' ? 'Images must be JPEG, PNG, WebP or GIF' : 'JSON required' });
    }
    req.user = user;
    requestContext.run({ username: user.username }, next);
  });

  const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Only admins can do that' }));
  const id = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new ValidationError('Invalid id');
    return n;
  };
  const optId = (v) => (v ? id(v) : undefined);

  app.get('/api/overview', (req, res) => {
    const clients = db.prepare('SELECT * FROM clients ORDER BY name').all();
    const accountRows = db.prepare(`SELECT a.id, a.client_id, a.username, a.name, a.status, a.timezone, a.created_at,
        (SELECT COUNT(*) FROM slots s WHERE s.account_id = a.id) AS slots,
        (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status = 'scheduled') AS queued,
        (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status = 'draft') AS drafts,
        (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id AND p.status = 'failed') AS failed,
        (SELECT MIN(scheduled_at) FROM posts p WHERE p.account_id = a.id AND p.status = 'scheduled') AS next_post_at,
        (SELECT COUNT(*) FROM mentions m WHERE m.account_id = a.id AND m.status = 'new') AS new_mentions
      FROM accounts a ORDER BY a.username`).all()
      .map((a) => ({ ...a, timezone: a.timezone || config.defaultTimezone, remaining_today: accounts.remainingToday(a.id) }));
    const invites = db.prepare('SELECT token, client_id, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ?').all(Date.now());
    res.json({
      maxAccounts: config.maxAccounts,
      dailyPostCap: config.dailyPostCap,
      mock: x.mock,
      totals: {
        accounts: accountRows.length,
        queued: accountRows.reduce((n, a) => n + a.queued, 0),
        drafts: accountRows.reduce((n, a) => n + a.drafts, 0),
        failed: accountRows.reduce((n, a) => n + a.failed, 0),
        mentions: accountRows.reduce((n, a) => n + a.new_mentions, 0),
        reauth: accountRows.filter((a) => a.status !== 'active').length,
      },
      clients: clients.map((c) => ({
        ...c,
        accounts: accountRows.filter((a) => a.client_id === c.id),
        invites: invites.filter((i) => i.client_id === c.id).map((i) => ({ url: `${config.baseUrl}/connect/${i.token}`, expires_at: i.expires_at })),
      })),
    });
  });

  // --- clients & accounts (admin) ---
  app.post('/api/clients', adminOnly, (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 100) throw new ValidationError('Client name is required (max 100 characters)');
    const clientId = Number(db.prepare('INSERT INTO clients (name, created_at) VALUES (?, ?)').run(name, Date.now()).lastInsertRowid);
    audit(db, 'client.created', name);
    res.status(201).json({ id: clientId, name });
  });

  app.delete('/api/clients/:id', adminOnly, async (req, res) => {
    const clientId = id(req.params.id);
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    for (const a of db.prepare('SELECT id FROM accounts WHERE client_id = ?').all(clientId)) await accounts.disconnect(a.id);
    db.prepare('DELETE FROM clients WHERE id = ?').run(clientId);
    audit(db, 'client.deleted', client.name);
    res.json({ ok: true });
  });

  app.post('/api/clients/:id/invites', adminOnly, (req, res) => {
    const clientId = id(req.params.id);
    if (!db.prepare('SELECT 1 FROM clients WHERE id = ?').get(clientId)) return res.status(404).json({ error: 'Client not found' });
    if (accounts.countAccounts() >= config.maxAccounts) throw new ValidationError(`All ${config.maxAccounts} account slots are in use`);
    const token = randomToken(24);
    const expiresAt = Date.now() + INVITE_TTL;
    db.prepare('INSERT INTO invites (token, client_id, expires_at) VALUES (?, ?, ?)').run(token, clientId, expiresAt);
    audit(db, 'invite.created', `client #${clientId}`);
    res.status(201).json({ url: `${config.baseUrl}/connect/${token}`, expires_at: expiresAt });
  });

  app.delete('/api/accounts/:id', adminOnly, async (req, res) => {
    if (!(await accounts.disconnect(id(req.params.id)))) return res.status(404).json({ error: 'Account not found' });
    res.json({ ok: true });
  });

  app.get('/api/accounts/:id/settings', (req, res) => {
    const settings = accounts.getSettings(id(req.params.id));
    if (!settings) return res.status(404).json({ error: 'Account not found' });
    res.json(settings);
  });
  app.put('/api/accounts/:id/settings', adminOnly, (req, res) => {
    const { timezone, voice, slots } = req.body ?? {};
    res.json(accounts.updateSettings(id(req.params.id), { timezone, voice, slots }));
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
    res.json(posts.list({ status: req.query.status || undefined, accountId: optId(req.query.accountId), clientId: optId(req.query.clientId) }));
  });
  app.post('/api/posts', (req, res) => {
    const { accountId, parts, scheduledAt, mediaIds, approve } = req.body ?? {};
    if (approve && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can approve posts; save it as a draft' });
    const post = tx(db, () => {
      const created = posts.create({ accountId: id(accountId), parts, scheduledAt, mediaIds });
      return approve ? posts.approve(created.id) : created;
    });
    res.status(201).json(kickIfDue(post));
  });
  app.put('/api/posts/:id', (req, res) => {
    const { accountId, parts, scheduledAt, mediaIds } = req.body ?? {};
    res.json(posts.update(id(req.params.id), { accountId: optId(accountId), parts, scheduledAt, mediaIds }));
  });
  app.post('/api/posts/:id/approve', adminOnly, (req, res) => res.json(kickIfDue(posts.approve(id(req.params.id)))));
  app.post('/api/posts/:id/cancel', adminOnly, (req, res) => res.json(posts.cancel(id(req.params.id))));
  app.post('/api/posts/bulk', adminOnly, (req, res) => {
    const results = posts.bulk(req.body?.ids, req.body?.action);
    if (req.body?.action === 'approve') setImmediate(() => posts.runDue().catch((err) => console.error(err)));
    res.json(results);
  });
  app.post('/api/posts/import', (req, res) => {
    const approve = Boolean(req.body?.approve);
    if (approve && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can import straight into the queue' });
    res.json(posts.importCsv(req.body?.csv, { approve }));
  });

  // --- images ---
  app.post('/api/media', (req, res) => res.status(201).json(media.save(req.body, req.headers['content-type']?.split(';')[0])));
  app.get('/api/media/:id', (req, res) => {
    const m = media.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    res.type(m.mime).sendFile(path.resolve(m.path));
  });

  // --- inbox ---
  app.get('/api/mentions', (req, res) => {
    const status = ['new', 'replied', 'dismissed'].includes(req.query.status) ? req.query.status : 'new';
    res.json(inbox.list({ status, accountId: optId(req.query.accountId), clientId: optId(req.query.clientId) }));
  });
  app.post('/api/mentions/poll', async (req, res) => res.json({ fetched: await inbox.pollAll() }));
  app.post('/api/mentions/:accountId/:tweetId/reply', async (req, res) => {
    res.json(await inbox.reply(id(req.params.accountId), String(req.params.tweetId), req.body?.text));
  });
  app.post('/api/mentions/:accountId/:tweetId/dismiss', (req, res) => {
    inbox.dismiss(id(req.params.accountId), String(req.params.tweetId));
    res.json({ ok: true });
  });

  // --- AI drafts (a person always reviews and sends) ---
  app.post('/api/ai/reply', async (req, res) => {
    const accountId = id(req.body?.accountId);
    const mention = inbox.getMention(accountId, String(req.body?.tweetId ?? ''));
    if (!mention) throw new ValidationError('Mention not found');
    res.json({ text: await ai.suggestReply({ account: accounts.getAccount(accountId), mention }) });
  });
  app.post('/api/ai/post', async (req, res) => {
    const account = accounts.getAccount(id(req.body?.accountId));
    if (!account) throw new ValidationError('Pick a connected account');
    const brief = String(req.body?.brief ?? '').trim();
    if (!brief || brief.length > 4000) throw new ValidationError('Describe the post in up to 4000 characters');
    res.json({ parts: await ai.draftPost({ account, brief, thread: Boolean(req.body?.thread) }) });
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
  app.get('/api/analytics', (req, res) => res.json(metrics.summary({ clientId: optId(req.query.clientId) })));
  app.post('/api/analytics/refresh', async (req, res) => {
    await metrics.refreshAll();
    res.json(metrics.summary({ clientId: optId(req.body?.clientId) }));
  });
  app.get('/api/analytics.csv', (req, res) => {
    res.type('text/csv').attachment(`xpanel-report-${new Date().toISOString().slice(0, 10)}.csv`)
      .send(metrics.exportCsv({ clientId: optId(req.query.clientId) }));
  });
  app.get('/api/activity', (req, res) => res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all()));

  // --- team ---
  app.get('/api/users', adminOnly, (req, res) => res.json(users.list()));
  app.post('/api/users', adminOnly, (req, res) => res.status(201).json(users.create(req.body ?? {})));
  app.put('/api/users/:id', (req, res) => {
    const userId = id(req.params.id);
    const { role, password, currentPassword } = req.body ?? {};
    if (req.user.role !== 'admin') {
      // Editors may only change their own password, and must confirm the current one.
      if (userId !== req.user.id || role !== undefined) return res.status(403).json({ error: 'Only admins can do that' });
      if (!users.authenticate(req.user.username, currentPassword)) throw new ValidationError('Current password is wrong');
    }
    res.json(users.update(userId, { role, password }));
  });
  app.delete('/api/users/:id', adminOnly, (req, res) => {
    const userId = id(req.params.id);
    if (userId === req.user.id) throw new ValidationError('You cannot delete yourself');
    users.remove(userId);
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(PUBLIC_DIR));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof RateLimitedError) return res.status(429).json({ error: err.message });
    if (err instanceof AccountUnavailableError) return res.status(409).json({ error: err.message });
    if (err instanceof XApiError) return res.status(502).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload too large' });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
