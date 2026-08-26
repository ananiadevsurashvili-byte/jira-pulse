/* ══════════════════════ JiraPulse · app logic ══════════════════════ */
'use strict';

/* ── helpers ─────────────────────────────────────────────────────── */
const $ = (s) => document.querySelector(s);
const DAY = 86400000;
const LS_CONN = 'jp_conn_v1';
const LS_LAST_BOARD = 'jp_last_board_v1';
const PROXY = 'https://corsproxy.io/?url=';
const ISSUE_FIELDS = ['summary', 'status', 'resolutiondate', 'created', 'issuetype', 'assignee'];

const state = {
  conn: null,          // { domain, email, token, useProxy }
  boards: [],
  boardId: null,
  issues: [],
  charts: {},
  usedProxy: false,
  hasChangelog: true,
  debugLog: [],
  boardLoadMeta: null,
};

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function safeData(value) {
  return JSON.parse(JSON.stringify(value ?? null, (key, val) => {
    const k = String(key || '').toLowerCase();
    if (k.includes('token') || k.includes('authorization')) return '[redacted]';
    if (typeof val === 'string' && val.length > 500) return val.slice(0, 500) + '…';
    return val;
  }));
}

function logDiag(level, message, extra = null) {
  const entry = {
    at: new Date().toISOString(),
    level,
    message,
    extra: extra ? safeData(extra) : undefined,
  };
  state.debugLog.push(entry);
  if (state.debugLog.length > 400) state.debugLog.shift();
  renderDebugLog();
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  method('[JiraPulse]', message, entry.extra || '');
}

function formatDebugLog() {
  return state.debugLog.map((entry) => {
    const head = `[${entry.at}] ${entry.level.toUpperCase()} ${entry.message}`;
    return entry.extra ? `${head}\n${JSON.stringify(entry.extra, null, 2)}` : head;
  }).join('\n\n');
}

function renderDebugLog() {
  const el = $('#debugLogOutput');
  if (!el) return;
  el.textContent = formatDebugLog() || 'No diagnostics captured yet.';
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

/* draw an "empty state" message directly onto a chart canvas */
function drawCanvasMessage(id, lines) {
  const el = document.getElementById(id);
  if (!el) return;
  const ctx = el.getContext('2d');
  ctx.clearRect(0, 0, el.width, el.height);
  ctx.save();
  ctx.font = '600 13px Inter, system-ui';
  ctx.fillStyle = '#8b93ad';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    ctx.fillText(line, el.width / 2, el.height / 2 + (i - (lines.length - 1) / 2) * 20);
  });
  ctx.restore();
}

/* count-up animation for KPI numbers */
function animateValue(el, target) {
  if (!el) return;
  const from = parseInt(el.textContent, 10) || 0;
  if (from === target) { el.textContent = target; return; }
  const dur = 650;
  const t0 = performance.now();
  function frame(t) {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (target - from) * eased);
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function titleize(s) {
  return String(s || '').toLowerCase().split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function pctDelta(prev, cur) {
  if (!prev) return cur ? 100 : null;
  return Math.round((cur - prev) / prev * 100);
}

/* small ▲/▼ badge used under KPI values */
function trendBadge(prev, cur, label, mode = 'up-good') {
  const d = pctDelta(prev, cur);
  if (d === null) return `<span class="muted">${escapeHtml(label)}</span>`;
  let cls = 'trend-flat';
  if (mode !== 'neutral') {
    const good = mode === 'up-good' ? d >= 0 : d <= 0;
    cls = good ? 'trend-good' : 'trend-bad';
  }
  const arrow = d >= 0 ? '▲' : '▼';
  return `<span class="trend ${cls}">${arrow} ${Math.abs(d)}%</span> <span class="muted">${escapeHtml(label)}</span>`;
}

/* ── connection / API layer ──────────────────────────────────────── */
function normalizeDomain(raw) {
  let v = String(raw || '').trim().toLowerCase();
  if (!v) throw new Error('Please enter your Jira site address.');
  v = v.replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/')[0];
  if (!v.includes('.')) throw new Error('That doesn\'t look like a valid site address (e.g. yourcompany.atlassian.net).');
  return 'https://' + v;
}

async function api(path, options = {}) {
  const c = state.conn;
  if (!c) throw new Error('Not connected.');
  const method = options.method || 'GET';
  const url = c.domain + path;
  const headers = {
    'Authorization': 'Basic ' + btoa(c.email + ':' + c.token),
    'Accept': 'application/json',
  };
  if (options.body != null) headers['Content-Type'] = 'application/json';

  const attempts = [];
  let viaProxy = false;
  if (c.useProxy) attempts.push(PROXY + encodeURIComponent(url));
  else { attempts.push(url); attempts.push(PROXY + encodeURIComponent(url)); }

  let lastErr = null;
  for (const target of attempts) {
    try {
      logDiag('info', 'API request', { method, path, viaProxy: target !== url, body: options.body || null });
      const res = await fetch(target, {
        method,
        headers,
        body: options.body != null ? JSON.stringify(options.body) : undefined,
      });
      viaProxy = target !== url;
      let body = null;
      const text = await res.text();
      try { body = JSON.parse(text); } catch (_) { /* non-json */ }
      if (!res.ok) {
        const jiraMsg = body && (body.errorMessages?.join('; ') || body.message);
        const err = new Error(jiraMsg || `Jira responded with HTTP ${res.status}`);
        err.status = res.status;
        logDiag('warn', 'API response error', { method, path, status: res.status, viaProxy, body });
        throw err;
      }
      state.usedProxy = viaProxy;
      updateProxyBadge();
      logDiag('info', 'API response ok', {
        method, path, status: res.status, viaProxy,
        count: Array.isArray(body?.values) ? body.values.length
          : Array.isArray(body?.issues) ? body.issues.length
          : Array.isArray(body?.boards) ? body.boards.length
          : undefined,
      });
      return body;
    } catch (err) {
      lastErr = err;
      if (!err.status) logDiag('warn', 'API network/proxy failure', { method, path, viaProxy: target !== url, message: err.message });
      // HTTP errors from Jira itself are real answers — don't retry through proxy
      if (err.status) throw err;
      // network / CORS failure → try next attempt
    }
  }
  const e = new Error(
    `Could not reach ${c.domain} (${lastErr?.message || 'network error'}). ` +
    `If this is a CORS block by the browser, open Settings and enable "Route requests via CORS proxy".`
  );
  logDiag('error', 'API request failed completely', { method, path, message: e.message });
  throw e;
}

async function fetchPaginated(request, cap = 500) {
  const base = typeof request === 'string' ? { path: request, method: 'GET' } : request;
  let startAt = 0;
  const out = [];
  while (true) {
    let page;
    if ((base.method || 'GET') === 'GET') {
      const sep = base.path.includes('?') ? '&' : '?';
      page = await api(`${base.path}${sep}startAt=${startAt}&maxResults=100`);
    } else {
      page = await api(base.path, {
        method: base.method || 'POST',
        body: { ...(base.body || {}), startAt, maxResults: 100 },
      });
    }
    const vals = Array.isArray(page.values) ? page.values
      : Array.isArray(page.issues) ? page.issues
      : Array.isArray(page.boards) ? page.boards
      : [];
    out.push(...vals);
    const total = typeof page.total === 'number' ? page.total : null;
    if (!vals.length || page.isLast === true) break;
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
  goBoards({ autoOpenLast: true });
}

function goBoards({ autoOpenLast = false } = {}) {
  hide($('#dashScreen')); show($('#boardsScreen'));
  hide($('#errorBanner'));
  hide($('#changelogNotice'));
  $('#boardSelect').innerHTML = '<option value="">Loading boards…</option>';
  loadBoards({ autoOpenLast }).catch((e) => handleAuthError(e));
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
async function loadBoards({ autoOpenLast = false } = {}) {
  const grid = $('#boardsGrid');
  const btn = $('#syncBoardsBtn');
  btn.disabled = true;
  show($('#boardsLoading')); hide($('#boardsEmpty'));
  grid.innerHTML = '';
  try {
    const boards = await fetchPaginated('/rest/agile/1.0/board', 250);
    boards.sort((a, b) => (a.location?.projectName || a.name).localeCompare(b.location?.projectName || b.name));
    state.boards = boards;
    logDiag('info', 'Boards loaded', { count: boards.length });

    // dropdown
    const sel = $('#boardSelect');
    sel.innerHTML = boards.length
      ? boards.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')
      : '<option value="">No boards found</option>';

    renderBoardCards();

    if (!boards.length) { show($('#boardsEmpty')); return; }

    // auto-open last viewed board only when explicitly requested
    if (autoOpenLast) {
      const lastId = parseInt(localStorage.getItem(LS_LAST_BOARD), 10);
      const last = boards.find((b) => b.id === lastId);
      if (last) { sel.value = String(last.id); selectBoard(last); }
    }
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

async function resolveBoardContext(board) {
  const ctx = {
    boardId: board.id,
    boardName: board.name,
    boardType: board.type,
    location: board.location || null,
    filterId: null,
    filterJql: '',
    projectKeys: [],
  };

  try {
    const freshBoard = await api(`/rest/agile/1.0/board/${board.id}`);
    ctx.location = freshBoard.location || ctx.location;
    ctx.boardType = freshBoard.type || ctx.boardType;
    logDiag('info', 'Board details resolved', { boardId: board.id, boardType: ctx.boardType, location: ctx.location });
  } catch (e) {
    logDiag('warn', 'Board details lookup failed', { boardId: board.id, status: e.status, message: e.message });
  }

  try {
    const cfg = await api(`/rest/agile/1.0/board/${board.id}/configuration`);
    ctx.filterId = cfg?.filter?.id || null;
    logDiag('info', 'Board configuration resolved', { boardId: board.id, filterId: ctx.filterId });
  } catch (e) {
    logDiag('warn', 'Board configuration lookup failed', { boardId: board.id, status: e.status, message: e.message });
  }

  if (ctx.filterId) {
    try {
      const filter = await api(`/rest/api/3/filter/${ctx.filterId}`);
      ctx.filterJql = filter?.jql || '';
      logDiag('info', 'Board filter JQL resolved', { boardId: board.id, filterId: ctx.filterId, jqlPreview: ctx.filterJql.slice(0, 180) });
    } catch (e) {
      logDiag('warn', 'Board filter lookup failed', { boardId: board.id, filterId: ctx.filterId, status: e.status, message: e.message });
    }
  }

  try {
    const projects = await fetchPaginated(`/rest/agile/1.0/board/${board.id}/project`, 100);
    ctx.projectKeys = projects.map((p) => p.key).filter(Boolean);
    logDiag('info', 'Board projects resolved', { boardId: board.id, projectKeys: ctx.projectKeys });
  } catch (e) {
    logDiag('warn', 'Board projects lookup failed', { boardId: board.id, status: e.status, message: e.message });
  }

  if (!ctx.projectKeys.length && ctx.location?.projectKey) ctx.projectKeys = [ctx.location.projectKey];
  return ctx;
}

async function searchIssuesByJql(jql, withChangelog = false) {
  return await fetchPaginated({
    path: '/rest/api/3/search',
    method: 'POST',
    body: {
      jql,
      fields: ISSUE_FIELDS,
      expand: withChangelog ? ['changelog'] : [],
      fieldsByKeys: false,
    },
  }, 600);
}

/* ── dashboard ───────────────────────────────────────────────────── */
async function loadBoardIssues(board) {
  state.hasChangelog = true;
  state.boardLoadMeta = { source: '', note: '' };
  const ctx = await resolveBoardContext(board);

  const attempts = [
    {
      name: 'agile-changelog',
      run: () => fetchPaginated(`/rest/agile/1.0/board/${board.id}/issue?fields=${encodeURIComponent(ISSUE_FIELDS.join(','))}&expand=changelog`, 600),
      onSuccess: () => { state.hasChangelog = true; state.boardLoadMeta = { source: 'Agile board issues + changelog', note: '' }; },
    },
    {
      name: 'agile-basic',
      run: () => fetchPaginated(`/rest/agile/1.0/board/${board.id}/issue?fields=${encodeURIComponent(ISSUE_FIELDS.join(','))}`, 600),
      onSuccess: () => { state.hasChangelog = false; state.boardLoadMeta = { source: 'Agile board issues', note: 'Loaded without changelog expansion.' }; },
    },
    {
      name: 'software-basic',
      run: () => fetchPaginated(`/rest/software/1.0/board/${board.id}/issue?fields=${encodeURIComponent(ISSUE_FIELDS.join(','))}`, 600),
      onSuccess: () => { state.hasChangelog = false; state.boardLoadMeta = { source: 'Software board issues', note: 'Used enhanced software endpoint.' }; },
    },
    ...(ctx.filterJql ? [{
      name: 'search-filter-jql-changelog',
      run: () => searchIssuesByJql(ctx.filterJql, true),
      onSuccess: () => { state.hasChangelog = true; state.boardLoadMeta = { source: 'Board filter JQL + changelog', note: 'Used Jira issue search based on the board filter.' }; },
    }] : []),
    ...(ctx.filterJql ? [{
      name: 'search-filter-jql-basic',
      run: () => searchIssuesByJql(ctx.filterJql, false),
      onSuccess: () => { state.hasChangelog = false; state.boardLoadMeta = { source: 'Board filter JQL', note: 'Used Jira issue search based on the board filter.' }; },
    }] : []),
    ...(ctx.filterId ? [{
      name: 'search-filter-id-basic',
      run: () => searchIssuesByJql(`filter=${ctx.filterId} ORDER BY created DESC`, false),
      onSuccess: () => { state.hasChangelog = false; state.boardLoadMeta = { source: 'Board filter reference', note: 'Used filter id fallback.' }; },
    }] : []),
    ...(ctx.projectKeys.length ? [{
      name: 'search-projects-basic',
      run: () => searchIssuesByJql(`project in (${ctx.projectKeys.map((k) => `"${k}"`).join(', ')}) ORDER BY created DESC`, false),
      onSuccess: () => { state.hasChangelog = false; state.boardLoadMeta = { source: 'Board projects fallback', note: 'This fallback may include project issues beyond the exact board filter.' }; },
    }] : []),
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      logDiag('info', 'Board load attempt', { boardId: board.id, strategy: attempt.name });
      const issues = await attempt.run();
      attempt.onSuccess();
      logDiag('info', 'Board load succeeded', {
        boardId: board.id,
        strategy: attempt.name,
        issues: issues.length,
        source: state.boardLoadMeta,
      });
      return issues;
    } catch (e) {
      lastErr = e;
      logDiag('warn', 'Board load attempt failed', {
        boardId: board.id,
        strategy: attempt.name,
        status: e.status,
        message: e.message,
      });
    }
  }

  const err = new Error(`No compatible loading strategy worked for this board. Last error: ${lastErr?.message || 'unknown error'}`);
  err.status = lastErr?.status || 500;
  throw err;
}

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
    logDiag('info', 'Board selected', { boardId: board.id, name: board.name, type: board.type, location: board.location || null });
    const issues = await loadBoardIssues(board);
    state.issues = issues;
    const m = computeMetrics(issues);
    renderDashboard(board, m);
    $('#syncedAt').textContent = 'updated ' + new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    $('#issueCountBadge').textContent = 'failed';
    const banner = $('#errorBanner');
    let msg = e?.message || 'Failed to load board issues.';
    // Add hint for common issues
    if (e?.status === 403) msg += ' (403: check board permissions / API token scopes)';
    if (e?.status === 404) msg += ' (404: board may be team-managed with different API)';
    if (e?.status === 429) msg += ' (429: rate limited — wait a moment and click Refresh)';
    banner.innerHTML = `⚠️ ${escapeHtml(msg)}<div class="error-help">Open Diagnostics and copy the log so I can see every Jira request and fallback step.</div>`;
    show(banner);
    logDiag('error', 'Board load failed', { boardId: board.id, message: msg, status: e?.status });
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
  const WEEKS = 26; // 6 months of weekly pipeline buckets
  const m = {
    total: issues.length,
    created30: 0, resolved30: 0, done: 0, wip: 0,
    createdPrev30: 0, resolvedPrev30: 0,
    cycles: [],
    cycleRecent: [], cyclePrev: [],
    statusDist: new Map(),
    statusTime: new Map(),
    bottlenecks: new Map(),
    slow: [],
    dailyCreated: Array(30).fill(0),
    dailyResolved: Array(30).fill(0),
    weekly: Array.from({ length: 12 }, (_, i) => ({
      count: 0,
      label: fmtDate(NOW - (11 - i) * 7 * DAY),
    })),
    pipelineWeekly: Array.from({ length: WEEKS }, (_, i) => ({
      created: 0, resolved: 0,
      label: fmtDate(NOW - (WEEKS - 1 - i) * 7 * DAY),
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
    if (created && NOW - created >= 30 * DAY && NOW - created < 60 * DAY) m.createdPrev30++;
    if (resolved) {
      if (NOW - resolved < 30 * DAY) {
        m.resolved30++;
        m.dailyResolved[Math.max(0, 29 - Math.floor((NOW - resolved) / DAY))]++;
      }
      if (NOW - resolved >= 30 * DAY && NOW - resolved < 60 * DAY) m.resolvedPrev30++;
      const wkIdx = Math.floor((NOW - resolved) / (7 * DAY));
      if (wkIdx >= 0 && wkIdx < 12) m.weekly[11 - wkIdx].count++;
      const pwIdx = WEEKS - 1 - Math.floor((NOW - resolved) / (7 * DAY));
      if (pwIdx >= 0 && pwIdx < WEEKS) m.pipelineWeekly[pwIdx].resolved++;
      if (created) {
        m.cycles.push(resolved - created);
        if (NOW - resolved < 30 * DAY) m.cycleRecent.push(resolved - created);
        else if (NOW - resolved < 60 * DAY) m.cyclePrev.push(resolved - created);
      }
    }
    if (created) {
      const pwIdx = WEEKS - 1 - Math.floor((NOW - created) / (7 * DAY));
      if (pwIdx >= 0 && pwIdx < WEEKS) m.pipelineWeekly[pwIdx].created++;
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
      const bcat = classifyBottleneck(statusName);
      m.bottlenecks.set(bcat, (m.bottlenecks.get(bcat) || 0) + 1);
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
  m.cycleRecentAvg = m.cycleRecent.length ? m.cycleRecent.reduce((a, b) => a + b, 0) / m.cycleRecent.length : null;
  m.cyclePrevAvg = m.cyclePrev.length ? m.cyclePrev.reduce((a, b) => a + b, 0) / m.cyclePrev.length : null;
  m.doneRate = m.total ? Math.round((m.done / m.total) * 100) : 0;
  m.slow.sort((a, b) => b.age - a.age);

  /* stakeholder-vs-team phase delays (from changelog status times) */
  m.phaseDelays = [...m.statusTime.entries()]
    .map(([k, v]) => ({ status: k, avg: v.sum / v.n, side: classifySide(k), sum: v.sum, n: v.n }))
    .filter((r) => r.side)
    .sort((a, b) => b.avg - a.avg);
  let shSum = 0, shN = 0, tmSum = 0, tmN = 0;
  for (const r of m.phaseDelays) {
    if (r.side === 'stakeholder') { shSum += r.sum; shN += r.n; }
    else { tmSum += r.sum; tmN += r.n; }
  }
  m.stakeholderAvgMs = shN ? shSum / shN : null;
  m.teamAvgMs = tmN ? tmSum / tmN : null;

  return m;
}

/* ── rendering ───────────────────────────────────────────────────── */
const PALETTE = ['#6366f1', '#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#38bdf8', '#fb923c'];

/* ── status intelligence ─────────────────────────────────────────── */
/* Stakeholder gates: approvals, sign-offs, external reviews.
   Team phases: development, testing, QA work. */
const RE_STAKEHOLDER = /(business\s*owner|internal\s*it|\bbd\b|business\s*development|approv|sign[\s-]?off|steering|compliance|\blegal\b|security\s*review|acceptance)/;
const RE_TEAM = /(dev|cod(e|ing)|build|implement|\bbug|\bqa\b|test|uat|verif|integrat|refactor|deploy|release)/;

function classifySide(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return null;
  if (RE_STAKEHOLDER.test(s)) return 'stakeholder';
  if (RE_TEAM.test(s)) return 'team';
  return null;
}

/* Bottleneck buckets for open work. First matching rule wins,
   so order matters (e.g. "Internal IT Approval" → Technical Analysis). */
const BOTTLENECK_RULES = [
  { cat: 'Testing',            color: '#22d3ee', re: /\b(uat|qa|test|verif|regression)/ },
  { cat: 'In Development',     color: '#6366f1', re: /(ready\s*for\s*dev|\bdev|develop|\bbug|cod(e|ing)\b|in\s*progress|implement)/ },
  { cat: 'Pending Review',     color: '#fbbf24', re: /(pre[\s-]*analys|business\s*owner|product\s*owner|\bbd\b)/ },
  { cat: 'Technical Analysis', color: '#8b5cf6', re: /(technical|internal\s*it|analys|analyz|investigat|estimat|specificat|\bspec\b|solution|design)/ },
  { cat: 'Pending Review',     color: '#fbbf24', re: /(approv|review|pending|waiting|hold|block)/ },
];

function classifyBottleneck(name) {
  const s = String(name || '').toLowerCase();
  for (const r of BOTTLENECK_RULES) if (r.re.test(s)) return r.cat;
  return 'Other';
}

function bottleneckColor(cat) {
  const hit = BOTTLENECK_RULES.find((r) => r.cat === cat);
  return hit ? hit.color : '#64748b';
}
const BOTTLENECK_ORDER = ['Pending Review', 'Technical Analysis', 'In Development', 'Testing', 'Other'];

/* draws a big number + label inside doughnut holes */
const centerTextPlugin = {
  id: 'centerText',
  afterDraw(chart) {
    const opts = chart.config.options?.plugins?.centerText;
    if (!opts || !opts.enable) return;
    const meta = chart.getDatasetMeta(0);
    if (!meta.data.length) return;
    const { x, y } = meta.data[0];
    const ctx = chart.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 26px Inter, system-ui';
    ctx.fillStyle = '#e9edf8';
    ctx.fillText(String(opts.value ?? ''), x, y - 7);
    ctx.font = '700 10px Inter, system-ui';
    ctx.fillStyle = '#8b93ad';
    ctx.fillText(String(opts.label ?? '').toUpperCase(), x, y + 14);
    ctx.restore();
  },
};
Chart.register(centerTextPlugin);

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

function buildInsights(m) {
  const out = [];
  if (m.bottlenecks.size) {
    const [cat, n] = [...m.bottlenecks.entries()].sort((a, b) => b[1] - a[1])[0];
    out.push({ icon: '⛔', cls: 'ins-warn', html: `<b>${n}</b> open issue${n !== 1 ? 's' : ''} currently sitting in <b>${escapeHtml(cat)}</b>` });
  }
  if (m.phaseDelays.length) {
    const w = m.phaseDelays[0];
    out.push({ icon: '⏳', cls: 'ins-warn', html: `Slowest stage right now: <b>${escapeHtml(titleize(w.status))}</b> · ${fmtDuration(w.avg)} average` });
  }
  const thr = pctDelta(m.resolvedPrev30, m.resolved30);
  if (thr !== null) {
    out.push({ icon: thr >= 0 ? '📈' : '📉', cls: thr >= 0 ? 'ins-good' : 'ins-bad', html: `Throughput <b>${thr >= 0 ? '+' : ''}${thr}%</b> vs the previous 30 days` });
  }
  const aged = m.slow.filter((r) => r.age > 14 * DAY).length;
  if (aged) {
    out.push({ icon: '🧊', cls: 'ins-bad', html: `<b>${aged}</b> open issue${aged !== 1 ? 's' : ''} stuck longer than 14 days` });
  }
  if (m.created30 || m.resolved30) {
    const net = m.resolved30 - m.created30;
    out.push({
      icon: net >= 0 ? '✅' : '📥',
      cls: net >= 0 ? 'ins-good' : 'ins-warn',
      html: `Net flow <b>${net >= 0 ? '+' : ''}${net}</b> issues in 30 days — backlog ${net >= 0 ? 'shrinking' : 'growing'}`,
    });
  }
  return out.slice(0, 4);
}

function renderDashboard(board, m) {
  /* KPIs (animated) */
  animateValue($('#kpiTotal'), m.total);
  $('#kpiTotalSub').textContent = 'issues on this board';
  animateValue($('#kpiCreated'), m.created30);
  $('#kpiCreatedSub').innerHTML = trendBadge(m.createdPrev30, m.created30, 'vs prior 30d', 'neutral');
  animateValue($('#kpiDone'), m.done);
  $('#kpiDoneSub').textContent = m.doneRate + '% completion rate';
  animateValue($('#kpiResolved'), m.resolved30);
  $('#kpiResolvedSub').innerHTML = trendBadge(m.resolvedPrev30, m.resolved30, 'vs prior 30d', 'up-good');
  $('#kpiCycle').textContent = m.cycleAvg != null ? fmtDuration(m.cycleAvg) : '—';
  $('#kpiCycle').classList.toggle('muted', m.cycleAvg == null);
  if (m.cycleRecentAvg != null && m.cyclePrevAvg != null) {
    const d = pctDelta(m.cyclePrevAvg, m.cycleRecentAvg);
    $('#kpiCycleSub').innerHTML = d === null
      ? '<span class="muted">create → resolve</span>'
      : `<span class="trend ${d <= 0 ? 'trend-good' : 'trend-bad'}">${d <= 0 ? '▼' : '▲'} ${Math.abs(d)}%</span> <span class="muted">${Math.abs(d)}% ${d <= 0 ? 'faster' : 'slower'} than prior 30d</span>`;
  } else {
    $('#kpiCycleSub').innerHTML = '<span class="muted">create → resolve</span>';
  }
  animateValue($('#kpiWip'), m.wip);
  $('#issueCountBadge').textContent = `${m.total} issues analyzed`;

  /* auto-insights */
  const strip = $('#insightsStrip');
  const ins = buildInsights(m);
  if (ins.length) {
    strip.innerHTML = ins.map((x, i) =>
      `<div class="insight" style="animation-delay:${i * 70}ms"><span class="ins-icon">${x.icon}</span><span>${x.html}</span></div>`
    ).join('');
    show(strip);
  } else {
    hide(strip);
  }

  /* changelog availability notice */
  const changelogNotice = $('#changelogNotice');
  if (!state.hasChangelog) {
    const extraNote = state.boardLoadMeta?.note ? ` ${state.boardLoadMeta.note}` : '';
    changelogNotice.textContent = `⚠ Status-time analytics unavailable — this board may be team-managed or your token lacks changelog permissions. Showing core metrics only.${extraNote}`;
    show(changelogNotice);
  } else {
    hide(changelogNotice);
  }

  const theme = chartTheme();
  const legendOn = { display: true, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, padding: 14 } };

  /* incoming vs completed pipeline · weekly, last 6 months */
  const grad = (ctx, rgb) => {
    const g = ctx.createLinearGradient(0, 0, 0, 280);
    g.addColorStop(0, `rgba(${rgb},.28)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    return g;
  };
  const pctx = $('#pipelineChart').getContext('2d');
  mkChart('pipelineChart', {
    type: 'line',
    data: {
      labels: m.pipelineWeekly.map((w) => w.label),
      datasets: [
        { label: 'Registered', data: m.pipelineWeekly.map((w) => w.created), borderColor: '#6366f1', backgroundColor: grad(pctx, '99,102,241'), fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.5 },
        { label: 'Completed', data: m.pipelineWeekly.map((w) => w.resolved), borderColor: '#34d399', backgroundColor: grad(pctx, '52,211,153'), fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.5 },
      ],
    },
    options: {
      ...theme,
      interaction: { mode: 'index', intersect: false },
      plugins: { ...theme.plugins, legend: legendOn },
    },
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
        centerText: { enable: true, value: m.total, label: 'issues' },
      },
    },
  });

  /* avg time per status */
  const st = [...m.statusTime.entries()]
    .map(([k, v]) => ({ k, avg: v.sum / v.n }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 10)
    .reverse();

  if (!state.hasChangelog || st.length === 0) {
    drawCanvasMessage('statusTimeChart', !state.hasChangelog
      ? ['Changelog data not available for this board', '(team-managed boards or permission limits)']
      : ['No status transition data found']);
    if (state.charts.statusTimeChart) {
      state.charts.statusTimeChart.destroy();
      state.charts.statusTimeChart = null;
    }
  } else {
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
  }

  /* stakeholder vs team delays · avg days parked in each stage */
  const pdSub = $('#phaseDelaysSub');
  if (!state.hasChangelog || m.phaseDelays.length === 0) {
    drawCanvasMessage('phaseDelaysChart', !state.hasChangelog
      ? ['Changelog unavailable on this board —', 'cannot compare stakeholder vs team stages']
      : ['No stakeholder / team stage transitions', 'detected in the last 6 months of changelog']);
    if (state.charts.phaseDelaysChart) {
      state.charts.phaseDelaysChart.destroy();
      state.charts.phaseDelaysChart = null;
    }
    if (pdSub) pdSub.textContent = !state.hasChangelog ? 'changelog unavailable on this board' : 'no matching stage transitions found';
  } else {
    const picked = m.phaseDelays.slice(0, 8).reverse(); // slowest on top
    const shData = [], tmData = [];
    picked.forEach((r) => {
      const days = +(r.avg / DAY).toFixed(1);
      if (r.side === 'stakeholder') { shData.push(days); tmData.push(null); }
      else { tmData.push(days); shData.push(null); }
    });
    mkChart('phaseDelaysChart', {
      type: 'bar',
      data: {
        labels: picked.map((r) => titleize(r.status)),
        datasets: [
          { label: 'Stakeholder gate', data: shData, backgroundColor: '#fbbf24cc', hoverBackgroundColor: '#fcd34d', borderRadius: 7, borderSkipped: false, barPercentage: 0.6, categoryPercentage: 0.74 },
          { label: 'Team phase', data: tmData, backgroundColor: '#22d3eecc', hoverBackgroundColor: '#67e8f9', borderRadius: 7, borderSkipped: false, barPercentage: 0.6, categoryPercentage: 0.74 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: {
          legend: legendOn,
          tooltip: {
            ...theme.plugins.tooltip,
            callbacks: { label: (c) => c.parsed.x != null ? `${fmtDuration(c.parsed.x * DAY)} average` : '' },
          },
        },
        scales: {
          x: { ...theme.scales.x, ticks: { callback: (v) => v + 'd' } },
          y: { grid: { display: false }, ticks: { precision: 0 } },
        },
      },
    });
    if (pdSub) {
      pdSub.innerHTML =
        `<span style="color:#fcd34d">●</span> Stakeholder gates avg <b>${fmtDuration(m.stakeholderAvgMs)}</b>` +
        ` &nbsp;·&nbsp; <span style="color:#67e8f9">●</span> Team phases avg <b>${fmtDuration(m.teamAvgMs)}</b>`;
    }
  }

  /* active bottlenecks · where open work is parked right now */
  const openTotal = m.wip;
  const bCats = BOTTLENECK_ORDER.filter((c) => m.bottlenecks.has(c));
  if (openTotal === 0 || bCats.length === 0) {
    drawCanvasMessage('bottleneckChart', ['No open issues — everything is done 🎉']);
    if (state.charts.bottleneckChart) {
      state.charts.bottleneckChart.destroy();
      state.charts.bottleneckChart = null;
    }
  } else {
    mkChart('bottleneckChart', {
      type: 'doughnut',
      data: {
        labels: bCats,
        datasets: [{
          data: bCats.map((c) => m.bottlenecks.get(c)),
          backgroundColor: bCats.map(bottleneckColor),
          borderColor: 'rgba(10,15,34,.9)',
          borderWidth: 3,
          hoverOffset: 8,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '68%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 9, boxHeight: 9, usePointStyle: true, padding: 12 } },
          tooltip: {
            ...theme.plugins.tooltip,
            callbacks: {
              label: (c) => {
                const total = c.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total ? Math.round(c.parsed / total * 100) : 0;
                return ` ${c.parsed} issues · ${pct}%`;
              },
            },
          },
          centerText: { enable: true, value: openTotal, label: 'open' },
        },
      },
    });
  }

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
    const barColor = r.age > 14 * DAY ? '#f87171' : r.age > 5 * DAY ? '#fbbf24' : '#34d399';
    const barPct = Math.min(100, Math.round(r.age / (30 * DAY) * 100));
    const link = state.conn ? `${state.conn.domain}/browse/${r.key}` : '#';
    return `<tr>
      <td><a href="${link}" target="_blank" rel="noopener">${r.key}</a></td>
      <td>${escapeHtml(r.summary)}</td>
      <td><span class="status-pill">${escapeHtml(r.status)}</span></td>
      <td class="${cls}">${fmtDuration(r.age)}<div class="age-bar"><i style="width:${barPct}%;background:${barColor}"></i></div></td>
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

function openDiagnostics() {
  renderDebugLog();
  show($('#debugModal'));
}

async function copyDiagnostics() {
  const text = formatDebugLog();
  try {
    await navigator.clipboard.writeText(text);
    toast('Diagnostics copied.', 'ok');
  } catch (_) {
    toast('Could not copy diagnostics.', 'err');
  }
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
  $('#syncBoardsBtn').addEventListener('click', () => goBoards({ autoOpenLast: false }));
  $('#backToBoardsBtn').addEventListener('click', () => goBoards({ autoOpenLast: false }));
  $('#openDebugBtn').addEventListener('click', openDiagnostics);
  $('#refreshBtn').addEventListener('click', () => {
    const b = state.boards.find((x) => x.id === state.boardId);
    if (b) { selectBoard(b); toast('Refreshing board data…'); }
  });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettingsBtn').addEventListener('click', () => hide($('#settingsModal')));
  $('#settingsModal').addEventListener('click', (ev) => {
    if (ev.target === $('#settingsModal')) hide($('#settingsModal'));
  });
  $('#closeDebugBtn').addEventListener('click', () => hide($('#debugModal')));
  $('#copyDebugBtn').addEventListener('click', copyDiagnostics);
  $('#clearDebugBtn').addEventListener('click', () => {
    state.debugLog = [];
    renderDebugLog();
    toast('Diagnostics cleared.', 'ok');
  });
  $('#debugModal').addEventListener('click', (ev) => {
    if (ev.target === $('#debugModal')) hide($('#debugModal'));
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

  window.addEventListener('error', (ev) => {
    logDiag('error', 'Unhandled browser error', { message: ev.message, filename: ev.filename, lineno: ev.lineno, colno: ev.colno });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason;
    logDiag('error', 'Unhandled promise rejection', {
      message: reason?.message || String(reason),
      status: reason?.status,
    });
  });
});
