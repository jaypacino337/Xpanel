// XPanel front end: plain DOM, no build step.
const $ = (sel) => document.querySelector(sel);
const view = $('#view');

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// Replaces the main view; accepts nested arrays and skips empty values like h() does.
function render(...nodes) {
  view.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// Wraps a click handler: disables the button while it runs and reports errors.
const action = (fn) => async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try { await fn(e); } catch (err) { toast(err.message); } finally { btn.disabled = false; }
};

const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : '—');
const num = (n) => (n == null ? '—' : Number(n).toLocaleString());
const postUrl = (username, id) => `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(id)}`;
const URL_RE = /https?:\/\/\S+/g;
const postLength = (t) => [...t.replace(URL_RE, 'x'.repeat(23))].length;
const toLocalInput = (ms) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
const STATUS_CLASS = { posted: 'ok', scheduled: 'ok', draft: '', posting: 'warn', failed: 'bad', cancelled: '', active: 'ok', reauth_required: 'bad' };
const badge = (s) => h('span', { class: `badge ${STATUS_CLASS[s] ?? ''}` }, s.replace('_', ' '));

let overview = { clients: [] };
const allAccounts = () => overview.clients.flatMap((c) => c.accounts.map((a) => ({ ...a, client_name: c.name })));

function accountSelect(selected, { includeAll = false } = {}) {
  const sel = h('select', {}, includeAll ? h('option', { value: '' }, 'All accounts') : null);
  for (const c of overview.clients) {
    if (!c.accounts.length) continue;
    sel.append(h('optgroup', { label: c.name }, c.accounts.map((a) =>
      h('option', { value: a.id, selected: String(a.id) === String(selected) }, `@${a.username}`))));
  }
  return sel;
}

async function loadOverview() {
  overview = await api('GET', '/api/overview');
  $('#mock-badge').hidden = !overview.mock;
}

// ---------- Clients & accounts ----------
async function renderOverview() {
  await loadOverview();
  const used = allAccounts().length;
  const nameInput = h('input', { placeholder: 'Client name', maxlength: 100 });
  render(
    h('h1', {}, 'Clients & accounts'),
    h('p', { class: 'muted' }, `${used} of ${overview.maxAccounts} account slots used · each account may send up to ${overview.dailyPostCap} posts and replies per 24 hours.`),
    h('div', { class: 'card' },
      h('h2', {}, 'Add a client'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, nameInput),
        h('button', { onclick: action(async () => {
          await api('POST', '/api/clients', { name: nameInput.value });
          toast('Client added');
          renderOverview();
        }) }, 'Add'))),
    overview.clients.length ? null : h('p', { class: 'muted' }, 'No clients yet.'),
    overview.clients.map((c) => h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('h2', { class: 'grow' }, c.name),
        h('button', { class: 'ghost', disabled: used >= overview.maxAccounts, onclick: action(async () => {
          const inv = await api('POST', `/api/clients/${c.id}/invites`, {});
          await navigator.clipboard?.writeText(inv.url).catch(() => {});
          toast('Connect link created and copied');
          renderOverview();
        }) }, 'Create connect link'),
        h('button', { class: 'danger', onclick: action(async () => {
          if (!confirm(`Delete ${c.name}? Their accounts are disconnected and their queue is removed.`)) return;
          await api('DELETE', `/api/clients/${c.id}`, {});
          renderOverview();
        }) }, 'Delete')),
      c.invites.map((i) => h('div', { class: 'invite' },
        'Send this link to the client. They sign in on X themselves and approve access (expires ', fmt(i.expires_at), '):',
        h('br'), h('code', {}, i.url))),
      c.accounts.length ? h('div', { class: 'accounts' }, c.accounts.map((a) => h('div', { class: 'account' },
        h('div', { class: 'row' }, h('span', { class: 'handle grow' }, `@${a.username}`), badge(a.status)),
        h('div', { class: 'stats' },
          `${a.queued} queued · ${a.drafts} drafts · ${a.failed} failed`, h('br'),
          `${a.new_mentions} new mentions · ${a.remaining_today} posts left today`),
        a.status === 'reauth_required' ? h('p', { class: 'error' }, 'Access expired. Create a new connect link for the client.') : null,
        h('button', { class: 'danger', onclick: action(async () => {
          if (!confirm(`Disconnect @${a.username}? This revokes the panel's access on X.`)) return;
          await api('DELETE', `/api/accounts/${a.id}`, {});
          renderOverview();
        }) }, 'Disconnect'))))
        : h('p', { class: 'muted' }, 'No accounts connected yet.'))));
}

// ---------- Compose ----------
let editing = null; // post being edited, if any

async function renderCompose() {
  await loadOverview();
  const accs = allAccounts();
  if (!accs.length) {
    render(h('h1', {}, 'Compose'), h('p', { class: 'muted' }, 'Connect an account first.'));
    return;
  }
  const post = editing;
  const acctSel = accountSelect(post?.account_id ?? accs[0].id);
  const when = h('input', { type: 'datetime-local', value: post?.scheduled_at ? toLocalInput(post.scheduled_at) : '' });
  const partsBox = h('div');
  const capNote = h('p', { class: 'muted' });

  function addPart(text = '') {
    const ta = h('textarea', { placeholder: partsBox.children.length ? 'Next post in thread…' : "What's happening?" });
    ta.value = text;
    const counter = h('span', { class: 'counter' });
    const update = () => {
      const n = postLength(ta.value);
      counter.textContent = `${n}/280`;
      counter.classList.toggle('over', n > 280);
    };
    ta.addEventListener('input', update);
    update();
    const wrap = h('div', { class: 'part' }, ta, h('div', { class: 'row' }, counter, h('span', { class: 'grow' }),
      h('button', { class: 'ghost', type: 'button', onclick: () => { if (partsBox.children.length > 1) wrap.remove(); } }, 'Remove')));
    partsBox.append(wrap);
    ta.focus();
  }
  (post?.parts ?? ['']).forEach(addPart);

  const showCap = () => {
    const a = accs.find((x) => String(x.id) === acctSel.value);
    capNote.textContent = a ? `@${a.username} can send ${a.remaining_today} more posts in the next 24 hours.` : '';
  };
  acctSel.addEventListener('change', showCap);
  showCap();

  const payload = () => ({
    accountId: Number(acctSel.value),
    parts: [...partsBox.querySelectorAll('textarea')].map((t) => t.value),
    scheduledAt: when.value ? new Date(when.value).toISOString() : null,
  });

  async function save(approve) {
    let saved;
    if (post) {
      saved = await api('PUT', `/api/posts/${post.id}`, payload());
      if (approve) saved = await api('POST', `/api/posts/${saved.id}/approve`, {});
    } else {
      saved = await api('POST', '/api/posts', { ...payload(), approve });
    }
    editing = null;
    toast(approve ? (saved.scheduled_at > Date.now() ? `Scheduled for ${fmt(saved.scheduled_at)}` : 'Queued to post now') : 'Draft saved');
    show('queue');
  }

  render(
    h('h1', {}, post ? `Edit post #${post.id}` : 'Compose'),
    h('div', { class: 'card' },
      h('label', {}, 'Account', acctSel),
      capNote,
      partsBox,
      h('button', { class: 'ghost', type: 'button', onclick: () => addPart() }, '+ Add to thread'),
      h('label', { style: 'margin-top:12px' }, 'Publish at (leave empty to post as soon as approved)', when),
      h('div', { class: 'row end' },
        post ? h('button', { class: 'ghost', onclick: () => { editing = null; show('queue'); } }, 'Cancel edit') : null,
        h('button', { class: 'ghost', onclick: action(() => save(false)) }, 'Save draft'),
        h('button', { onclick: action(() => save(true)) }, 'Approve & schedule'))),
    h('p', { class: 'muted' }, 'X does not allow the same text on more than one account, so the panel blocks duplicates across accounts.'));
}

// ---------- Queue ----------
let queueFilter = { status: '', accountId: '' };

async function renderQueue() {
  await loadOverview();
  const statusSel = h('select', {}, ['', 'draft', 'scheduled', 'posting', 'posted', 'failed', 'cancelled']
    .map((s) => h('option', { value: s, selected: s === queueFilter.status }, s || 'All statuses')));
  const acctSel = accountSelect(queueFilter.accountId, { includeAll: true });
  const reload = () => {
    queueFilter = { status: statusSel.value, accountId: acctSel.value };
    renderQueue();
  };
  statusSel.addEventListener('change', reload);
  acctSel.addEventListener('change', reload);

  const q = new URLSearchParams(Object.entries(queueFilter).filter(([, v]) => v));
  const list = await api('GET', `/api/posts?${q}`);
  render(
    h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Queue'),
      h('button', { onclick: () => { editing = null; show('compose'); } }, 'New post')),
    h('div', { class: 'row', style: 'margin-bottom:12px' }, statusSel, acctSel),
    list.length ? null : h('p', { class: 'muted' }, 'Nothing here.'),
    list.map((p) => h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('strong', {}, `@${p.username}`), badge(p.status),
        p.parts.length > 1 ? h('span', { class: 'badge' }, `thread · ${p.parts.length}`) : null,
        h('span', { class: 'grow' }),
        h('span', { class: 'muted' }, p.status === 'posted' ? `Posted ${fmt(p.posted_at)}` : p.scheduled_at ? `For ${fmt(p.scheduled_at)}` : 'No time set')),
      p.parts.map((t) => h('div', { class: 'post-text' }, t)),
      p.error ? h('p', { class: 'error' }, p.error) : null,
      h('div', { class: 'row end' },
        p.tweet_ids.length ? h('a', { href: postUrl(p.username, p.tweet_ids[0]), target: '_blank', rel: 'noopener' }, 'View on X') : null,
        ['draft', 'scheduled', 'failed'].includes(p.status)
          ? h('button', { class: 'ghost', onclick: () => { editing = p; show('compose'); } }, 'Edit') : null,
        ['draft', 'failed'].includes(p.status) && !p.tweet_ids.length
          ? h('button', { onclick: action(async () => { await api('POST', `/api/posts/${p.id}/approve`, {}); toast('Approved'); renderQueue(); }) }, p.status === 'failed' ? 'Retry' : 'Approve') : null,
        ['draft', 'scheduled', 'failed'].includes(p.status)
          ? h('button', { class: 'danger', onclick: action(async () => { await api('POST', `/api/posts/${p.id}/cancel`, {}); renderQueue(); }) }, 'Cancel') : null))));
}

// ---------- Inbox ----------
let inboxFilter = { status: 'new', accountId: '' };

async function renderInbox() {
  await loadOverview();
  const [templates, mentions] = await Promise.all([
    api('GET', '/api/templates'),
    api('GET', `/api/mentions?${new URLSearchParams(Object.entries(inboxFilter).filter(([, v]) => v))}`),
  ]);
  const statusSel = h('select', {}, ['new', 'replied', 'dismissed'].map((s) => h('option', { value: s, selected: s === inboxFilter.status }, s)));
  const acctSel = accountSelect(inboxFilter.accountId, { includeAll: true });
  const reload = () => { inboxFilter = { status: statusSel.value, accountId: acctSel.value }; renderInbox(); };
  statusSel.addEventListener('change', reload);
  acctSel.addEventListener('change', reload);

  render(
    h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Inbox'),
      h('button', { class: 'ghost', onclick: action(async () => {
        const r = await api('POST', '/api/mentions/poll', {});
        toast(`${r.fetched} new mentions`);
        renderInbox();
      }) }, 'Check now')),
    h('p', { class: 'muted' }, 'Mentions are checked automatically. Every reply is written or reviewed and sent by a person.'),
    h('div', { class: 'row', style: 'margin-bottom:12px' }, statusSel, acctSel),
    mentions.length ? null : h('p', { class: 'muted' }, 'No mentions here.'),
    mentions.map((m) => {
      const who = m.author_username ? `@${m.author_username}` : `user ${m.author_id}`;
      const ta = h('textarea', { placeholder: `Reply as @${m.account_username}…` });
      const counter = h('span', { class: 'counter' }, '0/280');
      ta.addEventListener('input', () => {
        const n = postLength(ta.value);
        counter.textContent = `${n}/280`;
        counter.classList.toggle('over', n > 280);
      });
      const tplSel = h('select', {}, h('option', { value: '' }, 'Insert template…'), templates.map((t) => h('option', { value: t.id }, t.name)));
      tplSel.addEventListener('change', () => {
        const t = templates.find((x) => String(x.id) === tplSel.value);
        if (t) { ta.value = t.text.replaceAll('{{username}}', m.author_username ? `@${m.author_username}` : ''); ta.dispatchEvent(new Event('input')); }
        tplSel.value = '';
      });
      return h('div', { class: 'card' },
        h('div', { class: 'row' }, h('strong', {}, who), h('span', { class: 'muted' }, `→ @${m.account_username}`),
          h('span', { class: 'grow' }), h('span', { class: 'muted' }, fmt(m.created_at))),
        h('div', { class: 'post-text' }, m.text),
        h('a', { href: postUrl(m.author_username || 'i', m.tweet_id), target: '_blank', rel: 'noopener' }, 'Open on X'),
        m.status === 'new' ? h('div', { style: 'margin-top:10px' }, ta,
          h('div', { class: 'row' }, counter, templates.length ? tplSel : null, h('span', { class: 'grow' }),
            h('button', { class: 'ghost', onclick: action(async () => {
              await api('POST', `/api/mentions/${m.account_id}/${m.tweet_id}/dismiss`, {});
              renderInbox();
            }) }, 'Dismiss'),
            h('button', { onclick: action(async () => {
              await api('POST', `/api/mentions/${m.account_id}/${m.tweet_id}/reply`, { text: ta.value });
              toast('Reply sent');
              renderInbox();
            }) }, 'Send reply')))
          : m.reply_tweet_id ? h('p', {}, h('a', { href: postUrl(m.account_username, m.reply_tweet_id), target: '_blank', rel: 'noopener' }, 'View reply')) : null);
    }));
}

// ---------- Templates ----------
async function renderTemplates() {
  const templates = await api('GET', '/api/templates');
  const name = h('input', { placeholder: 'e.g. Thanks' });
  const text = h('textarea', { placeholder: 'Thanks {{username}}! We will get back to you shortly.' });
  render(
    h('h1', {}, 'Reply templates'),
    h('div', { class: 'card' },
      h('label', {}, 'Name', name),
      h('label', {}, 'Text ({{username}} is replaced with the person you reply to)', text),
      h('div', { class: 'row end' }, h('button', { onclick: action(async () => {
        await api('POST', '/api/templates', { name: name.value, text: text.value });
        renderTemplates();
      }) }, 'Save template'))),
    templates.map((t) => h('div', { class: 'card' },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, t.name),
        h('button', { class: 'danger', onclick: action(async () => { await api('DELETE', `/api/templates/${t.id}`, {}); renderTemplates(); }) }, 'Delete')),
      h('div', { class: 'post-text' }, t.text))));
}

// ---------- Analytics ----------
async function renderAnalytics(data) {
  data ??= await api('GET', '/api/analytics');
  render(
    h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Analytics'),
      h('button', { class: 'ghost', onclick: action(async () => renderAnalytics(await api('POST', '/api/analytics/refresh', {}))) }, 'Refresh from X')),
    h('p', { class: 'muted' }, 'Totals for posts and replies sent from this panel in the last 30 days.'),
    h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Client'), h('th', {}, 'Account'),
        ['Sent', 'Impressions', 'Likes', 'Reposts', 'Replies', 'Quotes'].map((c) => h('th', { class: 'num' }, c)))),
      h('tbody', {}, data.perAccount.map((r) => h('tr', {}, h('td', {}, r.client_name), h('td', {}, `@${r.username}`),
        [r.sent_30d, r.impressions, r.likes, r.retweets, r.replies, r.quotes].map((v) => h('td', { class: 'num' }, num(v)))))))),
    h('h2', {}, 'Top posts'),
    data.topPosts.length ? h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Post'), h('th', {}, 'Account'), ['Likes', 'Reposts', 'Replies'].map((c) => h('th', { class: 'num' }, c)))),
      h('tbody', {}, data.topPosts.map((p) => h('tr', {},
        h('td', {}, h('a', { href: postUrl(p.username, p.tweet_id), target: '_blank', rel: 'noopener' }, (p.text || 'Reply').slice(0, 80))),
        h('td', {}, `@${p.username}`), [p.likes, p.retweets, p.replies].map((v) => h('td', { class: 'num' }, num(v))))))))
      : h('p', { class: 'muted' }, 'No data yet.'));
}

// ---------- Activity ----------
async function renderActivity() {
  const rows = await api('GET', '/api/activity');
  render(h('h1', {}, 'Activity log'),
    h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Action'), h('th', {}, 'Detail'))),
      h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, fmt(r.at)), h('td', {}, r.action), h('td', {}, r.detail ?? '')))))));
}

// ---------- shell ----------
const TABS = { overview: renderOverview, compose: renderCompose, queue: renderQueue, inbox: renderInbox,
  templates: renderTemplates, analytics: renderAnalytics, activity: renderActivity };

async function show(tab) {
  if (!TABS[tab]) tab = 'overview';
  document.querySelectorAll('.sidebar [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  try { await TABS[tab](); } catch (err) { if (err.message !== 'Signed out') toast(err.message); }
}

function showLogin() {
  $('#shell').hidden = true;
  $('#login').hidden = false;
}

async function start() {
  const s = await api('GET', '/api/session');
  if (!s.authenticated) return showLogin();
  $('#login').hidden = true;
  $('#shell').hidden = false;
  show(location.hash.slice(1));
}

document.querySelectorAll('.sidebar [data-tab]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab === 'compose') editing = null;
  show(b.dataset.tab);
}));
$('#logout').addEventListener('click', async () => { await api('POST', '/api/logout', {}); showLogin(); });
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/login', { password: new FormData(e.target).get('password') });
    $('#login-error').textContent = '';
    start();
  } catch (err) { $('#login-error').textContent = err.message; }
});

start();
