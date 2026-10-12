import { audit, tx } from '../db.js';
import { XApiError } from '../x/api.js';
import { isValidTimeZone } from '../lib/time.js';

import { AccountUnavailableError, RateLimitedError, ValidationError } from '../lib/errors.js';

export { AccountUnavailableError, RateLimitedError };

const DAY = 24 * 60 * 60 * 1000;

export function createAccountService({ db, x, cipher, config }) {
  const getAccount = (id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);

  function saveTokens(accountId, tok) {
    db.prepare(`UPDATE accounts SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc),
                expires_at = ?, status = 'active' WHERE id = ?`)
      .run(cipher.encrypt(tok.access_token), tok.refresh_token ? cipher.encrypt(tok.refresh_token) : null,
        Date.now() + (tok.expires_in ?? 7200) * 1000, accountId);
  }

  function markReauth(account, reason) {
    db.prepare("UPDATE accounts SET status = 'reauth_required' WHERE id = ?").run(account.id);
    audit(db, 'account.reauth_required', `@${account.username}: ${reason}`);
  }

  async function refresh(account) {
    const rt = cipher.decrypt(account.refresh_token_enc);
    if (!rt) { markReauth(account, 'no refresh token'); throw new AccountUnavailableError('Account needs to be reconnected'); }
    try {
      saveTokens(account.id, await x.refresh(rt));
    } catch (err) {
      markReauth(account, err.message);
      throw new AccountUnavailableError('Account needs to be reconnected');
    }
    return getAccount(account.id);
  }

  function recordRateLimit(accountId, endpoint, rl) {
    if (!rl) return;
    db.prepare(`INSERT INTO rate_limits (account_id, endpoint, remaining, reset_at) VALUES (?, ?, ?, ?)
                ON CONFLICT (account_id, endpoint) DO UPDATE SET remaining = excluded.remaining, reset_at = excluded.reset_at`)
      .run(accountId, endpoint, rl.remaining, rl.resetAt);
  }

  function rateLimitBlock(accountId, endpoint, now = Date.now()) {
    const row = db.prepare('SELECT * FROM rate_limits WHERE account_id = ? AND endpoint = ?').get(accountId, endpoint);
    if (row && row.remaining === 0 && row.reset_at && row.reset_at > now) return row.reset_at;
    return null;
  }

  // Runs fn(accessToken, account) with a fresh token, honouring and recording X rate limits.
  async function withToken(accountId, endpoint, fn) {
    let account = getAccount(accountId);
    if (!account) throw new AccountUnavailableError('Account not found');
    if (account.status !== 'active') throw new AccountUnavailableError('Account needs to be reconnected');
    const blockedUntil = rateLimitBlock(accountId, endpoint);
    if (blockedUntil) throw new RateLimitedError(endpoint, blockedUntil);
    if (!account.expires_at || account.expires_at < Date.now() + 60_000) account = await refresh(account);

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await fn(cipher.decrypt(account.access_token_enc), account);
        recordRateLimit(accountId, endpoint, result?.rateLimit);
        return result;
      } catch (err) {
        const status = err instanceof XApiError ? err.status : err.status;
        if (status === 429) {
          const resetAt = err.resetAt || Date.now() + 15 * 60_000;
          recordRateLimit(accountId, endpoint, { remaining: 0, resetAt });
          throw new RateLimitedError(endpoint, resetAt);
        }
        if (status === 401 && attempt === 0) { account = await refresh(account); continue; }
        if (status === 401) markReauth(account, 'unauthorized');
        throw err;
      }
    }
  }

  function sentInLastDay(accountId, now = Date.now()) {
    return db.prepare('SELECT COUNT(*) AS n FROM sent_log WHERE account_id = ? AND sent_at > ?')
      .get(accountId, now - DAY).n;
  }

  function remainingToday(accountId) {
    return Math.max(0, config.dailyPostCap - sentInLastDay(accountId));
  }

  function logSent(accountId, tweetId, kind, text) {
    db.prepare('INSERT INTO sent_log (account_id, tweet_id, kind, text, sent_at) VALUES (?, ?, ?, ?, ?)')
      .run(accountId, tweetId, kind, text ?? null, Date.now());
  }

  // True when an X user is one of the accounts managed here (used to stop accounts engaging with each other).
  function isManagedUser(xUserId) {
    return Boolean(xUserId && db.prepare('SELECT 1 FROM accounts WHERE x_user_id = ?').get(String(xUserId)));
  }

  const timezoneOf = (account) => account.timezone || config.defaultTimezone;

  function getSlots(accountId) {
    return db.prepare('SELECT weekday, minute FROM slots WHERE account_id = ? ORDER BY weekday, minute').all(accountId);
  }

  function getSettings(accountId) {
    const account = getAccount(accountId);
    if (!account) return null;
    return { timezone: timezoneOf(account), voice: account.voice || '', slots: getSlots(accountId) };
  }

  // slots: [{ weekday: 0-6, minute: 0-1439 }]
  function updateSettings(accountId, { timezone, voice, slots }) {
    const account = getAccount(accountId);
    if (!account) throw new AccountUnavailableError('Account not found');
    if (timezone !== undefined && !isValidTimeZone(timezone)) throw new ValidationError(`Unknown time zone "${timezone}"`);
    if (voice !== undefined && String(voice).length > 2000) throw new ValidationError('Brand voice notes are limited to 2000 characters');
    if (slots !== undefined) {
      if (!Array.isArray(slots) || slots.length > 200) throw new ValidationError('Up to 200 posting slots per account');
      for (const sl of slots) {
        if (!Number.isInteger(sl.weekday) || sl.weekday < 0 || sl.weekday > 6
          || !Number.isInteger(sl.minute) || sl.minute < 0 || sl.minute > 1439) throw new ValidationError('Invalid posting slot');
      }
    }
    tx(db, () => {
      if (timezone !== undefined) db.prepare('UPDATE accounts SET timezone = ? WHERE id = ?').run(timezone, accountId);
      if (voice !== undefined) db.prepare('UPDATE accounts SET voice = ? WHERE id = ?').run(String(voice).trim() || null, accountId);
      if (slots !== undefined) {
        db.prepare('DELETE FROM slots WHERE account_id = ?').run(accountId);
        const ins = db.prepare('INSERT OR IGNORE INTO slots (account_id, weekday, minute) VALUES (?, ?, ?)');
        for (const sl of slots) ins.run(accountId, sl.weekday, sl.minute);
      }
      audit(db, 'account.settings', `@${account.username}`);
    });
    return getSettings(accountId);
  }

  function countAccounts() {
    return db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  }

  // Called from the OAuth callback once the client has approved access on X.
  async function connectFromCode({ code, verifier, clientId }) {
    const tok = await x.exchangeCode({ code, verifier });
    const me = await x.me(tok.access_token);
    const existing = db.prepare('SELECT * FROM accounts WHERE x_user_id = ?').get(me.id);
    if (!existing && countAccounts() >= config.maxAccounts) {
      await x.revoke(tok.access_token).catch(() => {});
      throw new Error(`This panel is limited to ${config.maxAccounts} accounts.`);
    }
    let id;
    if (existing) {
      id = existing.id;
      db.prepare('UPDATE accounts SET username = ?, name = ?, client_id = ?, scopes = ? WHERE id = ?')
        .run(me.username, me.name, clientId, tok.scope || null, id);
    } else {
      id = Number(db.prepare(`INSERT INTO accounts (client_id, x_user_id, username, name, scopes, timezone, created_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(clientId, me.id, me.username, me.name, tok.scope || null, config.defaultTimezone, Date.now()).lastInsertRowid);
    }
    saveTokens(id, tok);
    audit(db, existing ? 'account.reconnected' : 'account.connected', `@${me.username}`);
    return getAccount(id);
  }

  async function disconnect(accountId) {
    const account = getAccount(accountId);
    if (!account) return false;
    const token = cipher.decrypt(account.access_token_enc);
    if (token) await x.revoke(token).catch(() => {});
    db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
    audit(db, 'account.disconnected', `@${account.username}`);
    return true;
  }

  return {
    getAccount, withToken, remainingToday, logSent, countAccounts, connectFromCode, disconnect,
    isManagedUser, timezoneOf, getSlots, getSettings, updateSettings,
  };
}
