# XPanel

A self-hosted panel for managing up to **10 client accounts on X**, built on X's official API.

- **Client onboarding by link.** You create a connect link for a client. They open it, sign in on X themselves and approve access (OAuth 2.0 with PKCE). The panel never sees a password, stores tokens encrypted (AES-256-GCM) and refreshes them automatically. Disconnecting revokes access on X.
- **Compose and schedule.** Single posts and threads (up to 25 parts) with a 280-character counter that counts links as 23 characters. Posts start as drafts and only go out after someone approves them, either straight away or at a set time.
- **Queue.** Filter by status and account; edit, approve, retry or cancel. Editing sends a post back to draft, so it is approved again.
- **Mention inbox.** Mentions for every account are pulled in on a timer (or with *Check now*). Replies are written or picked from saved templates and **sent by a person**; nothing replies on its own.
- **Analytics.** Impressions, likes, reposts, replies and quotes per account for the last 30 days, plus your top posts.
- **Activity log** of every connect, approval, publish, failure and reply.

## Guardrails

These keep accounts within [X's automation rules](https://help.x.com/en/rules-and-policies/x-automation):

| Guardrail | Why |
| --- | --- |
| Hard cap of 10 connected accounts (`MAX_ACCOUNTS`, cannot be set higher) | Scope of this tool |
| Same text blocked across different accounts | X forbids identical or near-identical content across multiple accounts |
| Daily cap per account (`DAILY_POST_CAP`, default 25 posts and replies per 24h) | Keeps volume reasonable |
| X rate limits read from response headers; on a 429 the post waits until the reset time | Never hammers the API |
| Every reply is sent by a person | Automated replies are heavily restricted by X |
| No auto-likes, auto-reposts, follow/unfollow automation, proxies, or accounts engaging with each other | Not allowed by X |

## Quick start (mock mode, no X keys needed)

Requires Node.js 22.9 or newer.

```bash
npm install
PANEL_PASSWORD=pick-a-password npm run dev
```

Open http://localhost:3000. In mock mode connect links create fake accounts and nothing is posted to X.

## Running against X

1. On [developer.x.com](https://developer.x.com), create a project and app. Under **User authentication settings**, enable **OAuth 2.0**, set type to **Web App**, and add the callback URL `BASE_URL/oauth/callback` (for example `https://panel.example.com/oauth/callback`).
2. Copy `.env.example` to `.env` and fill it in:
   ```bash
   cp .env.example .env
   openssl rand -hex 32   # SESSION_SECRET
   openssl rand -hex 32   # TOKEN_ENC_KEY
   ```
   Set `X_CLIENT_ID`, `X_CLIENT_SECRET`, `BASE_URL`, `PANEL_PASSWORD` and `X_MOCK=0`.
3. `npm start`

Use HTTPS in production (put it behind a reverse proxy such as Caddy or nginx); the session cookie is marked `Secure` when `BASE_URL` starts with `https://`. Back up `data/` and keep `TOKEN_ENC_KEY` safe: without it, the stored tokens cannot be decrypted and clients would have to reconnect.

### API tier

Which features work depends on your X API plan, so check its limits on developer.x.com. Entry plans allow posting but may not allow reading mentions or post metrics; when X refuses those calls the inbox and analytics stay empty, and posting carries on. The poll intervals (`MENTIONS_POLL_MINUTES`, `METRICS_POLL_MINUTES`) are there to stay inside your plan's read limits.

## Using it

1. **Clients & accounts** → add a client → **Create connect link** → send the link to the client. Links are single-use and expire after 7 days.
2. **Compose** → pick the account → write the post or thread → **Save draft** or **Approve & schedule**.
3. **Queue** → review drafts, approve, edit or cancel. Failed posts show the error from X and can be retried.
4. **Inbox** → reply to mentions, optionally starting from a **Reply template** (`{{username}}` is filled in).
5. **Analytics** → **Refresh from X** for the latest numbers.

If a client revokes access on X, their account shows *reauth required*; send them a new connect link.

## Development

```bash
npm test     # node:test suite, runs against the mock X client
```

Layout:

```
src/
  server.js          entry point, wires services together
  app.js             HTTP routes, session, OAuth connect/callback
  scheduler.js       background jobs: publish, poll mentions, refresh metrics
  services/          accounts (tokens, rate limits, caps), posts, inbox, metrics
  x/api.js           X API v2 client      x/mock.js  fake client for dev and tests
  db.js              SQLite schema (node:sqlite)
public/              the panel UI (plain HTML/CSS/JS, no build step)
```
