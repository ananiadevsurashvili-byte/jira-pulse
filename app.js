/* ══════════════════════ JiraPulse · app logic ══════════════════════ */
'use strict';

/* ── helpers ─────────────────────────────────────────────────────── */
const $ = (s) => document.querySelector(s);
const DAY = 86400000;
const LS_CONN = 'jp_conn_v1';
const LS_LAST_BOARD = 'jp_last_board_v1';
const PROXY = 'https://corsproxy.io/?url=';
const ISSUE_FIELDS = ['summary', 'status', 'resolutiondate', 'created', 'issuetype', 'assignee', 'priority', 'labels'];

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
  lastBoard: null,     // last board object, for re-rendering charts after edits
  lastMetrics: null,   // cached computeMetrics() result for the last board
};

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ── public board publishing (snapshot + email-domain auth) ────────── */
const LS_PUBLISH = 'jp_publish_v1';
const PUBLISH_DOMAIN = 'caucasusauto.com';   /* allowed email domain */
const PUBLISH_TOKEN_LEN = 16;
const ADMIN_EMAIL = 'anania.devsurashvili@caucasusauto.com';  /* the JiraPulse admin */

/* is this email the admin? */
function isAdminEmail(email) {
  return (email || '').toLowerCase().trim() === ADMIN_EMAIL;
}

function loadPublishStore() {
  try { return JSON.parse(localStorage.getItem(LS_PUBLISH) || '{}'); } catch { return {}; }
}
function savePublishStore(s) { localStorage.setItem(LS_PUBLISH, JSON.stringify(s)); }

/* deterministic 6-digit code from token + email */
function publishCode(token, email) {
  let h = 0;
  const s = token + '|' + email.toLowerCase().trim();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(Math.abs(h) % 1000000).padStart(6, '0');
}

/* is this email in the allowed domain? */
function publishEmailOk(email) {
  const e = (email || '').toLowerCase().trim();
  return e.endsWith('@' + PUBLISH_DOMAIN) && e.split('@')[1] === PUBLISH_DOMAIN;
}

/* generate a fresh random token */
function newPublishToken() {
  const a = new Uint32Array(PUBLISH_TOKEN_LEN);
  crypto.getRandomValues(a);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(a, (x) => chars[x % chars.length]).join('');
}

/* create a publish snapshot for a board, or for every board (scope='all') */
async function createPublishSnapshot(boardId, scope) {
  if (scope === 'all') return await createAllBoardsSnapshot();
  const board = state.boards.find((b) => b.id === boardId);
  if (!board) return null;
  const defs = effectiveCharts();
  const payload = buildBoardRenderPayload(state.issues, state.lastMetrics, defs, state.hasChangelog);
  const snapshot = {
    token: newPublishToken(),
    boardId,
    boardName: board.name,
    scope: 'board',
    createdAt: Date.now(),
    issuesCount: state.issues.length,
    hasChangelog: state.hasChangelog,
    charts: payload.charts,       // [{ def, data }] — self-contained render data
  };
  const store = loadPublishStore();
  store[snapshot.token] = snapshot;
  savePublishStore(store);
  return snapshot;
}

/* build a snapshot that bundles every board with its own portable render payload */
async function createAllBoardsSnapshot() {
  const now = Date.now();
  const records = [];
  let anyChangelog = false;
  const defs = effectiveCharts();
  for (const board of state.boards) {
    try {
      logDiag('info', 'Publish: loading board for all-boards snapshot', { boardId: board.id, name: board.name });
      const issues = await loadBoardIssues(board);
      const m = computeMetrics(issues);
      anyChangelog = anyChangelog || state.hasChangelog;
      const prevBoardId = state.boardId, prevBoard = state.lastBoard;
      /* temporarily point board context at this board so render payload carries its name */
      state.boardId = board.id; state.lastBoard = board;
      const payload = buildBoardRenderPayload(issues, m, defs, state.hasChangelog);
      state.boardId = prevBoardId; state.lastBoard = prevBoard;
      records.push({
        boardId: board.id,
        name: board.name,
        issuesCount: issues.length,
        hasChangelog: state.hasChangelog,
        charts: payload.charts,
      });
    } catch (e) {
      logDiag('warn', 'Publish: board skipped in all-boards snapshot', { boardId: board.id, name: board.name, message: e?.message });
    }
  }
  if (!records.length) { toast('Could not load any boards to publish.', 'warn'); return null; }
  const snapshot = {
    token: newPublishToken(),
    boardId: null,
    boardName: 'All boards',
    scope: 'all',
    createdAt: now,
    issuesCount: records.reduce((a, r) => a + r.issuesCount, 0),
    hasChangelog: anyChangelog,
    charts: [],
    boards: records,
  };
  const store = loadPublishStore();
  store[snapshot.token] = snapshot;
  savePublishStore(store);
  return snapshot;
}

/* list all snapshots */
function listPublishSnapshots() {
  const store = loadPublishStore();
  return Object.values(store).sort((a, b) => b.createdAt - a.createdAt);
}

/* delete a snapshot */
function deletePublishSnapshot(token) {
  const store = loadPublishStore();
  delete store[token];
  savePublishStore(store);
}

/* turn issues + metrics + chart defs into a portable, precomputed render payload.
   This collapses raw issues (and non-serializable Maps inside metrics) into the
   exact arrays Chart.js needs, so a snapshot can be embedded in a URL and drawn
   on any device WITHOUT a Jira connection or the full issue list. */
function buildBoardRenderPayload(issues, m, defs, hasChangelog) {
  const charts = (defs || []).map((def) => {
    const data = buildChartData(def, m, issues, hasChangelog);
    return { def, data };
  });
  return {
    boardId: state.boardId,
    boardName: state.lastBoard ? state.lastBoard.name : '',
    issuesCount: issues.length,
    hasChangelog,
    charts,
  };
}

/* encode a snapshot into a compact, self-contained share hash (#p=<compressed>) */
function encodeSharePayload(snap) {
  const obj = {
    v: 2,
    scope: snap.scope,
    boardName: snap.scope === 'all' ? 'All boards' : snap.boardName,
    boardId: snap.boardId,
    createdAt: snap.createdAt,
    hasChangelog: snap.hasChangelog,
    charts: snap.charts,   // array of { def, data }
    boards: snap.boards,   // array of portable board records (for scope 'all')
  };
  const json = JSON.stringify(obj);
  const compressed = typeof LZString !== 'undefined' ? LZString.compressToEncodedURIComponent(json) : encodeURIComponent(json);
  return compressed;
}

function decodeSharePayload(compressed) {
  if (compressed == null) return null;
  try {
    const json = typeof LZString !== 'undefined' ? LZString.decompressFromEncodedURIComponent(compressed) : decodeURIComponent(compressed);
    if (!json) return null;
    return JSON.parse(json);
  } catch (e) {
    logDiag('warn', 'Failed to decode share payload', { message: e?.message });
    return null;
  }
}

/* build a share URL from a snapshot (self-contained, works on any device) */
function buildShareUrl(snap) {
  const payload = encodeSharePayload(snap);
  return location.origin + location.pathname + '#p=' + payload;
}

/* check if current URL is a self-contained share link */
function parseSharePayload() {
  const u = new URL(location.href);
  const p = u.hash.match(/^#p=(.+)$/);
  if (!p) return null;
  return decodeSharePayload(p[1]);
}

/* check if current URL has a share token */
function parseShareToken() {
  const u = new URL(location.href);
  return u.searchParams.get('share');
}

/* normalize both share formats into a snapshot object for rendering.
   Priority: self-contained #p= payload, then legacy ?share= localStorage token. */
function loadShareSnapshot() {
  const payload = parseSharePayload();
  if (payload) {
    /* self-contained link — works on any device. Build a snapshot view-model. */
    const snap = {
      token: null,
      boardId: payload.boardId,
      boardName: payload.boardName,
      scope: payload.scope,
      createdAt: payload.createdAt,
      issuesCount: payload.scope === 'all' ? (payload.boards || []).reduce((a, b) => a + (b.issuesCount || 0), 0) : 0,
      hasChangelog: payload.hasChangelog,
      charts: payload.charts || [],
      boards: payload.boards || [],
    };
    /* for single-board payloads, issuesCount lives on the payload too */
    if (payload.scope === 'board') snap.issuesCount = payload.issuesCount || 0;
    return snap;
  }
  const shareToken = parseShareToken();
  if (shareToken) {
    const store = loadPublishStore();
    const snap = store[shareToken];
    if (snap) {
      /* migrate any old v1 snapshot (which stored raw issues/metrics) to portable render */
      if (snap.issues && !snap.charts?.length) {
        const charts = effectiveCharts().map((def) => ({ def, data: buildChartData(def, snap.metrics, snap.issues, snap.hasChangelog) }));
        snap.charts = charts;
        snap.issuesCount = snap.issues.length;
        delete snap.issues;
        delete snap.metrics;
        savePublishStore(store);
      }
      return snap;
    }
    toast('This published link is no longer available.', 'warn');
    location.href = location.pathname;
    return null;
  }
  return null;
}

/* ── public share screen logic ─────────────────────────────────────── */
let pubState = {
  snapshot: null,
  email: '',
  verified: false,
  codeSent: false,
  isAdmin: false,          /* true when the viewer is the JiraPulse admin */
  currentBoard: null,      /* board being viewed when snapshot.scope === 'all' */
  allSnapshot: null,       /* parent all-boards snapshot when drilled into a board */
};

/* Google OAuth client id (leave empty to disable Google sign-in) */
const GOOGLE_CLIENT_ID = '671098966570-21bp1aeud5o2glbjsliif3foi6n71gmh.apps.googleusercontent.com';

function googleReady() {
  return typeof window.google !== 'undefined' && window.google.accounts && window.google.accounts.id;
}

function initGoogleButton() {
  if (!GOOGLE_CLIENT_ID || !googleReady()) return;
  try {
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: (resp) => {
        /* decode the JWT payload to get the email */
        const payload = decodeJwt(resp.credential);
        const email = (payload?.email || '').toLowerCase().trim();
        if (!publishEmailOk(email)) {
          $('#pubStatus').textContent = 'Access is restricted to @caucasusauto.com accounts.';
          $('#pubStatus').className = 'error';
          return;
        }
        /* verified Google account in the right domain — grant access */
        pubState.email = email;
        pubState.verified = true;
        pubState.isAdmin = isAdminEmail(email);
        $('#pubStatus').textContent = 'Verified via Google. Loading snapshot…';
        $('#pubStatus').className = 'ok';
        $('#pubContent').classList.remove('hidden');
        $('#pubAuthBox').classList.add('hidden');
        renderPubContent();
      },
      context: 'use',
      ux_mode: 'popup',
      hd: PUBLISH_DOMAIN,   /* restrict to caucasusauto.com domain */
    });
    window.google.accounts.id.renderButton($( '#pubGoogleBtn'), {
      theme: 'outline',
      size: 'large',
      width: 240,
      text: 'continue_with',
      logo_alignment: 'center',
    });
  } catch (e) {
    logDiag('warn', 'Google init failed', { message: e.message });
  }
}

function decodeJwt(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64);
    return JSON.parse(json);
  } catch { return null; }
}

function showPubScreen(snapshot) {
  pubState.snapshot = snapshot;
  pubState.email = '';
  pubState.verified = false;
  pubState.codeSent = false;
  pubState.isAdmin = false;
  pubState.currentBoard = null;

  /* title depends on scope */
  if (snapshot.scope === 'all') {
    $('#pubTitle').textContent = 'Organization board stats';
    $('#pubSubtitle').textContent = 'Sign in with your ' + PUBLISH_DOMAIN + ' email to view the published board stats.';
  } else {
    $('#pubTitle').textContent = snapshot.boardName + ' — published stats';
    $('#pubSubtitle').textContent = 'Sign in with your ' + PUBLISH_DOMAIN + ' email to view this board snapshot.';
  }
  $('#pubEmail').value = '';
  $('#pubEmail').disabled = false;
  $('#pubEmail').placeholder = 'you@' + PUBLISH_DOMAIN;
  $('#pubCodeWrap').classList.add('hidden');
  $('#pubCode').value = '';
  $('#pubCode').disabled = false;
  $('#pubSendBtn').textContent = 'Send code';
  $('#pubVerifyBtn').textContent = 'Verify';
  $('#pubVerifyBtn').classList.add('hidden');
  $('#pubStatus').textContent = '';
  $('#pubStatus').className = 'muted';
  $('#pubContent').classList.add('hidden');
  $('#pubAuthBox').classList.remove('hidden');
  $('#pubAuthBox').classList.add('glass');
  $('#pubAdminBar').classList.add('hidden');

  /* hide app chrome — include setup + topbar so a share link opened directly
     never leaves the connect/setup screen visible beneath the share overlay */
  hide($( '#setupScreen'));
  hide($( '#topbar'));
  hide($( '#dashScreen'));
  hide($( '#boardsScreen'));
  show($( '#pubScreen'));
}

/* stable seed for the access code — self-contained links have no token, so
   derive a deterministic seed from boardId + scope + createdAt */
function pubCodeSeed(snap) {
  return snap.token || (snap.scope + '|' + (snap.boardId || 'all') + '|' + (snap.createdAt || 'jp'));
}

function pubSendCode() {
  const email = $('#pubEmail').value.trim();
  if (!publishEmailOk(email)) {
    $('#pubStatus').textContent = 'Please enter a valid @' + PUBLISH_DOMAIN + ' email.';
    $('#pubStatus').className = 'error';
    return;
  }
  pubState.email = email;
  pubState.isAdmin = isAdminEmail(email);
  const code = publishCode(pubCodeSeed(pubState.snapshot), email);
  pubState.codeSent = true;

  /* show code inline (no backend) and offer mailto link */
  $('#pubStatus').textContent = 'Your access code: ' + code;
  $('#pubStatus').className = 'ok';
  $('#pubCodeWrap').classList.remove('hidden');
  $('#pubVerifyBtn').classList.remove('hidden');
  $('#pubSendBtn').textContent = 'Resend code';

  /* mailto link so admin can forward the code */
  const subject = encodeURIComponent('Your JiraPulse access code');
  const body = encodeURIComponent('Your access code for ' + pubState.snapshot.boardName + ':\n\n' + code + '\n\nEnter it on the JiraPulse page.');
  const mailto = 'mailto:' + encodeURIComponent(email) + '?subject=' + subject + '&body=' + body;
  $('#pubMailLink').href = mailto;
  show($( '#pubMailLink'));
}

function pubVerifyCode() {
  const entered = $('#pubCode').value.trim();
  const expected = publishCode(pubCodeSeed(pubState.snapshot), pubState.email);
  if (entered === expected) {
    pubState.verified = true;
    pubState.isAdmin = isAdminEmail(pubState.email);
    $('#pubStatus').textContent = 'Verified. Loading snapshot…';
    $('#pubStatus').className = 'ok';
    $('#pubContent').classList.remove('hidden');
    $('#pubAuthBox').classList.add('hidden');
    renderPubContent();
  } else {
    $('#pubStatus').textContent = 'Wrong code. Please try again.';
    $('#pubStatus').className = 'error';
  }
}

function renderPubContent() {
  const snap = pubState.snapshot;
  const admin = pubState.isAdmin;

  /* admin bar — visible only to the admin */
  const adminBar = $('#pubAdminBar');
  if (admin) {
    adminBar.classList.remove('hidden');
    $('#pubAdminText').textContent = 'Signed in as ' + pubState.email + ' · Admin';
    $('#pubManageBtn').style.display = '';
  } else {
    adminBar.classList.add('hidden');
  }

  /* admin share-link box — only visible to admin once they're inside a board view */
  const linkBox = $('#pubLinkBox');
  if (admin && snap.scope === 'board') {
    const link = buildShareUrl(snap);
    $('#pubLinkInput').value = link;
    linkBox.classList.remove('hidden');
  } else {
    linkBox.classList.add('hidden');
  }

  /* title/subtitle */
  if (snap.scope === 'all') {
    $('#pubTitle').textContent = 'Organization board stats';
    $('#pubSubtitle').textContent = 'All published boards · snapshot ' +
      new Date(snap.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } else {
    $('#pubTitle').textContent = snap.boardName;
    $('#pubSubtitle').textContent = 'Snapshot taken ' + new Date(snap.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' · ' + (snap.issuesCount ?? 0) + ' issues';
  }

  $('#pubIssueCount').textContent = snap.scope === 'all'
    ? snap.boards.length + ' boards'
    : (snap.issuesCount ?? 0) + ' issues';
  $('#pubChangelogBadge').textContent = snap.hasChangelog ? '✓ changelog' : '⚠ no changelog';
  $('#pubChangelogBadge').className = 'data-badge ' + (snap.hasChangelog ? 'ok' : 'missing');

  const boardsList = $('#pubBoardsList');
  const chartsGrid = $('#pubChartsGrid');

  if (snap.scope === 'all') {
    /* ── all-boards view: show the boards list ── */
    chartsGrid.classList.add('hidden');
    boardsList.classList.remove('hidden');
    const boards = snap.boards || [];
    if (!boards.length) {
      boardsList.innerHTML = '<div class="card glass chart-card wide" style="text-align:center;padding:34px;color:var(--muted)">No boards published.</div>';
    } else {
      boardsList.innerHTML = boards.map((b) => `
        <div class="pub-board-row" data-bid="${b.boardId}">
          <span class="board-open" style="color:var(--muted)">▸</span>
          <div>
            <div class="bname">${escapeHtml(b.name)}</div>
            <div class="bmeta">${b.issuesCount} issues · ${b.hasChangelog ? 'changelog ✓' : 'no changelog'}</div>
          </div>
          ${admin ? `<button class="link-btn" data-copyboard="${b.boardId}" style="margin-left:auto;font-size:0.72rem">🔗 copy link</button>` : ''}
        </div>`).join('');
      boardsList.querySelectorAll('.pub-board-row').forEach((row) => {
        const bid = row.dataset.bid;
        const copyBtn = row.querySelector('[data-copyboard]');
        if (copyBtn) {
          copyBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const b = boards.find((x) => String(x.boardId) === bid);
            if (b) {
              const link = buildShareUrl({ scope: 'board', boardId: b.boardId, boardName: b.name, createdAt: snap.createdAt, hasChangelog: b.hasChangelog, charts: b.charts || [], issuesCount: b.issuesCount });
              navigator.clipboard.writeText(link).then(() => toast('Board link copied.', 'ok')).catch(() => toast('Could not copy.', 'warn'));
            }
          });
        }
        row.addEventListener('click', () => {
          const b = boards.find((x) => String(x.boardId) === bid);
          if (b) openBoardSnapshot(b);
        });
      });
    }
  } else {
    /* ── single-board view: render the charts ── */
    boardsList.classList.add('hidden');
    chartsGrid.classList.remove('hidden');
    const grid = chartsGrid;
    const charts = snap.charts || [];
    if (!charts.length) {
      grid.innerHTML = '<div class="card glass chart-card wide" style="text-align:center;padding:34px;color:var(--muted)">No charts in this snapshot.</div>';
    } else {
      grid.innerHTML = charts.map((c) => chartCardHTML(c.def, false)).join('');
    }
    const theme = chartTheme();
    for (const c of charts) {
      const def = c.def;
      const data = c.data;
      const canvasId = 'chart_' + def.id;
      if (!data || data.empty) {
        drawCanvasMessage(canvasId, Array.isArray(data?.empty) ? data.empty : [data ? data.empty : 'No data']);
        continue;
      }
      mkChart(canvasId, chartConfigFor(def, data, theme, canvasId));
    }
  }
}

/* helper: when viewing an 'all' snapshot and a viewer clicks a board, show that board's snapshot */
function openBoardSnapshot(boardRec) {
  const snap = pubState.snapshot;
  if (boardRec.charts) {
    pubState.currentBoard = boardRec;
    pubState.allSnapshot = snap;   /* remember parent for Back */
    const sub = {
      token: snap.token,
      boardId: boardRec.boardId,
      boardName: boardRec.name,
      scope: 'board',
      createdAt: snap.createdAt,
      issuesCount: boardRec.issuesCount,
      charts: boardRec.charts,
      hasChangelog: boardRec.hasChangelog,
    };
    pubState.snapshot = sub;
    renderPubContent();
    $('#pubBackBtn').dataset.fromAll = '1';
    $('#pubBackBtn').textContent = '← All boards';
  }
}

function hidePubScreen() {
  hide($( '#pubScreen'));
  /* clear the #p= hash so the URL no longer points to the share, then reload app */
  if (location.hash) location.hash = '';
  if (loadConn()) enterApp();
  else showSetup();
}

/* ── publish modal (admin only) ─────────────────────────────────────── */
let pubModalState = { mode: 'all' /* 'all' | 'board' */, boardId: null };

function openPublishModal() {
  const connected = state.conn && state.boards.length;
  if (!connected) {
    toast(state.conn ? 'No boards loaded yet.' : 'Connect to Jira first to create new snapshots — you can still manage existing ones.', 'warn');
  }

  /* hide the "create" area when not connected (admins can still copy/delete existing links) */
  const createWrap = $( '#pubCreateWrap');
  if (createWrap) createWrap.style.display = connected ? '' : 'none';
  if (connected) {
    $('#pubBoardSelect').innerHTML = state.boards.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  }

  const allSnapshots = listPublishSnapshots();
  $('#pubListBody').innerHTML = allSnapshots.length
    ? allSnapshots.map((s) => `<tr>
        <td>${escapeHtml(s.boardName)}</td>
        <td>${s.scope === 'all' ? 'all boards' : 'this board'}</td>
        <td>${new Date(s.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</td>
        <td><span class="mono">${escapeHtml(s.token)}</span></td>
        <td>
          <button class="link-btn" data-copy="${escapeHtml(s.token)}">copy link</button>
          <button class="link-btn" data-open="${s.token}" style="display:${connected ? '' : 'none'}">open</button>
          <button class="link-btn" data-del="${s.token}" style="color:#f87171">delete</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted" style="text-align:center;padding:14px">No published snapshots yet.</td></tr>';

  $('#pubListBody').querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', () => {
      const token = b.dataset.copy;
      const snap = allSnapshots.find((s) => s.token === token);
      const link = snap ? buildShareUrl(snap) : (location.origin + location.pathname + '?share=' + token);
      navigator.clipboard.writeText(link).then(() => toast('Link copied to clipboard.', 'ok')).catch(() => toast('Could not copy.', 'warn'));
    });
  });
  $('#pubListBody').querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => {
      const token = b.dataset.open;
      const snap = allSnapshots.find((s) => s.token === token);
      const link = snap ? buildShareUrl(snap) : (location.origin + location.pathname + '?share=' + token);
      window.open(link, '_blank');
    });
  });
  $('#pubListBody').querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', () => {
      deletePublishSnapshot(b.dataset.del);
      openPublishModal();
      toast('Snapshot deleted.', 'ok');
    });
  });

    $('#pubCreateBtn').textContent = 'Create snapshot';
    $('#pubModalTitle').textContent = connected ? 'Publish board stats' : 'Manage published snapshots';
    show($( '#pubModal'));
}

async function createSnapshotFromModal() {
  const scope = $( '#pubScope').querySelector('button.active').dataset.v;
  const boardId = scope === 'all' ? state.boardId : parseInt($( '#pubBoardSelect').value, 10);
  /* for 'all' scope the boardId is not required */
  if (scope === 'board' && !boardId) { toast('Select a board first.', 'warn'); return; }
  const btn = $( '#pubCreateBtn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const snap = await createPublishSnapshot(boardId, scope);
    if (!snap) { toast('Could not create snapshot.', 'warn'); return; }
    const link = buildShareUrl(snap);
    navigator.clipboard.writeText(link).then(() => toast('Snapshot created — link copied.', 'ok')).catch(() => toast('Snapshot created. Token: ' + snap.token, 'ok'));
    hide($( '#pubModal'));
    openPublishModal();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create snapshot';
  }
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
/* detect whether an issues list actually has changelog data */
function hasChangelogData(issues) {
  if (!issues || !issues.length) return false;
  for (const iss of issues) {
    if (iss.changelog && iss.changelog.histories && iss.changelog.histories.length) return true;
  }
  return false;
}

async function loadBoardIssues(board) {
  state.hasChangelog = true;
  state.boardLoadMeta = { source: '', note: '' };
  const ctx = await resolveBoardContext(board);

  const attempts = [
    {
      name: 'agile-changelog',
      run: () => fetchPaginated(`/rest/agile/1.0/board/${board.id}/issue?fields=${encodeURIComponent(ISSUE_FIELDS.join(','))}&expand=changelog`, 600),
      onSuccess: () => { state.hasChangelog = true; state.boardLoadMeta = { source: 'Agile board issues + changelog', note: '' }; },
      /* verify the result actually has changelog; if not, keep trying */
      verify: (issues) => hasChangelogData(issues),
      onVerifyFail: { source: 'Agile board issues (no changelog)', note: 'Changelog expansion returned no history. Trying alternative strategy.' },
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
      verify: (issues) => hasChangelogData(issues),
      onVerifyFail: { source: 'Board filter JQL (no changelog)', note: 'Search returned issues but no changelog history. Trying alternative strategy.' },
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
      /* if this strategy claims changelog, verify the data really has it */
      if (attempt.verify && !attempt.verify(issues)) {
        logDiag('warn', 'Strategy returned no changelog data, trying next', { strategy: attempt.name });
        if (attempt.onVerifyFail) state.boardLoadMeta = { source: attempt.onVerifyFail.source, note: attempt.onVerifyFail.note };
        lastErr = new Error(`${attempt.name}: no changelog in response`);
        continue;
      }
      attempt.onSuccess();
      logDiag('info', 'Board load succeeded', {
        boardId: board.id,
        strategy: attempt.name,
        issues: issues.length,
        hasChangelog: state.hasChangelog,
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
    state.lastBoard = board;
    state.lastMetrics = m;
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

/* ══════════════════ chart customization engine ══════════════════ */
const CHART_STORE_PREFIX = 'jp_charts_v1_';

/* metric catalogue: what a chart can show */
const METRIC_DEFS = {
  flow:          { label: 'Created vs resolved over time', kind: 'time' },
  created:       { label: 'Issues created over time',      kind: 'time' },
  resolved:      { label: 'Issues resolved over time',     kind: 'time' },
  count:         { label: 'Issue count by group',          kind: 'category' },
  avgCycle:      { label: 'Avg cycle time by group',       kind: 'category', duration: true, resolvedOnly: true },
  openAge:       { label: 'Current age of open issues',    kind: 'category', duration: true, openOnly: true },
  avgStatusTime: { label: 'Avg time in status by group',   kind: 'statusTime', duration: true },
};

const GROUP_LABELS = {
  time: 'Time', status: 'Status', assignee: 'Assignee', type: 'Issue type',
  priority: 'Priority', label: 'First label', bottleneck: 'Bottleneck stage',
  stage: 'Stakeholder vs team',
};

/* which groupings each metric kind supports */
const GROUPS_FOR_KIND = {
  time: [['time', 'Time (bucketed)']],
  category: [
    ['status', 'Status'], ['assignee', 'Assignee'], ['type', 'Issue type'],
    ['priority', 'Priority'], ['label', 'First label'], ['bottleneck', 'Bottleneck stage'],
  ],
  statusTime: [['status', 'Each status'], ['stage', 'Stakeholder vs team']],
};

const RANGE_OPTIONS = [
  [30, 'Last 30 days'], [90, 'Last 90 days'], [182, 'Last 6 months'],
  [365, 'Last 12 months'], [0, 'All time'],
];

const ACCENT_RGB = {
  indigo: '99,102,241', cyan: '34,211,238', green: '52,211,153',
  amber: '251,191,36', violet: '139,92,246', pink: '244,114,182',
};
const ACCENT_HEX = {
  indigo: '#6366f1', cyan: '#22d3ee', green: '#34d399',
  amber: '#fbbf24', violet: '#8b5cf6', pink: '#f472b6',
};

/* the built-in charts, expressed as editable definitions */
const BUILTIN_DEFS = [
  { id: 'pipeline', title: 'Incoming vs Completed', subtitle: 'Created vs resolved over time', type: 'line', metric: 'flow', groupBy: 'time', bucket: 'week', range: 182, filter: 'all', topN: 0, split: 'none', color: 'indigo', wide: true, centerTotal: false },
  { id: 'throughput', title: 'Weekly Throughput', subtitle: 'Resolved issues per week', type: 'bar', metric: 'resolved', groupBy: 'time', bucket: 'week', range: 84, filter: 'all', topN: 0, split: 'none', color: 'green', wide: true, centerTotal: false },
  { id: 'createdTrend', title: 'Issues Created', subtitle: 'Weekly creation trend', type: 'line', metric: 'created', groupBy: 'time', bucket: 'week', range: 182, filter: 'all', topN: 0, split: 'none', color: 'cyan', wide: false, centerTotal: false },
  { id: 'resolvedTrend', title: 'Issues Resolved', subtitle: 'Weekly resolution trend', type: 'line', metric: 'resolved', groupBy: 'time', bucket: 'week', range: 182, filter: 'all', topN: 0, split: 'none', color: 'green', wide: false, centerTotal: false },
  { id: 'bottlenecks', title: 'Active Bottlenecks', subtitle: 'Where open work is parked', type: 'doughnut', metric: 'count', groupBy: 'bottleneck', bucket: 'week', range: 0, filter: 'open', topN: 0, split: 'none', color: 'indigo', wide: false, centerTotal: true },
  { id: 'statusDist', title: 'Status Distribution', subtitle: 'All issues by current status', type: 'doughnut', metric: 'count', groupBy: 'status', bucket: 'week', range: 0, filter: 'all', topN: 8, split: 'none', color: 'violet', wide: false, centerTotal: true },
  { id: 'statusTime', title: 'Avg Time in Status', subtitle: 'Lifetime average per status · changelog', type: 'hbar', metric: 'avgStatusTime', groupBy: 'status', bucket: 'week', range: 0, filter: 'all', topN: 12, split: 'none', color: 'violet', wide: false, centerTotal: false },
  { id: 'phaseDelays', title: 'Stakeholder vs Team Delays', subtitle: 'Avg days per stage · stakeholder gates vs team work · changelog', type: 'hbar', metric: 'avgStatusTime', groupBy: 'status', bucket: 'week', range: 182, filter: 'all', topN: 8, split: 'stage', color: 'amber', wide: false, centerTotal: false },
  { id: 'typeDist', title: 'Issue Type Breakdown', subtitle: 'Open issues by type', type: 'doughnut', metric: 'count', groupBy: 'type', bucket: 'week', range: 0, filter: 'open', topN: 8, split: 'none', color: 'cyan', wide: false, centerTotal: true },
  { id: 'assigneeLoad', title: 'Assignee Workload', subtitle: 'Open issues per assignee', type: 'hbar', metric: 'count', groupBy: 'assignee', bucket: 'week', range: 0, filter: 'open', topN: 12, split: 'none', color: 'pink', wide: false, centerTotal: false },
  { id: 'priorityDist', title: 'Priority Distribution', subtitle: 'Open issues by priority', type: 'doughnut', metric: 'count', groupBy: 'priority', bucket: 'week', range: 0, filter: 'open', topN: 8, split: 'none', color: 'amber', wide: false, centerTotal: true },
  { id: 'ageDist', title: 'Open Issue Age', subtitle: 'How long issues have been open', type: 'hbar', metric: 'openAge', groupBy: 'assignee', bucket: 'week', range: 0, filter: 'open', topN: 10, split: 'none', color: 'green', wide: false, centerTotal: false },
];

function chartStoreKey() { return CHART_STORE_PREFIX + (state.conn?.domain || 'default'); }

function loadChartStore() {
  try {
    return { custom: [], overrides: {}, hidden: [], ...JSON.parse(localStorage.getItem(chartStoreKey()) || '{}') };
  } catch (_) {
    return { custom: [], overrides: {}, hidden: [] };
  }
}

function saveChartStore(s) { localStorage.setItem(chartStoreKey(), JSON.stringify(s)); }

/* built-ins (with overrides) + custom charts visible for the current board */
function effectiveCharts() {
  const store = loadChartStore();
  const list = [];
  for (const b of BUILTIN_DEFS) {
    if (store.hidden.includes(b.id)) continue;
    list.push({ ...b, ...(store.overrides[b.id] || {}), builtin: true, scope: 'global' });
  }
  for (const c of store.custom) {
    if (c.scope === 'board' && c.boardId !== state.boardId) continue;
    list.push({ ...c, builtin: false });
  }
  return list;
}

/* ── data engine: definition → {labels, datasets, colors, ...} ──── */
function statusIsDone(f) {
  return f.status?.statusCategory?.key === 'done'
    || String(f.status?.statusCategory?.name || '').toLowerCase() === 'done';
}

function groupKeyOf(def, f) {
  switch (def.groupBy) {
    case 'assignee': return f.assignee?.displayName || 'Unassigned';
    case 'type': return f.issuetype?.name || 'Task';
    case 'priority': return f.priority?.name || 'None';
    case 'label': return Array.isArray(f.labels) && f.labels.length ? f.labels[0] : 'No label';
    case 'bottleneck': return classifyBottleneck(f.status?.name);
    default: return f.status?.name || 'Unknown';
  }
}

function filterPool(def, issues) {
  if (def.filter === 'open') return issues.filter((i) => !statusIsDone(i.fields || {}));
  if (def.filter === 'done') return issues.filter((i) => statusIsDone(i.fields || {}));
  return issues;
}

function rangeLabel(days) {
  if (!days) return 'all time';
  if (days <= 30) return 'last 30 days';
  if (days <= 90) return 'last 90 days';
  if (days <= 200) return 'last 6 months';
  return 'last 12 months';
}

/* build time-bucketed series for created / resolved / flow */
function buildTimeSeries(def, issues) {
  const NOW = Date.now();
  const wantCreated = def.metric !== 'resolved';
  const wantResolved = def.metric !== 'created';
  let rangeDays = def.range || 0;

  let oldest = Infinity;
  for (const iss of issues) {
    const f = iss.fields || {};
    if (wantCreated && f.created) oldest = Math.min(oldest, Date.parse(f.created));
    if (wantResolved && f.resolutiondate) oldest = Math.min(oldest, Date.parse(f.resolutiondate));
  }
  if (!isFinite(oldest)) return { empty: 'No dated issues found for this chart' };
  if (!rangeDays) rangeDays = Math.ceil((NOW - oldest) / DAY) + 1;
  rangeDays = Math.max(7, rangeDays);

  /* pick bucket size, auto-upgrading so we never draw 400 bars */
  let bucket = def.bucket || 'week';
  let nBuckets = bucket === 'day' ? rangeDays : bucket === 'week' ? Math.ceil(rangeDays / 7) : Math.ceil(rangeDays / 30.4);
  if (bucket === 'day' && nBuckets > 120) { bucket = 'week'; nBuckets = Math.ceil(rangeDays / 7); }
  if (bucket === 'week' && nBuckets > 104) { bucket = 'month'; nBuckets = Math.ceil(rangeDays / 30.4); }
  nBuckets = Math.min(nBuckets, 400);
  const bucketMs = bucket === 'day' ? DAY : 7 * DAY;

  const createdCounts = Array(nBuckets).fill(0);
  const resolvedCounts = Array(nBuckets).fill(0);
  const nowMonthIdx = new Date(NOW).getFullYear() * 12 + new Date(NOW).getMonth();

  for (const iss of issues) {
    const f = iss.fields || {};
    if (wantCreated && f.created) {
      const ts = Date.parse(f.created);
      let idx;
      if (bucket === 'month') {
        const d = new Date(ts);
        idx = nBuckets - 1 - (nowMonthIdx - (d.getFullYear() * 12 + d.getMonth()));
      } else {
        idx = nBuckets - 1 - Math.floor((NOW - ts) / bucketMs);
      }
      if (idx >= 0 && idx < nBuckets) createdCounts[idx]++;
    }
    if (wantResolved && f.resolutiondate) {
      const ts = Date.parse(f.resolutiondate);
      let idx;
      if (bucket === 'month') {
        const d = new Date(ts);
        idx = nBuckets - 1 - (nowMonthIdx - (d.getFullYear() * 12 + d.getMonth()));
      } else {
        idx = nBuckets - 1 - Math.floor((NOW - ts) / bucketMs);
      }
      if (idx >= 0 && idx < nBuckets) resolvedCounts[idx]++;
    }
  }

  const labels = [];
  for (let i = 0; i < nBuckets; i++) {
    if (bucket === 'month') {
      const back = nBuckets - 1 - i;
      const d = new Date(NOW);
      d.setMonth(d.getMonth() - back);
      labels.push(d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }));
    } else {
      labels.push(fmtDate(NOW - (nBuckets - 1 - i) * bucketMs));
    }
  }

  const datasets = [];
  if (wantCreated) datasets.push({ label: 'Registered', data: createdCounts, color: '#6366f1', rgb: ACCENT_RGB.indigo });
  if (wantResolved) datasets.push({ label: 'Completed', data: resolvedCounts, color: '#34d399', rgb: ACCENT_RGB.green });

  const parts = [];
  if (wantCreated && wantResolved) parts.push('registered vs completed');
  else if (wantCreated) parts.push('created');
  else parts.push('resolved');
  const subtitle = `${parts.join(' · ')} · per ${bucket} · ${rangeLabel(def.range)}`;

  const total = (wantCreated ? createdCounts : resolvedCounts).reduce((a, b) => a + b, 0);
  return {
    labels, datasets, duration: false,
    subtitle,
    centerValue: total, centerLabel: 'issues',
  };
}

/* category aggregation: count / avgCycle / openAge */
function buildCategoryData(def, issues) {
  const metric = METRIC_DEFS[def.metric];
  const NOW = Date.now();
  const pool = filterPool(def, issues);
  const map = new Map();
  for (const iss of pool) {
    const f = iss.fields || {};
    let val;
    if (def.metric === 'count') val = 1;
    else if (def.metric === 'avgCycle') {
      if (!f.resolutiondate || !f.created) continue;
      val = Date.parse(f.resolutiondate) - Date.parse(f.created);
    } else if (def.metric === 'openAge') {
      if (!f.created) continue;
      val = Math.max(0, NOW - Date.parse(f.created));
    }
    if (val == null || !isFinite(val)) continue;
    const key = groupKeyOf(def, f);
    const rec = map.get(key) || { sum: 0, n: 0 };
    rec.sum += val; rec.n++;
    map.set(key, rec);
  }
  if (!map.size) return { empty: def.metric === 'avgCycle' ? 'No resolved issues to measure yet' : 'No issues match this chart yet' };

  let rows = [...map.entries()].map(([k, r]) => ({
    k, v: metric.duration ? r.sum / r.n : r.sum, n: r.n,
  }));
  if (def.groupBy === 'bottleneck') rows.sort((a, b) => BOTTLENECK_ORDER.indexOf(a.k) - BOTTLENECK_ORDER.indexOf(b.k));
  else rows.sort((a, b) => b.v - a.v);

  let labels = rows.map((r) => r.k);
  let values = rows.map((r) => metric.duration ? +(r.v / DAY).toFixed(2) : r.v);
  let colors;
  if (def.groupBy === 'bottleneck') colors = labels.map(bottleneckColor);
  else if (def.groupBy === 'stage') colors = labels.map((k) => (k === 'Stakeholder gates' ? '#fbbf24' : '#22d3ee'));
  else colors = labels.map((_, i) => PALETTE[i % PALETTE.length]);

  /* topN: doughnuts fold the tail into "Other", bars simply cut */
  const topN = def.topN || 0;
  if (topN && values.length > topN) {
    if (def.type === 'doughnut') {
      const headL = labels.slice(0, topN - 1), headV = values.slice(0, topN - 1);
      const rest = values.slice(topN - 1).reduce((a, b) => a + b, 0);
      labels = headL.concat(['Other']);
      values = headV.concat([rest]);
      colors = colors.slice(0, topN - 1).concat(['#64748b']);
    } else {
      labels = labels.slice(0, topN); values = values.slice(0, topN); colors = colors.slice(0, topN);
    }
  }
  if (def.type === 'hbar') { labels = labels.slice().reverse(); values = values.slice().reverse(); colors = colors.slice().reverse(); }

  const totalVal = metric.duration
    ? [...map.values()].reduce((a, r) => a + r.sum, 0) / [...map.values()].reduce((a, r) => a + r.n, 0)
    : values.reduce((a, b) => a + b, 0);

  const filterTxt = def.filter === 'open' ? ' · open only' : def.filter === 'done' ? ' · done only' : '';
  const subtitle = `${metric.duration ? 'avg' : 'count'} by ${GROUP_LABELS[def.groupBy] || def.groupBy}${metric.duration ? '' : filterTxt}`;
  return {
    labels,
    datasets: [{ label: def.title, data: values, color: ACCENT_HEX[def.color] || ACCENT_HEX.indigo, rgb: ACCENT_RGB[def.color] || ACCENT_RGB.indigo }],
    colors,
    duration: metric.duration,
    subtitle,
    centerValue: metric.duration ? fmtDuration(totalVal) : Math.round(totalVal),
    centerLabel: metric.duration ? 'avg' : 'issues',
  };
}

/* status-time aggregation from changelog (avgStatusTime metric) */
function buildStatusTimeData(def, m, hasChangelog) {
  const hc = hasChangelog != null ? hasChangelog : state.hasChangelog;
  if (!hc || !m || !m.statusTime) return { empty: ['Changelog unavailable on this board', '— status-time charts need it'] };

  let rows = [...m.statusTime.entries()]
    .map(([k, v]) => ({ k, avg: v.sum / v.n, side: classifySide(k), sum: v.sum, n: v.n }));
  if (!rows.length) return { empty: ['No status transition data found'] };

  let extraSub = '';
  let labels, values, colors;

  if (def.groupBy === 'stage') {
    const agg = { 'Stakeholder gates': { sum: 0, n: 0 }, 'Team phases': { sum: 0, n: 0 } };
    for (const r of rows) {
      if (!r.side) continue;
      const t = r.side === 'stakeholder' ? 'Stakeholder gates' : 'Team phases';
      agg[t].sum += r.sum; agg[t].n += r.n;
    }
    rows = Object.entries(agg).filter(([, r]) => r.n).map(([k, r]) => ({ k, avg: r.sum / r.n }));
    if (!rows.length) return { empty: ['No stakeholder / team stage transitions detected'] };
    rows.sort((a, b) => b.avg - a.avg);
    labels = rows.map((r) => r.k);
    values = rows.map((r) => +(r.avg / DAY).toFixed(2));
    colors = labels.map((k) => (k === 'Stakeholder gates' ? '#fbbf24cc' : '#22d3eecc'));
  } else if (def.split === 'stage') {
    const picked = rows.filter((r) => r.side).sort((a, b) => b.avg - a.avg).slice(0, def.topN || 8);
    if (!picked.length) return { empty: ['No stakeholder / team stage transitions detected'] };
    const sh = [], tm = [];
    picked.forEach((r) => {
      const d = +(r.avg / DAY).toFixed(1);
      if (r.side === 'stakeholder') { sh.push(d); tm.push(null); }
      else { tm.push(d); sh.push(null); }
    });
    labels = picked.map((r) => titleize(r.k)).reverse();
    let shAvg = null, tmAvg = null, sS = 0, sN = 0, tS = 0, tN = 0;
    picked.forEach((r) => { if (r.side === 'stakeholder') { sS += r.sum; sN++; } else { tS += r.sum; tN++; } });
    if (sN) shAvg = sS / sN;
    if (tN) tmAvg = tS / tN;
    extraSub =
      `<span style="color:#fcd34d">●</span> Stakeholder gates avg <b>${shAvg != null ? fmtDuration(shAvg) : '—'}</b>` +
      ` &nbsp;·&nbsp; <span style="color:#67e8f9">●</span> Team phases avg <b>${tmAvg != null ? fmtDuration(tmAvg) : '—'}</b>`;
    return {
      labels,
      datasets: [
        { label: 'Stakeholder gate', data: sh.reverse(), color: '#fbbf24', rgb: ACCENT_RGB.amber },
        { label: 'Team phase', data: tm.reverse(), color: '#22d3ee', rgb: ACCENT_RGB.cyan },
      ],
      duration: true,
      subtitle: 'avg days parked per stage · changelog',
      extraSub,
    };
  } else {
    rows.sort((a, b) => b.avg - a.avg);
    rows = rows.slice(0, def.topN || 10);
    labels = rows.map((r) => r.k).reverse();
    values = rows.map((r) => +(r.avg / DAY).toFixed(2)).reverse();
    colors = labels.map(() => (ACCENT_HEX[def.color] || '#8b5cf6') + 'cc');
  }

  return {
    labels,
    datasets: [{ label: def.title, data: values, color: ACCENT_HEX[def.color] || ACCENT_HEX.violet, rgb: ACCENT_RGB[def.color] || ACCENT_RGB.violet }],
    colors,
    duration: true,
    subtitle: def.groupBy === 'stage' ? 'avg days · stakeholder vs team · changelog' : 'avg days per status · lifetime · changelog',
    extraSub,
  };
}

function buildChartData(def, m, issues, hasChangelog) {
  const metric = METRIC_DEFS[def.metric];
  const iss = issues || state.issues;
  const hc = hasChangelog != null ? hasChangelog : state.hasChangelog;
  if (!metric) return { empty: ['Unknown metric'] };
  if (metric.kind === 'time') return buildTimeSeries(def, iss);
  if (metric.kind === 'statusTime') return buildStatusTimeData(def, m, hc);
  return buildCategoryData(def, iss);
}

/* ── chart card rendering ────────────────────────────────────────── */
const LEGEND_ON = { display: true, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, padding: 14 } };

function chartCardHTML(def, overridden) {
  const scopeClass = def.scope === 'global' ? ' global' : '';
  const scopeChip = def.builtin
    ? ''
    : `<span class="scope-chip${scopeClass}">${def.scope === 'global' ? 'all boards' : 'this board'}</span>`;
  const actions = def.builtin
    ? `<button class="chart-btn" data-act="edit" data-id="${def.id}" title="Configure this chart">✎</button>` +
      (overridden ? `<button class="chart-btn" data-act="reset" data-id="${def.id}" title="Reset to default">↺</button>` : '') +
      `<button class="chart-btn" data-act="hide" data-id="${def.id}" title="Hide this chart">✕</button>`
    : `<button class="chart-btn" data-act="edit" data-id="${def.id}" title="Configure this chart">✎</button>` +
      `<button class="chart-btn" data-act="del" data-id="${def.id}" title="Delete this chart">🗑</button>`;
  return `<div class="card glass chart-card${def.wide ? ' wide' : ''}" data-cid="${def.id}">
    <div class="chart-head">
      <div class="chart-titles">
        <h3>${escapeHtml(def.title)} ${scopeChip}</h3>
        <span class="chart-sub" id="sub_${def.id}">${escapeHtml(def.subtitle || '')}</span>
      </div>
      <div class="chart-actions">${actions}</div>
    </div>
    <div class="canvas-wrap"><canvas id="chart_${def.id}"></canvas></div>
  </div>`;
}

function chartConfigFor(def, data, theme, canvasId) {
  const dur = data.duration;
  const fmtV = dur ? (v) => fmtDuration(v * DAY) : (v) => String(Math.round(v));

  if (def.type === 'doughnut') {
    return {
      type: 'doughnut',
      data: {
        labels: data.labels,
        datasets: [{
          data: data.datasets[0].data,
          backgroundColor: data.colors,
          borderColor: 'rgba(10,15,34,.9)',
          borderWidth: 3,
          hoverOffset: 8,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: def.centerTotal ? '68%' : '62%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 9, boxHeight: 9, usePointStyle: true, padding: 12 } },
          tooltip: {
            ...theme.plugins.tooltip,
            callbacks: {
              label: (c) => {
                const tot = c.dataset.data.reduce((a, b) => a + b, 0);
                const pct = tot ? Math.round(c.parsed / tot * 100) : 0;
                return ` ${fmtV(c.parsed)} · ${pct}%`;
              },
            },
          },
          centerText: def.centerTotal ? { enable: true, value: data.centerValue, label: data.centerLabel } : { enable: false },
        },
      },
    };
  }

  if (def.type === 'line') {
    const el = document.getElementById(canvasId);
    const ctx = el ? el.getContext('2d') : null;
    const grad = (rgb) => {
      if (!ctx) return `rgba(${rgb},.15)`;
      const g = ctx.createLinearGradient(0, 0, 0, 280);
      g.addColorStop(0, `rgba(${rgb},.28)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      return g;
    };
    return {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: data.datasets.map((ds) => ({
          label: ds.label, data: ds.data,
          borderColor: ds.color, backgroundColor: grad(ds.rgb),
          fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2.5,
        })),
      },
      options: {
        ...theme,
        interaction: { mode: 'index', intersect: false },
        plugins: { ...theme.plugins, legend: data.datasets.length > 1 ? LEGEND_ON : { display: false } },
      },
    };
  }

  /* bar / hbar */
  const isH = def.type === 'hbar';
  const multi = data.datasets.length > 1;
  return {
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: data.datasets.map((ds) => ({
        label: ds.label, data: ds.data,
        backgroundColor: multi ? ds.color + 'cc' : (data.colors && data.colors.length === data.labels.length ? data.colors : ds.color + 'cc'),
        hoverBackgroundColor: multi ? ds.color : (data.colors && data.colors.length === data.labels.length ? data.colors : ds.color),
        borderRadius: 7, borderSkipped: false,
        barPercentage: multi ? 0.6 : 0.72, categoryPercentage: 0.74,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      indexAxis: isH ? 'y' : 'x',
      plugins: {
        legend: multi ? LEGEND_ON : { display: false },
        tooltip: { ...theme.plugins.tooltip, callbacks: { label: (c) => c.parsed[isH ? 'x' : 'y'] != null ? fmtV(c.parsed[isH ? 'x' : 'y']) : '' } },
      },
      scales: isH
        ? {
            x: { ...theme.scales.x, ...(dur ? { ticks: { callback: (v) => v + 'd' } } : {}) },
            y: { grid: { display: false }, ticks: { precision: 0 } },
          }
        : theme.scales,
    },
  };
}

function renderCharts(defs, m) {
  const grid = $('#chartsGrid');
  const store = loadChartStore();

  Object.values(state.charts).forEach((c) => c && c.destroy());
  state.charts = {};

  if (!defs.length) {
    grid.innerHTML = '<div class="card glass chart-card wide" style="text-align:center;padding:34px;color:var(--muted)">No charts on this board yet — click <b>＋ New chart</b> to build one.</div>';
  } else {
    grid.innerHTML = defs.map((d) => chartCardHTML(d, !d.builtin ? false : !!store.overrides[d.id])).join('');
  }

  /* hidden built-ins restore strip */
  const strip = $('#hiddenChartsStrip');
  if (store.hidden.length) {
    strip.innerHTML = 'Hidden charts: ' + store.hidden.map((id) => {
      const b = BUILTIN_DEFS.find((x) => x.id === id);
      return `<button class="link-btn" data-restore="${id}">${escapeHtml(b ? b.title : id)} ↺</button>`;
    }).join(' ');
    show(strip);
  } else {
    hide(strip);
  }

  const theme = chartTheme();
  for (const def of defs) {
    const canvasId = 'chart_' + def.id;
    const data = buildChartData(def, m);
    const sub = document.getElementById('sub_' + def.id);
    if (sub) {
      const base = data.subtitle || def.subtitle || '';
      sub.innerHTML = escapeHtml(base) + (data.extraSub ? ` <span class="sub-extra">· ${data.extraSub}</span>` : '');
    }
    
    /* add data availability badge */
    const card = document.querySelector(`.chart-card[data-cid="${def.id}"]`);
    if (card) {
      const badgeContainer = card.querySelector('.chart-titles');
      if (badgeContainer) {
        const badge = getDataAvailabilityBadge(def, data, m);
        if (badge) badgeContainer.insertAdjacentHTML('beforeend', badge);
      }
    }

    if (data.empty) {
      drawCanvasMessage(canvasId, Array.isArray(data.empty) ? data.empty : [data.empty]);
      if (card) card.classList.add('empty');
      continue;
    }
    if (card) card.classList.remove('empty');
    mkChart(canvasId, chartConfigFor(def, data, theme, canvasId));
  }

  /* per-card actions */
  grid.querySelectorAll('.chart-btn').forEach((btn) => {
    btn.addEventListener('click', () => onChartAction(btn.dataset.act, btn.dataset.id));
  });
  strip.querySelectorAll('[data-restore]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = loadChartStore();
      s.hidden = s.hidden.filter((id) => id !== btn.dataset.restore);
      saveChartStore(s);
      rerenderDashboard();
      toast('Chart restored.', 'ok');
    });
  });
}

/* determine if a chart will have meaningful data */
function getDataAvailabilityBadge(def, data, m) {
  if (data.empty) {
    if (def.metric === 'avgStatusTime' || def.split === 'stage') {
      if (!state.hasChangelog) {
        return `<span class="data-badge missing" title="Changelog not available for this board">⚠ No changelog</span>`;
      }
    }
    if (def.metric === 'openAge' || def.filter === 'open') {
      if (!m.wip) return `<span class="data-badge missing" title="No open issues on this board">⚠ No open issues</span>`;
    }
    return `<span class="data-badge warn" title="No data matches the current filters">⚠ No data</span>`;
  }
  if (def.metric === 'avgStatusTime' || def.split === 'stage') {
    if (!state.hasChangelog) {
      return `<span class="data-badge missing" title="Changelog not available for this board">⚠ No changelog</span>`;
    }
    return `<span class="data-badge ok" title="Changelog data available">✓ Changelog</span>`;
  }
  return '';
}

function onChartAction(act, id) {
  const store = loadChartStore();
  const builtin = BUILTIN_DEFS.find((b) => b.id === id);
  const custom = store.custom.find((c) => c.id === id);
  if (act === 'edit') {
    if (builtin) openChartModal({ ...builtin, ...(store.overrides[id] || {}) }, { mode: 'builtin' });
    else if (custom) openChartModal({ ...custom }, { mode: 'custom' });
  } else if (act === 'hide') {
    store.hidden = [...new Set([...store.hidden, id])];
    saveChartStore(store);
    rerenderDashboard();
    toast('Chart hidden — restore it from the link below the grid.');
  } else if (act === 'reset') {
    delete store.overrides[id];
    store.hidden = store.hidden.filter((x) => x !== id);
    saveChartStore(store);
    rerenderDashboard();
    toast('Chart reset to default.', 'ok');
  } else if (act === 'del') {
    if (!custom) return;
    if (!confirm(`Delete chart "${custom.title}"?`)) return;
    store.custom = store.custom.filter((c) => c.id !== id);
    saveChartStore(store);
    rerenderDashboard();
    toast('Chart deleted.', 'ok');
  }
}

function rerenderDashboard() {
  if (state.lastBoard && state.lastMetrics) renderDashboard(state.lastBoard, state.lastMetrics);
}

/* ── chart builder modal ─────────────────────────────────────────── */
state.chartEditing = null;

function segSet(segEl, value) {
  segEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === value));
}
function segGet(segEl) {
  return segEl.querySelector('button.active')?.dataset.v || null;
}

function buildSeg(el, options, value) {
  el.innerHTML = options.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('');
  segSet(el, value);
}

function openChartModal(def, meta) {
  state.chartEditing = { ...meta, def: { ...def } };
  $('#chartModalTitle').textContent =
    meta.mode === 'new' ? 'New chart' :
    meta.mode === 'builtin' ? `Configure “${def.title}”` : `Configure “${def.title}”`;

  $('#cTitle').value = def.title || '';
  buildSeg($('#cType'), [['line', 'Line'], ['bar', 'Bars'], ['hbar', 'Horizontal'], ['doughnut', 'Donut']], def.type || 'bar');
  buildSeg($('#cScope'), [['board', 'This board only'], ['global', 'All boards']], def.scope === 'global' ? 'global' : 'board');

  $('#cMetric').innerHTML = Object.entries(METRIC_DEFS)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  $('#cMetric').value = def.metric || 'count';
  $('#cRange').innerHTML = RANGE_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('#cRange').value = String(def.range ?? 90);
  $('#cBucket').value = def.bucket || 'week';
  $('#cFilter').value = def.filter || 'all';
  $('#cSplit').value = def.split || 'none';
  $('#cColor').value = def.color || 'indigo';
  $('#cTop').value = String(def.topN || 8);
  $('#cWide').checked = !!def.wide;

  $('#scopeNote').classList.toggle('hidden', meta.mode === 'new');
  $('#resetChartBtn').classList.toggle('hidden', meta.mode !== 'builtin');
  $('#deleteChartBtn').classList.toggle('hidden', meta.mode !== 'custom');

  syncChartForm();
  show($('#chartModal'));
}

/* enable/disable form fields based on the chosen metric */
function syncChartForm() {
  const metric = $('#cMetric').value;
  const md = METRIC_DEFS[metric];
  const kind = md.kind;

  const groupWrap = $('#cGroupWrap');
  groupWrap.classList.toggle('hidden', kind === 'time');
  if (kind !== 'time') {
    const opts = GROUPS_FOR_KIND[kind] || GROUPS_FOR_KIND.category;
    const cur = $('#cGroup').value;
    $('#cGroup').innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    if (opts.some(([v]) => v === cur)) $('#cGroup').value = cur;
  }

  $('#cBucketWrap').classList.toggle('hidden', kind !== 'time');
  $('#cSplitWrap').classList.toggle('hidden', !(metric === 'avgStatusTime' && $('#cGroup').value === 'status'));
  $('#cRangeWrap').classList.toggle('hidden', metric === 'avgStatusTime');
  $('#cFilterWrap').classList.toggle('hidden', kind !== 'category');
  $('#cTopWrap').classList.toggle('hidden', kind === 'time' || $('#cType').value === 'line');
  $('#cColorWrap').classList.toggle('hidden', $('#cType').value === 'doughnut');

  /* smart defaults when metric changes */
  if (kind === 'time') {
    if (!['line', 'bar'].includes($('#cType').value)) {
      $('#cType').querySelector('[data-v="line"]').click();
    }
  } else if (kind === 'statusTime') {
    if ($('#cType').value !== 'hbar') {
      $('#cType').querySelector('[data-v="hbar"]').click();
    }
  }

  /* update subtitle hint */
  updateSubtitleHint(md, kind);
}

/* subtitle hint based on metric + grouping */
function updateSubtitleHint(md, kind) {
  const hintEl = $('#subtitleHint');
  if (!hintEl) return;
  let hint = '';
  if (kind === 'time') {
    hint = 'Shows a time series. Choose bucket (day/week/month) and range.';
  } else if (kind === 'statusTime') {
    hint = 'Requires changelog data. Shows average days issues spend in each status.';
  } else if (kind === 'category') {
    if (md.openOnly) {
      hint = 'Shows age of currently open issues. Groups by assignee, status, etc.';
    } else if (md.resolvedOnly) {
      hint = 'Shows cycle time for resolved issues only.';
    } else {
      hint = 'Counts issues in each group. Use filter for open/done/all.';
    }
  }
  hintEl.textContent = hint;
}

function chartDefFromForm(base) {
  const def = { ...(base || {}) };
  def.title = $('#cTitle').value.trim() || 'Untitled chart';
  def.type = segGet($('#cType')) || 'bar';
  def.metric = $('#cMetric').value;
  def.groupBy = METRIC_DEFS[def.metric].kind === 'time' ? 'time' : $('#cGroup').value;
  def.range = parseInt($('#cRange').value, 10) || 0;
  def.bucket = $('#cBucket').value;
  def.filter = $('#cFilter').value;
  def.split = $('#cSplit').value;
  def.color = $('#cColor').value;
  def.topN = parseInt($('#cTop').value, 10) || 0;
  def.wide = $('#cWide').checked;
  return def;
}

function saveChartFromForm() {
  const edit = state.chartEditing;
  if (!edit) return;

  // validation
  const title = $('#cTitle').value.trim();
  if (!title) {
    $('#cTitle').focus();
    toast('Please enter a chart title.', 'warn');
    return;
  }

  const store = loadChartStore();
  if (edit.mode === 'new') {
    const def = chartDefFromForm({
      id: 'c' + Date.now().toString(36),
      scope: segGet($('#cScope')) === 'global' ? 'global' : 'board',
      boardId: state.boardId,
    });
    if (def.scope === 'global') def.boardId = null;
    store.custom.push(def);
    toast('Chart added to ' + (def.scope === 'global' ? 'all boards' : 'this board') + '.', 'ok');
  } else if (edit.mode === 'custom') {
    const def = chartDefFromForm(edit.def);
    def.scope = segGet($('#cScope')) === 'global' ? 'global' : 'board';
    def.boardId = def.scope === 'global' ? null : state.boardId;
    store.custom = store.custom.map((c) => (c.id === def.id ? def : c));
    toast('Chart updated.', 'ok');
  } else if (edit.mode === 'builtin') {
    const def = chartDefFromForm(edit.def);
    const override = {};
    for (const k of ['title', 'subtitle', 'type', 'metric', 'groupBy', 'bucket', 'range', 'filter', 'topN', 'split', 'color', 'wide', 'centerTotal']) {
      override[k] = def[k];
    }
    store.overrides[edit.def.id] = override;
    store.hidden = store.hidden.filter((x) => x !== edit.def.id);
    toast('Chart updated for all boards.', 'ok');
  }
  saveChartStore(store);
  hide($('#chartModal'));
  state.chartEditing = null;
  rerenderDashboard();
}

function resetChartFromModal() {
  const edit = state.chartEditing;
  if (!edit || edit.mode !== 'builtin') return;
  const store = loadChartStore();
  delete store.overrides[edit.def.id];
  store.hidden = store.hidden.filter((x) => x !== edit.def.id);
  saveChartStore(store);
  hide($('#chartModal'));
  state.chartEditing = null;
  rerenderDashboard();
  toast('Chart reset to default.', 'ok');
}

function deleteChartFromModal() {
  const edit = state.chartEditing;
  if (!edit || edit.mode !== 'custom') return;
  const store = loadChartStore();
  store.custom = store.custom.filter((c) => c.id !== edit.def.id);
  saveChartStore(store);
  hide($('#chartModal'));
  state.chartEditing = null;
  rerenderDashboard();
  toast('Chart deleted.', 'ok');
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

  /* dynamic charts (built-in + custom, per-board/global) */
  renderCharts(effectiveCharts(), m);

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

  /* chart builder modal wiring */
  $('#addChartBtn').addEventListener('click', () => {
    const def = {
      title: 'New chart', type: 'bar', metric: 'count', groupBy: 'status',
      range: 90, bucket: 'week', filter: 'all', topN: 8, split: 'none',
      color: 'indigo', wide: false, scope: 'board',
    };
    openChartModal(def, { mode: 'new' });
  });
  $('#saveChartBtn').addEventListener('click', saveChartFromForm);
  $('#resetChartBtn').addEventListener('click', resetChartFromModal);
  $('#deleteChartBtn').addEventListener('click', deleteChartFromModal);
  $('#closeChartBtn').addEventListener('click', () => { hide($('#chartModal')); state.chartEditing = null; });
  $('#chartModal').addEventListener('click', (ev) => {
    if (ev.target === $('#chartModal')) { hide($('#chartModal')); state.chartEditing = null; }
  });
  ['#cMetric', '#cGroup', '#cType'].forEach((sel) => {
    $(sel).addEventListener('change', syncChartForm);
  });

  /* publish modal wiring */
  $('#publishBtn').addEventListener('click', openPublishModal);
  $('#publishAllBtn').addEventListener('click', async () => {
    if (!state.conn) { toast('Connect to Jira first.', 'warn'); return; }
    if (!state.boards.length) { toast('No boards loaded yet.', 'warn'); return; }
    const btn = $( '#publishAllBtn');
    btn.disabled = true;
    btn.textContent = 'Publishing…';
    try {
      const snap = await createAllBoardsSnapshot();
      if (!snap) return;
      const link = buildShareUrl(snap);
      navigator.clipboard.writeText(link).then(() => toast('All boards published — link copied.', 'ok')).catch(() => toast('All boards published. Token: ' + snap.token, 'ok'));
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ Publish all';
    }
  });
  $('#closePubBtn').addEventListener('click', () => hide($( '#pubModal')));
  $('#pubModal').addEventListener('click', (ev) => {
    if (ev.target === $( '#pubModal')) hide($( '#pubModal'));
  });
  $('#pubCreateBtn').addEventListener('click', createSnapshotFromModal);
  $( '#pubScope').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    $( '#pubScope').querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const scope = btn.dataset.v;
    $( '#pubBoardSelectWrap').classList.toggle('hidden', scope !== 'board');
  });

  /* public share screen wiring */
  $('#pubSendBtn').addEventListener('click', pubSendCode);
  $('#pubVerifyBtn').addEventListener('click', pubVerifyCode);
  $('#pubManageBtn').addEventListener('click', () => {
    /* admin can manage snapshots even if viewing from a share link without a live connection */
    openPublishModal();
  });
  $('#pubCopyLinkBtn').addEventListener('click', () => {
    const val = $('#pubLinkInput').value;
    if (val) navigator.clipboard.writeText(val).then(() => toast('Share link copied.', 'ok')).catch(() => toast('Could not copy.', 'warn'));
  });
  $('#pubBackBtn').addEventListener('click', () => {
    /* if we drilled into a board from an all-boards snapshot, go back to the list */
    if ($('#pubBackBtn').dataset.fromAll === '1' && pubState.snapshot.scope === 'board' && pubState.allSnapshot) {
      pubState.snapshot = pubState.allSnapshot;
      pubState.currentBoard = null;
      pubState.allSnapshot = null;
      $('#pubBackBtn').dataset.fromAll = '';
      $('#pubBackBtn').textContent = '← Back';
      renderPubContent();
      return;
    }
    hidePubScreen();
  });
  $('#pubEmail').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') pubSendCode();
  });
  $('#pubCode').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') pubVerifyCode();
  });

  /* initialize Google sign-in button (only on the share screen) */
  initGoogleButton();

  /* load a shared snapshot — self-contained (#p=) or legacy token (?share=) */
  const loadedSnap = loadShareSnapshot();
  if (loadedSnap) {
    showPubScreen(loadedSnap);
    /* if this browser also has a previously saved Jira session, keep it ready in the background */
    const bg = loadConn();
    if (bg) { state.conn = bg; }
  } else {
    // no share link — restore previous session silently
    const saved = loadConn();
    if (saved) {
      state.conn = saved;
      enterApp();
      api('/rest/api/3/myself')
        .catch((e) => handleAuthError(e));
    } else {
      showSetup();
    }
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
