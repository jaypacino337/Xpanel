// Creates or updates .env. Existing secrets are kept: changing TOKEN_ENC_KEY would make every
// stored X token unreadable and force all clients to reconnect.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const FILE = new URL('../.env', import.meta.url);
const existing = fs.existsSync(FILE) ? parseEnv(fs.readFileSync(FILE, 'utf8')) : {};
const interactive = stdin.isTTY && !process.argv.includes('--yes');
const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

async function ask(key, question, fallback = '') {
  const current = process.env[key] ?? existing[key] ?? fallback;
  if (!rl) return current;
  const answer = (await rl.question(`${question}${current ? ` [${key.includes('SECRET') || key.includes('KEY') || key.includes('PASSWORD') ? 'keep current' : current}]` : ''}: `)).trim();
  return answer || current;
}

const hex = () => crypto.randomBytes(32).toString('hex');

console.log(interactive ? 'XPanel setup. Press Enter to keep the value in brackets.\n' : 'XPanel setup (non-interactive).');

const mock = (await ask('X_MOCK', 'Run in mock mode without X keys? (1 = yes, 0 = no)', '0')) === '1' ? '1' : '0';
const port = await ask('PORT', 'Port', '3000');
const env = {
  PORT: port,
  BASE_URL: (await ask('BASE_URL', 'Public URL of the panel (https://… in production)', `http://localhost:${port}`)).replace(/\/$/, ''),
  PANEL_PASSWORD: await ask('PANEL_PASSWORD', 'Password for the first "admin" login (blank = generate one)', ''),
  SESSION_SECRET: existing.SESSION_SECRET || hex(),
  TOKEN_ENC_KEY: existing.TOKEN_ENC_KEY || hex(),
  DB_PATH: existing.DB_PATH || 'data/xpanel.db',
  X_MOCK: mock,
  X_CLIENT_ID: mock === '1' ? existing.X_CLIENT_ID ?? '' : await ask('X_CLIENT_ID', 'X OAuth 2.0 Client ID'),
  X_CLIENT_SECRET: mock === '1' ? existing.X_CLIENT_SECRET ?? '' : await ask('X_CLIENT_SECRET', 'X OAuth 2.0 Client Secret'),
  MAX_ACCOUNTS: await ask('MAX_ACCOUNTS', 'Maximum connected accounts (1-100)', '10'),
  DEFAULT_TIMEZONE: await ask('DEFAULT_TIMEZONE', 'Default time zone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
  DAILY_POST_CAP: existing.DAILY_POST_CAP || '25',
  ANTHROPIC_API_KEY: await ask('ANTHROPIC_API_KEY', 'Anthropic API key for AI drafting (optional)'),
  ALERT_WEBHOOK_URL: await ask('ALERT_WEBHOOK_URL', 'Slack/Discord webhook for alerts (optional)'),
  TRUST_PROXY: existing.TRUST_PROXY || 'loopback',
};
rl?.close();

let generatedPassword = null;
if (!env.PANEL_PASSWORD) {
  generatedPassword = crypto.randomBytes(12).toString('base64url');
  env.PANEL_PASSWORD = generatedPassword;
}
if (env.X_MOCK === '0' && !env.X_CLIENT_ID) {
  console.error('\nX_CLIENT_ID is required unless mock mode is on. Run setup again, or set X_MOCK=1 to try the panel first.');
  process.exit(1);
}

// Keep any extra settings the file already had.
const merged = { ...existing, ...env };
const body = Object.entries(merged).map(([k, v]) => `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`).join('\n');
fs.writeFileSync(FILE, `# Written by npm run setup. Keep this file private.\n${body}\n`, { mode: 0o600 });
fs.chmodSync(FILE, 0o600);

console.log(`\nSaved .env${existing.TOKEN_ENC_KEY ? ' (kept existing secrets)' : ''}.`);
if (generatedPassword) console.log(`First login: admin / ${generatedPassword}  (change it under Team after signing in)`);
if (env.X_MOCK === '0') {
  console.log(`\nOn developer.x.com, set your app's OAuth 2.0 type to "Web App" and add this callback URL:\n  ${env.BASE_URL}/oauth/callback`);
}
console.log('\nStart the panel with: npm start');
