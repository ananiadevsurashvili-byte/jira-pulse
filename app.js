/* ══════════════════════ JiraPulse · app logic ══════════════════════ */
'use strict';

/* set when served from /admin/ — this is the admin panel, so the admin UI is always on
   and the brand links back to the public app's boards page */
const ADMIN_PANEL = typeof window.ADMIN_PANEL !== 'undefined' && window.ADMIN_PANEL === true;

/* ── helpers ─────────────────────────────────────────────────────── */
const $ = (s) => document.querySelector(s);
const DAY = 86400000;
const LS_CONN = 'jp_conn_v1';
const LS_RELAY = 'jp_relay_v1';
const LS_LAST_BOARD = 'jp_last_board_v1';
/* ── CORS relay cascade ──────────────────────────────────────────────
   Browsers cannot call the Jira Cloud REST API directly from a GitHub Pages
   site (Jira sends no CORS headers), so requests must pass through a relay.
   The FIRST relay is JiraPulse's OWN hosted relay — a free Val Town HTTP val
   (100,000 requests/day, forwards the Authorization header verbatim, accepts
   only https://*.atlassian.net targets, stores nothing). It is tried before
   anything else; the public keyless relays below and a final direct attempt
   serve as fallbacks. A relay configured in Settings is always tried first. */
const OWN_RELAY = 'https://gensweaty--65df49bca6d911f19f231607ee4eb77e.web.val.run/?url=';
const RELAYS = [
  /* { key, build, keyless } — corsproxy.io also accepts a user-supplied API key */
  { key: 'own', build: (url) => OWN_RELAY + encodeURIComponent(url), keyless: true },
  { key: 'cors.lol', build: (url) => 'https://api.cors.lol/?url=' + encodeURIComponent(url), keyless: true },
  { key: 'corsproxy', build: (url, conn) =>
      'https://corsproxy.io/?' + (conn?.proxyApiKey ? 'key=' + encodeURIComponent(conn.proxyApiKey) + '&' : '') + 'url=' + encodeURIComponent(url), keyless: false },
];
const ISSUE_FIELDS = ['summary', 'status', 'resolutiondate', 'created', 'issuetype', 'assignee', 'priority', 'labels'];

const state = {
  conn: null,          // { domain, email, token, useProxy, proxyApiKey, proxyUrl }
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
  inShareScreen: false, // true while the public share overlay (#pubScreen) is open
  compare: null,       // compare mode: { boardId, board, issues, metrics, syncedAt } for board B
  compareGen: 0,       // bumped on every compare exit so stale async loads are discarded
  pickCompare: null,   // boards-page pick mode: { a: boardId|null, b: boardId|null } — null = off
};

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* the public app root path — always strips a trailing /admin/ so share links and
   board links built anywhere (admin panel included) point at the *public* app. */
function publicRootPath() {
  return location.pathname.replace(/\/admin\/?$/i, '').replace(/\/+$/, '') + '/';
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

/* admin powers are granted ONLY inside the dedicated /admin/ panel.
   On the public app (root URL / share links) everyone — including the admin
   account — is treated as a regular org viewer, so the admin can test the
   exact user experience. */
function orgIsAdmin(email) {
  if (!ADMIN_PANEL) return false;
  return isAdminEmail(email);
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

/* generate a fresh random token (used only for legacy/one-off links) */
function newPublishToken() {
  const a = new Uint32Array(PUBLISH_TOKEN_LEN);
  crypto.getRandomValues(a);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(a, (x) => chars[x % chars.length]).join('');
}

/* STABLE publish identity so the same share link is reused across republishes.
   Republishing overwrites the SAME store entry → the link a viewer already has
   keeps working and shows the latest data, without minting a new URL each time. */
function publishId(scope, boardId) {
  if (scope === 'all') return 'ALL_BOARDS';
  return 'BOARD_' + boardId;
}

/* create a publish snapshot for a board, or for every board (scope='all') */
async function createPublishSnapshot(boardId, scope) {
  if (scope === 'all') return await createAllBoardsSnapshot();
  const board = state.boards.find((b) => b.id === boardId);
  if (!board) return null;
  const defs = effectiveCharts();
  const payload = buildBoardRenderPayload(state.issues, state.lastMetrics, defs, state.hasChangelog);
  const snapshot = {
    token: publishId('board', boardId),   // stable: republishing updates this same snapshot
    pubId: publishId('board', boardId),
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

/* build a snapshot that bundles every board with its own portable render payload.
   Reports progress via onProgress(done, total) so the UI can show "Publishing… 3/12". */
async function createAllBoardsSnapshot(onProgress) {
  const now = Date.now();
  const records = [];
  let anyChangelog = false;
  const defs = effectiveCharts();
  const total = state.boards.length;
  let done = 0;
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
    done++;
    if (typeof onProgress === 'function') onProgress(done, total);
  }
  if (!records.length) { toast('Could not load any boards to publish.', 'warn'); return null; }
  const snapshot = {
    token: publishId('all', null),   // stable: republishing updates this same snapshot
    pubId: publishId('all', null),
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

/* list all snapshots — deduped by pubId so only the NEWEST version of each stable
   snapshot is returned. This is what makes "republish → same link shows latest" work:
   old copies of a board/all snapshot never shadow the fresh one. */
function listPublishSnapshots() {
  const store = loadPublishStore();
  const all = Object.values(store);
  const latest = new Map();
  for (const s of all) {
    const key = s.pubId || s.token || (s.scope + ':' + (s.boardId || 'all'));
    const cur = latest.get(key);
    if (!cur || (s.createdAt || 0) > (cur.createdAt || 0)) latest.set(key, s);
  }
  return [...latest.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/* the newest single snapshot (board or all) — used to boot the public org view */
function latestPublishSnapshot() {
  const snaps = listPublishSnapshots();
  return snaps.length ? snaps[0] : null;
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

/* build a share URL from a snapshot. Always points at the public app root (never /admin/).
   When the snapshot exists in this browser's publish store (it has a stable token), we return
   a small `?share=<token>` link — this AUTO-UPDATES on republish because the store entry is
   overwritten in place, so viewers keep the same link and always see the latest data.
   For manufactured sub-payloads (e.g. a board drilled out of an "all" snapshot) that have no
   store entry, we embed the data as a self-contained `#p=` payload so it still works anywhere. */
function buildShareUrl(snap) {
  const store = loadPublishStore();
  const tid = snap.pubId || snap.token;
  if (tid && store[tid]) {
    return location.origin + publicRootPath() + '?share=' + encodeURIComponent(tid);
  }
  const payload = encodeSharePayload(snap);
  return location.origin + publicRootPath() + '#p=' + payload;
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

/* grant access to a verified Google account (domain checked in the callback) */
function handleGoogleCredential(resp) {
  const payload = decodeJwt(resp.credential);
  const email = (payload?.email || '').toLowerCase().trim();
  if (!publishEmailOk(email)) {
    $('#pubStatus').textContent = 'Access is restricted to @' + PUBLISH_DOMAIN + ' accounts.';
    $('#pubStatus').className = 'error';
    return;
  }
  pubState.email = email;
  pubState.verified = true;
  pubState.isAdmin = isAdminEmail(email);
  $('#pubStatus').textContent = 'Verified via Google. Loading snapshot…';
  $('#pubStatus').className = 'ok';
  $('#pubContent').classList.remove('hidden');
  $('#pubAuthBox').classList.add('hidden');
  renderPubContent();
}

/* render Google's official sign-in button. The GSI script is loaded with `async`,
   so we poll until it is ready instead of assuming it's present at DOMContentLoaded. */
function initGoogleButton() {
  const container = $('#pubGoogleBtn');
  if (!container) return;
  if (!GOOGLE_CLIENT_ID) return;

  let polls = 0;
  const timer = setInterval(() => {
    polls++;
    if (!googleReady()) {
      /* never leave the user with a dead button — wire a manual fallback once */
      if (polls === 1) {
        container.addEventListener('click', () => {
          $('#pubStatus').textContent = 'Google sign-in is still loading… try again in a few seconds.';
          $('#pubStatus').className = 'warn';
        });
      }
      if (polls > 50) clearInterval(timer);   // ~10s cap
      return;
    }
    clearInterval(timer);
    try {
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleCredential,
        context: 'use',
        ux_mode: 'popup',
        /* hd restricts the account chooser to the org domain; the callback re-verifies it too */
        hd: PUBLISH_DOMAIN,
      });
      /* let Google draw its own branded button over our placeholder container */
      container.innerHTML = '';
      window.google.accounts.id.renderButton(container, {
        theme: 'outline',
        size: 'large',
        width: 280,
        text: 'continue_with',
        logo_alignment: 'center',
      });
    } catch (e) {
      logDiag('warn', 'Google init failed', { message: e.message });
      $('#pubStatus').textContent = 'Google sign-in could not start. Use your ' + PUBLISH_DOMAIN + ' email instead.';
      $('#pubStatus').className = 'error';
    }
  }, 200);
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
  state.inShareScreen = true;
  show($( '#pubScreen'));
}

/* stable seed for the access code — self-contained links have no token, so
   derive a deterministic seed from boardId + scope + createdAt */
function pubCodeSeed(snap) {
  return snap.token || (snap.scope + '|' + (snap.boardId || 'all') + '|' + (snap.createdAt || 'jp'));
}

/* Send the access code to the user's email using FormSubmit (free, no backend).
   We NEVER display the code on-screen — it goes only to the recipient's inbox.
   FormSubmit requires a one-time activation email to the recipient address before
   the first delivery; after that each code is emailed automatically. */
async function pubSendCode() {
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

  const btn = $('#pubSendBtn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  $('#pubStatus').textContent = 'Sending your code to ' + email + '…';
  $('#pubStatus').className = 'muted';

  /* FormSubmit accepts an arbitrary recipient email — each org member receives
     the code in their own inbox. No secret is exposed to the page. */
  const recipient = email;
  const subject = 'Your JiraPulse access code';
  const body =
    'Hello,\n\n' +
    'Your one-time access code for JiraPulse (' + (pubState.snapshot?.boardName || 'board stats') + ') is:\n\n' +
    code + '\n\n' +
    'Enter it on the JiraPulse page to view the published stats.\n\n' +
    'If you did not request this, ignore this email.';

  try {
    const res = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(recipient), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        email: email,
        _subject: subject,
        message: body,
        _template: 'table',
        _captcha: 'false',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || 'Email service error (' + res.status + ')';
      throw new Error(msg);
    }
    /* FormSubmit returns success:false when the recipient address needs a one-time
       activation (it emails an activation link first) or when it can't validate the
       request. Never claim the code was sent in that case — show the real reason
       and point the user to Google sign-in as the reliable fallback. */
    if (data && data.success === false) {
      const reason = data.message || 'the email service needs confirmation';
      const activating = /activat/i.test(reason);
      $('#pubStatus').textContent = activating
        ? 'First time for this email — FormSubmit has emailed an activation link to ' + email + '. Click it, then press "Resend code".'
        : 'Could not deliver the code right now (' + reason + '). Use Sign in with Google instead.';
      $('#pubStatus').className = activating ? 'warn' : 'error';
      $('#pubCodeWrap').classList.remove('hidden');
      $('#pubVerifyBtn').classList.remove('hidden');
      $('#pubMailLink').classList.add('hidden');
      $('#pubSendBtn').textContent = 'Resend code';
      return;
    }
    $('#pubStatus').textContent = 'Code sent to ' + email + '. Check your inbox, then enter it below.';
    $('#pubStatus').className = 'ok';
    $('#pubCodeWrap').classList.remove('hidden');
    $('#pubVerifyBtn').classList.remove('hidden');
    $('#pubMailLink').classList.add('hidden');
    $('#pubSendBtn').textContent = 'Resend code';
  } catch (e) {
    logDiag('warn', 'pubSendCode failed', { email, message: e.message });
    $('#pubStatus').textContent = 'Could not email the code (' + e.message + '). Use Sign in with Google instead.';
    $('#pubStatus').className = 'error';
    $('#pubMailLink').classList.add('hidden');
  } finally {
    btn.disabled = false;
    if (!btn.textContent.startsWith('Resend')) btn.textContent = 'Send code';
  }
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
  /* admin powers on the public share view are granted ONLY when inside the /admin/
     panel. On the public app the admin account is treated like any org member, so it
     can test the exact user experience (no admin bar, no manage/publish button). */
  const admin = pubState.isAdmin && ADMIN_PANEL;

  /* admin bar — visible only to the admin INSIDE the admin panel */
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
      /* split [P] org boards from the rest so they always appear first */
      const pubRow = (b) => `
        <div class="pub-board-row" data-bid="${b.boardId}">
          <span class="board-open" style="color:var(--muted)">▸</span>
          <div>
            <div class="bname">${escapeHtml(b.name)}</div>
            <div class="bmeta">${b.issuesCount} issues · ${b.hasChangelog ? 'changelog ✓' : 'no changelog'}</div>
          </div>
          ${admin ? `<button class="link-btn" data-copyboard="${b.boardId}" style="margin-left:auto;font-size:0.72rem">🔗 copy link</button>` : ''}
        </div>`;
      const P = boards.filter((b) => isPBoard(b));
      const others = boards.filter((b) => !isPBoard(b));
      let html = '';
      if (P.length) html += `<div class="board-group-title">[P] Org boards</div>${P.map(pubRow).join('')}<div style="height:14px"></div>`;
      if (others.length) html += `<div class="board-group-title">All other boards</div>${others.map(pubRow).join('')}`;
      boardsList.innerHTML = html;
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
  state.inShareScreen = false;
  hide($( '#pubScreen'));
  /* clear the #p= hash so the URL no longer points to the share, then reload app */
  if (location.hash) location.hash = '';
  if (loadConn()) enterApp();
  else if (!ADMIN_PANEL) showPublicLanding();   /* public: back to the org gate */
  else showSetup();
}

/* Public landing for the root URL "/" — org members should never see the Jira
   API-token form. Build an "all boards" snapshot from the published snapshots stored
   on this device and show the org sign-in gate (Google 1-click / email code). */
function showPublicLanding() {
  const snaps = listPublishSnapshots();
  const allSnap = snaps.find((s) => s.scope === 'all') || null;
  const boardSnaps = snaps.filter((s) => s.scope === 'board');

  if (allSnap) {
    /* reuse the newest published all-boards snapshot directly */
    showPubScreen(allSnap);
    return;
  }
  if (boardSnaps.length) {
    /* no "all" snapshot yet — synthesize one from every published single board */
    const synthetic = {
      token: null,
      boardId: null,
      boardName: 'All boards',
      scope: 'all',
      createdAt: Math.max(...boardSnaps.map((b) => b.createdAt)),
      issuesCount: boardSnaps.reduce((a, b) => a + (b.issuesCount || 0), 0),
      hasChangelog: boardSnaps.some((b) => b.hasChangelog),
      charts: [],
      boards: boardSnaps.map((b) => ({
        boardId: b.boardId, name: b.boardName, issuesCount: b.issuesCount || 0, hasChangelog: !!b.hasChangelog, charts: b.charts || [],
      })),
    };
    showPubScreen(synthetic);
    return;
  }
  /* nothing published yet — show an empty published state through the gate */
  const empty = {
    token: null, boardId: null, boardName: 'All boards', scope: 'all', createdAt: Date.now(),
    issuesCount: 0, hasChangelog: false, charts: [], boards: [],
  };
  showPubScreen(empty);
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
      const link = snap ? buildShareUrl(snap) : (location.origin + publicRootPath() + '?share=' + token);
      navigator.clipboard.writeText(link).then(() => toast('Link copied to clipboard.', 'ok')).catch(() => toast('Could not copy.', 'warn'));
    });
  });
  $('#pubListBody').querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => {
      const token = b.dataset.open;
      const snap = allSnapshots.find((s) => s.token === token);
      const link = snap ? buildShareUrl(snap) : (location.origin + publicRootPath() + '?share=' + token);
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

  /* Build the attempt list: [custom relay →] [built-in relays (own first) →]
     direct. Each attempt is tried in order; the first one that reaches Jira
     wins. A user-configured relay (Settings) is always tried first. The
     built-in own relay (Val Town) is tried before the direct call, which is
     CORS-blocked on GitHub Pages and always fails — its single failure costs
     ~100 ms and it stays last purely as a future-proof escape hatch. */
  const attempts = [];
  let viaProxy = false;
  const withRelay = (r) => attempts.push({
    url: r.build(url, c),
    relay: r.key,
    /* relay responses are identifiable by their error payload shape.
       - own (Val Town): {error:"..."} JSON for app-level rejections; the Val
         Town platform itself answers 500 {message:"..."} when the val is down.
       - corsproxy: {error:"..."} mentioning api key / invalid or inactive.
       - cors.lol: plain-text 429 rate-limit bodies. */
    isRelayErr: r.key === 'own'
      ? (s, b) => (s === 500 && typeof b?.message === 'string' && /not found/i.test(b.message))
        || (s === 502 && typeof b?.error === 'string' && /upstream/i.test(b.error))
      : r.key === 'corsproxy'
        ? (s, b) => (s === 401 || s === 403) && typeof b?.error === 'string' && /api key|invalid or inactive/i.test(b.error)
        : (s, b) => s === 429 && typeof b === 'string' && /rate limit/i.test(b),
  });
  if (c.proxyUrl) {
    /* custom relay template with {url} placeholder (falls back to suffix style) */
    const custom = { key: 'custom', build: (u) => c.proxyUrl.includes('{url}')
      ? c.proxyUrl.replace('{url}', encodeURIComponent(u))
      : c.proxyUrl + encodeURIComponent(u) };
    withRelay(custom);
  }
  /* built-in relays next (own hosted relay first), then a final direct call.
     The direct attempt is last because Jira never sends CORS headers to a
     browser — on GitHub Pages it always fails; it only wins on hosts that
     proxy /rest/* server-side. */
  if (!c.proxyUrl) {
    for (const r of RELAYS) {
      if (r.keyless || c.proxyApiKey) withRelay(r);
    }
  }
  if (!c.useProxy) attempts.push({ url, relay: null, isRelayErr: null });

  let lastErr = null;
  for (const attempt of attempts) {
    const target = attempt.url;
    /* abort a request that hangs — prevents publish-all ("Publishing…") from
       spinning forever on a single unreachable endpoint */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      logDiag('info', 'API request', { method, path, viaProxy: target !== url, relay: attempt.relay || null, body: options.body || null });
      const res = await fetch(target, {
        method,
        headers,
        body: options.body != null ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      viaProxy = target !== url;
      let body = null;
      const text = await res.text();
      try { body = JSON.parse(text); } catch (_) { /* non-json */ }
      if (!res.ok) {
        /* relay's own error (key/limit/abuse block) is NOT Jira's answer — fall
           through to the next relay instead of surfacing it to the user */
        if (attempt.isRelayErr && attempt.isRelayErr(res.status, body ?? text)) {
          logDiag('warn', 'Relay rejected the request, trying next relay', { relay: attempt.relay, status: res.status, body });
          lastErr = new Error(`relay ${attempt.relay}: HTTP ${res.status}`);
          continue;
        }
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
      if (err.name === 'AbortError' || err?.message === 'The user aborted a request.') {
        logDiag('warn', 'API request timed out', { method, path, viaProxy: target !== url });
      } else if (!err.status) {
        logDiag('warn', 'API network/proxy failure', { method, path, viaProxy: target !== url, message: err.message });
      }
      // HTTP errors from Jira itself are real answers — don't retry through proxy
      if (err.status) throw err;
      // network / timeout / CORS failure → try next attempt
    } finally {
      clearTimeout(timer);
    }
  }
  const e = new Error(
    `Could not reach ${c.domain} (${lastErr?.message || 'network error'}). ` +
    `The built-in online relay and all fallbacks failed. ` +
    `Please retry in a minute; if it persists, check your connection or paste a ` +
    `custom relay URL (Settings → Relay settings).`
  );
  logDiag('error', 'API request failed completely', { method, path, message: e.message });
  throw e;
}

async function fetchPaginated(request, cap = 500, pageSize = 50) {
  const base = typeof request === 'string' ? { path: request, method: 'GET' } : request;
  let startAt = 0;
  const out = [];
  while (true) {
    let page;
    if ((base.method || 'GET') === 'GET') {
      const sep = base.path.includes('?') ? '&' : '?';
      /* pageSize stays modest (default 50) so each relayed response keeps under the
         CORS-proxy ~1 MB cap; large boards still paginate via startAt. */
      page = await api(`${base.path}${sep}startAt=${startAt}&maxResults=${pageSize}`);
    } else {
      page = await api(base.path, {
        method: base.method || 'POST',
        body: { ...(base.body || {}), startAt, maxResults: pageSize },
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
/* relay preferences survive independently of the Jira connection, so they are
   not lost if the user configures a relay before ever connecting successfully */
function loadRelayPrefs() {
  try { return JSON.parse(localStorage.getItem(LS_RELAY)) || null; } catch (_) { return null; }
}
function saveRelayPrefs(useProxy, proxyApiKey, proxyUrl) {
  localStorage.setItem(LS_RELAY, JSON.stringify({ useProxy, proxyApiKey, proxyUrl }));
}
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
  $('#proxyKeyInput').value = state.conn.proxyApiKey || '';
  $('#proxyUrlInput').value = state.conn.proxyUrl || '';
  /* show the Admin badge when in the admin panel; show an Org badge on the
     public app when a non-admin org member signs in. Guard for HTML variants
     (the admin shell has no #orgBadge). */
  const adminBadge = $('#adminBadge');
  const orgBadge = $('#orgBadge');
  if (ADMIN_PANEL) {
    if (adminBadge) adminBadge.classList.remove('hidden');
    if (orgBadge) orgBadge.classList.add('hidden');
  } else {
    if (adminBadge) adminBadge.classList.add('hidden');
    if (orgBadge) orgBadge.classList.toggle('hidden', !(state.conn && publishEmailOk(state.conn.email)));
  }
  /* show/hide admin-only controls (publish / new chart) based on context */
  syncAdminControls();
  /* route to the current hash (#/ or #/board/<id>) — bootstrap boards */
  route();
}

/* unique shareable link for a board (used for the 🔗 copy button + router).
   When we're inside the /admin/ panel, the copy-link must still point to the
   *public* app root (e.g. .../jira-pulse/#/board/1), never .../admin/#/board/1. */
function boardLink(boardId) {
  return location.origin + publicRootPath() + '#/board/' + boardId;
}

/* are modify/publish operations allowed in this context?
   Only true in the dedicated /admin/ panel, or when the connected Jira user
   is the admin account. Regular org viewers are read-only. */
function canModify() {
  if (state.inShareScreen) return false;   /* share viewers are always read-only */
  /* modify/publish powers live ONLY inside the dedicated /admin/ panel.
     Outside it, everyone (even the admin account) is a read-only org viewer, so the
     public/user view shows the same charts & design but no admin buttons/functions. */
  return !!ADMIN_PANEL;
}

/* hide/show all admin-only controls in the topbar + board/dashboard headers.
   Outside /admin/ the user view is read-only: hide publish, new-chart, the settings &
   diagnostics buttons, and the admin badge. Navigation (Boards / Refresh) stays so users
   can browse boards, but they get no editing powers. */
function syncAdminControls() {
  const modify = canModify();
  ['publishAllBtn', 'publishBtn', 'addChartBtn'].forEach((id) => {
    const el = $('#'.concat(id));
    if (el) el.style.display = modify ? '' : 'none';
  });
  /* user view is read-only: hide admin-gated utilities (settings + diagnostics) */
  const adminIds = ['openDebugBtn', 'settingsBtn'];
  adminIds.forEach((id) => {
    const el = $('#'.concat(id));
    if (el) el.style.display = modify ? '' : 'none';
  });
  const adminBadge = $('#adminBadge');
  if (adminBadge) adminBadge.classList.toggle('hidden', !modify);
  /* org badge reflects auto-verified org membership on the public app */
  const orgBadge = $('#orgBadge');
  if (orgBadge) orgBadge.classList.toggle('hidden', modify || !(state.conn && publishEmailOk(state.conn.email)));
}

/* open a board's dashboard from a board object (keeps URL in sync) */
function openBoard(board) {
  if (!board) return;
  $('#boardSelect').value = String(board.id);
  selectBoard(board);
  if (location.hash !== '#/board/' + board.id) {
    history.replaceState(null, '', location.pathname + '#/board/' + board.id);
  }
  syncHeaderState();
}

/* show the all-boards main page (used when on #/ or clicking logo/Boards) */
function showAllBoards() {
  if (location.hash && location.hash !== '#/' && !location.hash.startsWith('#/board/')) {
    history.replaceState(null, '', location.pathname);
  } else if (location.hash && location.hash !== '#/') {
    history.replaceState(null, '', location.pathname + '#/');
  }
  hide($('#dashScreen')); show($('#boardsScreen'));
  hide($('#errorBanner'));
  hide($('#changelogNotice'));
  syncHeaderState();
  /* if boards are already loaded, keep the "All boards" option visible immediately */
  if (state.boards.length) {
    const sel = $('#boardSelect');
    if (!sel.querySelector('option[value=""]')) {
      sel.insertAdjacentHTML('afterbegin', '<option value="">All boards</option>');
    }
    sel.value = '';
  }
  loadBoards({ autoOpenLast: false }).catch((e) => handleAuthError(e));
}

/* keep the topbar centered label + logo/Boards button in sync with the current view */
function syncHeaderState() {
  const onBoards = !$('#boardsScreen').classList.contains('hidden');
  const onDash = !$('#dashScreen').classList.contains('hidden');
  const label = $('#allBoardsLabel');
  const backBtn = $('#backToBoardsBtn');
  if (onBoards) {
    label.style.display = 'inline-flex';
    backBtn.style.display = 'none';   /* we're already on the boards page — hide "← Boards" */
  } else if (onDash) {
    label.style.display = 'none';
    backBtn.style.display = 'inline-flex';
  } else {
    label.style.display = 'none';
    backBtn.style.display = 'none';
  }
  /* compare entry points are per-screen: ⇄ pick-boards on the main page,
     ⇄ compare-with-this-board on a board's dashboard */
  const pickBtn = $('#pickCompareBtn');
  if (pickBtn) pickBtn.style.display = onBoards ? '' : 'none';
  const cmpBtn = $('#compareBtn');
  if (cmpBtn) cmpBtn.style.display = onDash ? '' : 'none';
  syncAdminControls();
}

/* hash router — #/ = all boards, #/board/<id> = a specific board */
function route() {
  const hash = location.hash;
  const boardMatch = hash.match(/^#\/board\/(\d+)/);
  if (boardMatch) {
    const bid = parseInt(boardMatch[1], 10);
    /* if boards are already loaded, open immediately; otherwise load then open */
    const b = state.boards.find((x) => x.id === bid);
    hide($('#setupScreen')); show($('#topbar'));
    hide($('#boardsScreen')); show($('#dashScreen'));
    syncHeaderState();
    $('#boardSelect').innerHTML = '<option value="">Loading boards…</option>';
    loadBoards({ autoOpenLast: false, targetBoardId: bid }).catch((e) => handleAuthError(e));
  } else {
    hide($('#setupScreen')); show($('#topbar'));
    showAllBoards();
  }
}

function goBoards({ autoOpenLast = false } = {}) {
  hide($('#dashScreen')); show($('#boardsScreen'));
  hide($('#errorBanner'));
  hide($('#changelogNotice'));
  $('#boardSelect').innerHTML = '<option value="">Loading boards…</option>';
  syncHeaderState();
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

function adminRedirectUrl() {
  /* disabled: the root URL is ALWAYS the org user view. The /admin/ panel is reached
     explicitly via the admin link (it has its own token connect flow). Even the admin
     account can sign in at the root to test the exact read-only user experience. */
  return null;
}

/* ── connect flow ────────────────────────────────────────────────── */
async function connect(domainRaw, email, token) {
  const domain = normalizeDomain(domainRaw);
  if (!email.trim()) throw new Error('Email is required.');
  if (!token.trim()) throw new Error('API token is required.');
  /* relay prefs come from the dedicated store (saved via Settings, even
     pre-connection) and fall back to whatever a previous session had */
  const rp = loadRelayPrefs() || {};
  state.conn = { domain, email: email.trim(), token: token.trim(),
        useProxy: rp.useProxy ?? false,
        proxyApiKey: rp.proxyApiKey ?? state.conn?.proxyApiKey ?? '',
        proxyUrl: rp.proxyUrl ?? state.conn?.proxyUrl ?? '' };
  state.usedProxy = false;
  await api('/rest/api/3/myself'); // auth check
  saveConn();
  /* if the admin account logs in from the public app (not the admin panel),
     bounce them straight to the /admin/ panel so they can do all operations. */
  const redirect = adminRedirectUrl();
  if (redirect) {
    location.replace(redirect);
    return;
  }
  enterApp();
  toast('Connected to ' + domain.replace('https://', '') + ' 🎉', 'ok');
}

/* ── boards ──────────────────────────────────────────────────────── */
async function loadBoards({ autoOpenLast = false, targetBoardId = null } = {}) {
  const grid = $('#boardsGrid');
  const btn = $('#syncBoardsBtn');
  btn.disabled = true;
  show($('#boardsLoading')); hide($('#boardsEmpty'));
  try {
    const boards = await fetchPaginated('/rest/agile/1.0/board', 250);
    boards.sort((a, b) => (a.location?.projectName || a.name).localeCompare(b.location?.projectName || b.name));
    state.boards = boards;
    logDiag('info', 'Boards loaded', { count: boards.length });
    /* only replace the DOM after a successful fetch — never lose the board list on failure */
    grid.innerHTML = '';

    // dropdown — first option is "All boards", selected by default on the main page
    const sel = $('#boardSelect');
    sel.innerHTML = '<option value="">All boards</option>' + (boards.length
      ? boards.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')
      : '<option value="" disabled>No boards found</option>');
    sel.value = targetBoardId != null ? String(targetBoardId) : '';
    renderBoardCards();

    if (!boards.length) { show($('#boardsEmpty')); syncHeaderState(); return; }

    // auto-open a specific board from the URL hash (#/board/<id>)
    if (targetBoardId != null) {
      const target = boards.find((b) => b.id === targetBoardId);
      if (target) { sel.value = String(target.id); openBoard(target); return; }
    }
    // auto-open last viewed board only when explicitly requested
    if (autoOpenLast) {
      const lastId = parseInt(localStorage.getItem(LS_LAST_BOARD), 10);
      const last = boards.find((b) => b.id === lastId);
      if (last) { sel.value = String(last.id); openBoard(last); }
    }
    syncHeaderState();
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

/* ── board-card stats (main page) ──────────────────────────────────
   Every card on the "Choose a board" page gets 4 headline stats — issues,
   done %, WIP and avg cycle time — so the whole org is visible at a glance.
   Numbers are fetched with a LIGHT search (no changelog expand), cached in
   localStorage for 30 minutes, and enriched one board at a time in the
   background so the page never blocks or hammers the relay. */
const LS_BSTATS = 'jp_bstats_v1';
const BSTATS_TTL = 30 * 60 * 1000;
const _bstatsMem = new Map();     // boardId → fresh record this session
const _bstatsInflight = new Set();// boardIds currently being fetched
let _bstatsRunning = false;

function loadBstatsStore() {
  try { return JSON.parse(localStorage.getItem(LS_BSTATS) || '{}'); } catch { return {}; }
}

function cachedBoardStats(boardId) {
  const mem = _bstatsMem.get(boardId);
  if (mem) return mem;
  try {
    const rec = loadBstatsStore()[String(boardId)];
    if (rec && Date.now() - rec.ts < BSTATS_TTL) { _bstatsMem.set(boardId, rec); return rec; }
  } catch { /* ignore corrupt cache */ }
  return null;
}

function saveBoardStats(boardId, rec) {
  _bstatsMem.set(boardId, rec);
  try {
    const store = loadBstatsStore();
    store[String(boardId)] = rec;
    localStorage.setItem(LS_BSTATS, JSON.stringify(store));
  } catch { /* storage full — memory cache still works */ }
}

/* light fetch of one board's headline numbers (reuses the dashboard's own
   context resolution + metrics computation, minus the changelog weight) */
async function fetchBoardStats(board) {
  const ctx = await resolveBoardContext(board);
  const jql = ctx.projectKeys.length
    ? `project in (${ctx.projectKeys.map((k) => `"${k}"`).join(', ')}) ORDER BY created DESC`
    : (ctx.filterJql || null);
  let issues = null;
  if (jql) {
    try { issues = await searchIssuesByJql(jql, false); } catch (e) {
      logDiag('warn', 'Board stats search failed', { boardId: board.id, status: e?.status, message: e?.message });
    }
  }
  if (!issues) {
    try {
      issues = await fetchPaginated(`/rest/agile/1.0/board/${board.id}/issue?fields=${encodeURIComponent(ISSUE_FIELDS.join(','))}`, 600);
    } catch (e) {
      logDiag('warn', 'Board stats board-endpoint fallback failed', { boardId: board.id, status: e?.status, message: e?.message });
      return null;
    }
  }
  const m = computeMetrics(issues);
  return {
    ts: Date.now(),
    total: m.total, done: m.done, wip: m.wip,
    doneRate: m.doneRate, cycleAvg: m.cycleAvg,
    created30: m.created30, resolved30: m.resolved30,
  };
}

/* background loop: fetch stats for boards that have none/fresh — sequentially,
   one board at a time, updating cards in place as each result lands */
async function enrichBoardStats() {
  if (_bstatsRunning || !state.conn) return;
  _bstatsRunning = true;
  try {
    for (const b of state.boards) {
      if (cachedBoardStats(b.id) || _bstatsInflight.has(b.id)) continue;
      _bstatsInflight.add(b.id);
      try {
        const rec = await fetchBoardStats(b);
        if (rec) { saveBoardStats(b.id, rec); updateBoardStatsDom(b.id, rec); }
        else updateBoardStatsDom(b.id, null);
      } finally {
        _bstatsInflight.delete(b.id);
      }
    }
  } finally {
    _bstatsRunning = false;
  }
}

/* chips HTML for a card (cached values, loading pill, or failure mark) */
function boardStatsChipHtml(rec) {
  if (!rec) return '<span class="bstat bstat-pending"><span class="spinner spinner-sm"></span> measuring…</span>';
  return `
    <span class="bstat" title="Issues analyzed"><span class="b-ic">▦</span>${rec.total}</span>
    <span class="bstat" title="Done overall"><span class="b-ic">✓</span>${rec.doneRate}%</span>
    <span class="bstat" title="Work in progress"><span class="b-ic">◔</span>${rec.wip}</span>
    <span class="bstat" title="Avg cycle time (create → resolve)"><span class="b-ic">⏱</span>${rec.cycleAvg != null ? fmtDuration(rec.cycleAvg) : '—'}</span>`;
}

/* update one card's stats row in place (cards animate in — never re-render the grid) */
function updateBoardStatsDom(boardId, rec) {
  const box = document.getElementById('bstats_' + boardId);
  if (box) box.innerHTML = rec ? boardStatsChipHtml(rec) : '<span class="bstat bstat-skip">stats unavailable</span>';
}

/* is this board one of the "[P]" org boards? Its project name (e.g. "[P] Automarket")
   marks it as a shared org-flow Kanban board with the same statuses → shown first. */
function isPBoard(b) {
  return /^\[P\]/i.test(b.location?.projectName || '') || /^\[P\]/i.test(b.name || '');
}

/* render a single board card (shared by the grouped list + the sorter).
   In pick-compare mode cards switch from "open dashboard" to "select A/B". */
function boardCardHTML(b, i) {
  const pick = state.pickCompare;
  const pickedA = pick && pick.a === b.id;
  const pickedB = pick && pick.b === b.id;
  const picked = pickedA || pickedB;
  const openLabel = pick
    ? (picked ? `Selected as ${pickedA ? 'A' : 'B'} — click to remove` : (pick.a == null ? 'Click to pick as A' : 'Click to pick as B'))
    : 'Open dashboard →';
  return `
    <div class="board-card glass${picked ? ' pick-sel' : ''}${pickedA ? ' pick-a' : ''}${pickedB ? ' pick-b' : ''}" data-id="${b.id}" style="animation-delay:${Math.min(i * 35, 400)}ms">
      <div class="board-card-head">
        <h3>${escapeHtml(b.name)}</h3>
        <button class="link-btn board-copy-link" data-copyboard="${b.id}" title="Copy link to this board" aria-label="Copy board link">🔗</button>
      </div>
      <div class="board-meta">
        ${b.type ? `<span class="${boardTypeClass(b.type)}">${escapeHtml(b.type)} board</span>` : ''}
        ${b.location?.projectKey ? `<span class="chip">${escapeHtml(b.location.projectKey)}</span>` : ''}
      </div>
      ${b.location?.projectName ? `<div class="muted small" style="margin-bottom:10px">Project · ${escapeHtml(b.location.projectName)}</div>` : '<div style="height:22px"></div>'}
      <div class="board-stats" id="bstats_${b.id}">${boardStatsChipHtml(cachedBoardStats(b.id))}</div>
      <span class="board-open">${openLabel}</span>
    </div>`;
}

function renderBoardCards() {
  const grid = $('#boardsGrid');
  const pBoards = state.boards.filter(isPBoard);
  const otherBoards = state.boards.filter((b) => !isPBoard(b));
  let html = '';
  if (pBoards.length) {
    html += `<div class="board-group"><span class="board-group-title">[P] Org boards</span><div class="boards-grid">${pBoards.map((b, ci) => boardCardHTML(b, ci)).join('')}</div></div>`;
  }
  if (otherBoards.length) {
    html += `<div class="board-group"><span class="board-group-title">All other boards</span><div class="boards-grid">${otherBoards.map((b, ci) => boardCardHTML(b, ci)).join('')}</div></div>`;
  }
  grid.innerHTML = html;
  /* event wiring is shared for all cards (grouped grids are still DOM children) */
  grid.querySelectorAll('.board-card .board-copy-link').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const b = state.boards.find((x) => x.id === parseInt(btn.dataset.copyboard, 10));
      if (b) {
        const link = boardLink(b.id);
        navigator.clipboard.writeText(link).then(() => toast('Board link copied.', 'ok')).catch(() => toast('Could not copy.', 'warn'));
      }
    });
  });
  grid.querySelectorAll('.board-card').forEach((card) => {
    card.addEventListener('click', () => {
      const b = state.boards.find((x) => x.id === parseInt(card.dataset.id, 10));
      if (!b) return;
      if (state.pickCompare) { togglePickCompare(b); return; }   // pick mode → cards select instead of open
      $('#boardSelect').value = String(b.id);
      openBoard(b);
    });
  });
  /* kick off the background stats enrichment (cached boards render instantly) */
  enrichBoardStats().catch((e) => logDiag('warn', 'Board stats enrichment stopped', { message: e?.message }));
}

/* board-context cache: avoids re-hitting 3–4 Jira endpoints every time you re-open a board.
   The cache is keyed by board id and persists for the session (in memory). */
const _boardCtxCache = new Map();

async function resolveBoardContext(board) {
  const cached = _boardCtxCache.get(board.id);
  if (cached) {
    logDiag('info', 'Board context cache hit', { boardId: board.id, filterId: cached.filterId, projectKeys: cached.projectKeys.length, filterJql: cached.filterJql.slice(0, 80) });
    return cached;
  }

  const ctx = {
    boardId: board.id,
    boardName: board.name,
    boardType: board.type,
    location: board.location || null,
    filterId: null,
    filterJql: '',
    projectKeys: [],
  };

  /* run the independent lookups in parallel; failures are non-fatal (each try/catch).
     The filter JQL depends on filterId, so it is chained after the config resolves. */
  const [boardResp, cfgResp, projectsResp] = await Promise.all([
    api(`/rest/agile/1.0/board/${board.id}`).catch((e) => { logDiag('warn', 'Board details lookup failed', { boardId: board.id, status: e.status, message: e.message }); return null; }),
    api(`/rest/agile/1.0/board/${board.id}/configuration`).catch((e) => { logDiag('warn', 'Board configuration lookup failed', { boardId: board.id, status: e.status, message: e.message }); return null; }),
    fetchPaginated(`/rest/agile/1.0/board/${board.id}/project`, 100).catch((e) => { logDiag('warn', 'Board projects lookup failed', { boardId: board.id, status: e.status, message: e.message }); return []; }),
  ]);

  if (boardResp) {
    ctx.location = boardResp.location || ctx.location;
    ctx.boardType = boardResp.type || ctx.boardType;
  }
  ctx.filterId = cfgResp?.filter?.id || null;
  ctx.projectKeys = (projectsResp || []).map((p) => p.key).filter(Boolean);

  logDiag('info', 'Board details resolved', { boardId: board.id, boardType: ctx.boardType, filterId: ctx.filterId, projectKeys: ctx.projectKeys.length });

  if (ctx.filterId) {
    try {
      const filter = await api(`/rest/api/3/filter/${ctx.filterId}`);
      ctx.filterJql = filter?.jql || '';
      logDiag('info', 'Board filter JQL resolved', { boardId: board.id, filterId: ctx.filterId, jqlPreview: ctx.filterJql.slice(0, 180) });
    } catch (e) {
      logDiag('warn', 'Board filter lookup failed', { boardId: board.id, filterId: ctx.filterId, status: e.status, message: e.message });
    }
  }

  if (!ctx.projectKeys.length && ctx.location?.projectKey) ctx.projectKeys = [ctx.location.projectKey];

  _boardCtxCache.set(board.id, ctx);
  return ctx;
}

/* Jira's legacy `/rest/api/3/search` endpoint has been DISABLED on newer Jira Cloud sites
   and now returns 410 Gone. The modern endpoint is `/rest/api/3/search/jql`, which:
     - returns `changelog.histories` + `resolutiondate` (which power the status-time and
       resolved/throughput/cycle charts — without them those charts show "No data")
     - paginates with `nextPageToken` + `isLast` (no `startAt`/`total`)

   IMPORTANT: the public CORS proxy (corsproxy.io) BLOCKS POST requests (HTTP 403), so we
   must do the search as a GET with JQL + fields as query parameters (exactly like Jira's
   own UI). GET also carries the bearer/Basic auth headers fine and returns full data. */
async function searchIssuesByJql(jql, withChangelog = false) {
  /* IMPORTANT: the public CORS proxy (corsproxy.io) refuses to relay responses above
     ~0.8–1 MB (HTTP 413 Payload Too Large). With `expand=changelog` each issue carries a
     full history, so a large page can blow that limit and abort the whole search → the app
     falls back to the board endpoints which OMIT `resolutiondate`, leaving the
     resolved/throughput/cycle charts at "No data". We therefore start at a modest page size
     and, if the proxy returns 413 on any page, HALVE the page size and restart the search
     from scratch (Jira's `nextPageToken` cannot resume mid-way). */
  const MAX_TOTAL = 600;
  const startPage = withChangelog ? 25 : 50;
  let pageSize = startPage;
  let lastErr = null;

  for (let pass = 0; pass < 8; pass++) {
    const out = [];
    let nextPageToken = null;
    let ok = true;
    while (out.length < MAX_TOTAL) {
      const qp = new URLSearchParams();
      qp.set('jql', jql);
      qp.set('fields', ISSUE_FIELDS.join(','));
      qp.set('maxResults', String(pageSize));
      if (withChangelog) qp.set('expand', 'changelog');
      if (nextPageToken) qp.set('nextPageToken', nextPageToken);
      let page;
      try {
        page = await api(`/rest/api/3/search/jql?${qp.toString()}`, { method: 'GET' });
      } catch (e) {
        lastErr = e;
        if (e.status === 413 && pageSize > 1) {
          ok = false;               /* response too big for the proxy → shrink and retry */
          logDiag('warn', 'Search page too large for proxy, shrinking page size', { jql: jql.slice(0, 80), pageSize, status: 413 });
          break;
        }
        throw e;                    /* any other error: let the caller decide (try next strategy) */
      }
      if (Array.isArray(page.issues)) out.push(...page.issues);
      if (page.isLast === true || !page.nextPageToken) break;
      nextPageToken = page.nextPageToken;
    }
    if (ok) return out;             /* completed without a 413 */
    pageSize = Math.max(1, Math.floor(pageSize / 2));
  }

  /* couldn't get the whole set under the proxy cap at any page size — surface last error */
  const e = new Error(`Could not fetch all search results (last error: ${lastErr?.message || 'unknown'})`);
  e.status = lastErr?.status || 500;
  throw e;
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

/* detect whether an issues list has either resolutiondate (resolved/cycle/throughput
   charts) OR changelog (status-time charts) — i.e. it is a REAL full-fields payload,
   not a board-endpoint response that only carries `created`. */
function hasResolutionOrChangelog(issues) {
  if (!issues || !issues.length) return false;
  for (const iss of issues) {
    const f = iss.fields || {};
    if (f.resolutiondate) return true;
    if (iss.changelog && iss.changelog.histories && iss.changelog.histories.length) return true;
  }
  return false;
}

async function loadBoardIssues(board) {
  state.hasChangelog = true;
  state.boardLoadMeta = { source: '', note: '' };
  const ctx = await resolveBoardContext(board);

  /* The board endpoints (/rest/agile|software/.../issue) reliably return `created`
     but usually OMIT `resolutiondate` and never honour `expand=changelog`, which breaks
     the resolved/throughput/cycle/status-time charts. The Jira search API always returns
     both, so we try every changelog-capable SEARCH strategy FIRST, then fall back to the
     board endpoints (best-effort, status-time charts may warn), then to JQL-by-filter /
     project searches without changelog as a last resort. */
  const attempts = [
    /* PRIMARY: full project-wide search. Kanban/Scrum board filters often restrict the
       view to UNRESOLVED work (e.g. `resolution = Unresolved`), so querying the board's own
       JQL returns only WIP — leaving Resolved/Throughput/Avg-cycle at 0. Searching across the
       board's PROJECTS returns the complete issue set (including resolved + changelog), which
       is the only way the resolved/throughput/cycle and status-time charts get real data. */
    ...(ctx.projectKeys.length ? [{
      name: 'search-projects-changelog',
      run: () => searchIssuesByJql(`project in (${ctx.projectKeys.map((k) => `"${k}"`).join(', ')}) ORDER BY created DESC`, true),
      /* Always accept the project-wide search — it's the only source that reliably returns
         `resolutiondate` (resolved / throughput / cycle charts) regardless of whether the
         project also exposes changelog. hasChangelog is derived from the actual payload so
         status-time charts only warn when the project genuinely has no changelog. */
      onSuccess: (issues) => {
        state.hasChangelog = hasChangelogData(issues);
        state.boardLoadMeta = {
          source: 'Board projects + changelog',
          note: state.hasChangelog ? 'Full issue set (includes resolved + changelog).' : 'Full issue set (resolved available, no changelog history).',
        };
      },
    }] : []),
    ...(ctx.filterJql ? [{
      name: 'search-filter-jql-changelog',
      run: () => searchIssuesByJql(ctx.filterJql, true),
      onSuccess: (issues) => {
        state.hasChangelog = hasChangelogData(issues);
        state.boardLoadMeta = {
          source: 'Board filter JQL + changelog',
          note: state.hasChangelog ? 'Used the board filter JQL. Full fields (resolutiondate + changelog) loaded.' : 'Board filter JQL returned issues but no changelog history.',
        };
      },
      verify: (issues) => hasResolutionOrChangelog(issues),
      onVerifyFail: { source: 'Board filter JQL (no data)', note: 'Search returned issues but no resolved/changelog data. Trying board projects.' },
    }] : []),
    {
      name: 'agile-changelog',
      run: () => fetchPaginated(`/rest/agile/1.0/board/${board.id}/issue?fields=${encodeURIComponent(ISSUE_FIELDS.join(','))}&expand=changelog`, 600, 25),
      onSuccess: () => { state.hasChangelog = true; state.boardLoadMeta = { source: 'Agile board issues + changelog', note: '' }; },
      verify: (issues) => hasChangelogData(issues),
      onVerifyFail: { source: 'Agile board issues (no changelog)', note: 'Changelog expansion returned no history. Trying alternative strategy.' },
    },
    {
      name: 'agile-basic',
      run: () => fetchPaginated(`/rest/agile/1.0/board/${board.id}/issue?fields=${encodeURIComponent(ISSUE_FIELDS.join(','))}`, 600),
      onSuccess: () => { state.hasChangelog = false; state.boardLoadMeta = { source: 'Agile board issues', note: 'Loaded without changelog — status-time charts may be limited.' }; },
    },
    {
      name: 'software-basic',
      run: () => fetchPaginated(`/rest/software/1.0/board/${board.id}/issue?fields=${encodeURIComponent(ISSUE_FIELDS.join(','))}`, 600),
      onSuccess: () => { state.hasChangelog = false; state.boardLoadMeta = { source: 'Software board issues', note: 'Loaded without changelog — status-time charts may be limited.' }; },
    },
    ...(ctx.filterId ? [{
      name: 'search-filter-id-basic',
      run: () => searchIssuesByJql(`filter=${ctx.filterId} ORDER BY created DESC`, false),
      onSuccess: () => { state.hasChangelog = false; state.boardLoadMeta = { source: 'Board filter reference', note: 'Used filter id fallback.' }; },
    }] : []),
    ...(ctx.filterJql ? [{
      name: 'search-filter-jql-basic',
      run: () => searchIssuesByJql(ctx.filterJql, false),
      onSuccess: () => { state.hasChangelog = false; state.boardLoadMeta = { source: 'Board filter JQL', note: 'Used Jira issue search based on the board filter.' }; },
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
      attempt.onSuccess(issues);
      /* learn this board's done-status names (statusCategory=done) so changelog-based
         completion walks recognise custom-named done statuses (e.g. "Deployed") */
      rememberDoneStatuses(issues);
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
  /* leaving the boards page always cancels an in-progress pick-compare selection */
  if (state.pickCompare) { state.pickCompare = null; updatePickBar(); }
  hide($('#boardsScreen')); show($('#dashScreen'));
  syncHeaderState();
  hide($('#errorBanner'));

  /* switching boards invalidates the comparison — always start clean.
     Bump the generation even if compare was already off, so any in-flight
     compare-board load is discarded when its await resumes. */
  state.compare = null;
  state.compareGen = (state.compareGen || 0) + 1;
  hide($('#compareBar'));
  $('#compareBtn').classList.remove('active');

  $('#dashBoardName').textContent = board.name;
  $('#syncedAt').textContent = '';

  /* clear the previous board's data immediately so it never lingers during sync */
  showDashLoading(board.name);

  try {
    logDiag('info', 'Board selected', { boardId: board.id, name: board.name, type: board.type, location: board.location || null });
    const issues = await loadBoardIssues(board);
    /* only replace data AFTER a successful load — never lose the previous board on failure */
    state.issues = issues;
    const m = computeMetrics(issues);
    state.lastBoard = board;
    state.lastMetrics = m;

    hide($('#errorBanner'));

    renderDashboard(board, m);
    $('#syncedAt').textContent = 'updated ' + new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    /* keep the previous board's dashboard intact — just warn */
    $('#issueCountBadge').textContent = 'failed';
    const banner = $('#errorBanner');
    let msg = e?.message || 'Failed to load board issues.';
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
    blockedDist: new Map(),     // blocked/canceled/rejected work by status
    blockedCount: 0,
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
    /* completion moment: prefer resolutiondate, else first changelog entry into a
       completed status (eg Released / Babysitting / Done Approved have no resolutiondate) */
    const resolved = issueCompletedAt(f, iss.changelog);
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

    /* blocked / canceled / rejected work — counted separately (shown in its own chart) */
    if (isBlockedStatus(f)) {
      m.blockedCount++;
      m.blockedDist.set(statusName, (m.blockedDist.get(statusName) || 0) + 1);
    }

    /* time-in-status from changelog. Excluded statuses (done/canceled/blocked) are
       still recorded for the Status Distribution, but we DROP their contributions to
       the active-work status-time / phase-delay maps so "Avg Time in Status" and
       "Stakeholder vs Team Delays" reflect real flow time, not parked/finished states. */
    const evts = [];
    const excludedNow = isExcludedStatus(f);
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
      if (ev.ts > prevTs && !isExcludedStatus({ status: { name: prevName } })) {
        addTime(m.statusTime, prevName, ev.ts - prevTs);
      }
      prevTs = ev.ts;
      if (ev.to) prevName = ev.to;
    }
    const curAge = Math.max(0, NOW - prevTs);
    if (!excludedNow && !isExcludedStatus({ status: { name: prevName } })) {
      addTime(m.statusTime, prevName, curAge);
    }

    if (!doneCat && !isExcludedStatus(f)) {
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

  /* stakeholder-vs-team phase delays (from changelog status times) — only ACTIVE statuses,
     with the excluded done/blocked/canceled set filtered out */
  m.phaseDelays = [...m.statusTime.entries()]
    .map(([k, v]) => ({ status: k, avg: v.sum / v.n, side: classifySide(k), sum: v.sum, n: v.n }))
    .filter((r) => r.side && !isExcludedStatus({ status: { name: r.status } }))
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

/* ══════════════════ compare mode (board A vs board B) ══════════════════ */
/* Enter compare mode: board A = the dashboard currently open, board B is picked
   from the dropdown. Every KPI shows both values + a winner chip + delta, every
   chart overlays both boards as two datasets, and a "who wins what" strip
   replaces the auto-insights. Leaving compare restores the normal dashboard. */
async function enterCompareMode() {
  if (!state.conn) { toast('Connect to Jira first.', 'warn'); return; }
  if (!state.boards.length) {
    toast('Board list is still loading — try again in a moment.', 'warn');
    return;
  }
  if (!state.lastBoard || !state.lastMetrics) { toast('Open a board first.', 'warn'); return; }

  const btn = $('#compareBtn');
  btn.classList.add('active');

  /* populate the board picker (exclude the board we're currently viewing) */
  const sel = $('#cmpBoardSelect');
  sel.innerHTML = '<option value="">Choose a board to compare…</option>' +
    state.boards
      .filter((b) => b.id !== state.lastBoard.id)
      .map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`)
      .join('');
  if (state.compare?.boardId && state.boards.some((b) => b.id === state.compare.boardId)) {
    sel.value = String(state.compare.boardId);
  } else {
    sel.value = '';
  }

  show($('#compareBar'));
  $('#cmpNameA').textContent = state.lastBoard.name;
  $('#cmpSynced').textContent = state.compare ? 'B synced' : '';
  renderCompareDashboard();   /* re-render KPIs in compare layout (even before B is chosen) */
  if (state.compare) renderCharts(effectiveCharts(), state.lastMetrics);
}

function exitCompareMode() {
  state.compare = null;
  /* bump the generation so any in-flight compare-board load knows it is stale */
  state.compareGen = (state.compareGen || 0) + 1;
  hide($('#compareBar'));
  $('#compareBtn').classList.remove('active');
  if (state.lastBoard && state.lastMetrics) {
    renderDashboard(state.lastBoard, state.lastMetrics);
  }
}

async function onCompareBoardChange(ev) {
  const id = parseInt(ev.target.value, 10);
  if (!id || !state.lastBoard) return;
  if (state.compare && state.compare.boardId === id) return;

  const board = state.boards.find((b) => b.id === id);
  if (!board) return;

  const sel = $('#cmpBoardSelect');
  sel.disabled = true;
  $('#cmpSynced').innerHTML = '<span class="spinner spinner-sm"></span> syncing board B…';

  /* staleness guard: the user may switch boards (or exit compare) while board B is
     loading. Capture board A's id + a compare generation now and re-verify after the
     await — a stale load must NEVER resurrect compare mode onto a different board's
     dashboard, and exiting compare during the load must discard the result. */
  const boardAId = state.lastBoard?.id;
  const genAtStart = state.compareGen || 0;
  const isStale = () => !state.lastBoard || state.lastBoard.id !== boardAId || (state.compareGen || 0) !== genAtStart;

  try {
    logDiag('info', 'Compare board load started', { boardId: board.id, name: board.name });
    const issues = await loadBoardIssues(board);
    if (isStale()) {
      logDiag('info', 'Compare load discarded — board changed during sync', { boardId: board.id });
      return;
    }
    const m = computeMetrics(issues);
    /* save-then-restore: loadBoardIssues writes hasChangelog/boardLoadMeta into
       global state for the MAIN board — snapshot it for board B's charts instead */
    state.compare = {
      boardId: board.id, board, issues, metrics: m,
      hasChangelog: state.hasChangelog,
      syncedAt: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    };
    $('#cmpSynced').textContent = `board B synced · ${state.compare.syncedAt}`;
    logDiag('info', 'Compare board loaded', { boardId: board.id, issues: issues.length, hasChangelog: state.hasChangelog });
    renderCompareDashboard();
    renderCharts(effectiveCharts(), state.lastMetrics);
  } catch (e) {
    if (isStale()) return; /* board switched during a failing load — stay silent */
    $('#cmpSynced').textContent = '⚠ board B failed to sync — pick another';
    toast(`Could not load “${board.name}” for comparison.`, 'warn');
    logDiag('error', 'Compare board load failed', { boardId: board.id, message: e?.message, status: e?.status });
    if (!state.compare) { sel.value = ''; }
  } finally {
    sel.disabled = false;
  }
}

/* KPI metric descriptors for compare mode */
const CMP_KPIS = [
  { key: 'total',    label: 'Issues analyzed', icon: '▦', cls: 'ic-indigo',     fmt: (v) => String(v),                          winner: 'more',  sub: 'on the board' },
  { key: 'created30',label: 'Created · 30 days', icon: '＋', cls: 'ic-cyan',   fmt: (v) => String(v),                          winner: 'more',  sub: 'new issues' },
  { key: 'done',     label: 'Done overall', icon: '✓', cls: 'ic-green',       fmt: (v) => String(v),                          winner: 'more',  sub: 'completed' },
  { key: 'resolved30',label: 'Resolved · 30 days', icon: '↻', cls: 'ic-green',  fmt: (v) => String(v),                          winner: 'more',  sub: 'shipped recently' },
  { key: 'cycleAvg', label: 'Avg cycle time', icon: '⏱', cls: 'ic-violet',     fmt: (v) => (v != null ? fmtDuration(v) : '—'), winner: 'less',  sub: 'create → resolve' },
  { key: 'wip',      label: 'Work in progress', icon: '◔', cls: 'ic-amber',     fmt: (v) => String(v),                          winner: 'less',  sub: 'not yet done' },
];

/* re-render the six KPI cards in compare layout (A value vs B value + winner + delta) */
function renderCompareDashboard() {
  const A = state.lastMetrics, B = state.compare?.metrics;
  const nameA = state.lastBoard?.name || 'Board A';
  const nameB = state.compare?.board?.name || null;
  const grid = document.querySelector('.kpi-grid');
  if (!grid) return;

  grid.classList.add('kpi-grid-compare');
  grid.innerHTML = CMP_KPIS.map((k) => {
    const a = A ? A[k.key] : null;
    const b = B ? B[k.key] : null;
    const valuesHtml = B
      ? `<div class="cmp-values">
           <span class="cmp-val cmp-val-a"><span class="cmp-val-num">${k.fmt(a)}</span><span class="cmp-val-tag">A</span></span>
           <span class="cmp-vs-inline">/</span>
           <span class="cmp-val cmp-val-b"><span class="cmp-val-num">${k.fmt(b)}</span><span class="cmp-val-tag">B</span></span>
         </div>`
      : `<div class="cmp-values"><span class="cmp-val-num" style="color:var(--muted)">—</span></div>`;

    let winnerHtml = '', deltaHtml = '';
    if (B) {
      const numA = (a != null && isFinite(a)) ? a : null;
      const numB = (b != null && isFinite(b)) ? b : null;
      if (numA != null && numB != null && numA !== numB) {
        const aWins = k.winner === 'less' ? numA < numB : numA > numB;
        const d = pctDelta(numB, numA);
        const label = k.winner === 'less'
          ? (aWins ? `${nameA} is faster` : `${nameB} is faster`)
          : (aWins ? `${nameA} higher` : `${nameB} higher`);
        winnerHtml = `<span class="cmp-winner ${aWins ? 'cmp-winner-a' : 'cmp-winner-b'}">${aWins ? '▲' : '▼'} ${escapeHtml(label)}</span>`;
        deltaHtml = `<div class="cmp-delta ${d > 0 ? 'up' : 'down'}">A is ${Math.abs(d)}% ${d > 0 ? 'above' : 'below'} B</div>`;
      } else if (numA != null && numB != null) {
        winnerHtml = `<span class="cmp-winner cmp-winner-even">— even</span>`;
        deltaHtml = `<div class="cmp-delta even">identical on both boards</div>`;
      } else {
        deltaHtml = `<div class="cmp-delta even">no data to compare</div>`;
      }
    } else {
      deltaHtml = `<div class="cmp-delta even">${escapeHtml(nameA)} vs <b>?</b> — pick board B above</div>`;
    }

    return `<div class="kpi glass compare">
      <div class="kpi-top"><span class="kpi-icon ${k.cls}">${k.icon}</span><span class="kpi-label">${escapeHtml(k.label)}</span></div>
      ${valuesHtml}
      ${winnerHtml}
      ${deltaHtml}
    </div>`;
  }).join('');

  /* keep the header badge informative */
  $('#issueCountBadge').textContent = B
    ? `A: ${A?.total ?? 0} issues · B: ${B.total} issues`
    : `${A?.total ?? 0} issues analyzed`;

  /* insights strip → compare winners strip */
  const strip = $('#insightsStrip');
  if (B) {
    const ins = buildCompareInsights(A, B, nameA, nameB);
    strip.innerHTML = ins.map((x, i) =>
      `<div class="cmp-insight" style="animation-delay:${i * 70}ms"><span class="ins-icon">${x.icon}</span><span>${x.html}</span></div>`
    ).join('');
    show(strip);
  } else {
    strip.innerHTML = `<div class="cmp-insight"><span class="ins-icon">⇄</span><span><b>Compare mode</b> — pick a second board in the bar above to overlay every chart and metric.</span></div>`;
    show(strip);
  }
}

/* "who wins what" summary for the compare strip */
function buildCompareInsights(A, B, nameA, nameB) {
  const out = [];
  const d = (x, y) => pctDelta(y, x); /* % A vs B */
  const wA = (html) => `<span class="cmp-good">${escapeHtml(nameA)}</span> ${html}`;
  const wB = (html) => `<span class="cmp-good">${escapeHtml(nameB)}</span> ${html}`;

  /* throughput winner */
  if (A.resolved30 !== B.resolved30) {
    const aWins = A.resolved30 > B.resolved30;
    out.push({ icon: '⚡', html: `Throughput · ${aWins ? wA(`shipped <b>${A.resolved30}</b> vs <b>${B.resolved30}</b> in 30 days`) : wB(`shipped <b>${B.resolved30}</b> vs <b>${A.resolved30}</b> in 30 days`)}` });
  }
  /* cycle time winner (lower is better) */
  if (A.cycleAvg != null && B.cycleAvg != null && Math.round(A.cycleAvg) !== Math.round(B.cycleAvg)) {
    const aWins = A.cycleAvg < B.cycleAvg;
    out.push({ icon: '⏱', html: `Speed · ${aWins ? wA(`closes work in <b>${fmtDuration(A.cycleAvg)}</b> vs <b>${fmtDuration(B.cycleAvg)}</b>`) : wB(`closes work in <b>${fmtDuration(B.cycleAvg)}</b> vs <b>${fmtDuration(A.cycleAvg)}</b>`)}` });
  }
  /* WIP (lower is healthier) */
  if (A.wip !== B.wip) {
    const aWins = A.wip < B.wip;
    out.push({ icon: '📋', html: `Open load · ${aWins ? wA(`carries less WIP (<b>${A.wip}</b> vs <b>${B.wip}</b>)`) : wB(`carries less WIP (<b>${B.wip}</b> vs <b>${A.wip}</b>)`)}` });
  }
  /* completion rate */
  if (A.doneRate !== B.doneRate) {
    const aWins = A.doneRate > B.doneRate;
    out.push({ icon: '🏁', html: `Completion · ${aWins ? wA(`<b>${A.doneRate}%</b> done vs <b>${B.doneRate}%</b>`) : wB(`<b>${B.doneRate}%</b> done vs <b>${A.doneRate}%</b>`)}` });
  }
  /* blocked work */
  if (A.blockedCount !== B.blockedCount) {
    const aWins = A.blockedCount < B.blockedCount;
    out.push({ icon: '⛔', html: `Blocked work · ${aWins ? wA(`has less (<b>${A.blockedCount}</b> vs <b>${B.blockedCount}</b>)`) : wB(`has less (<b>${B.blockedCount}</b> vs <b>${A.blockedCount}</b>)`)}` });
  }
  /* biggest divergence */
  const dd = d(A.created30, B.created30);
  if (dd !== null && Math.abs(dd) >= 25) {
    out.push({ icon: '📥', cls: '', html: `Intake gap · ${nameA} created <b>${A.created30}</b> vs <b>${B.created30}</b> (${dd > 0 ? '+' : ''}${dd}%)` });
  }
  return out.slice(0, 4);
}

/* ══════════════════ compare from the MAIN page (pick 2 boards) ══════════════════
   "⇄ Compare boards" turns the board grid into a picker: click any card to slot it
   as A, another as B, then "Compare →" loads both and opens the dashboard with every
   KPI + chart overlaid. Available on the admin panel AND the public user view. */
function togglePickCompareMode() {
  if (state.pickCompare) { state.pickCompare = null; updatePickBar(); renderBoardCards(); return; }
  if (!state.boards.length) { toast('Board list is still loading — try again in a moment.', 'warn'); return; }
  state.pickCompare = { a: null, b: null };
  updatePickBar();
  renderBoardCards();
}

/* card click inside pick mode: fill A, then B; click a picked card to un-pick it;
   click an unpicked card when both slots are full → replace B */
function togglePickCompare(board) {
  const pick = state.pickCompare;
  if (!pick) return;
  if (pick.a === board.id) { pick.a = pick.b; pick.b = null; }
  else if (pick.b === board.id) { pick.b = null; }
  else if (pick.a == null) { pick.a = board.id; }
  else if (pick.b == null) { pick.b = board.id; }
  else { pick.b = board.id; }
  updatePickBar();
  renderBoardCards();
}

/* sync the floating pick bar with state.pickCompare. Every pick-mode state
   change funnels through here, so this is also where the body class lives —
   it drives the card hover/label styling while picking. */
function updatePickBar() {
  document.body.classList.toggle('pick-mode', !!state.pickCompare);
  const bar = $('#pickCompareBar');
  if (!bar) return;
  const pick = state.pickCompare;
  if (!pick) { hide(bar); return; }
  const nameA = pick.a != null ? (state.boards.find((x) => x.id === pick.a) || {}).name : null;
  const nameB = pick.b != null ? (state.boards.find((x) => x.id === pick.b) || {}).name : null;
  $('#pickSlotA').textContent = nameA || 'Pick board A';
  $('#pickSlotA').classList.toggle('filled', !!nameA);
  $('#pickSlotB').textContent = nameB || 'Pick board B';
  $('#pickSlotB').classList.toggle('filled', !!nameB);
  $('#pickGoBtn').disabled = !(nameA && nameB);
  $('#pickHint').textContent = !nameA ? 'click a card to slot it as A'
    : !nameB ? 'now click a second card as B'
    : 'ready — open the side-by-side view';
  show(bar);
}

/* load BOTH picked boards and open the dashboard in compare mode.
   Reuses the whole existing pipeline: selectBoard() for A, enterCompareMode() +
   onCompareBoardChange() for B — identical code path as the in-dashboard picker. */
async function openPickCompareDashboard() {
  const pick = state.pickCompare;
  if (!pick || pick.a == null || pick.b == null) return;
  const boardA = state.boards.find((x) => x.id === pick.a);
  const boardB = state.boards.find((x) => x.id === pick.b);
  if (!boardA || !boardB) return;

  /* leave pick mode first (bar hidden, cards clickable normally again) */
  state.pickCompare = null;
  updatePickBar();

  toast(`Loading “${boardA.name}” vs “${boardB.name}”…`);
  await selectBoard(boardA);
  if (!state.lastBoard || state.lastBoard.id !== boardA.id) return;   // A failed → error banner already shown

  /* enter compare on A's dashboard and sync B through the standard picker path */
  await enterCompareMode();
  const sel = $('#cmpBoardSelect');
  if (!sel.querySelector(`option[value="${boardB.id}"]`)) { toast('Could not start compare mode.', 'warn'); return; }
  sel.value = String(boardB.id);
  await onCompareBoardChange({ target: sel });
}

/* ── compare-mode chart merging: overlay board B's data onto each chart ── */
function buildCompareChartData(def, mA, issuesA, hcA, mB, issuesB, hcB) {
  const dataA = buildChartData(def, mA, issuesA, hcA);
  const dataB = buildChartData(def, mB, issuesB, hcB);
  const emptyA = dataA.empty, emptyB = dataB.empty;
  const nameB = state.compare?.board?.name || 'Board B';
  const nameA = state.lastBoard?.name || 'Board A';
  const B_SERIES = { label: nameB, color: '#22d3ee', rgb: ACCENT_RGB.cyan };
  if (emptyA && emptyB) return { empty: ['No data on either board', 'for this chart'] };

  /* doughnuts render a single ring on one canvas — a second board cannot be
     overlaid legibly. They stay board-A only; KPI pairs + the insight strip
     already carry board B's numbers. Everything else gets a true overlay. */
  if (def.type === 'doughnut') {
    if (emptyA) return { empty: ['No data on board A for this chart'] };
    return dataA;
  }

  /* time-series charts bucket from "now" backwards on both boards, so the
     label at the same index means the same date — plain index alignment is
     correct. Pad the shorter series with nulls. Datasets get board-name
     prefixes so the legend tells the two boards apart. */
  const isTime = def.metric === 'flow' || def.metric === 'created' || def.metric === 'resolved';
  if (isTime) {
    const labels = (dataA.labels || dataB.labels || []);
    const n = Math.max(labels.length, (dataA.datasets?.[0]?.data || []).length, (dataB.datasets?.[0]?.data || []).length);
    const pad = (arr) => Array.from({ length: n }, (_, i) => arr[i] ?? null);
    const relabel = (ds, boardName) => ({
      ...ds,
      data: pad(ds.data),
      label: (dataA.datasets?.length > 1 || dataB.datasets?.length > 1)
        ? `${boardName} · ${ds.label}`
        : boardName,
    });
    const datasets = [];
    if (!emptyA) datasets.push(...dataA.datasets.map((ds) => relabel(ds, nameA)));
    if (!emptyB) datasets.push(...dataB.datasets.map((ds) => relabel({ ...ds, color: '#22d3ee', rgb: ACCENT_RGB.cyan }, nameB)));
    if (!datasets.length) return { empty: ['No comparable data'] };
    return {
      labels: labels,
      datasets,
      duration: false,
      subtitle: dataA.subtitle || dataB.subtitle || def.subtitle,
      extraSub: `${escapeHtml(nameB)} shown in cyan`,
    };
  }

  /* category / statusTime charts: merge on the union of labels, one value per
     board, then re-sort by the max of the two series so grouped bars stay
     readable (single-board charts sort by value; two boards need a shared order) */
  const rawLabels = [];
  const seen = new Set();
  const collect = (d) => (d.labels || []).forEach((l) => { if (!seen.has(l)) { seen.add(l); rawLabels.push(l); } });
  if (!emptyA) collect(dataA);
  if (!emptyB) collect(dataB);

  const aMap = new Map((dataA.labels || []).map((l, i) => [l, i]));
  const bMap = new Map((dataB.labels || []).map((l, i) => [l, i]));
  const aVals = dataA.datasets?.[0]?.data || [];
  const bVals = dataB.datasets?.[0]?.data || [];
  const align = (map, vals, l) => {
    const i = map.get(l);
    return i != null ? (vals[i] ?? null) : null;
  };

  const scored = rawLabels.map((l) => {
    const av = align(aMap, aVals, l);
    const bv = align(bMap, bVals, l);
    return { l, av, bv, score: Math.max(av ?? 0, bv ?? 0) };
  });
  scored.sort((x, y) => y.score - x.score);

  const topN = def.topN || 0;
  const picked = topN ? scored.slice(0, topN) : scored;

  const isDuration = !!(dataA.duration || dataB.duration);
  let labels = picked.map((r) => r.l);
  let dsA = picked.map((r) => r.av);
  let dsB = picked.map((r) => r.bv);
  if (def.type === 'hbar') {
    labels = labels.slice().reverse();
    dsA = dsA.slice().reverse();
    dsB = dsB.slice().reverse();
  }

  const datasets = [];
  if (!emptyA) {
    datasets.push({ label: nameA, data: dsA, color: ACCENT_HEX[def.color] || ACCENT_HEX.indigo, rgb: ACCENT_RGB[def.color] || ACCENT_RGB.indigo });
  }
  if (!emptyB) {
    datasets.push({ ...B_SERIES, data: dsB });
  }

  const base = emptyA ? dataB : dataA;
  const extraSub = (emptyA || emptyB)
    ? `${emptyA ? escapeHtml(nameB) + ' only' : escapeHtml(nameA) + ' only'} · one board has no data here`
    : `${escapeHtml(nameB)} shown in cyan`;

  return {
    labels,
    datasets,
    colors: undefined,       /* per-bar colors make no sense with two series */
    duration: isDuration,
    subtitle: base.subtitle || def.subtitle || '',
    extraSub,
    centerValue: isDuration
      ? fmtDuration(avgOf(dsA.concat(dsB)) * DAY)
      : Math.round(dsA.concat(dsB).reduce((s, v) => s + (v || 0), 0)),
    centerLabel: isDuration ? 'avg' : 'issues',
  };
}

/* mean of a list that may contain nulls */
function avgOf(vals) {
  const v = vals.filter((x) => x != null && isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

/* ══════════════════ chart customization engine ══════════════════ */
const CHART_STORE_PREFIX = 'jp_charts_v1_';

/* metric catalogue: what a chart can show */
const METRIC_DEFS = {
  flow:          { label: 'Created vs resolved over time', kind: 'time' },
  created:       { label: 'Issues created over time',      kind: 'time' },
  resolved:      { label: 'Issues resolved over time',     kind: 'time' },
  count:         { label: 'Issue count by group',          kind: 'category' },
  blockedCount:  { label: 'Blocked / canceled by status',  kind: 'category', blockedOnly: true },
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
  { id: 'throughput', title: 'Monthly Throughput', subtitle: 'Completed issues per month (Done/Approved/Babysitting/Released)', type: 'bar', metric: 'resolved', groupBy: 'time', bucket: 'month', range: 182, filter: 'all', topN: 0, split: 'none', color: 'green', wide: true, centerTotal: false },
  { id: 'createdTrend', title: 'Issues Created', subtitle: 'Weekly creation trend', type: 'line', metric: 'created', groupBy: 'time', bucket: 'week', range: 182, filter: 'all', topN: 0, split: 'none', color: 'cyan', wide: false, centerTotal: false },
  { id: 'resolvedTrend', title: 'Issues Resolved', subtitle: 'Monthly completion trend', type: 'line', metric: 'resolved', groupBy: 'time', bucket: 'month', range: 182, filter: 'all', topN: 0, split: 'none', color: 'green', wide: false, centerTotal: false },
  { id: 'blockedDist', title: 'Blocked & Canceled', subtitle: 'Work sitting on blocked/canceled/rejected statuses', type: 'hbar', metric: 'blockedCount', groupBy: 'status', bucket: 'week', range: 0, filter: 'all', topN: 10, split: 'none', color: 'pink', wide: false, centerTotal: false },
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

/* ── status intelligence (org flow) ─────────────────────────────────
   In the [P] boards the work is finished through these statuses, and crucially these
   issues carry NO `resolutiondate` — completion is only visible in the changelog. We
   therefore treat these as the "Completed" set and derive a completion timestamp from
   the FIRST transition into one of them (or from resolutiondate when present). */

/* statuses that count as a delivered / completed outcome (throughput, resolved) */
const COMPLETED_STATUSES = ['Done Approved', 'Released', 'Babysitting', 'Done', 'Closed', 'Resolved'];
const COMPLETED_RE = /^(done approved|released|babysitting|done|closed|resolved|ready for release|ready for development|onboarding completed|hired)$/i;

/* terminal statuses that are NOT a completed delivery — excluded from delivery metrics
   and flagged separately as "stuck/removed" work (Blocked / Canceled / Rejected…). */
const BLOCKED_STATUSES = ['Blocked', 'Canceled', 'Cancelled', 'Rejected', 'Declined', 'Discarded', 'Stuck', 'On Hold'];
const BLOCKED_RE = /^(blocked|canceled|cancelled|rejected|declined|discarded|stuck|on hold)$/i;

/* does a status name represent a completed delivery?
   allowCategory: also accept statuses Jira classifies as statusCategory=done
   (learned at runtime from the loaded issues) even when the name is custom
   (e.g. "Deployed", "Shipped") — but never blocked/cancelled statuses. */
function isCompletedStatus(f, allowCategory) {
  const name = String(f?.status?.name || '');
  if (COMPLETED_STATUSES.includes(name)) return true;
  if (COMPLETED_RE.test(name)) return true;
  if (allowCategory && DONE_STATUS_NAMES.has(name.toLowerCase()) && !isBlockedStatus(f)) return true;
  return false;
}

/* status names observed on loaded issues whose statusCategory is 'done' (excluding
   blocked/cancelled). Changelog entries carry only status NAMES, so this set is how
   we recognise a transition into a custom-named done status during completion walks. */
const DONE_STATUS_NAMES = new Set();
function rememberDoneStatuses(issues) {
  for (const iss of issues || []) {
    const f = iss.fields || {};
    if (f.status?.name && statusIsDone(f) && !isBlockedStatus(f)) {
      DONE_STATUS_NAMES.add(String(f.status.name).toLowerCase());
    }
  }
}

/* does a status name represent blocked/canceled/rejected work? */
function isBlockedStatus(f) {
  const name = String(f?.status?.name || '');
  if (BLOCKED_STATUSES.includes(name)) return true;
  return BLOCKED_RE.test(name);
}

/* derive the moment an issue was COMPLETED. Prefer `resolutiondate`, but for issues
   that stay in a done status without one (e.g. "Released"/"Babysitting"), walk the
   changelog for the first transition into a completed status. Returns a ms timestamp or null. */
function issueCompletedAt(f, changelog) {
  if (f?.resolutiondate) return Date.parse(f.resolutiondate);
  const histories = (changelog || {}).histories || [];
  const evts = [];
  for (const h of histories) {
    for (const it of h.items || []) {
      if (String(it.field).toLowerCase() === 'status' && it.toString) {
        evts.push({ ts: Date.parse(h.created), to: it.toString });
      }
    }
  }
  evts.sort((a, b) => a.ts - b.ts);
  for (const ev of evts) {
    /* allowCategory=true: also recognise transitions into custom-named done statuses
       (statusCategory=done) learned from the loaded issue set */
    if (isCompletedStatus({ status: { name: ev.to } }, true)) return ev.ts;
  }
  return null;
}

/* helper: is this status one of the 'excluded' terminal set (used to keep status-time &
   phase-delay charts focused on active work, not finished/cancelled states)? */
function isExcludedStatus(f) {
  return isCompletedStatus(f) || isBlockedStatus(f);
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
    if (wantResolved) {
      const ts = issueCompletedAt(f, iss.changelog);
      if (ts) oldest = Math.min(oldest, ts);
    }
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
    if (wantResolved) {
      const ts = issueCompletedAt(f, iss.changelog);
      if (ts) {
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
    else if (def.metric === 'blockedCount') {
      if (!isBlockedStatus(f)) continue;
      val = 1;
    } else if (def.metric === 'avgCycle') {
      const doneAt = issueCompletedAt(f, iss.changelog);
      if (!doneAt || !f.created) continue;
      val = doneAt - Date.parse(f.created);
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
  const actions = canModify()
    ? (def.builtin
        ? `<button class="chart-btn" data-act="edit" data-id="${def.id}" title="Configure this chart">✎</button>` +
          (overridden ? `<button class="chart-btn" data-act="reset" data-id="${def.id}" title="Reset to default">↺</button>` : '') +
          `<button class="chart-btn" data-act="hide" data-id="${def.id}" title="Hide this chart">✕</button>`
        : `<button class="chart-btn" data-act="edit" data-id="${def.id}" title="Configure this chart">✎</button>` +
          `<button class="chart-btn" data-act="del" data-id="${def.id}" title="Delete this chart">🗑</button>`)
    : '';
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
        layout: { padding: 4 },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 12, font: { size: 11 } } },
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
        barPercentage: multi ? 0.58 : 0.68, categoryPercentage: 0.72,
        maxBarThickness: 46,
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
            x: { ...theme.scales.x, ...(dur ? { ticks: { callback: (v) => v + 'd' } } : {}), grid: { display: false } },
            y: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { precision: 0 } },
          }
        : {
            ...theme.scales,
            x: { ...theme.scales.x, grid: { display: false } },
          },
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
  /* compare mode: overlay board B onto every non-doughnut chart using the
     snapshot stored in state.compare (board B issues/metrics/hasChangelog) */
  const cmp = state.compare && state.compare.metrics ? state.compare : null;
  for (const def of defs) {
    const canvasId = 'chart_' + def.id;
    const data = cmp
      ? buildCompareChartData(def, m, state.issues, state.hasChangelog, cmp.metrics, cmp.issues, cmp.hasChangelog)
      : buildChartData(def, m);
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

/* clear the dashboard and show a loading state while a new board syncs.
   This prevents the PREVIOUS board's charts/KPIs from lingering on screen during
   the (sometimes slow) fetch — the user never sees stale data from another board. */
function showDashLoading(boardName) {
  ['kpiTotal', 'kpiCreated', 'kpiDone', 'kpiResolved', 'kpiCycle', 'kpiWip'].forEach((id) => ($('#' + id).textContent = '…'));
  ['kpiTotalSub', 'kpiCreatedSub', 'kpiDoneSub', 'kpiResolvedSub', 'kpiCycleSub', 'kpiWipSub'].forEach((id) => { const el = $('#' + id); if (el) el.textContent = 'syncing…'; });
  $('#issueCountBadge').textContent = 'syncing…';
  $('#slowTableBody').innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:26px"><span class="spinner spinner-sm"></span> Loading ${escapeHtml(boardName || 'this board')}…</td></tr>`;
  hide($('#insightsStrip'));
  hide($('#changelogNotice'));
  /* destroy current chart canvases + replace the grid with a loading placeholder */
  Object.values(state.charts).forEach((c) => c && c.destroy());
  state.charts = {};
  $('#chartsGrid').innerHTML = '<div class="card glass chart-card wide" style="text-align:center;padding:42px;color:var(--muted)"><span class="spinner spinner-lg"></span><div style="margin-top:14px">Syncing your dashboard…</div></div>';
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
  /* Settings must open even before the first successful connection — the
     relay inputs are the escape hatch for "Could not reach" errors. */
  if (!state.conn) state.conn = { domain: '', email: '', token: '', useProxy: false, proxyApiKey: '', proxyUrl: '' };
  $('#setDomain').value = state.conn.domain.replace(/^https?:\/\//, '');
  $('#setEmail').value = state.conn.email;
  $('#setToken').value = '';
  $('#proxyToggle').checked = !!state.conn.useProxy;
  /* relay prefs must round-trip — otherwise a re-save would wipe them */
  $('#proxyKeyInput').value = state.conn.proxyApiKey || '';
  $('#proxyUrlInput').value = state.conn.proxyUrl || '';
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
  const proxyUrl = $('#proxyUrlInput').value.trim();
  const proxyApiKey = $('#proxyKeyInput').value.trim();
  const useProxy = $('#proxyToggle').checked;
  const hasSession = !!(state.conn && state.conn.token);
  saveRelayPrefs(useProxy, proxyApiKey, proxyUrl);
  if (hasSession) {
    const email = $('#setEmail').value.trim() || state.conn.email;
    const token = $('#setToken').value.trim() || state.conn.token;
    let domain;
    try { domain = normalizeDomain($('#setDomain').value || state.conn.domain); }
    catch (e) { toast(e.message, 'err'); return; }
    state.conn = { domain, email, token, useProxy, proxyApiKey, proxyUrl };
    saveConn();
  } else {
    /* pre-connection: the user is configuring the relay escape hatch for a
       "Could not reach" error — relay prefs are already persisted above; keep
       the (non-)session as-is and stay on the setup screen */
    if (state.conn && !state.conn.token) {
      state.conn = { ...state.conn, useProxy, proxyApiKey, proxyUrl };
    }
  }
  hide($('#settingsModal'));
  toast(hasSession ? 'Settings saved.' : 'Relay settings saved. Now connect to Jira.', 'ok');
  if (hasSession) goBoards();
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

  /* relay settings are reachable from the setup screen — without them a user
     blocked by CORS/rate-limited public relays has no way to configure one */
  const setupRelayBtn = $('#setupRelayBtn');
  if (setupRelayBtn) setupRelayBtn.addEventListener('click', openSettings);

  $('#boardSelect').addEventListener('change', (ev) => {
    const val = ev.target.value;
    if (!val) { showAllBoards(); return; }   // "All boards" selected → main page
    const b = state.boards.find((x) => x.id === parseInt(val, 10));
    if (b) openBoard(b);
  });
  $('#syncBoardsBtn').addEventListener('click', () => goBoards({ autoOpenLast: false }));
  /* compare mode wiring: ⇄ toggle, board B picker, exit button */
  $('#compareBtn').addEventListener('click', enterCompareMode);
  $('#cmpExitBtn').addEventListener('click', exitCompareMode);
  $('#cmpBoardSelect').addEventListener('change', onCompareBoardChange);
  /* main-page compare: ⇄ pick mode toggle, floating bar actions */
  const pickToggle = $('#pickCompareBtn');
  if (pickToggle) pickToggle.addEventListener('click', togglePickCompareMode);
  $('#pickCancelBtn').addEventListener('click', togglePickCompareMode);
  $('#pickGoBtn').addEventListener('click', () => { openPickCompareDashboard().catch((e) => { toast(e?.message || 'Compare failed to load.', 'warn'); logDiag('error', 'Pick-compare failed', { message: e?.message }); }); });
  $('#brandBtn').addEventListener('click', () => { location.hash = '#/'; showAllBoards(); });
  $('#brandBtn').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); location.hash = '#/'; showAllBoards(); }
  });
  $('#backToBoardsBtn').addEventListener('click', () => { location.hash = '#/'; showAllBoards(); });
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
    const btn = $('#publishAllBtn');
    btn.disabled = true;
    btn.textContent = 'Publishing… 0/' + state.boards.length;
    try {
      const snap = await createAllBoardsSnapshot((done, total) => {
        btn.textContent = 'Publishing… ' + done + '/' + total;
      });
      if (!snap) return;
      const link = buildShareUrl(snap);
      navigator.clipboard.writeText(link).then(() => toast('All ' + snap.boards.length + ' boards published — link copied.', 'ok')).catch(() => toast('All boards published. Token: ' + snap.token, 'ok'));
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

  /* route on hash change (back/forward navigation) — but not when opening a share link */
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#p=') || location.hash.startsWith('#share')) return;
    if (state.conn) route();
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
      /* merge relay prefs from the dedicated store (covers sessions saved
         before the relay fields existed, without overriding newer values) */
      const rp = loadRelayPrefs();
      if (rp) {
        if (saved.useProxy == null) saved.useProxy = rp.useProxy;
        if (!saved.proxyApiKey) saved.proxyApiKey = rp.proxyApiKey || '';
        if (!saved.proxyUrl) saved.proxyUrl = rp.proxyUrl || '';
      }
      state.conn = saved;
    }

    if (ADMIN_PANEL) {
      /* ADMIN PANEL: show the live, synced dashboard. If a session exists, enter the
         app; otherwise show the API-token connect flow (the only place it belongs). */
      if (saved) enterApp();
      else showSetup();
    } else {
      /* PUBLIC APP (root URL): org members land here. If a Jira session exists on this
         device, open the LIVE read-only dashboard so users see the same charts & design
         as the admin panel — but without any admin functions/buttons (no publish, no new
         chart, no settings, no diagnostics). Without a session, fall back to the secure
         published-snapshot gate. */
      if (saved) enterApp();
      else showPublicLanding();
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
