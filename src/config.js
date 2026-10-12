import crypto from 'node:crypto';

function int(name, fallback) {
  const v = process.env[name];
  const n = v === undefined || v === '' ? fallback : Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

export function loadConfig(env = process.env) {
  const mock = env.X_MOCK === '1' || env.X_MOCK === 'true';
  const port = int('PORT', 3000);
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
    maxAccounts: Math.min(int('MAX_ACCOUNTS', 10), 10),
    dailyPostCap: int('DAILY_POST_CAP', 25),
    mentionsPollMinutes: int('MENTIONS_POLL_MINUTES', 15),
    metricsPollMinutes: int('METRICS_POLL_MINUTES', 60),
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
  if (missing.length) throw new Error(`Missing required settings: ${missing.join(', ')} (see .env.example)`);
  if (!/^[0-9a-f]{64}$/i.test(config.tokenEncKey)) throw new Error('TOKEN_ENC_KEY must be 64 hex characters');
  return config;
}
