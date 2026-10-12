# XPanel

A self-hosted control panel for agencies managing **10 to 100 client accounts on X**, built on X's official API.

## What it does

| Area | Features |
| --- | --- |
| **Dashboard** | All clients and accounts in one place, with search, account health, queue counts, next scheduled post, new mentions, and posts left today. |
| **Client onboarding** | Create a connect link, send it to the client, and they sign in on X themselves (OAuth 2.0 with PKCE). No passwords are shared. Tokens are stored encrypted (AES-256-GCM) and refreshed automatically. Disconnecting revokes access on X. |
| **Compose** | Single posts and threads (up to 25 parts) with up to 4 images, a 280-character counter (links count as 23), and three timing options: as soon as approved, at a set time, or the next free posting slot. |
| **AI drafting** (optional) | Write a short brief and Claude drafts a post or thread in the account's brand voice. In the inbox, **Suggest reply** drafts a response to a mention. Nothing is sent until a person reviews it and clicks send. |
| **Schedules** | Weekly posting times per account in that account's time zone, plus brand voice notes. Times can be copied across weekdays or applied to all of a client's accounts. "Next free posting slot" fills them in order without double-booking. |
| **Bulk import** | Upload a CSV of posts (account, text, time) to fill weeks of content at once, including threads and "next slot" times. Bad rows are reported by line number and the rest still import. |
| **Queue** | Filter by status, client, and account; edit, approve, retry, or cancel posts, one at a time or in bulk. |
| **Inbox** | Mentions across all accounts, filterable by client. Reply with templates, AI suggestions, or your own text. |
| **Analytics** | Impressions and engagement per account and client for the last 30 days, top posts, and a **CSV report** to send clients. |
| **Team** | Separate logins. **Admins** approve posts, connect accounts, and manage the team. **Editors** write drafts, import drafts, and reply to mentions. Every action is recorded in the activity log with who did it. |
| **Alerts** (optional) | Failed posts and expired client access are sent to a Slack or Discord webhook. |

## Guardrails

These keep every account within [X's automation rules](https://help.x.com/en/rules-and-policies/x-automation) and protect your clients' accounts:

| Guardrail | Why |
| --- | --- |
| Each account is connected by its owner through X's own sign-in | Clients stay in control, and can revoke access on X at any time |
| Same text blocked across different accounts | X forbids identical or near-identical content across multiple accounts |
| Accounts in the panel cannot reply to each other | Prevents coordinated engagement between managed accounts |
| Posts are approved before they go out; replies are sent by a person | Automated replies and unreviewed posting are heavily restricted by X |
| Daily cap per account (`DAILY_POST_CAP`, default 25 posts and replies per 24 hours) | Keeps volume reasonable |
| X rate limits are read from response headers; on a 429 the post waits until the reset time | Never hammers the API |
| Background jobs check accounts a batch at a time with a concurrency limit | 100 accounts don't all hit X at once |
| No auto-likes, auto-reposts, follow/unfollow automation, or proxies | Not allowed by X |

## Quick start (mock mode, no X keys needed)

Requires Node.js 22.9 or newer.

```bash
npm install
PANEL_PASSWORD=pick-a-password npm run dev
```

Open http://localhost:3000 and sign in as `admin` with that password. In mock mode, connect links create fake accounts and nothing is posted to X.

## Running against X

1. On [developer.x.com](https://developer.x.com), create a project and app. Under **User authentication settings**, turn on **OAuth 2.0**, set the type to **Web App**, and add the callback URL `BASE_URL/oauth/callback` (for example `https://panel.example.com/oauth/callback`).
2. Copy `.env.example` to `.env` and fill it in:
   ```bash
   cp .env.example .env
   openssl rand -hex 32   # SESSION_SECRET
   openssl rand -hex 32   # TOKEN_ENC_KEY
   ```
   Set `X_CLIENT_ID`, `X_CLIENT_SECRET`, `BASE_URL`, `PANEL_PASSWORD`, `MAX_ACCOUNTS` (up to 100), `DEFAULT_TIMEZONE`, and `X_MOCK=0`. Optionally set `ANTHROPIC_API_KEY` for AI drafting and `ALERT_WEBHOOK_URL` for alerts.
3. `npm start`, then sign in as `admin` with `PANEL_PASSWORD`. That password only seeds the first admin; change it under **Team**, and add your team there.

Use HTTPS in production (put the panel behind a reverse proxy such as Caddy or nginx); the session cookie is marked `Secure` when `BASE_URL` starts with `https://`. Back up `data/` (database and uploaded images) and keep `TOKEN_ENC_KEY` safe: without it the stored tokens cannot be decrypted, and every client would have to reconnect.

Accounts connected with an earlier version of XPanel don't have the `media.write` permission. Send them a fresh connect link before posting images from those accounts.

### X API plan

Your X API plan decides how far this scales, so check its limits on developer.x.com before connecting many accounts. Plans cap posts per month across the whole app, and reading mentions and metrics may need a higher tier. When X refuses a call, posting still works, and the inbox and analytics stay empty. The poll intervals (`MENTIONS_POLL_MINUTES`, `METRICS_POLL_MINUTES`) let you stay inside your plan's read limits.

## Bulk import format

```csv
account,text,scheduled_at
@acmecoffee,"Weekend sale starts now: 20% off everything.",next
@acmecoffee,"New in: our autumn menu
---
Pumpkin spice is back, plus two new seasonal roasts.",2026-11-02 09:00
@northsidegym,Holiday hours are up on our site,
```

- `account`: the X handle, with or without `@`.
- `text`: the post. A line containing only `---` splits a thread (keep the whole cell in quotes).
- `scheduled_at`: `YYYY-MM-DD HH:MM` in the account's time zone, an ISO timestamp, `next` for the next free posting slot, or empty for an unscheduled draft.

Imports arrive as drafts; admins can tick **Approve straight into the queue**.

## Development

```bash
npm test     # node:test suite, runs against the mock X client and a fake AI client
```

```
src/
  server.js          entry point, wires services together
  app.js             HTTP routes, sessions and roles, OAuth connect/callback
  scheduler.js       background jobs: publish, poll mentions, refresh metrics, clean up images
  alerts.js          Slack/Discord webhook alerts
  services/          accounts, posts, inbox, metrics, media, users, ai
  lib/               time zones and slots, CSV, concurrency, error types
  x/api.js           X API v2 client      x/mock.js  fake client for dev and tests
  db.js              SQLite schema (node:sqlite), upgrades older databases in place
public/              the panel UI (plain HTML/CSS/JS, no build step)
```
