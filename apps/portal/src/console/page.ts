/*
 * The vendor's console: one page, its own script, no framework and nothing
 * fetched from anywhere but this portal.
 *
 * Everything shown came from a till, and a till's first report is trusted on
 * first use only (`health/store.ts`), so nothing from a report is ever put in
 * the page as HTML: every value goes in as a text node. The session token is
 * kept in sessionStorage, which closes with the tab.
 */

export const CONSOLE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ShopOS console</title>
<style>
  :root { --ink: #1d232b; --ink-2: #5a6472; --rule: #d9dde3; --bg: #f6f7f9; --card: #fff;
          --p1: #b3261e; --p2: #9a5b00; --p3: #44607a; --ok: #2e7d4f; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e6e9ee; --ink-2: #9aa4b2; --rule: #333a44; --bg: #15191e; --card: #1d2229;
            --p1: #ff8a80; --p2: #ffb74d; --p3: #90b4d6; --ok: #81c995; }
  }
  * { box-sizing: border-box; border-radius: 0; }
  body { margin: 0; font: 14px/1.45 system-ui, sans-serif; color: var(--ink); background: var(--bg); }
  header { display: flex; gap: 16px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--rule); background: var(--card); }
  header h1 { font-size: 16px; margin: 0; flex: 1; }
  main { padding: 16px; max-width: 1200px; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; background: var(--card); }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { font-size: 12px; color: var(--ink-2); font-weight: 600; }
  tr.link { cursor: pointer; } tr.link:hover td { background: var(--bg); }
  .num { font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
  .P1 { color: var(--p1); font-weight: 600; } .P2 { color: var(--p2); font-weight: 600; } .P3 { color: var(--p3); }
  .ok { color: var(--ok); } .muted { color: var(--ink-2); }
  .card { background: var(--card); border: 1px solid var(--rule); padding: 12px 14px; margin: 0 0 14px; }
  .card h2 { font-size: 14px; margin: 0 0 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 6px 18px; }
  input, button { font: inherit; padding: 6px 10px; border: 1px solid var(--rule); background: var(--card); color: var(--ink); }
  button { cursor: pointer; } button.primary { background: var(--ink); color: var(--bg); }
  pre { background: var(--card); border: 1px solid var(--rule); padding: 12px; overflow: auto; font-size: 12px; }
  .alerts li { margin: 3px 0; } .alerts { padding-left: 18px; margin: 0; }
  .wrap { overflow-x: auto; }
</style>
</head>
<body>
<header><h1>ShopOS console</h1><span id="who" class="muted"></span><button id="out" hidden>Sign out</button></header>
<main id="main"></main>
<script>
"use strict";
const main = document.getElementById('main');
let token = null;
try { token = sessionStorage.getItem('console_token'); } catch (e) {}

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false)
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return node;
}
function show(...nodes) { main.replaceChildren(...nodes); }
function ago(iso) {
  if (!iso) return 'never';
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  return h < 1 ? Math.max(1, Math.round(h * 60)) + ' min ago' : h < 48 ? Math.round(h) + ' h ago' : Math.round(h / 24) + ' days ago';
}
async function api(path, opts) {
  const res = await fetch(path, { ...(opts || {}), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
  if (res.status === 401 && path.startsWith('/v1/console/')) { signOut(); throw new Error('Signed out.'); }
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error((body && (body.detail || body.error)) || ('HTTP ' + res.status));
  return body;
}
function signOut() {
  if (token) fetch('/v1/auth/sign-out', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
  token = null; try { sessionStorage.removeItem('console_token'); } catch (e) {}
  document.getElementById('out').hidden = true; document.getElementById('who').textContent = '';
  signIn();
}
document.getElementById('out').addEventListener('click', signOut);

function signIn() {
  const phone = el('input', { placeholder: '+91 98765 43210', autocomplete: 'tel' });
  const note = el('p', { class: 'muted' }, 'Sign in with the phone listed in SHOPOS_VENDOR_PHONES.');
  const form = el('form', { class: 'card', on: { submit: async (e) => {
    e.preventDefault();
    try {
      const started = await api('/v1/auth/start', { method: 'POST', body: JSON.stringify({ phone: phone.value }) });
      const code = el('input', { placeholder: 'Code', inputmode: 'numeric', autocomplete: 'one-time-code' });
      const hint = started.devCode ? el('p', { class: 'muted' }, 'Development code: ' + started.devCode) : null;
      show(el('form', { class: 'card', on: { submit: async (e2) => {
        e2.preventDefault();
        try {
          const done = await api('/v1/auth/verify', { method: 'POST', body: JSON.stringify({ challengeId: started.challengeId, code: code.value }) });
          token = done.token; try { sessionStorage.setItem('console_token', token); } catch (e) {}
          fleet();
        } catch (err) { show(el('p', { class: 'P1' }, err.message)); setTimeout(signIn, 2000); }
      } } }, el('h2', {}, 'Code sent by ' + started.channel), hint, code, ' ', el('button', { class: 'primary' }, 'Sign in')));
    } catch (err) { note.textContent = err.message; note.className = 'P1'; }
  } } }, el('h2', {}, 'Sign in'), phone, ' ', el('button', { class: 'primary' }, 'Send code'), note);
  show(form);
}

function alertList(alerts, names) {
  if (alerts.length === 0) return el('p', { class: 'ok' }, 'Nothing to look at.');
  return el('ul', { class: 'alerts' }, alerts.map((a) => el('li', {},
    el('span', { class: a.severity }, a.severity), ' ',
    names ? (names.get(a.shopId) || 'Shop') + ' (' + a.shopId.slice(0, 8) + ') ' : '',
    el('span', { class: 'muted' }, a.deviceId ? 'till ' + a.deviceId.slice(0, 8) + ': ' : 'shop: '), a.text)));
}

async function fleet() {
  let data;
  try { data = await api('/v1/console/fleet'); } catch (err) { if (token) show(el('p', { class: 'P1' }, err.message)); return; }
  document.getElementById('out').hidden = false;
  document.getElementById('who').textContent = 'signed in as ' + data.role;
  const names = new Map(data.shops.map((s) => [s.shopId, s.shopName]));
  const find = el('input', { placeholder: 'Support code or shop name', 'aria-label': 'Find a shop' });
  const body = el('tbody');
  const fill = () => {
    const q = find.value.replace(/\\s/g, '').toLowerCase();
    body.replaceChildren(...data.shops
      .filter((s) => !q || s.shopId.replace(/[^0-9a-z]/gi, '').toLowerCase().startsWith(q) || (s.shopName || '').toLowerCase().includes(q))
      .map((s) => el('tr', { class: 'link', on: { click: () => shop(s.shopId) } },
        el('td', {}, s.shopName || 'Shop'),
        el('td', { class: 'num' }, s.shopId.slice(0, 4) + ' ' + s.shopId.slice(4, 8)),
        el('td', { class: 'num' }, s.tills.length),
        el('td', { class: 'num' }, [...new Set(s.tills.map((t) => t.version))].join(', ')),
        el('td', {}, ago(s.tills.map((t) => t.receivedAt).sort().pop())),
        el('td', {}, ['P1', 'P2', 'P3'].filter((p) => s.alerts[p]).map((p) => el('span', { class: p }, s.alerts[p] + ' ' + p + ' ')))))); };
  find.addEventListener('input', fill);
  fill();
  const urgent = data.alerts.filter((a) => a.severity !== 'P3');
  let rel = { releases: [], switches: null };
  try { rel = await api('/v1/console/releases'); } catch (err) {}
  const releases = el('div', { class: 'card' }, el('h2', {}, 'Releases'),
    rel.releases.length === 0 ? el('p', { class: 'muted' }, 'No reports yet.') : el('div', { class: 'wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Version', 'Tills', 'Runs', 'Crashed', 'Ended without closing', 'Crash-free'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rel.releases.map((r) => el('tr', {},
        el('td', { class: 'num' }, r.version), el('td', { class: 'num' }, r.tills), el('td', { class: 'num' }, r.started),
        el('td', { class: 'num' + (r.panicked ? ' P2' : '') }, r.panicked), el('td', { class: 'num' }, r.unclean),
        el('td', { class: 'num' }, r.crashFree === null ? '-' : (100 * r.crashFree).toFixed(1) + '%')))))),
    el('p', { class: 'muted' }, rel.switches ? 'Switch board out since ' + rel.switches.issuedAt + ': ' + switchesSaid(rel.switches.token) : 'No switch board: every feature is on.'));
  show(
    el('div', { class: 'card' }, el('h2', {}, 'To look at (' + urgent.length + ')'), alertList(urgent, names)),
    releases,
    el('p', {}, find, ' ', el('span', { class: 'muted' }, data.shops.length + ' shop(s)')),
    el('div', { class: 'wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Shop', 'Code', 'Tills', 'Version', 'Last report', 'Alerts'].map((h) => el('th', {}, h)))), body)),
  );
}

/* What a board switches off, read without checking it: the tills check it. */
function switchesSaid(token) {
  try {
    const b = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    return b.off.length === 0 ? 'everything on.' : b.off.map((o) => o.feature + (o.shops ? ' at ' + o.shops.join(', ') : ' everywhere') + (o.until ? ' until ' + o.until.slice(0, 10) : '')).join('; ');
  } catch (e) { return 'unreadable.'; }
}

function fact(label, value, cls) {
  return el('div', {}, el('span', { class: 'muted' }, label + ': '), el('span', { class: cls || '' }, value));
}

async function shop(shopId) {
  let data;
  try { data = await api('/v1/console/shops/' + encodeURIComponent(shopId)); } catch (err) { show(el('p', { class: 'P1' }, err.message)); return; }
  const back = el('button', { on: { click: fleet } }, '← All shops');
  const tills = data.tills.map((t) => {
    const s = t.summary;
    const runs = s.runs ? s.runs.started + ' runs, ' + s.runs.panicked + ' crashed, ' + s.runs.unclean + ' ended without closing' : 'unknown';
    const history = el('table', {}, el('thead', {}, el('tr', {}, ['Received', 'Version', 'Runs', 'Errors', 'Set aside', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, t.history.map((h) => el('tr', {},
        el('td', {}, ago(h.receivedAt)), el('td', { class: 'num' }, h.summary.version || '?'),
        el('td', { class: 'num' }, h.summary.runs ? h.summary.runs.started + ' / ' + h.summary.runs.panicked + ' / ' + h.summary.runs.unclean : '?'),
        el('td', { class: 'num' }, h.summary.errorKinds), el('td', { class: 'num' }, h.summary.setAsideWaiting),
        el('td', {}, el('button', { on: { click: () => openReport(h.id, shopId) } }, 'Open'))))));
    const forget = el('button', { on: { click: async () => {
      if (!confirm('Forget this till\\'s key? Its next report will be taken as its first.')) return;
      try { await api('/v1/console/shops/' + encodeURIComponent(shopId) + '/tills/' + encodeURIComponent(t.deviceId) + '/forget-key', { method: 'POST' }); forget.textContent = 'Forgotten'; }
      catch (err) { forget.textContent = err.message; }
    } } }, 'Forget key');
    return el('div', { class: 'card' },
      el('h2', {}, 'Till ' + t.deviceId.slice(0, 8) + ' · ' + (s.version || '?') + ' · ' + ago(t.receivedAt)),
      el('div', { class: 'grid' },
        fact('Integrity', s.integrityOk === null ? 'unknown' : s.integrityOk ? 'ok' : 'FAILED', s.integrityOk === false ? 'P1' : ''),
        fact('Bills without books', s.booksMissing ?? 'unknown', s.booksMissing ? 'P1' : ''),
        fact('Set aside', s.setAsideWaiting, s.setAsideWaiting ? 'P2' : ''),
        fact('Needs Attention', s.discrepancyKinds.join(', ') || 'nothing'),
        fact('Licence', s.licence ? (s.licence.problem || s.licence.state) + (s.licence.paidThrough ? ' to ' + s.licence.paidThrough : '') : 'unknown'),
        fact('Runs', runs, s.runs && s.runs.panicked ? 'P2' : ''),
        fact('Kinds of error', s.errorKinds),
        fact('Schema', s.schemaVersion ?? 'unknown'),
        ...s.peers.map((p) => fact('Agreed with ' + (p.label || p.deviceId.slice(0, 8)), ago(p.lastAgreedAt) + (p.lastError ? ' — ' + p.lastError : ''), p.lastError ? 'P2' : ''))),
      el('details', {}, el('summary', {}, 'History'), el('div', { class: 'wrap' }, history)),
      el('p', {}, forget));
  });
  const uploads = el('div', { class: 'card' }, el('h2', {}, 'Data sent to support'),
    data.data.length === 0 ? el('p', { class: 'muted' }, 'None.') : el('table', {},
      el('thead', {}, el('tr', {}, ['Sent', 'Size', 'Customers', 'Note', 'Deleted', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, data.data.map((u) => el('tr', {},
        el('td', {}, ago(u.createdAt)),
        el('td', { class: 'num' }, (u.bytes / 1048576).toFixed(1) + ' MB' + (u.completedAt ? '' : ' (' + Math.round(100 * u.received / u.bytes) + '% arrived)')),
        el('td', {}, u.anonymised ? 'left out' : 'included'),
        el('td', {}, u.note || ''),
        el('td', {}, u.deletedAt ? ago(u.deletedAt) : 'on ' + u.deleteAfter.slice(0, 10)),
        el('td', {}, u.completedAt && !u.deletedAt ? el('button', { on: { click: () => download(u.id) } }, 'Download') : ''))))));
  const log = el('details', {}, el('summary', {}, 'Support log'),
    el('ul', {}, data.log.map((l) => el('li', {}, ago(l.at) + ' · ' + l.action + (l.detail ? ' · ' + l.detail : '')))));
  show(back,
    el('h2', {}, (data.shopName || 'Shop') + ' · ' + shopId.slice(0, 4) + ' ' + shopId.slice(4, 8)),
    el('div', { class: 'card' }, el('h2', {}, 'Alerts'), alertList(data.alerts, null)),
    ...tills, uploads, el('div', { class: 'card' }, log));
}

/* Ciphertext: it opens only with the vendor's private key, in tools/support. */
async function download(id) {
  const res = await fetch('/v1/console/data/' + id, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) { alert('Could not download: HTTP ' + res.status); return; }
  const url = URL.createObjectURL(await res.blob());
  const a = el('a', { href: url, download: 'shopos-data-' + id.slice(0, 8) + '.sod' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function openReport(id, shopId) {
  try {
    const body = await api('/v1/console/reports/' + id);
    show(el('button', { on: { click: () => shop(shopId) } }, '← Back'), el('pre', {}, JSON.stringify(body, null, 2)));
  } catch (err) { show(el('p', { class: 'P1' }, err.message)); }
}

if (token) fleet(); else signIn();
</script>
</body>
</html>
`
