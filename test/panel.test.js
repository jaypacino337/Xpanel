import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { makeCipher, randomToken } from '../src/crypto.js';
import { createMockX } from '../src/x/mock.js';
import { XApiError } from '../src/x/api.js';
import { postLength } from '../src/services/posts.js';
import { buildServices } from '../src/server.js';
import { createApp } from '../src/app.js';

const KEY = 'a'.repeat(64);

async function setup(overrides = {}) {
  const config = {
    port: 0, baseUrl: 'http://127.0.0.1', panelPassword: 'pw', sessionSecret: 's'.repeat(32), tokenEncKey: KEY,
    mock: true, maxAccounts: 10, dailyPostCap: 25, mentionsPollMinutes: 15, metricsPollMinutes: 60, ...overrides,
  };
  const db = openDb(':memory:');
  const x = createMockX({ redirectUri: `${config.baseUrl}/oauth/callback` });
  const services = buildServices(config, { db, x });
  const server = createApp(services).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Mock authorize URLs point at config.baseUrl; rewrite them to the test server's port.
  config.baseUrl = base;
  let cookie = '';
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
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
  return { ...services, call, connectAccount, close: () => server.close() };
}

async function signedIn(overrides) {
  const t = await setup(overrides);
  assert.equal((await t.call('POST', '/api/login', { password: 'pw' })).status, 200);
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
    assert.equal((await t.call('POST', '/api/login', { password: 'nope' })).status, 401);
    assert.equal((await t.call('POST', '/api/login', { password: 'pw' })).status, 200);
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
