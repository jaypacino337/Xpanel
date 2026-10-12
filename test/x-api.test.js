import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealX, XApiError, SCOPES } from '../src/x/api.js';

// Records requests and answers them like X does.
function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: new URL(url), method: init.method, headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    const { status = 200, json, headers = {} } = await handler(call);
    return new Response(json === undefined ? '' : JSON.stringify(json), { status, headers });
  };
  return { calls, fetchImpl };
}

const redirectUri = 'https://panel.example.com/oauth/callback';

test('authorize URL asks for the right scopes with PKCE', () => {
  const x = createRealX({ clientId: 'cid', clientSecret: 'sec', redirectUri });
  const url = new URL(x.authorizeUrl({ state: 'st', challenge: 'ch' }));
  assert.equal(url.origin + url.pathname, 'https://x.com/i/oauth2/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(url.searchParams.get('scope').split(' '), SCOPES);
  assert.ok(SCOPES.includes('offline.access') && SCOPES.includes('media.write'));
});

test('confidential client exchanges the code with Basic auth', async () => {
  const { calls, fetchImpl } = stubFetch(() => ({ json: { access_token: 'a', refresh_token: 'r', expires_in: 7200 } }));
  const x = createRealX({ clientId: 'cid', clientSecret: 'sec', redirectUri, fetchImpl });
  const tok = await x.exchangeCode({ code: 'c0de', verifier: 'v' });
  assert.equal(tok.access_token, 'a');
  const [c] = calls;
  assert.equal(c.url.href, 'https://api.x.com/2/oauth2/token');
  assert.equal(c.headers.authorization, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
  const form = new URLSearchParams(c.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code_verifier'), 'v');
  assert.equal(form.get('redirect_uri'), redirectUri);
});

test('public client refreshes with client_id in the form', async () => {
  const { calls, fetchImpl } = stubFetch(() => ({ json: { access_token: 'a2', refresh_token: 'r2', expires_in: 7200 } }));
  const x = createRealX({ clientId: 'cid', clientSecret: '', redirectUri, fetchImpl });
  await x.refresh('r1');
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('client_id'), 'cid');
  assert.equal(calls[0].headers.authorization, undefined);
});

test('createPost sends reply and media fields and reads rate limits', async () => {
  const reset = Math.floor(Date.now() / 1000) + 900;
  const { calls, fetchImpl } = stubFetch(() => ({
    status: 201,
    json: { data: { id: '123', text: 'hi' } },
    headers: { 'x-rate-limit-remaining': '7', 'x-rate-limit-reset': String(reset) },
  }));
  const x = createRealX({ clientId: 'cid', redirectUri, fetchImpl });
  const res = await x.createPost('tok', { text: 'hi', replyTo: '99', mediaIds: ['m1'] });
  assert.equal(res.id, '123');
  assert.deepEqual(res.rateLimit, { remaining: 7, resetAt: reset * 1000 });
  assert.equal(calls[0].headers.authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].body), { text: 'hi', reply: { in_reply_to_tweet_id: '99' }, media: { media_ids: ['m1'] } });
});

test('errors become XApiError with status and reset time', async () => {
  const reset = Math.floor(Date.now() / 1000) + 60;
  const { fetchImpl } = stubFetch(() => ({ status: 429, json: { title: 'Too Many Requests' }, headers: { 'x-rate-limit-reset': String(reset) } }));
  const x = createRealX({ clientId: 'cid', redirectUri, fetchImpl });
  await assert.rejects(x.createPost('tok', { text: 'hi' }), (err) => err instanceof XApiError && err.status === 429 && err.resetAt === reset * 1000);
});

test('mentions are parsed with author usernames', async () => {
  const { calls, fetchImpl } = stubFetch(() => ({
    json: {
      data: [{ id: '5', text: '@brand hello', author_id: 'u1', created_at: '2026-10-01T12:00:00.000Z' }],
      includes: { users: [{ id: 'u1', username: 'fan' }] },
    },
  }));
  const x = createRealX({ clientId: 'cid', redirectUri, fetchImpl });
  const { items } = await x.mentions('tok', '42', { sinceId: '4' });
  assert.equal(calls[0].url.pathname, '/2/users/42/mentions');
  assert.equal(calls[0].url.searchParams.get('since_id'), '4');
  assert.deepEqual(items[0], { id: '5', text: '@brand hello', authorId: 'u1', authorUsername: 'fan', createdAt: Date.parse('2026-10-01T12:00:00.000Z') });
});

test('no new mentions returns an empty list', async () => {
  const { fetchImpl } = stubFetch(() => ({ json: { meta: { result_count: 0 } } }));
  const x = createRealX({ clientId: 'cid', redirectUri, fetchImpl });
  assert.deepEqual((await x.mentions('tok', '42')).items, []);
});

test('images are uploaded as multipart with the right category', async () => {
  const { calls, fetchImpl } = stubFetch(() => ({ json: { data: { id: 'm9', media_key: '3_m9' } } }));
  const x = createRealX({ clientId: 'cid', redirectUri, fetchImpl });
  const res = await x.uploadMedia('tok', { data: Buffer.from('GIF89a'), mime: 'image/gif' });
  assert.equal(res.id, 'm9');
  assert.equal(calls[0].url.href, 'https://api.x.com/2/media/upload');
  assert.ok(calls[0].body instanceof FormData);
  assert.equal(calls[0].body.get('media_category'), 'tweet_gif');
  assert.equal(calls[0].body.get('media').type, 'image/gif');
});

test('metrics are read from public_metrics', async () => {
  const { calls, fetchImpl } = stubFetch(() => ({
    json: { data: [{ id: '1', public_metrics: { impression_count: 50, like_count: 3, retweet_count: 1, reply_count: 2, quote_count: 0 } }] },
  }));
  const x = createRealX({ clientId: 'cid', redirectUri, fetchImpl });
  const { items } = await x.postMetrics('tok', ['1', '2']);
  assert.equal(calls[0].url.searchParams.get('ids'), '1,2');
  assert.deepEqual(items[0], { id: '1', impressions: 50, likes: 3, retweets: 1, replies: 2, quotes: 0 });
});
