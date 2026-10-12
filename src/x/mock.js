// In-memory stand-in for the X API so the panel can be tried without credentials.
import crypto from 'node:crypto';

let seq = 1_800_000_000_000_000_000n;
const nextId = () => String(seq++);

export function createMockX({ redirectUri }) {
  const users = new Map(); // token -> user
  const posts = new Map(); // id -> { authorId, text, replyTo, mediaIds }
  const uploads = new Map();
  let userCount = 0;

  function userFor(token) {
    const u = users.get(token);
    if (!u) throw Object.assign(new Error('mock: invalid token'), { status: 401 });
    return u;
  }

  return {
    mock: true,
    posts,
    uploads,

    authorizeUrl({ state }) {
      // Skip X's consent screen and come straight back with a fake code.
      return `${redirectUri}?${new URLSearchParams({ state, code: crypto.randomUUID() })}`;
    },

    async exchangeCode() {
      userCount += 1;
      const token = `mock-at-${crypto.randomUUID()}`;
      users.set(token, { id: nextId(), username: `demo_client_${userCount}`, name: `Demo Client ${userCount}` });
      return { access_token: token, refresh_token: `mock-rt-${token}`, expires_in: 7200, scope: 'tweet.read tweet.write users.read media.write offline.access' };
    },

    async refresh(refreshToken) {
      const old = refreshToken.replace(/^mock-rt-/, '');
      const user = userFor(old);
      const token = `mock-at-${crypto.randomUUID()}`;
      users.set(token, user);
      return { access_token: token, refresh_token: `mock-rt-${token}`, expires_in: 7200 };
    },

    async revoke() {},

    async me(token) {
      return userFor(token);
    },

    async uploadMedia(token, { data, mime }) {
      userFor(token);
      const id = nextId();
      uploads.set(id, { size: data.length, mime });
      return { id, rateLimit: null };
    },

    async createPost(token, { text, replyTo, mediaIds }) {
      const user = userFor(token);
      const id = nextId();
      posts.set(id, { authorId: user.id, text, replyTo: replyTo || null, mediaIds: mediaIds || [] });
      return { id, rateLimit: null };
    },

    async mentions(token, userId, { sinceId } = {}) {
      userFor(token);
      // Produce one fake mention per poll so the inbox has something in it.
      const id = nextId();
      if (sinceId && BigInt(id) <= BigInt(sinceId)) return { items: [], rateLimit: null };
      const n = Math.floor(Math.random() * 900) + 100;
      return {
        items: [{ id, text: `Hey, quick question about your latest post (#${n})`, authorId: `9${n}`, authorUsername: `follower${n}`, createdAt: Date.now() }],
        rateLimit: null,
      };
    },

    async postMetrics(token, ids) {
      userFor(token);
      return {
        items: ids.map((id) => {
          const seed = Number(BigInt(id) % 997n);
          return { id, impressions: seed * 13, likes: seed % 40, retweets: seed % 9, replies: seed % 6, quotes: seed % 3 };
        }),
        rateLimit: null,
      };
    },
  };
}
