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
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// Replaces the main view; accepts nested arrays and skips empty values like h() does.
function render(...nodes) {
  view.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
}

async function api(method, path, body, { raw, type } = {}) {
  const headers = raw ? { 'content-type': type } : body === undefined ? {} : { 'content-type': 'application/json' };
  const res = await fetch(path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
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
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
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
const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STATUS_CLASS = { posted: 'ok', scheduled: 'ok', draft: '', posting: 'warn', failed: 'bad', cancelled: '', active: 'ok', reauth_required: 'bad' };
const badge = (s) => h('span', { class: `badge ${STATUS_CLASS[s] ?? ''}` }, s.replace('_', ' '));

let session = { user: null, aiEnabled: false };
const isAdmin = () => session.user?.role === 'admin';
let overview = { clients: [], totals: {} };
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

function clientSelect(selected) {
  return h('select', {}, h('option', { value: '' }, 'All clients'),
    overview.clients.map((c) => h('option', { value: c.id, selected: String(c.id) === String(selected) }, c.name)));
}

function charCounter(ta) {
  const counter = h('span', { class: 'counter' });
  const update = () => {
    const n = postLength(ta.value);
    counter.textContent = `${n}/280`;
    counter.classList.toggle('over', n > 280);
  };
  ta.addEventListener('input', update);
  update();
  return counter;
}

const query = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v != null)).toString();

async function loadOverview() {
  overview = await api('GET', '/api/overview');
  $('#mock-badge').hidden = !overview.mock;
}

// ---------- Dashboard: clients & accounts ----------
let search = '';

async function renderOverview() {
  await loadOverview();
  const t = overview.totals;
  const used = t.accounts;
  const nameInput = h('input', { placeholder: 'Client name', maxlength: 100 });
  const searchInput = h('input', { placeholder: 'Search clients and accounts…', value: search, type: 'search' });
  const list = h('div');

  const tile = (label, value, tab, alert) => h('button', { class: `tile ${alert && value ? 'alert' : ''}`, style: 'text-align:left;color:inherit', onclick: () => show(tab) },
    h('div', { class: 'value' }, num(value)), h('div', { class: 'label' }, label));

  function drawList() {
    const q = search.trim().toLowerCase().replace(/^@/, '');
    const clients = overview.clients
      .map((c) => {
        const clientHit = c.name.toLowerCase().includes(q);
        return { ...c, shown: clientHit ? c.accounts : c.accounts.filter((a) => a.username.toLowerCase().includes(q)), clientHit };
      })
      .filter((c) => !q || c.clientHit || c.shown.length);
    list.replaceChildren(...(clients.length ? clients.map(clientCard) : [h('p', { class: 'muted' }, q ? 'No matches.' : 'No clients yet.')]));
  }

  function clientCard(c) {
    return h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('h2', { class: 'grow' }, c.name, h('span', { class: 'muted', style: 'font-weight:400' }, ` · ${c.accounts.length} account${c.accounts.length === 1 ? '' : 's'}`)),
        isAdmin() ? h('button', { class: 'ghost', disabled: used >= overview.maxAccounts, onclick: action(async () => {
          const inv = await api('POST', `/api/clients/${c.id}/invites`, {});
          await navigator.clipboard?.writeText(inv.url).catch(() => {});
          toast('Connect link created and copied');
          renderOverview();
        }) }, 'Create connect link') : null,
        isAdmin() ? h('button', { class: 'danger', onclick: action(async () => {
          if (!confirm(`Delete ${c.name}? Their accounts are disconnected and their queue is removed.`)) return;
          await api('DELETE', `/api/clients/${c.id}`, {});
          renderOverview();
        }) }, 'Delete') : null),
      c.invites.map((i) => h('div', { class: 'invite' },
        'Send this link to the client. They sign in on X themselves and approve access (expires ', fmt(i.expires_at), '):',
        h('br'), h('code', {}, i.url))),
      c.shown.length ? h('div', { class: 'accounts' }, c.shown.map((a) => h('div', { class: 'account' },
        h('div', { class: 'row' }, h('span', { class: 'handle grow' }, `@${a.username}`), badge(a.status)),
        h('div', { class: 'stats' },
          `${a.queued} queued · ${a.drafts} drafts · ${a.failed} failed`, h('br'),
          `${a.new_mentions} new mentions · ${a.remaining_today} posts left today`, h('br'),
          a.next_post_at ? `Next post ${fmt(a.next_post_at)}` : 'Nothing scheduled', h('br'),
          `${a.slots} posting slots · ${a.timezone}`),
        a.status === 'reauth_required' ? h('p', { class: 'error' }, 'Access expired. Create a new connect link for the client.') : null,
        h('div', { class: 'row' },
          h('button', { class: 'ghost', onclick: () => { scheduleAccount = a.id; show('schedules'); } }, 'Schedule'),
          isAdmin() ? h('button', { class: 'danger', onclick: action(async () => {
            if (!confirm(`Disconnect @${a.username}? This revokes the panel's access on X.`)) return;
            await api('DELETE', `/api/accounts/${a.id}`, {});
            renderOverview();
          }) }, 'Disconnect') : null))))
        : h('p', { class: 'muted' }, c.accounts.length ? 'No accounts match.' : 'No accounts connected yet.'));
  }

  searchInput.addEventListener('input', () => { search = searchInput.value; drawList(); });
  drawList();

  render(
    h('h1', {}, 'Dashboard'),
    h('div', { class: 'tiles' },
      tile(`Accounts (of ${overview.maxAccounts})`, used, 'overview'),
      tile('Scheduled posts', t.queued, 'queue'),
      tile('Drafts to approve', t.drafts, 'queue'),
      tile('Failed posts', t.failed, 'queue', true),
      tile('New mentions', t.mentions, 'inbox'),
      tile('Need reconnecting', t.reauth, 'overview', true)),
    h('p', { class: 'muted' }, `Each account may send up to ${overview.dailyPostCap} posts and replies per 24 hours.`),
    isAdmin() ? h('div', { class: 'card' },
      h('h2', {}, 'Add a client'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, nameInput),
        h('button', { onclick: action(async () => {
          await api('POST', '/api/clients', { name: nameInput.value });
          toast('Client added');
          renderOverview();
        }) }, 'Add'))) : null,
    h('div', { style: 'margin-bottom:12px' }, searchInput),
    list);
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
  const partsBox = h('div');
  const capNote = h('p', { class: 'muted' });
  let mediaIds = [...(post?.media ?? [])];
  const thumbs = h('div', { class: 'thumbs' });

  function addPart(text = '') {
    const ta = h('textarea', { placeholder: partsBox.children.length ? 'Next post in thread…' : "What's happening?" });
    ta.value = text;
    const counter = charCounter(ta);
    const wrap = h('div', { class: 'part' }, ta, h('div', { class: 'row' }, counter, h('span', { class: 'grow' }),
      h('button', { class: 'ghost', type: 'button', onclick: () => { if (partsBox.children.length > 1) wrap.remove(); } }, 'Remove')));
    partsBox.append(wrap);
    ta.focus();
  }
  const setParts = (parts) => { partsBox.replaceChildren(); parts.forEach(addPart); };
  setParts(post?.parts ?? ['']);

  function drawThumbs() {
    thumbs.replaceChildren(...mediaIds.map((mid) => h('div', { class: 'thumb' },
      h('img', { src: `/api/media/${encodeURIComponent(mid)}`, alt: 'Attached image' }),
      h('button', { class: 'ghost', type: 'button', title: 'Remove image', onclick: () => { mediaIds = mediaIds.filter((m) => m !== mid); drawThumbs(); } }, '×'))));
  }
  drawThumbs();
  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', multiple: true });
  fileInput.addEventListener('change', async () => {
    for (const file of fileInput.files) {
      if (mediaIds.length >= 4) { toast('Up to 4 images per post'); break; }
      try {
        const m = await api('POST', '/api/media', undefined, { raw: file, type: file.type });
        mediaIds.push(m.id);
      } catch (err) { toast(`${file.name}: ${err.message}`); }
    }
    fileInput.value = '';
    drawThumbs();
  });

  // When to publish
  const mode = post?.scheduled_at ? 'time' : 'now';
  const radio = (value, label) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'when', value, checked: value === mode }), label);
  const whenChoice = h('div', { class: 'choice' }, radio('now', 'As soon as approved'), radio('time', 'At a set time'), radio('slot', 'Next free posting slot'));
  const when = h('input', { type: 'datetime-local', value: post?.scheduled_at ? toLocalInput(post.scheduled_at) : '' });
  const whenWrap = h('div', {}, when);
  const syncWhen = () => { whenWrap.hidden = whenChoice.querySelector('input:checked').value !== 'time'; };
  whenChoice.addEventListener('change', syncWhen);
  syncWhen();

  const showCap = () => {
    const a = accs.find((x) => String(x.id) === acctSel.value);
    capNote.textContent = a ? `@${a.username} can send ${a.remaining_today} more posts in the next 24 hours · ${a.slots} posting slots (${a.timezone}).` : '';
  };
  acctSel.addEventListener('change', showCap);
  showCap();

  const payload = () => {
    const m = whenChoice.querySelector('input:checked').value;
    return {
      accountId: Number(acctSel.value),
      parts: [...partsBox.querySelectorAll('textarea')].map((t) => t.value),
      mediaIds,
      scheduledAt: m === 'slot' ? 'next-slot' : m === 'time' && when.value ? new Date(when.value).toISOString() : null,
    };
  };

  async function save(approve) {
    let saved;
    if (post) {
      saved = await api('PUT', `/api/posts/${post.id}`, payload());
      if (approve) saved = await api('POST', `/api/posts/${saved.id}/approve`, {});
    } else {
      saved = await api('POST', '/api/posts', { ...payload(), approve });
    }
    editing = null;
    toast(approve ? (saved.scheduled_at > Date.now() ? `Scheduled for ${fmt(saved.scheduled_at)}` : 'Publishing now') : `Draft saved${saved.scheduled_at ? ` for ${fmt(saved.scheduled_at)}` : ''}`);
    show('queue');
  }

  let aiBox = null;
  if (session.aiEnabled) {
    const brief = h('textarea', { placeholder: 'What should the post say? e.g. "Announce our weekend sale, 20% off all roasts, ends Sunday"' });
    const thread = h('input', { type: 'checkbox' });
    aiBox = h('div', { class: 'ai-box' },
      h('strong', {}, 'Draft with AI'),
      h('p', { class: 'muted' }, "Uses the account's brand voice. You can edit everything before saving."),
      brief,
      h('div', { class: 'row', style: 'margin-top:8px' }, h('label', { class: 'check' }, thread, 'Write a thread'), h('span', { class: 'grow' }),
        h('button', { class: 'ghost', onclick: action(async () => {
          const r = await api('POST', '/api/ai/post', { accountId: Number(acctSel.value), brief: brief.value, thread: thread.checked });
          setParts(r.parts);
          toast('Draft ready. Review it before saving.');
        }) }, 'Write draft')));
  }

  render(
    h('h1', {}, post ? `Edit post #${post.id}` : 'Compose'),
    h('div', { class: 'card' },
      h('label', {}, 'Account', acctSel),
      capNote,
      aiBox,
      partsBox,
      h('div', { class: 'row' },
        h('button', { class: 'ghost', type: 'button', onclick: () => addPart() }, '+ Add to thread'),
        h('label', { class: 'check', style: 'margin-left:8px' }, 'Images (up to 4, on the first post):', fileInput)),
      thumbs,
      h('h2', { style: 'margin-top:14px' }, 'When'),
      whenChoice, whenWrap,
      h('div', { class: 'row end', style: 'margin-top:12px' },
        post ? h('button', { class: 'ghost', onclick: () => { editing = null; show('queue'); } }, 'Cancel edit') : null,
        h('button', { class: isAdmin() ? 'ghost' : '', onclick: action(() => save(false)) }, 'Save draft'),
        isAdmin() ? h('button', { onclick: action(() => save(true)) }, 'Approve & schedule') : null)),
    h('p', { class: 'muted' }, isAdmin()
      ? 'X does not allow the same text on more than one account, so the panel blocks duplicates across accounts.'
      : 'Drafts go to an admin for approval before anything is posted.'));
}

// ---------- Queue ----------
let queueFilter = { status: '', clientId: '', accountId: '' };

async function renderQueue() {
  await loadOverview();
  const statusSel = h('select', {}, ['', 'draft', 'scheduled', 'posting', 'posted', 'failed', 'cancelled']
    .map((s) => h('option', { value: s, selected: s === queueFilter.status }, s || 'All statuses')));
  const clientSel = clientSelect(queueFilter.clientId);
  const acctSel = accountSelect(queueFilter.accountId, { includeAll: true });
  const reload = () => { queueFilter = { status: statusSel.value, clientId: clientSel.value, accountId: acctSel.value }; renderQueue(); };
  [statusSel, clientSel, acctSel].forEach((s) => s.addEventListener('change', reload));

  const list = await api('GET', `/api/posts?${query(queueFilter)}`);
  const selected = new Set();
  const bulkBar = h('div', { class: 'row notice', hidden: true });
  const updateBar = () => {
    bulkBar.hidden = !selected.size;
    bulkBar.replaceChildren(h('strong', { class: 'grow' }, `${selected.size} selected`),
      h('button', { onclick: action(() => bulk('approve')) }, 'Approve selected'),
      h('button', { class: 'danger', onclick: action(() => bulk('cancel')) }, 'Cancel selected'));
  };
  async function bulk(kind) {
    const results = await api('POST', '/api/posts/bulk', { ids: [...selected], action: kind });
    const failed = results.filter((r) => !r.ok);
    toast(failed.length ? `${results.length - failed.length} done; ${failed.length} skipped: ${failed[0].error}` : `${results.length} posts updated`);
    renderQueue();
  }
  const selectable = list.filter((p) => ['draft', 'scheduled', 'failed'].includes(p.status) && !p.tweet_ids.length);

  render(
    h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Queue'),
      h('button', { onclick: () => { editing = null; show('compose'); } }, 'New post')),
    h('div', { class: 'row', style: 'margin-bottom:12px' }, statusSel, clientSel, acctSel,
      isAdmin() && selectable.length ? h('button', { class: 'ghost', onclick: () => {
        const all = selected.size !== selectable.length;
        selected.clear();
        if (all) selectable.forEach((p) => selected.add(p.id));
        view.querySelectorAll('input[data-post]').forEach((cb) => { cb.checked = all; cb.closest('.card').classList.toggle('selected', all); });
        updateBar();
      } }, 'Select all') : null),
    bulkBar,
    list.length ? null : h('p', { class: 'muted' }, 'Nothing here.'),
    list.map((p) => {
      const canSelect = isAdmin() && selectable.includes(p);
      const cb = canSelect ? h('input', { type: 'checkbox', 'data-post': p.id, 'aria-label': `Select post ${p.id}` }) : null;
      const card = h('div', { class: 'card' },
        h('div', { class: 'row' }, cb,
          h('strong', {}, `@${p.username}`), badge(p.status),
          p.parts.length > 1 ? h('span', { class: 'badge' }, `thread · ${p.parts.length}`) : null,
          p.media.length ? h('span', { class: 'badge' }, `${p.media.length} image${p.media.length > 1 ? 's' : ''}`) : null,
          h('span', { class: 'grow' }),
          h('span', { class: 'muted' }, p.status === 'posted' ? `Posted ${fmt(p.posted_at)}` : p.scheduled_at ? `For ${fmt(p.scheduled_at)}` : 'No time set')),
        p.parts.map((t) => h('div', { class: 'post-text' }, t)),
        p.media.length ? h('div', { class: 'thumbs' }, p.media.map((mid) => h('div', { class: 'thumb' }, h('img', { src: `/api/media/${encodeURIComponent(mid)}`, alt: 'Attached image', loading: 'lazy' })))) : null,
        p.error ? h('p', { class: 'error' }, p.error) : null,
        h('div', { class: 'row end' },
          p.tweet_ids.length ? h('a', { href: postUrl(p.username, p.tweet_ids[0]), target: '_blank', rel: 'noopener' }, 'View on X') : null,
          ['draft', 'scheduled', 'failed'].includes(p.status) && !p.tweet_ids.length
            ? h('button', { class: 'ghost', onclick: () => { editing = p; show('compose'); } }, 'Edit') : null,
          isAdmin() && ['draft', 'failed'].includes(p.status) && !p.tweet_ids.length
            ? h('button', { onclick: action(async () => { await api('POST', `/api/posts/${p.id}/approve`, {}); toast('Approved'); renderQueue(); }) }, p.status === 'failed' ? 'Retry' : 'Approve') : null,
          isAdmin() && ['draft', 'scheduled', 'failed'].includes(p.status)
            ? h('button', { class: 'danger', onclick: action(async () => { await api('POST', `/api/posts/${p.id}/cancel`, {}); renderQueue(); }) }, 'Cancel') : null));
      cb?.addEventListener('change', () => {
        if (cb.checked) selected.add(p.id); else selected.delete(p.id);
        card.classList.toggle('selected', cb.checked);
        updateBar();
      });
      return card;
    }));
}

// ---------- Inbox ----------
let inboxFilter = { status: 'new', clientId: '', accountId: '' };

async function renderInbox() {
  await loadOverview();
  const [templates, mentions] = await Promise.all([api('GET', '/api/templates'), api('GET', `/api/mentions?${query(inboxFilter)}`)]);
  const statusSel = h('select', {}, ['new', 'replied', 'dismissed'].map((s) => h('option', { value: s, selected: s === inboxFilter.status }, s)));
  const clientSel = clientSelect(inboxFilter.clientId);
  const acctSel = accountSelect(inboxFilter.accountId, { includeAll: true });
  const reload = () => { inboxFilter = { status: statusSel.value, clientId: clientSel.value, accountId: acctSel.value }; renderInbox(); };
  [statusSel, clientSel, acctSel].forEach((s) => s.addEventListener('change', reload));

  render(
    h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Inbox'),
      h('button', { class: 'ghost', onclick: action(async () => {
        const r = await api('POST', '/api/mentions/poll', {});
        toast(`${r.fetched} new mentions`);
        renderInbox();
      }) }, 'Check now')),
    h('p', { class: 'muted' }, 'Mentions are checked automatically. Every reply is written or reviewed and sent by a person.'),
    h('div', { class: 'row', style: 'margin-bottom:12px' }, statusSel, clientSel, acctSel),
    mentions.length ? null : h('p', { class: 'muted' }, 'No mentions here.'),
    mentions.map((m) => {
      const who = m.author_username ? `@${m.author_username}` : `user ${m.author_id}`;
      const ta = h('textarea', { placeholder: `Reply as @${m.account_username}…` });
      const counter = charCounter(ta);
      const setText = (text) => { ta.value = text; ta.dispatchEvent(new Event('input')); };
      const tplSel = h('select', {}, h('option', { value: '' }, 'Insert template…'), templates.map((t) => h('option', { value: t.id }, t.name)));
      tplSel.addEventListener('change', () => {
        const t = templates.find((x) => String(x.id) === tplSel.value);
        if (t) setText(t.text.replaceAll('{{username}}', m.author_username ? `@${m.author_username}` : ''));
        tplSel.value = '';
      });
      const replyArea = m.from_managed
        ? h('p', { class: 'muted' }, 'This is from another account managed here. Accounts in the panel do not reply to each other.')
        : h('div', { style: 'margin-top:10px' }, ta,
          h('div', { class: 'row' }, counter, templates.length ? tplSel : null,
            session.aiEnabled ? h('button', { class: 'ghost', onclick: action(async () => {
              setText((await api('POST', '/api/ai/reply', { accountId: m.account_id, tweetId: m.tweet_id })).text);
            }) }, 'Suggest reply') : null,
            h('span', { class: 'grow' }),
            h('button', { class: 'ghost', onclick: action(async () => {
              await api('POST', `/api/mentions/${m.account_id}/${m.tweet_id}/dismiss`, {});
              renderInbox();
            }) }, 'Dismiss'),
            h('button', { onclick: action(async () => {
              await api('POST', `/api/mentions/${m.account_id}/${m.tweet_id}/reply`, { text: ta.value });
              toast('Reply sent');
              renderInbox();
            }) }, 'Send reply')));
      return h('div', { class: 'card' },
        h('div', { class: 'row' }, h('strong', {}, who), h('span', { class: 'muted' }, `→ @${m.account_username}`),
          h('span', { class: 'grow' }), h('span', { class: 'muted' }, fmt(m.created_at))),
        h('div', { class: 'post-text' }, m.text),
        h('a', { href: postUrl(m.author_username || 'i', m.tweet_id), target: '_blank', rel: 'noopener' }, 'Open on X'),
        m.status === 'new' ? replyArea
          : m.reply_tweet_id ? h('p', {}, h('a', { href: postUrl(m.account_username, m.reply_tweet_id), target: '_blank', rel: 'noopener' }, 'View reply')) : null);
    }));
}

// ---------- Schedules: posting slots, time zone, brand voice ----------
let scheduleAccount = null;
const fmtMinute = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
function parseTimes(text) {
  return text.split(/[,\s]+/).filter(Boolean).map((t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`"${t}" is not a time like 09:30`);
    return +m[1] * 60 + +m[2];
  });
}

async function renderSchedules() {
  await loadOverview();
  const accs = allAccounts();
  if (!accs.length) { render(h('h1', {}, 'Schedules'), h('p', { class: 'muted' }, 'Connect an account first.')); return; }
  if (!accs.some((a) => a.id === scheduleAccount)) scheduleAccount = accs[0].id;
  const acc = accs.find((a) => a.id === scheduleAccount);
  const settings = await api('GET', `/api/accounts/${acc.id}/settings`);
  const acctSel = accountSelect(acc.id);
  acctSel.addEventListener('change', () => { scheduleAccount = Number(acctSel.value); renderSchedules(); });

  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const tz = h('input', { value: settings.timezone, list: 'tz-list', disabled: !isAdmin() });
  const dayInputs = DAYS.map((_, d) => h('input', {
    placeholder: 'e.g. 09:00, 13:00, 17:30', disabled: !isAdmin(),
    value: settings.slots.filter((s) => s.weekday === d).map((s) => fmtMinute(s.minute)).join(', '),
  }));
  const voice = h('textarea', { placeholder: 'e.g. Friendly and plain-spoken. Short sentences. Never use slang or more than one emoji. Mention free shipping when relevant.', disabled: !isAdmin() });
  voice.value = settings.voice;

  const collect = () => ({
    timezone: tz.value.trim(),
    voice: voice.value,
    slots: dayInputs.flatMap((inp, weekday) => parseTimes(inp.value).map((minute) => ({ weekday, minute }))),
  });
  const clientAccounts = accs.filter((a) => a.client_id === acc.client_id);

  render(
    h('h1', {}, 'Schedules'),
    h('p', { class: 'muted' }, 'Posting slots are the times "Next free posting slot" and CSV rows marked "next" fill, in order. Times use the account\'s time zone.'),
    h('div', { class: 'card' },
      h('label', {}, 'Account', acctSel),
      h('label', {}, 'Time zone', tz, h('datalist', { id: 'tz-list' }, zones.map((z) => h('option', { value: z })))),
      h('div', { class: 'slot-grid' }, DAYS.map((d, i) => [h('span', {}, d), dayInputs[i]])),
      isAdmin() ? h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'ghost', type: 'button', onclick: () => { dayInputs.slice(2, 6).forEach((inp) => { inp.value = dayInputs[1].value; }); } }, 'Copy Monday to Tue–Fri'),
        h('button', { class: 'ghost', type: 'button', onclick: () => { dayInputs.forEach((inp) => { inp.value = dayInputs[1].value; }); } }, 'Copy Monday to every day')) : null,
      h('h2', { style: 'margin-top:16px' }, 'Brand voice'),
      h('p', { class: 'muted' }, session.aiEnabled ? 'Used when AI drafts posts and replies for this account.' : 'Notes for your team. Also used by AI drafting if you turn it on.'),
      voice,
      isAdmin() ? h('div', { class: 'row end', style: 'margin-top:12px' },
        clientAccounts.length > 1 ? h('button', { class: 'ghost', onclick: action(async () => {
          const { timezone, slots } = collect();
          if (!confirm(`Use these times and time zone for all ${clientAccounts.length} accounts of ${acc.client_name}? Brand voice is not copied.`)) return;
          for (const a of clientAccounts) await api('PUT', `/api/accounts/${a.id}/settings`, { timezone, slots });
          toast(`Applied to ${clientAccounts.length} accounts`);
        }) }, `Apply times to all of ${acc.client_name}`) : null,
        h('button', { onclick: action(async () => { await api('PUT', `/api/accounts/${acc.id}/settings`, collect()); toast('Saved'); }) }, 'Save')) : null));
}

// ---------- Bulk import ----------
const SAMPLE_CSV = 'account,text,scheduled_at\n@yourbrand,"Weekend sale starts now: 20% off everything.",next\n@yourbrand,"New in: our autumn menu\n---\nPumpkin spice is back, plus two new seasonal roasts.",2026-11-02 09:00\n';

async function renderImport() {
  await loadOverview();
  const ta = h('textarea', { style: 'min-height:200px;font-family:ui-monospace,monospace;font-size:13px', placeholder: SAMPLE_CSV });
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  file.addEventListener('change', async () => { if (file.files[0]) ta.value = await file.files[0].text(); });
  const approve = h('input', { type: 'checkbox' });
  const result = h('div');
  const sampleHref = `data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE_CSV)}`;

  render(
    h('h1', {}, 'Bulk import'),
    h('div', { class: 'card' },
      h('p', {}, 'Upload or paste a CSV with the columns ', h('code', {}, 'account'), ', ', h('code', {}, 'text'), ' and ', h('code', {}, 'scheduled_at'), '.'),
      h('ul', { class: 'muted' },
        h('li', {}, 'account: the X handle, with or without @'),
        h('li', {}, 'text: the post. For a thread, put a line with only --- between posts (inside quotes)'),
        h('li', {}, 'scheduled_at: "2026-11-02 09:00" in the account\'s time zone, "next" for the next free posting slot, or empty for an unscheduled draft')),
      h('p', {}, h('a', { href: sampleHref, download: 'xpanel-sample.csv' }, 'Download a sample file')),
      h('div', { style: 'margin-bottom:10px' }, file),
      ta,
      h('div', { class: 'row', style: 'margin-top:10px' },
        isAdmin() ? h('label', { class: 'check' }, approve, 'Approve straight into the queue') : h('span', { class: 'muted' }, 'Imported posts arrive as drafts for an admin to approve.'),
        h('span', { class: 'grow' }),
        h('button', { onclick: action(async () => {
          const r = await api('POST', '/api/posts/import', { csv: ta.value, approve: approve.checked });
          result.replaceChildren(h('div', { class: 'card' },
            h('h2', {}, `${r.created} post${r.created === 1 ? '' : 's'} imported${r.errors.length ? `, ${r.errors.length} skipped` : ''}`),
            r.errors.length ? h('ul', {}, r.errors.map((e) => h('li', { class: 'error' }, `Line ${e.line}: ${e.error}`))) : null,
            h('button', { class: 'ghost', onclick: () => show('queue') }, 'Open the queue')));
        }) }, 'Import'))),
    result);
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
let analyticsClient = '';

async function renderAnalytics(data) {
  await loadOverview();
  data ??= await api('GET', `/api/analytics?${query({ clientId: analyticsClient })}`);
  const clientSel = clientSelect(analyticsClient);
  clientSel.addEventListener('change', () => { analyticsClient = clientSel.value; renderAnalytics(); });
  const totals = data.perAccount.reduce((t, r) => ({
    sent: t.sent + r.sent_30d, impressions: t.impressions + r.impressions, engagements: t.engagements + r.likes + r.retweets + r.replies + r.quotes,
  }), { sent: 0, impressions: 0, engagements: 0 });
  render(
    h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Analytics'),
      clientSel,
      h('a', { class: 'button-link', href: `/api/analytics.csv?${query({ clientId: analyticsClient })}`, download: '' }, 'Download CSV report'),
      h('button', { class: 'ghost', onclick: action(async () => renderAnalytics(await api('POST', '/api/analytics/refresh', { clientId: analyticsClient || undefined }))) }, 'Refresh from X')),
    h('p', { class: 'muted' }, 'Posts and replies sent from this panel in the last 30 days.'),
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('div', { class: 'value' }, num(totals.sent)), h('div', { class: 'label' }, 'Posts & replies sent')),
      h('div', { class: 'tile' }, h('div', { class: 'value' }, num(totals.impressions)), h('div', { class: 'label' }, 'Impressions')),
      h('div', { class: 'tile' }, h('div', { class: 'value' }, num(totals.engagements)), h('div', { class: 'label' }, 'Engagements'))),
    h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Client'), h('th', {}, 'Account'),
        ['Sent', 'Impressions', 'Likes', 'Reposts', 'Replies', 'Quotes'].map((c) => h('th', { class: 'num' }, c)))),
      h('tbody', {}, data.perAccount.map((r) => h('tr', {}, h('td', {}, r.client_name), h('td', {}, `@${r.username}`),
        [r.sent_30d, r.impressions, r.likes, r.retweets, r.replies, r.quotes].map((v) => h('td', { class: 'num' }, num(v)))))))),
    h('h2', {}, 'Top posts'),
    data.topPosts.length ? h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Post'), h('th', {}, 'Account'), ['Likes', 'Reposts', 'Replies'].map((c) => h('th', { class: 'num' }, c)))),
      h('tbody', {}, data.topPosts.map((p) => h('tr', {},
        h('td', {}, h('a', { href: postUrl(p.username, p.tweet_id), target: '_blank', rel: 'noopener' }, (p.text || 'View post').slice(0, 80))),
        h('td', {}, `@${p.username}`), [p.likes, p.retweets, p.replies].map((v) => h('td', { class: 'num' }, num(v))))))))
      : h('p', { class: 'muted' }, 'No data yet.'));
}

// ---------- Team ----------
async function renderTeam() {
  const me = session.user;
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  const ownPassword = h('div', { class: 'card' },
    h('h2', {}, 'Your password'),
    isAdmin() ? null : h('label', {}, 'Current password', current),
    h('label', {}, 'New password (8+ characters)', next),
    h('div', { class: 'row end' }, h('button', { onclick: action(async () => {
      await api('PUT', `/api/users/${me.id}`, { password: next.value, currentPassword: current.value });
      current.value = ''; next.value = '';
      toast('Password changed');
    }) }, 'Change password')));

  if (!isAdmin()) {
    render(h('h1', {}, 'Team'), h('p', { class: 'muted' }, `Signed in as ${me.username} (editor). Admins manage the team.`), ownPassword);
    return;
  }
  const users = await api('GET', '/api/users');
  const uname = h('input', { placeholder: 'e.g. sam', autocomplete: 'off' });
  const upass = h('input', { type: 'password', autocomplete: 'new-password' });
  const urole = h('select', {}, h('option', { value: 'editor' }, 'Editor: drafts, replies, imports drafts'), h('option', { value: 'admin' }, 'Admin: also approves, connects accounts, manages team'));
  render(
    h('h1', {}, 'Team'),
    h('div', { class: 'card' },
      h('h2', {}, 'Add a team member'),
      h('label', {}, 'Username', uname),
      h('label', {}, 'Temporary password (8+ characters)', upass),
      h('label', {}, 'Role', urole),
      h('div', { class: 'row end' }, h('button', { onclick: action(async () => {
        await api('POST', '/api/users', { username: uname.value, password: upass.value, role: urole.value });
        toast('Team member added');
        renderTeam();
      }) }, 'Add'))),
    h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'User'), h('th', {}, 'Role'), h('th', {}, 'Added'), h('th', {}, ''))),
      h('tbody', {}, users.map((u) => {
        const role = h('select', { disabled: u.id === me.id }, ['admin', 'editor'].map((r) => h('option', { value: r, selected: r === u.role }, r)));
        role.addEventListener('change', async () => {
          try { await api('PUT', `/api/users/${u.id}`, { role: role.value }); toast('Role updated'); } catch (err) { toast(err.message); role.value = u.role; }
        });
        return h('tr', {}, h('td', {}, u.username, u.id === me.id ? ' (you)' : ''), h('td', {}, role), h('td', {}, fmt(u.created_at)),
          h('td', { class: 'num' }, u.id === me.id ? null : h('div', { class: 'row end' },
            h('button', { class: 'ghost', onclick: action(async () => {
              const pw = prompt(`New password for ${u.username} (8+ characters)`);
              if (!pw) return;
              await api('PUT', `/api/users/${u.id}`, { password: pw });
              toast('Password reset');
            }) }, 'Reset password'),
            h('button', { class: 'danger', onclick: action(async () => {
              if (!confirm(`Remove ${u.username}?`)) return;
              await api('DELETE', `/api/users/${u.id}`, {});
              renderTeam();
            }) }, 'Remove'))));
      })))),
    ownPassword);
}

// ---------- Activity ----------
async function renderActivity() {
  const rows = await api('GET', '/api/activity');
  render(h('h1', {}, 'Activity log'),
    h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'Action'), h('th', {}, 'Detail'))),
      h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, fmt(r.at)), h('td', {}, r.user ?? ''), h('td', {}, r.action), h('td', {}, r.detail ?? '')))))));
}

// ---------- shell ----------
const TABS = { overview: renderOverview, compose: renderCompose, queue: renderQueue, inbox: renderInbox, schedules: renderSchedules,
  import: renderImport, templates: renderTemplates, analytics: renderAnalytics, team: renderTeam, activity: renderActivity };

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
  session = await api('GET', '/api/session');
  if (!session.authenticated) return showLogin();
  $('#login').hidden = true;
  $('#shell').hidden = false;
  $('#whoami').textContent = `${session.user.username} · ${session.user.role}`;
  show(location.hash.slice(1));
}

document.querySelectorAll('.sidebar [data-tab]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab === 'compose') editing = null;
  show(b.dataset.tab);
}));
$('#logout').addEventListener('click', async () => { await api('POST', '/api/logout', {}); showLogin(); });
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api('POST', '/api/login', { username: form.get('username'), password: form.get('password') });
    $('#login-error').textContent = '';
    start();
  } catch (err) { $('#login-error').textContent = err.message; }
});

start();
