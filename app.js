/* ══════════════════════ JiraPulse · app logic ══════════════════════ */
'use strict';

/* ── helpers ─────────────────────────────────────────────────────── */
const $ = (s) => document.querySelector(s);
const DAY = 86400000;
const LS_CONN = 'jp_conn_v1';
const LS_LAST_BOARD = 'jp_last_board_v1';
const PROXY = 'https://corsproxy.io/?url=';

const state = {
  conn: null,          // { domain, email, token, useProxy }
  boards: [],
  boardId: null,
  issues: [],
  charts: {},
  usedProxy: false,
};

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer = null;
function toast(msg, type = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (type === 'ok' ? ' toast-ok' : type === 'err' ? ' toast-err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(t), 4200);
}

function fmtDuration(ms) {
  if (!isFinite(ms) || ms < 0) return '—';
  const mins = ms / 60000;
  if (mins < 60) return Math.round(mins) + 'm';
  const hours = mins / 60;
  if (hours < 48) return Math.round(hours) + 'h';
  const days = hours / 24;
  if (days < 75) return (Math.round(days * 10) / 10) + 'd';
  return '~' + (Math.round(days / 30.4 * 10) / 10) + 'mo';
}

function fmtDays(ms) {
  if (!isFinite(ms)) return '—';
  return (Math.round(ms / DAY * 10) / 10) + 'd';
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ── connection / API layer ──────────────────────────────────────── */
function normalizeDomain(raw) {
  let v = String(raw || '').trim().toLowerCase();
  if (!v) throw new Error('Please enter your Jira site address.');
  v = v.replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/')[0];
  if (!v.includes('.')) throw new Error('That doesn\'t look like a valid site address (e.g. yourcompany.atlassian.net).');
  return 'https://' + v;
}

async function api(path) {
  const c = state.conn;
  if (!c) throw new Error('Not connected.');
  const url = c.domain + path;
  const headers = {
    'Authorization': 'Basic ' + btoa(c.email + ':' + c.token),
    'Accept': 'application/json',
  };

  const attempts = [];
  let viaProxy = false;
  if (c.useProxy) attempts.push(PROXY + encodeURIComponent(url));
  else { attempts.push(url); attempts.push(PROXY + encodeURIComponent(url)); }

  let lastErr = null;
  for (const target of attempts) {
    try {
      const res = await fetch(target, { method: 'GET', headers });
      viaProxy = target !== url;
      let body = null;
      const text = await res.text();
      try { body = JSON.parse(text); } catch (_) { /* non-json */ }
      if (!res.ok) {
        const jiraMsg = body && (body.errorMessages?.join('; ') || body.message);
        const err = new Error(jiraMsg || `Jira responded with HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      state.usedProxy = viaProxy;
      updateProxyBadge();
      return body;
    } catch (err) {
      lastErr = err;
      // HTTP errors from Jira itself are real answers — don't retry through proxy
      if (err.status) throw err;
      // network / CORS failure → try next attempt
    }
  }
  const e = new Error(
    `Could not reach ${c.domain} (${lastErr?.message || 'network error'}). ` +
    `If this is a CORS block by the browser, open Settings and enable "Route requests via CORS proxy".`
  );
  throw e;
}

async function fetchPaginated(basePath, cap = 500) {
  let startAt = 0;
  const out = [];
  while (true) {
    const sep = basePath.includes('?') ? '&' : '?';
    const page = await api(`${basePath}${sep}startAt=${startAt}&maxResults=100`);
    const vals = page.values || [];
    out.push(...vals);
    const total = typeof page.total === 'number' ? page.total : null;
    if (!vals.length) break;
    if (total !== null && startAt + vals.length >= total) break;
    if (out.length >= cap) break;
    startAt += vals.length;
  }
  return out.slice(0, cap);
}

/* ── persistence ─────────────────────────────────────────────────── */
function saveConn() { localStorage.setItem(LS_CONN, JSON.stringify(state.conn)); }
function loadConn() {
  try {
    const raw = localStorage.getItem(LS_CONN);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c.domain || !c.email || !c.token) return null;
    return c;
  } catch (_) { return null; }
}
function clearConn() { localStorage.removeItem(LS_CONN); localStorage.removeItem(LS_LAST_BOARD); }

/* ── screens ─────────────────────────────────────────────────────── */
function showSetup() {
  show($('#setupScreen')); hide($('#boardsScreen')); hide($('#dashScreen')); hide($('#topbar'));
}

function enterApp() {
  hide($('#setupScreen'));
  show($('#topbar'));
  $('#setDomain').value = state.conn.domain.replace(/^https?:\/\//, '');
  $('#setEmail').value = state.conn.email;
  $('#setToken').value = '';
  $('#proxyToggle').checked = !!state.conn.useProxy;
  goBoards();
}

function goBoards() {
  hide($('#dashScreen')); show($('#boardsScreen'));
  $('#boardSelect').innerHTML = '<option value="">Loading boards…</option>';
  loadBoards().catch((e) => handleAuthError(e));
}

function handleAuthError(e) {
  if (e && (e.status === 401 || e.status === 403)) {
    clearConn(); state.conn = null;
    showSetup();
    toast('Session rejected by Jira (' + e.status + '). Please reconnect with a fresh API token.', 'err');
  } else {
    toast(e?.message || 'Something went wrong.', 'err');
  }
}

/* ── connect flow ────────────────────────────────────────────────── */
async function connect(domainRaw, email, token) {
  const domain = normalizeDomain(domainRaw);
  if (!email.trim()) throw new Error('Email is required.');
  if (!token.trim()) throw new Error('API token is required.');
  state.conn = { domain, email: email.trim(), token: token.trim(), useProxy: false };
  state.usedProxy = false;
  await api('/rest/api/3/myself'); // auth check
  saveConn();
  enterApp();
  toast('Connected to ' + domain.replace('https://', '') + ' 🎉', 'ok');
}

/* ── boards ──────────────────────────────────────────────────────── */
async function loadBoards() {
  const grid = $('#boardsGrid');
  const btn = $('#syncBoardsBtn');
  btn.disabled = true;
  show($('#boardsLoading')); hide($('#boardsEmpty'));
  grid.innerHTML = '';
  try {
    const boards = await fetchPaginated('/rest/agile/1.0/board', 250);
    boards.sort((a, b) => (a.location?.projectName || a.name).localeCompare(b.location?.projectName || b.name));
    state.boards = boards;

    // dropdown
    const sel = $('#boardSelect');
    sel.innerHTML = boards.length
      ? boards.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')
      : '<option value="">No boards found</option>';

    renderBoardCards();

    if (!boards.length) { show($('#boardsEmpty')); return; }

    // auto-open last viewed board
    const lastId = parseInt(localStorage.getItem(LS_LAST_BOARD), 10);
    const last = boards.find((b) => b.id === lastId);
    if (last) { sel.value = String(last.id); selectBoard(last); }
  } finally {
    btn.disabled = false;
    hide($('#boardsLoading'));
  }
}

function boardTypeClass(t) {
  if (t === 'scrum') return 'chip chip-scrum';
  if (t === 'simple') return 'chip chip-simple';
  return 'chip';
}

function renderBoardCards() {
  const grid = $('#boardsGrid');
  grid.innerHTML = state.boards.map((b, i) => `
    <div class="board-card glass" data-id="${b.id}" style="animation-delay:${Math.min(i * 35, 400)}ms">
      <h3>${escapeHtml(b.name)}</h3>
      <div class="board-meta">
        ${b.type ? `<span class="${boardTypeClass(b.type)}">${escapeHtml(b.type)} board</span>` : ''}
        ${b.location?.projectKey ? `<span class="chip">${escapeHtml(b.location.projectKey)}</span>` : ''}
      </div>
      ${b.location?.projectName ? `<div class="muted small" style="margin-bottom:12px">Project · ${escapeHtml(b.location.projectName)}</div>` : '<div style="height:24px"></div>'}
      <span class="board-open">Open dashboard →</span>
    </div>`).join('');
  grid.querySelectorAll('.board-card').forEach((card) => {
    card.addEventListener('click', () => {
      const b = state.boards.find((x) => x.id === parseInt(card.dataset.id, 10));
      if (b) { $('#boardSelect').value = String(b.id); selectBoard(b); }
    });
  });
}

/* ── dashboard ───────────────────────────────────────────────────── */
async function selectBoard(board) {
  state.boardId = board.id;
  localStorage.setItem(LS_LAST_BOARD, String(board.id));
  hide($('#boardsScreen')); show($('#dashScreen'));
  hide($('#errorBanner'));

  $('#dashBoardName').textContent = board.name;
  $('#issueCountBadge').textContent = 'syncing…';
  $('#syncedAt').textContent = '';
  ['kpiTotal', 'kpiCreated', 'kpiDone', 'kpiResolved', 'kpiCycle', 'kpiWip'].forEach((id) => ($('#' + id).textContent = '…'));
  $('#slowTableBody').innerHTML = '';
  Object.values(state.charts).forEach((ch) => ch && ch.destroy());
  state.charts = {};

  try {
    const issues = await fetchPaginated(`/rest/agile/1.0/board/${board.id}/issue?expand=changelog`, 600);
    state.issues = issues;
    const m = computeMetrics(issues);
    renderDashboard(board, m);
    $('#syncedAt').textContent = 'updated ' + new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    $('#issueCountBadge').textContent = 'failed';
    const banner = $('#errorBanner');
    banner.textContent = '⚠️ ' + (e?.message || 'Failed to load board issues.');
    show(banner);
    if (!e?.status) handleAuthError(e);
  }
}

function addTime(map, name, ms) {
  if (!name || !isFinite(ms)) return;
  const rec = map.get(name) || { sum: 0, n: 0 };
  rec.sum += ms; rec.n += 1;
  map.set(name, rec);
}

function computeMetrics(issues) {
  const NOW = Date.now();
  const m = {
    total: issues.length,
    created30: 0, resolved30: 0, done: 0, wip: 0,
    cycles: [],
    statusDist: new Map(),
    statusTime: new Map(),
    slow: [],
    dailyCreated: Array(30).fill(0),
    dailyResolved: Array(30).fill(0),
    weekly: Array.from({ length: 12 }, (_, i) => ({
      count: 0,
      label: fmtDate(NOW - (11 - i) * 7 * DAY),
    })),
  };

  for (const iss of issues) {
    const f = iss.fields || {};
    const created = f.created ? Date.parse(f.created) : null;
    const resolved = f.resolutiondate ? Date.parse(f.resolutiondate) : null;
    const statusName = f.status?.name || 'Unknown';
    const doneCat = f.status?.statusCategory?.key === 'done'
      || String(f.status?.statusCategory?.name || '').toLowerCase() === 'done';

    if (created && NOW - created < 30 * DAY) {
      m.created30++;
      m.dailyCreated[Math.max(0, 29 - Math.floor((NOW - created) / DAY))]++;
    }
    if (resolved) {
      if (NOW - resolved < 30 * DAY) {
        m.resolved30++;
        m.dailyResolved[Math.max(0, 29 - Math.floor((NOW - resolved) / DAY))]++;
      }
      const wkIdx = Math.floor((NOW - resolved) / (7 * DAY));
      if (wkIdx >= 0 && wkIdx < 12) m.weekly[11 - wkIdx].count++;
      if (created) m.cycles.push(resolved - created);
    }
    if (doneCat) m.done++; else m.wip++;

    m.statusDist.set(statusName, (m.statusDist.get(statusName) || 0) + 1);

    /* time-in-status from changelog */
    const evts = [];
    for (const h of iss.changelog?.histories || []) {
      for (const it of h.items || []) {
        if (String(it.field).toLowerCase() === 'status') {
          evts.push({ ts: Date.parse(h.created), from: it.fromString || null, to: it.toString || it.to || null });
        }
      }
    }
    evts.sort((a, b) => a.ts - b.ts);
    let prevTs = created ?? NOW;
    let prevName = evts.length ? (evts[0].from || statusName) : statusName;
    for (const ev of evts) {
      if (ev.ts > prevTs) addTime(m.statusTime, prevName, ev.ts - prevTs);
      prevTs = ev.ts;
      if (ev.to) prevName = ev.to;
    }
    const curAge = Math.max(0, NOW - prevTs);
    addTime(m.statusTime, prevName, curAge);

    if (!doneCat) {
      m.slow.push({
        key: iss.key,
        summary: f.summary || '',
        status: statusName,
        age: curAge,
        type: f.issuetype?.name || 'Task',
        assignee: f.assignee?.displayName || 'Unassigned',
        created,
      });
    }
  }

  m.cycleAvg = m.cycles.length ? m.cycles.reduce((a, b) => a + b, 0) / m.cycles.length : null;
  m.doneRate = m.total ? Math.round((m.done / m.total) * 100) : 0;
  m.slow.sort((a, b) => b.age - a.age);
  return m;
}

/* ── rendering ───────────────────────────────────────────────────── */
const PALETTE = ['#6366f1', '#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#38bdf8', '#fb923c'];

function chartTheme() {
  Chart.defaults.color = '#8b93ad';
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(13,18,38,.95)',
        borderColor: 'rgba(255,255,255,.14)',
        borderWidth: 1,
        padding: 10,
        cornerRadius: 9,
        titleFont: { weight: '700' },
      },
    },
    scales: {
      x: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { maxTicksLimit: 10 } },
      y: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { precision: 0 } },
    },
  };
}

function mkChart(id, cfg) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart(el.getContext('2d'), cfg);
  return state.charts[id];
}

function renderDashboard(board, m) {
  /* KPIs */
  $('#kpiTotal').textContent = m.total;
  $('#kpiTotalSub').textContent = 'issues on this board';
  $('#kpiCreated').textContent = m.created30;
  $('#kpiDone').textContent = m.done;
  $('#kpiDoneSub').textContent = m.doneRate + '% completion rate';
  $('#kpiResolved').textContent = m.resolved30;
  $('#kpiCycle').textContent = m.cycleAvg != null ? fmtDuration(m.cycleAvg) : '—';
  $('#kpiCycle').classList.toggle('muted', m.cycleAvg == null);
  $('#kpiWip').textContent = m.wip;
  $('#issueCountBadge').textContent = `${m.total} issues analyzed`;

  const theme = chartTheme();

  /* created vs resolved */
  const labels = [...Array(30)].map((_, i) => fmtDate(Date.now() - (29 - i) * DAY));
  const grad = (ctx, rgb) => {
    const g = ctx.createLinearGradient(0, 0, 0, 280);
    g.addColorStop(0, `rgba(${rgb},.28)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    return g;
  };
  const lctx = $('#createdResolvedChart').getContext('2d');
  mkChart('createdResolvedChart', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Created', data: m.dailyCreated, borderColor: '#6366f1', backgroundColor: grad(lctx, '99,102,241'), fill: true, tension: 0.35, pointRadius: 2, borderWidth: 2 },
        { label: 'Resolved', data: m.dailyResolved, borderColor: '#22d3ee', backgroundColor: grad(lctx, '34,211,238'), fill: true, tension: 0.35, pointRadius: 2, borderWidth: 2 },
      ],
    },
    options: { ...theme, plugins: { ...theme.plugins, legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true } } } },
  });

  /* status distribution doughnut */
  const distSorted = [...m.statusDist.entries()].sort((a, b) => b[1] - a[1]);
  const top = distSorted.slice(0, 7);
  const restSum = distSorted.slice(7).reduce((a, [, v]) => a + v, 0);
  const dLabels = top.map(([k]) => k).concat(restSum ? ['Other'] : []);
  const dData = top.map(([, v]) => v).concat(restSum ? [restSum] : []);
  mkChart('statusChart', {
    type: 'doughnut',
    data: {
      labels: dLabels,
      datasets: [{
        data: dData,
        backgroundColor: dLabels.map((_, i) => PALETTE[i % PALETTE.length]),
        borderColor: 'rgba(10,15,34,.9)',
        borderWidth: 3,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 9, boxHeight: 9, usePointStyle: true, padding: 14 } },
        tooltip: theme.plugins.tooltip,
      },
    },
  });

  /* avg time per status */
  const st = [...m.statusTime.entries()]
    .map(([k, v]) => ({ k, avg: v.sum / v.n }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 10)
    .reverse();
  mkChart('statusTimeChart', {
    type: 'bar',
    data: {
      labels: st.map((x) => x.k),
      datasets: [{ data: st.map((x) => x.avg / DAY), backgroundColor: '#8b5cf6cc', hoverBackgroundColor: '#a78bfa', borderRadius: 7, borderSkipped: false, barPercentage: 0.72 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        tooltip: {
          ...theme.plugins.tooltip,
          callbacks: { label: (c) => fmtDuration(c.parsed.x * DAY) + ' average' },
        },
      },
      scales: {
        x: { ...theme.scales.x, ticks: { callback: (v) => v + 'd' } },
        y: { grid: { display: false }, ticks: { precision: 0 } },
      },
    },
  });

  /* weekly throughput */
  mkChart('throughputChart', {
    type: 'bar',
    data: {
      labels: m.weekly.map((w) => w.label),
      datasets: [{
        label: 'Resolved', data: m.weekly.map((w) => w.count),
        backgroundColor: 'rgba(52,211,153,.55)', hoverBackgroundColor: '#34d399',
        borderRadius: 7, borderSkipped: false, barPercentage: 0.62,
      }],
    },
    options: theme,
  });

  /* slow table */
  const rows = m.slow.slice(0, 12).map((r) => {
    const cls = r.age > 14 * DAY ? 'age-hot' : r.age > 5 * DAY ? 'age-warm' : '';
    const link = state.conn ? `${state.conn.domain}/browse/${r.key}` : '#';
    return `<tr>
      <td><a href="${link}" target="_blank" rel="noopener">${r.key}</a></td>
      <td>${escapeHtml(r.summary)}</td>
      <td><span class="status-pill">${escapeHtml(r.status)}</span></td>
      <td class="${cls}">${fmtDuration(r.age)}</td>
      <td><span class="type-chip">${escapeHtml(r.type)}</span></td>
      <td class="muted">${escapeHtml(r.assignee)}</td>
      <td class="muted">${r.created ? fmtDate(r.created) : '—'}</td>
    </tr>`;
  }).join('');
  $('#slowTableBody').innerHTML = rows ||
    `<tr><td colspan="7" class="muted" style="text-align:center;padding:26px">Nothing in progress — everything is done 🎉</td></tr>`;
}

function updateProxyBadge() {
  const badge = $('#proxyBadge');
  if (state.usedProxy) show(badge); else hide(badge);
}

/* ── settings modal ──────────────────────────────────────────────── */
function openSettings() {
  if (!state.conn) return;
  $('#setDomain').value = state.conn.domain.replace(/^https?:\/\//, '');
  $('#setEmail').value = state.conn.email;
  $('#setToken').value = '';
  $('#proxyToggle').checked = !!state.conn.useProxy;
  show($('#settingsModal'));
}

async function saveSettings() {
  const email = $('#setEmail').value.trim() || state.conn.email;
  const token = $('#setToken').value.trim() || state.conn.token;
  let domain;
  try { domain = normalizeDomain($('#setDomain').value || state.conn.domain); }
  catch (e) { toast(e.message, 'err'); return; }
  state.conn = { domain, email, token, useProxy: $('#proxyToggle').checked };
  saveConn();
  hide($('#settingsModal'));
  toast('Settings saved.', 'ok');
  goBoards();
}

/* ── event wiring ────────────────────────────────────────────────── */
function setBtnBusy(btn, busy) {
  const label = btn.querySelector('.btn-label');
  const spin = btn.querySelector('.spinner');
  if (label) label.textContent = busy ? 'Connecting…' : 'Connect to Jira';
  if (spin) busy ? show(spin) : hide(spin);
  btn.disabled = busy;
}

document.addEventListener('DOMContentLoaded', () => {
  $('#connectForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('#connectBtn');
    const errBox = $('#setupError');
    hide(errBox);
    setBtnBusy(btn, true);
    try {
      await connect($('#inDomain').value, $('#inEmail').value, $('#inToken').value);
    } catch (e) {
      errBox.textContent = '⚠️ ' + (e?.message || 'Connection failed.');
      show(errBox);
    } finally {
      setBtnBusy(btn, false);
    }
  });

  $('#boardSelect').addEventListener('change', (ev) => {
    const b = state.boards.find((x) => x.id === parseInt(ev.target.value, 10));
    if (b) selectBoard(b);
  });
  $('#syncBoardsBtn').addEventListener('click', () => goBoards());
  $('#refreshBtn').addEventListener('click', () => {
    const b = state.boards.find((x) => x.id === state.boardId);
    if (b) { selectBoard(b); toast('Refreshing board data…'); }
  });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettingsBtn').addEventListener('click', () => hide($('#settingsModal')));
  $('#settingsModal').addEventListener('click', (ev) => {
    if (ev.target === $('#settingsModal')) hide($('#settingsModal'));
  });
  $('#saveSettingsBtn').addEventListener('click', saveSettings);
  $('#clearDataBtn').addEventListener('click', () => {
    if (confirm('Delete stored Jira credentials and preferences from this browser?')) {
      clearConn(); location.reload();
    }
  });
  $('#logoutBtn').addEventListener('click', () => {
    clearConn(); state.conn = null; location.reload();
  });

  // restore previous session silently
  const saved = loadConn();
  if (saved) {
    state.conn = saved;
    enterApp();
    api('/rest/api/3/myself')
      .catch((e) => handleAuthError(e));
  } else {
    showSetup();
  }
});
