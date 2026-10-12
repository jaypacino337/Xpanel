// Thin client for the official X API v2 using OAuth 2.0 user-context tokens.
const API = 'https://api.x.com/2';
const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';

export const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];

export class XApiError extends Error {
  constructor(status, body, resetAt) {
    super(`X API ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
    this.resetAt = resetAt;
  }
}

function rateLimitFrom(res) {
  const remaining = res.headers.get('x-rate-limit-remaining');
  const reset = res.headers.get('x-rate-limit-reset');
  if (remaining == null && reset == null) return null;
  return {
    remaining: remaining == null ? null : Number(remaining),
    resetAt: reset == null ? null : Number(reset) * 1000,
  };
}

export function createRealX({ clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  async function request(method, url, { token, json, form, multipart, basic } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (basic) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    let body;
    if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form); }
    if (multipart) body = multipart; // fetch sets the multipart boundary header
    const res = await fetchImpl(url, { method, headers, body });
    const rateLimit = rateLimitFrom(res);
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new XApiError(res.status, data, rateLimit?.resetAt ?? null);
    return { data, rateLimit };
  }

  function tokenForm(params) {
    // Confidential clients authenticate with Basic auth; public clients send client_id.
    return clientSecret ? { form: params, basic: true } : { form: { ...params, client_id: clientId } };
  }

  return {
    mock: false,

    authorizeUrl({ state, challenge }) {
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: SCOPES.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return `${AUTHORIZE_URL}?${q}`;
    },

    async exchangeCode({ code, verifier }) {
      const { data } = await request('POST', `${API}/oauth2/token`, tokenForm({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
      }));
      return data; // { access_token, refresh_token, expires_in, scope }
    },

    async refresh(refreshToken) {
      const { data } = await request('POST', `${API}/oauth2/token`, tokenForm({
        grant_type: 'refresh_token', refresh_token: refreshToken,
      }));
      return data;
    },

    async revoke(token) {
      await request('POST', `${API}/oauth2/revoke`, tokenForm({ token, token_type_hint: 'access_token' }));
    },

    async me(token) {
      const { data } = await request('GET', `${API}/users/me`, { token });
      return data.data; // { id, name, username }
    },

    async uploadMedia(token, { data, mime }) {
      const form = new FormData();
      form.append('media', new Blob([data], { type: mime }), 'upload');
      form.append('media_category', mime === 'image/gif' ? 'tweet_gif' : 'tweet_image');
      const { data: res, rateLimit } = await request('POST', `${API}/media/upload`, { token, multipart: form });
      return { id: res.data.id, rateLimit };
    },

    async createPost(token, { text, replyTo, mediaIds }) {
      const json = { text };
      if (replyTo) json.reply = { in_reply_to_tweet_id: replyTo };
      if (mediaIds?.length) json.media = { media_ids: mediaIds };
      const { data, rateLimit } = await request('POST', `${API}/tweets`, { token, json });
      return { id: data.data.id, rateLimit };
    },

    async mentions(token, userId, { sinceId } = {}) {
      const q = new URLSearchParams({
        max_results: '50',
        'tweet.fields': 'created_at,author_id',
        expansions: 'author_id',
        'user.fields': 'username',
      });
      if (sinceId) q.set('since_id', sinceId);
      const { data, rateLimit } = await request('GET', `${API}/users/${userId}/mentions?${q}`, { token });
      const users = new Map((data?.includes?.users || []).map((u) => [u.id, u.username]));
      const items = (data?.data || []).map((t) => ({
        id: t.id,
        text: t.text,
        authorId: t.author_id,
        authorUsername: users.get(t.author_id) || null,
        createdAt: t.created_at ? Date.parse(t.created_at) : null,
      }));
      return { items, rateLimit };
    },

    async postMetrics(token, ids) {
      const q = new URLSearchParams({ ids: ids.join(','), 'tweet.fields': 'public_metrics' });
      const { data, rateLimit } = await request('GET', `${API}/tweets?${q}`, { token });
      const items = (data?.data || []).map((t) => ({
        id: t.id,
        impressions: t.public_metrics?.impression_count ?? null,
        likes: t.public_metrics?.like_count ?? 0,
        retweets: t.public_metrics?.retweet_count ?? 0,
        replies: t.public_metrics?.reply_count ?? 0,
        quotes: t.public_metrics?.quote_count ?? 0,
      }));
      return { items, rateLimit };
    },
  };
}
