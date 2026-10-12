// Sends selected audit events to a Slack or Discord incoming webhook.
const ALERT_ACTIONS = new Set(['post.failed', 'account.reauth_required', 'account.disconnected']);

export function attachAlerts(db, { webhookUrl, fetchImpl = fetch, log = console }) {
  if (!webhookUrl) return;
  db.onAudit = (action, detail) => {
    if (!ALERT_ACTIONS.has(action)) return;
    const text = `XPanel: ${action.replace('.', ' ')}${detail ? ` - ${detail}` : ''}`;
    // Slack reads "text", Discord reads "content".
    fetchImpl(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) })
      .catch((err) => log.warn(`alert webhook failed: ${err.message}`));
  };
}
