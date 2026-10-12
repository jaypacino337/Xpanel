import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { makeCipher } from './crypto.js';
import { createRealX } from './x/api.js';
import { createMockX } from './x/mock.js';
import { createAccountService } from './services/accounts.js';
import { createPostService } from './services/posts.js';
import { createInboxService } from './services/inbox.js';
import { createMetricsService } from './services/metrics.js';
import { createMediaService } from './services/media.js';
import { createUserService } from './services/users.js';
import { createAiService } from './services/ai.js';
import { startScheduler } from './scheduler.js';
import { attachAlerts } from './alerts.js';
import { createApp } from './app.js';

export function buildServices(config, { db = openDb(config.dbPath), x, aiClient } = {}) {
  const redirectUri = `${config.baseUrl}/oauth/callback`;
  x ??= config.mock
    ? createMockX({ redirectUri })
    : createRealX({ clientId: config.xClientId, clientSecret: config.xClientSecret, redirectUri });
  const cipher = makeCipher(config.tokenEncKey);
  const accounts = createAccountService({ db, x, cipher, config });
  const media = createMediaService({ db, config });
  const posts = createPostService({ db, x, accounts, media, config });
  const inbox = createInboxService({ db, x, accounts, config });
  const metrics = createMetricsService({ db, x, accounts, config });
  const users = createUserService({ db });
  const ai = createAiService({ config, client: aiClient });
  users.bootstrap(config.panelPassword);
  attachAlerts(db, { webhookUrl: config.alertWebhookUrl });
  return { db, x, config, accounts, media, posts, inbox, metrics, users, ai };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const services = buildServices(config);
  startScheduler(services);
  createApp(services).listen(config.port, () => {
    console.log(`XPanel on ${config.baseUrl}${config.mock ? ' (mock X API: no real posts are made)' : ''}`);
    console.log(`OAuth callback URL to register on developer.x.com: ${config.baseUrl}/oauth/callback`);
    console.log(`Up to ${config.maxAccounts} accounts · AI drafting ${services.ai.enabled ? 'on' : 'off'} · alerts ${config.alertWebhookUrl ? 'on' : 'off'}`);
  });
}
