import crypto from 'node:crypto';
import path from 'node:path';
import { isValidTimeZone } from './lib/time.js';

export const ACCOUNT_LIMIT = 100;

function int(env, name, fallback) {
  const v = env[name];
  const n = v === undefined || v === '' ? fallback : Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

// Express "trust proxy": a hop count, true/false, or a list like "loopback, 10.0.0.0/8".
function parseTrustProxy(value) {
  if (value === undefined || value === '') return 'loopback';
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true' || value === 'false') return value === 'true';
  return value;
}

export function loadConfig(env = process.env) {
  const mock = env.X_MOCK === '1' || env.X_MOCK === 'true';
  const port = int(env, 'PORT', 3000);
  const config = {
    port,
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    panelPassword: env.PANEL_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    tokenEncKey: env.TOKEN_ENC_KEY || '',
    dbPath: env.DB_PATH || 'data/xpanel.db',
    xClientId: env.X_CLIENT_ID || '',
    xClientSecret: env.X_CLIENT_SECRET || '',
    mock,
    maxAccounts: Math.max(1, Math.min(int(env, 'MAX_ACCOUNTS', 10), ACCOUNT_LIMIT)),
    defaultTimezone: env.DEFAULT_TIMEZONE || 'UTC',
    mediaDir: env.MEDIA_DIR || path.join(path.dirname(env.DB_PATH || 'data/xpanel.db'), 'media'),
    alertWebhookUrl: env.ALERT_WEBHOOK_URL || '',
    aiEnabled: Boolean(env.ANTHROPIC_API_KEY),
    concurrency: Math.max(1, int(env, 'X_CONCURRENCY', 5)),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    dailyPostCap: int(env, 'DAILY_POST_CAP', 25),
    mentionsPollMinutes: int(env, 'MENTIONS_POLL_MINUTES', 15),
    metricsPollMinutes: int(env, 'METRICS_POLL_MINUTES', 60),
  };

  const missing = [];
  if (!config.panelPassword) missing.push('PANEL_PASSWORD');
  if (mock) {
    // Mock mode is for local trials only, so fill in throwaway secrets.
    config.sessionSecret ||= crypto.randomBytes(32).toString('hex');
    config.tokenEncKey ||= crypto.randomBytes(32).toString('hex');
  } else {
    if (!config.sessionSecret) missing.push('SESSION_SECRET');
    if (!config.tokenEncKey) missing.push('TOKEN_ENC_KEY');
    if (!config.xClientId) missing.push('X_CLIENT_ID');
  }
  if (missing.length) throw new Error(`Missing required settings: ${missing.join(', ')} (run "npm run setup" or see .env.example)`);
  if (!isValidTimeZone(config.defaultTimezone)) throw new Error(`DEFAULT_TIMEZONE "${config.defaultTimezone}" is not a valid IANA time zone`);
  if (!/^[0-9a-f]{64}$/i.test(config.tokenEncKey)) throw new Error('TOKEN_ENC_KEY must be 64 hex characters');
  return config;
}
