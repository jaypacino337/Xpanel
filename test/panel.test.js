import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { makeCipher, randomToken } from '../src/crypto.js';
import { createMockX } from '../src/x/mock.js';
import { XApiError } from '../src/x/api.js';
import { postLength } from '../src/services/posts.js';
import { buildServices } from '../src/server.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { attachAlerts } from '../src/alerts.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const KEY = 'a'.repeat(64);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a8a80000000049454e44ae426082', 'hex');

async function setup(overrides = {}, { aiClient } = {}) {
  const config = {
    port: 0, baseUrl: 'http://127.0.0.1', panelPassword: 'password1', sessionSecret: 's'.repeat(32), tokenEncKey: KEY,
    mock: true, maxAccounts: 10, dailyPostCap: 25, mentionsPollMinutes: 15, metricsPollMinutes: 60,
    defaultTimezone: 'UTC', mediaDir: fs.mkdtempSync(path.join(os.tmpdir(), 'xpanel-media-')), alertWebhookUrl: '',
    aiEnabled: false, concurrency: 5, ...overrides,
  };
  const db = openDb(':memory:');
  const x = createMockX({ redirectUri: `${config.baseUrl}/oauth/callback` });
  const services = buildServices(config, { db, x, aiClient });
  const server = createApp(services).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Mock authorize URLs point at config.baseUrl; rewrite them to the test server's port.
  config.baseUrl = base;
  let cookie = '';
  async function call(method, path, body, { raw, type } = {}) {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { cookie, ...(raw ? { 'content-type': type } : body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  async function connectAccount(clientId) {
    const inv = await call('POST', `/api/clients/${clientId}/invites`, {});
    assert.equal(inv.status, 201, JSON.stringify(inv.data));
    const go = await call('GET', new URL(inv.data.url).pathname);
    assert.equal(go.status, 302);
    const cb = new URL(go.headers.get('location'));
    const done = await call('GET', cb.pathname + cb.search);
    return done;
  }
  const login = async (username, password) => {
    cookie = '';
    return call('POST', '/api/login', { username, password });
  };
  return { ...services, call, login, connectAccount, close: () => server.close() };
}

async function signedIn(overrides) {
  const t = await setup(overrides);
  assert.equal((await t.login('admin', 'password1')).status, 200);
  const client = await t.call('POST', '/api/clients', { name: 'Acme' });
  return { ...t, clientId: client.data.id };
}

test('token encryption round-trips and is not plaintext', () => {
  const c = makeCipher(KEY);
  const enc = c.encrypt('secret-token');
  assert.notEqual(enc, 'secret-token');
  assert.equal(c.decrypt(enc), 'secret-token');
  assert.notEqual(c.encrypt('secret-token'), enc);
  assert.ok(randomToken().length > 30);
});

test('links count as 23 characters', () => {
  assert.equal(postLength('hi https://example.com/a/very/long/path/that/goes/on'), 3 + 23);
});

test('API requires a session and rejects a wrong password', async () => {
  const t = await setup();
  try {
    assert.equal((await t.call('GET', '/api/overview')).status, 401);
    assert.equal((await t.login('admin', 'nope')).status, 401);
    assert.equal((await t.login('admin', 'password1')).status, 200);
    assert.equal((await t.call('GET', '/api/overview')).status, 200);
    assert.equal((await t.call('POST', '/api/clients', undefined)).status, 415);
  } finally { t.close(); }
});

test('client connects through an invite link, which is single-use', async () => {
  const t = await signedIn();
  try {
    const inv = await t.call('POST', `/api/clients/${t.clientId}/invites`, {});
    const path = new URL(inv.data.url).pathname;
    const go = await t.call('GET', path);
    const cb = new URL(go.headers.get('location'));
    const done = await t.call('GET', cb.pathname + cb.search);
    assert.match(done.data, /connected/);
    assert.equal((await t.call('GET', path)).status, 404);
    const ov = await t.call('GET', '/api/overview');
    assert.equal(ov.data.clients[0].accounts.length, 1);
    const stored = t.db.prepare('SELECT access_token_enc FROM accounts').get();
    assert.doesNotMatch(stored.access_token_enc, /mock-at-/);
  } finally { t.close(); }
});

test('account cap is enforced', async () => {
  const t = await signedIn({ maxAccounts: 2 });
  try {
    await t.connectAccount(t.clientId);
    await t.connectAccount(t.clientId);
    const third = await t.call('POST', `/api/clients/${t.clientId}/invites`, {});
    assert.equal(third.status, 400);
  } finally { t.close(); }
});

test('approved thread is published in order as replies', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    const acc = t.db.prepare('SELECT id FROM accounts').get();
    const draft = await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['one', 'two', 'three'] });
    assert.equal(draft.data.status, 'draft');
    await t.posts.runDue();
    assert.equal(t.posts.get(draft.data.id).status, 'draft', 'drafts are never published');
    await t.call('POST', `/api/posts/${draft.data.id}/approve`, {});
    await t.posts.runDue();
    const post = t.posts.get(draft.data.id);
    assert.equal(post.status, 'posted');
    assert.equal(post.tweet_ids.length, 3);
    assert.equal(t.x.posts.get(post.tweet_ids[1]).replyTo, post.tweet_ids[0]);
    assert.equal(t.x.posts.get(post.tweet_ids[2]).replyTo, post.tweet_ids[1]);
  } finally { t.close(); }
});

test('future posts wait for their time', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    const acc = t.db.prepare('SELECT id FROM accounts').get();
    const at = Date.now() + 3_600_000;
    const p = await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['later'], scheduledAt: new Date(at).toISOString(), approve: true });
    assert.equal(p.data.status, 'scheduled');
    await t.posts.runDue();
    assert.equal(t.posts.get(p.data.id).status, 'scheduled');
    await t.posts.runDue(at + 1);
    assert.equal(t.posts.get(p.data.id).status, 'posted');
  } finally { t.close(); }
});

test('the same text cannot be queued on two accounts', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    await t.connectAccount(t.clientId);
    const [a, b] = t.db.prepare('SELECT id FROM accounts ORDER BY id').all();
    assert.equal((await t.call('POST', '/api/posts', { accountId: a.id, parts: ['Big launch today!'], approve: true })).status, 201);
    const dup = await t.call('POST', '/api/posts', { accountId: b.id, parts: ['  big launch   TODAY! '], approve: true });
    assert.equal(dup.status, 400);
    assert.match(dup.data.error, /multiple accounts/);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE account_id = ?').get(b.id).n, 0, 'rolled back');
  } finally { t.close(); }
});

test('daily cap holds a post back instead of sending it', async () => {
  const t = await signedIn({ dailyPostCap: 2 });
  try {
    await t.connectAccount(t.clientId);
    const acc = t.db.prepare('SELECT id FROM accounts').get();
    const p = await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['a', 'b', 'c'], approve: true });
    await t.posts.runDue();
    const post = t.posts.get(p.data.id);
    assert.equal(post.status, 'scheduled');
    assert.equal(post.tweet_ids.length, 0);
    assert.match(post.error, /Daily post cap/);
  } finally { t.close(); }
});

test('rate limit from X reschedules the post for the reset time', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    const acc = t.db.prepare('SELECT id FROM accounts').get();
    const resetAt = Date.now() + 900_000;
    t.x.createPost = async () => { throw new XApiError(429, 'Too Many Requests', resetAt); };
    const p = await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['hello'], approve: true });
    await t.posts.runDue();
    const post = t.posts.get(p.data.id);
    assert.equal(post.status, 'scheduled');
    assert.equal(post.next_attempt_at, resetAt);
  } finally { t.close(); }
});

test('mentions land in the inbox and replies are threaded', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    const acc = t.db.prepare('SELECT id FROM accounts').get();
    assert.equal((await t.call('POST', '/api/mentions/poll', {})).data.fetched, 1);
    const [m] = (await t.call('GET', '/api/mentions')).data;
    const r = await t.call('POST', `/api/mentions/${acc.id}/${m.tweet_id}/reply`, { text: 'Thanks!' });
    assert.equal(r.status, 200);
    assert.equal(t.x.posts.get(r.data.id).replyTo, m.tweet_id);
    assert.equal((await t.call('POST', `/api/mentions/${acc.id}/${m.tweet_id}/reply`, { text: 'Again' })).status, 400);
    assert.equal((await t.call('GET', '/api/mentions')).data.length, 0);
  } finally { t.close(); }
});

test('expired access token is refreshed before calling X', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    const acc = t.db.prepare('SELECT id FROM accounts').get();
    t.db.prepare('UPDATE accounts SET expires_at = 0').run();
    const p = await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['fresh'], approve: true });
    await t.posts.runDue();
    assert.equal(t.posts.get(p.data.id).status, 'posted');
    assert.ok(t.db.prepare('SELECT expires_at FROM accounts').get().expires_at > Date.now());
  } finally { t.close(); }
});

const firstAccount = (t) => t.db.prepare('SELECT * FROM accounts ORDER BY id').get();

test('MAX_ACCOUNTS is clamped to 100', () => {
  const base = { PANEL_PASSWORD: 'x', X_MOCK: '1' };
  assert.equal(loadConfig({ ...base, MAX_ACCOUNTS: '100' }).maxAccounts, 100);
  assert.equal(loadConfig({ ...base, MAX_ACCOUNTS: '5000' }).maxAccounts, 100);
  assert.equal(loadConfig(base).maxAccounts, 10);
  assert.throws(() => loadConfig({ ...base, DEFAULT_TIMEZONE: 'Mars/Base' }));
});

test('editors draft and reply but cannot approve, connect, or manage the team', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    const acc = firstAccount(t);
    assert.equal((await t.call('POST', '/api/users', { username: 'sam', password: 'longenough', role: 'editor' })).status, 201);
    assert.equal((await t.login('sam', 'longenough')).status, 200);
    const draft = await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['from an editor'] });
    assert.equal(draft.status, 201);
    assert.equal((await t.call('POST', `/api/posts/${draft.data.id}/approve`, {})).status, 403);
    assert.equal((await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['sneaky'], approve: true })).status, 403);
    assert.equal((await t.call('POST', `/api/clients/${t.clientId}/invites`, {})).status, 403);
    assert.equal((await t.call('GET', '/api/users')).status, 403);
    const log = t.db.prepare("SELECT user FROM audit_log WHERE action = 'post.drafted' ORDER BY id DESC").get();
    assert.equal(log.user, 'sam');
  } finally { t.close(); }
});

test('"next slot" fills posting slots in order without double-booking', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    const acc = firstAccount(t);
    const none = await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['x'], scheduledAt: 'next-slot' });
    assert.match(none.data.error, /no posting slots/);
    const slots = [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [{ weekday, minute: 9 * 60 }, { weekday, minute: 17 * 60 }]);
    const set = await t.call('PUT', `/api/accounts/${acc.id}/settings`, { timezone: 'America/New_York', slots, voice: 'Warm, short.' });
    assert.equal(set.status, 200);
    const a = (await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['first'], scheduledAt: 'next-slot' })).data;
    const b = (await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['second'], scheduledAt: 'next-slot' })).data;
    assert.ok(a.scheduled_at > Date.now() && b.scheduled_at > a.scheduled_at);
    for (const p of [a, b]) {
      const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(p.scheduled_at));
      assert.ok([9, 17].includes(hour), `slot at ${hour}:00 New York time`);
    }
  } finally { t.close(); }
});

test('CSV import creates drafts and threads, reporting bad rows', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    const acc = firstAccount(t);
    const csv = [
      'account,text,scheduled_at',
      `@${acc.username},"Launch day!\n---\nHere is what is new, ""quoted""",2030-05-01 10:00`,
      `${acc.username},Plain post,`,
      'nobody,Who is this,',
      `${acc.username},${'x'.repeat(300)},`,
    ].join('\n');
    const res = await t.call('POST', '/api/posts/import', { csv });
    assert.equal(res.data.created, 2);
    assert.deepEqual(res.data.errors.map((e) => e.line), [4, 5]);
    const thread = t.posts.list({ accountId: acc.id }).find((p) => p.parts.length === 2);
    assert.equal(thread.parts[1], 'Here is what is new, "quoted"');
    assert.equal(thread.scheduled_at, Date.UTC(2030, 4, 1, 10, 0));
    assert.equal(thread.status, 'draft');
  } finally { t.close(); }
});

test('bulk approve reports each post separately', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    await t.connectAccount(t.clientId);
    const [a, b] = t.db.prepare('SELECT id FROM accounts ORDER BY id').all();
    const p1 = (await t.call('POST', '/api/posts', { accountId: a.id, parts: ['same words'], scheduledAt: '2030-01-01T00:00:00Z' })).data;
    const p2 = (await t.call('POST', '/api/posts', { accountId: b.id, parts: ['same words'], scheduledAt: '2030-01-01T00:00:00Z' })).data;
    const res = await t.call('POST', '/api/posts/bulk', { ids: [p1.id, p2.id], action: 'approve' });
    assert.deepEqual(res.data.map((r) => r.ok), [true, false]);
    assert.match(res.data[1].error, /multiple accounts/);
  } finally { t.close(); }
});

test('images are validated, stored, and attached to the first post of a thread', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    const acc = firstAccount(t);
    const bad = await t.call('POST', '/api/media', undefined, { raw: Buffer.from('not an image'), type: 'image/png' });
    assert.equal(bad.status, 400);
    const up = await t.call('POST', '/api/media', undefined, { raw: PNG, type: 'image/png' });
    assert.equal(up.status, 201);
    const p = await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['pic', 'no pic'], mediaIds: [up.data.id], approve: true });
    await t.posts.runDue();
    const post = t.posts.get(p.data.id);
    assert.equal(post.status, 'posted');
    assert.equal(t.x.posts.get(post.tweet_ids[0]).mediaIds.length, 1);
    assert.equal(t.x.posts.get(post.tweet_ids[1]).mediaIds.length, 0);
  } finally { t.close(); }
});

test('accounts in the panel cannot reply to each other', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    await t.connectAccount(t.clientId);
    const [a, b] = t.db.prepare('SELECT * FROM accounts ORDER BY id').all();
    t.db.prepare('INSERT INTO mentions (tweet_id, account_id, author_id, author_username, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('42', a.id, b.x_user_id, b.username, 'hey', Date.now());
    const res = await t.call('POST', `/api/mentions/${a.id}/42/reply`, { text: 'hi back' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /managed in this panel/);
  } finally { t.close(); }
});

test('AI drafts use the brand voice and handle refusals', async () => {
  const calls = [];
  let reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Post one\n---\nPost two' }] };
  const aiClient = { beta: { messages: { create: async (req) => { calls.push(req); return reply; } } } };
  const t = await setup({}, { aiClient });
  try {
    await t.login('admin', 'password1');
    const client = (await t.call('POST', '/api/clients', { name: 'Acme' })).data;
    await t.connectAccount(client.id);
    const acc = firstAccount(t);
    await t.call('PUT', `/api/accounts/${acc.id}/settings`, { voice: 'Playful, no jargon.' });
    const res = await t.call('POST', '/api/ai/post', { accountId: acc.id, brief: 'New store opening', thread: true });
    assert.deepEqual(res.data.parts, ['Post one', 'Post two']);
    assert.equal(calls[0].model, 'claude-opus-5-5');
    assert.equal(calls[0].fallbacks, 'default');
    assert.match(calls[0].messages[0].content, /Playful, no jargon/);
    reply = { stop_reason: 'refusal', content: [] };
    const refused = await t.call('POST', '/api/ai/post', { accountId: acc.id, brief: 'x' });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /declined/);
  } finally { t.close(); }
});

test('AI endpoints explain how to turn them on when no key is set', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    const res = await t.call('POST', '/api/ai/post', { accountId: firstAccount(t).id, brief: 'hello' });
    assert.match(res.data.error, /ANTHROPIC_API_KEY/);
  } finally { t.close(); }
});

test('analytics export is a CSV of sent posts with formula-safe cells', async () => {
  const t = await signedIn();
  try {
    await t.connectAccount(t.clientId);
    const acc = firstAccount(t);
    await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['=SUM(A1) totally normal post'], approve: true });
    await t.posts.runDue();
    await t.call('POST', '/api/analytics/refresh', {});
    const res = await t.call('GET', `/api/analytics.csv?clientId=${t.clientId}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const lines = res.data.trim().split('\r\n');
    assert.equal(lines.length, 2);
    assert.match(lines[1], /,'=SUM\(A1\) totally normal post,/);
  } finally { t.close(); }
});

test('failures are sent to the alert webhook', async () => {
  const t = await signedIn();
  const sent = [];
  attachAlerts(t.db, { webhookUrl: 'https://hooks.example/abc', fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return {}; } });
  try {
    await t.connectAccount(t.clientId);
    const acc = firstAccount(t);
    t.x.createPost = async () => { throw new XApiError(403, 'forbidden', null); };
    await t.call('POST', '/api/posts', { accountId: acc.id, parts: ['will fail'], approve: true });
    await t.posts.runDue();
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /post failed/);
    assert.equal(sent[0].content, sent[0].text);
  } finally { t.close(); }
});

test('publishing runs accounts in parallel', async () => {
  const t = await signedIn({ concurrency: 3 });
  try {
    for (let i = 0; i < 6; i++) await t.connectAccount(t.clientId);
    const accs = t.db.prepare('SELECT id FROM accounts').all();
    let inFlight = 0;
    let peak = 0;
    const real = t.x.createPost.bind(t.x);
    t.x.createPost = async (...args) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return real(...args);
    };
    for (const [i, a] of accs.entries()) {
      t.posts.approve(t.posts.create({ accountId: a.id, parts: [`post ${i}`], scheduledAt: Date.now() - 1000 }).id);
    }
    await t.posts.runDue();
    assert.equal(peak, 3);
    assert.equal(t.posts.list({ status: 'posted' }).length, 6);
  } finally { t.close(); }
});
