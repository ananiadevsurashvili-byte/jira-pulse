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
const ISSUE_FIELDS = ['summary', 'status', 'resolutiondate', 'created', 'updated', 'issuetype', 'assignee', 'priority', 'labels'];

/* complexity field discovery: Jira custom fields carry cryptic ids (customfield_NNNNN)
   that differ per instance, and the search API SILENTLY DROPS unknown ids from the
   `fields` param — hardcoding them breaks on every other tenant. So we look the field
   up by NAME in /rest/api/3/field ("Change Request Complexity" → customfield_10945 on
   the current instance), remember its id, and append it to the fetch field list.
   A value-shape scan over the loaded issue set stays as a fallback validator. */
let COMPLEXITY_FIELD_ID = null;
let complexityFieldDiscovery = null;   /* in-flight / settled discovery promise */
const COMPLEXITY_VALUE_RE = /^(small\s*\(s\)|medium\s*\(m\)|large\s*\(l\)|e?xtra\s*large\s*\(xl\)|[smlx])$/i;

/* Ask Jira's field catalog for the complexity field id. Runs once per session;
   failures resolve to null so board loads never block on it. */
function discoverComplexityFieldId() {
  if (COMPLEXITY_FIELD_ID) return Promise.resolve(COMPLEXITY_FIELD_ID);
  if (complexityFieldDiscovery) return complexityFieldDiscovery;
  complexityFieldDiscovery = (async () => {
    try {
      const fields = await api('/rest/api/3/field');
      /* prefer the exact well-known name, then any custom select whose name hints complexity */
      const wanted = fields.find((f) => f && f.custom && /change request complexity/i.test(f.name || ''))
        || fields.find((f) => f && f.custom && /complexity/i.test(f.name || ''));
      if (wanted && wanted.id) {
        COMPLEXITY_FIELD_ID = wanted.id;
        if (!ISSUE_FIELDS.includes(wanted.id)) ISSUE_FIELDS.push(wanted.id);
        logDiag('info', 'Complexity field discovered', { field: wanted.id, name: wanted.name });
      } else {
        logDiag('info', 'No complexity field in Jira field catalog', {});
      }
    } catch (err) {
      logDiag('warn', 'Complexity field discovery failed', { error: String(err && err.message || err) });
    }
    return COMPLEXITY_FIELD_ID;
  })();
  return complexityFieldDiscovery;
}

function detectComplexityField(issues) {
  if (COMPLEXITY_FIELD_ID) return COMPLEXITY_FIELD_ID;
  const hits = new Map();
  for (const iss of issues || []) {
    const f = iss.fields || {};
    for (const k of Object.keys(f)) {
      if (!/^customfield_\d+$/.test(k)) continue;
      const v = f[k];
      if (v == null || v === '' || typeof v !== 'object') continue;
      const name = String(v.value ?? v.name ?? '').trim();
      if (name && COMPLEXITY_VALUE_RE.test(name)) hits.set(k, (hits.get(k) || 0) + 1);
    }
  }
  let best = null, bestN = 0;
  for (const [k, n] of hits) if (n > bestN) { best = k; bestN = n; }
  if (best) {
    COMPLEXITY_FIELD_ID = best;
    if (!ISSUE_FIELDS.includes(best)) ISSUE_FIELDS.push(best);
    logDiag('info', 'Complexity field detected', { field: best, samples: bestN });
  }
  return COMPLEXITY_FIELD_ID;
}
/* canonical display order + short labels for the complexity ladder */
const COMPLEXITY_ORDER = ['Small (S)', 'Medium (M)', 'Large (L)', 'eXtra Large (XL)'];
function complexityShortLabel(v) {
  const s = String(v || '').toLowerCase().replace(/\s+/g, ' ');
  if (/^small|^\(s\)|\(s\)$/.test(s) || s === 's') return 'S';
  if (/^medium|^\(m\)|\(m\)$/.test(s) || s === 'm') return 'M';
  if (/^large|^\(l\)|\(l\)$/.test(s) || s === 'l') return 'L';
  if (/large|xl/.test(s)) return 'XL';
  return v;
}
function complexityOf(f) {
  if (!COMPLEXITY_FIELD_ID) return null;
  const v = f[COMPLEXITY_FIELD_ID];
  if (v == null || v === '') return null;
  return String(typeof v === 'object' ? (v.value ?? v.name ?? '') : v).trim() || null;
}
/* sort rank for the S→XL ladder (unknown values / 'No complexity' sink to the end) */
function complexityRank(v) {
  if (!v || v === 'No complexity') return 99;
  const i = COMPLEXITY_ORDER.findIndex((o) => o.toLowerCase() === String(v).toLowerCase());
  if (i >= 0) return i;
  const s = complexityShortLabel(v).toUpperCase();
  return ['S', 'M', 'L', 'XL'].indexOf(s) >= 0 ? ['S', 'M', 'L', 'XL'].indexOf(s) : 98;
}
/* fixed heat ramp keyed by the SHORT label: green → amber → orange → red */
const COMPLEXITY_COLORS = { S: '#34d399', M: '#fbbf24', L: '#fb923c', XL: '#ef4444' };

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
  compareC: null,      // compare mode: same shape as `compare` for the optional third board C
  compareGen: 0,       // bumped on every compare exit so stale async loads are discarded
  pickCompare: null,   // boards-page pick mode: { a, b, c } board ids (c optional) — null = off
};

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ── i18n · English + Georgian ──────────────────────────────────────
   t(key) resolves against the active language with an English fallback,
   so a missing Georgian key can never break the UI. applyI18n() walks the
   DOM for data-i18n / data-i18n-placeholder / data-i18n-title attributes. */
const LS_LANG = 'jp_lang_v1';
let LANG = 'en';
try { LANG = localStorage.getItem(LS_LANG) === 'ka' ? 'ka' : 'en'; } catch (_) {}

const I18N = {
  en: {
    'nav.allBoards': 'All boards',
    'nav.syncBoards': 'Sync boards',
    'nav.diagnostics': 'Diagnostics',
    'nav.boards': 'Boards',
    'nav.refresh': 'Refresh',
    'nav.publicView': 'Public view',
    'nav.compareBoards': '⇄ Compare boards',
    'nav.compare': '⇄ Compare',
    'nav.admin': 'Admin',
    'nav.org': 'Org',
    'nav.ribbon': '⚙ Management',
    'nav.manage': '⚙ Publish / manage boards',
    'nav.settings': 'Settings',
    'nav.disconnect': 'Disconnect',
    'nav.toBoards': 'Go to all boards',
    'setup.title': 'Your Jira,<br /><span class="grad-text">beautifully visualized.</span>',
    'setup.lead': 'Connect with your Jira API token to get instant delivery insights — how long tasks sit in each status, what shipped in the last 30&nbsp;days, team throughput and more. Credentials never leave your browser.',
    'setup.site': 'Jira site',
    'setup.email': 'Email',
    'setup.token': 'API token',
    'setup.tokenPh': 'Attach your Jira API token',
    'setup.connect': 'Connect to Jira',
    'setup.relay': '⚙ Relay settings',
    'setup.relayTitle': "Configure a CORS relay — fixes 'Could not reach' errors",
    'setup.helpSummary': 'How do I get an API token?',
    'setup.help1': 'Open <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener">id.atlassian.com → API tokens</a>',
    'setup.help2': 'Click <b>Create API token</b>, give it a name and copy the value',
    'setup.help3': 'Paste your site address, account email and token above',
    'setup.privacy': "This app runs fully client-side. Your credentials are stored only in this browser's local storage and sent directly (or via optional CORS proxy) to your Jira site.",
    'setup.privacyAdmin': "This admin panel runs fully client-side. Your credentials are stored only in this browser's local storage and sent directly (or via optional CORS proxy) to your Jira site.",
    'setup.adminTitle': 'Admin panel<br /><span class="grad-text">Manage your deliverable stats.</span>',
    'setup.adminLead': 'This is the <b>JiraPulse admin panel</b>. Connect your Jira account to publish board stats, generate shareable links, and control what your organization can see. Your credentials never leave this browser.',
    'boards.choose': 'Choose a board',
    'boards.sub': 'Synced straight from your Jira instance. Click any card to open its analytics dashboard.',
    'boards.subAdmin': 'Synced straight from your Jira instance. Click any card to open its admin dashboard.',
    'boards.publishAll': '⟳ Publish all',
    'boards.publishAllTitle': 'Publish all boards to your organization',
    'boards.loading': 'Fetching boards from Jira…',
    'boards.empty': 'No boards found for this account.<br />Make sure your Jira user has access to company-managed or team-managed boards.',
    'pick.title': '⇄ Compare boards',
    'pick.slotA': 'Pick board A',
    'pick.slotB': 'Pick board B',
    'pick.slotC': 'Pick board C (optional)',
    'pick.go': 'Compare →',
    'pick.cancel': 'Cancel',
    'pick.hintA': 'click a card to slot it as A',
    'pick.hintB': 'now click a second card as B',
    'pick.hintC': 'optional — click a third card as C, or just compare',
    'pick.hintGo': 'ready — open the side-by-side view',
    'kpi.total': 'Issues analyzed',
    'kpi.totalSub': 'on this board',
    'kpi.created': 'Created · 30 days',
    'kpi.createdSub': 'new tasks registered',
    'kpi.done': 'Done overall',
    'kpi.doneSub': 'completion rate',
    'kpi.resolved': 'Resolved · 30 days',
    'kpi.resolvedSub': 'shipped recently',
    'kpi.cycle': 'Avg cycle time',
    'kpi.cycleSub': 'create → resolve',
    'kpi.wip': 'Work in progress',
    'kpi.wipSub': 'not yet done',
    'cmp.roleA': 'Board A · current',
    'cmp.roleB': 'Board B · compared',
    'cmp.roleC': 'Board C · compared',
    'cmp.loadingBoards': 'Loading boards…',
    'cmp.pickB': 'Pick the board to compare against',
    'cmp.pickC': 'Optional: pick a third board to compare',
    'cmp.exit': '✕ Exit compare',
    'cmp.exitTitle': 'Leave compare mode and go back to the single-board dashboard',
    'cmp.compareTitle': 'Compare this board with another board — overlay every chart & metric',
    'cmp.pickTitle': 'Compare any two boards side by side — every chart & metric overlaid',
    'cmp.pubBtn': '⇄ Compare boards',
    'cmp.pubExit': '✕ Exit compare',
    'cmp.pubExitTitle': 'Leave the side-by-side comparison and go back to the board list',
    'cmp.pubPickTitle': '⇄ Compare boards',
    'cmp.pubPickHintA': 'click a card to slot it as A',
    'cmp.pubPickHintB': 'now click a second card as B',
    'cmp.pubPickHintGo': 'ready — open the side-by-side view',
    'cmp.pubLoading': 'Loading {a} vs {b}…',
    'cmp.pubLoadFailed': 'Could not load "{b}" for comparison.',
    'cmp.pubSlotA': 'Pick board A',
    'cmp.pubSlotB': 'Pick board B',
    'cmp.pubSelectedAs': 'Selected as {s} — click to remove',
    'cmp.pubClickPickA': 'Click to pick as A',
    'cmp.pubClickPickB': 'Click to pick as B',
    'cmp.pubClickPickC': 'Click to pick as C',
    'cmp.pubSlotC': 'Pick board C (optional)',
    'cmp.pubPickHintC': 'optional — click a third card as C, or just compare',
    'cmp.pubC': 'Board C',
    'cmp.pubGo': 'Compare →',
    'cmp.pubCancel': 'Cancel',
    'cmp.pubSyncing': 'syncing…',
    'cmp.pubSynced': 'synced · {x}',
    'cmp.pubA': 'Board A',
    'cmp.pubB': 'Board B',
    'table.title': 'Longest sitting in current status',
    'table.titleSub': '· open work',
    'th.key': 'Key', 'th.summary': 'Summary', 'th.status': 'Status',
    'th.timeInStatus': 'Time in status', 'th.type': 'Type', 'th.assignee': 'Assignee', 'th.created': 'Created',
    'th.updated': 'Updated',
    'tl.title': 'Last updated tasks', 'tl.titleSub': '· live from the board',
    'tl.sortLast': 'Last updated first', 'tl.sortOldest': 'Oldest updated first',
    'tl.sortTitle': 'Sort tasks', 'tl.filterTitle': 'Filter tasks',
    'tl.any': 'All', 'tl.searchPh': 'Search tasks…',
    'tl.count': '{n} tasks', 'tl.empty': 'No tasks match the current filters.',
    'ilist.empty': 'No issue data available for this selection.',
    'ilist.count': '{n} issue(s)',
    'ilist.openJira': 'open in Jira',
    'ilist.noLink': 'connect to Jira to open issues',
    'ilist.unassigned': 'Unassigned',
    'footer': 'JiraPulse · client-side delivery analytics — your credentials never leave this browser',
    'footerAdmin': 'JiraPulse · admin panel — your credentials never leave this browser',
    'proxyBadge': 'via relay',
    'proxyBadgeTitle': "Requests are being routed through JiraPulse's hosted relay (100k requests/day, free).",
    'pub.publish': '⟳ Publish',
    'settings.title': 'Settings',
    'settings.site': 'Jira site',
    'settings.email': 'Email',
    'settings.token': 'API token',
    'settings.tokenKeep': '(leave blank to keep current)',
    'settings.relayOnly': 'Relay-only mode',
    'settings.relayOnlyDesc': 'Requests always go through the hosted relay (default: built-in relay → fallbacks → direct). Turning this on skips the final direct browser→Jira attempt, which Jira blocks anyway (CORS).',
    'settings.proxyKey': 'corsproxy.io API key',
    'settings.optional': '(optional)',
    'settings.proxyKeyPh': 'paste key for higher limits',
    'settings.customRelay': 'Custom relay URL',
    'settings.customRelaySub': '(optional, used first)',
    'settings.clearData': 'Clear local data',
    'settings.close': 'Close',
    'settings.save': 'Save',
    'debug.title': 'Diagnostics',
    'debug.desc': 'If a board fails, open this panel and copy the log. It includes each Jira request, fallback strategy, and response status.',
    'debug.none': 'No diagnostics captured yet.',
    'debug.clear': 'Clear log',
    'debug.copy': 'Copy log',
    'chart.new': 'New chart',
    'chart.edit': 'Edit chart',
    'chart.titleLabel': 'Chart title',
    'chart.titlePh': 'e.g. Bugs created per week',
    'chart.type': 'Chart type',
    'chart.scope': 'Applies to',
    'chart.metric': 'Metric',
    'chart.groupBy': 'Group by',
    'chart.range': 'Time range',
    'chart.bucket': 'Bucket',
    'chart.filter': 'Filter',
    'chart.split': 'Split',
    'chart.top': 'Max groups',
    'chart.accent': 'Accent',
    'chart.wide': 'Full-width chart',
    'chart.scopeNote': 'This is a built-in chart. Editing it here updates it for <b>all boards</b>.',
    'chart.delete': 'Delete',
    'chart.reset': 'Reset to default',
    'chart.save': 'Save chart',
    'bucket.day': 'Day', 'bucket.week': 'Week', 'bucket.month': 'Month',
    'filter.all': 'All issues', 'filter.open': 'Open only', 'filter.done': 'Done only',
    'split.none': 'None', 'split.stage': 'Stakeholder vs team',
    'accent.indigo': 'Indigo', 'accent.cyan': 'Cyan', 'accent.green': 'Green',
    'accent.amber': 'Amber', 'accent.violet': 'Violet', 'accent.pink': 'Pink',
    'pub.modal.title': 'Publish board stats',
    'pub.modal.desc': 'Create a public snapshot anyone in your organization can view. Share the link — viewers sign in with a <b>@caucasusauto.com</b> email and a one-time code.',
    'pub.scope': 'Scope',
    'pub.scopeAll': 'All boards',
    'pub.scopeBoard': 'This board',
    'pub.board': 'Board',
    'pub.create': 'Create snapshot',
    'pub.list': 'Published snapshots',
    'th.board': 'Board', 'th.scope': 'Scope', 'th.created': 'Created', 'th.token': 'Token', 'th.actions': 'Actions',
    'pub.title': 'Published stats',
    'pub.subtitle': 'Sign in with your @caucasusauto.com email to view this board snapshot.',
    'pub.google': 'Sign in with Google',
    'pub.orEmail': '— or with email —',
    'pub.send': 'Send code',
    'pub.accessCode': 'Access code',
    'pub.codePh': '6-digit code',
    'pub.verify': 'Verify',
    'pub.mailLink': 'Email me the code',
    'pub.share': '🔗 Share link',
    'pub.shareNote': 'Only you (admin) can see this link. Viewers authenticate with a @caucasusauto.com Google or email account.',
    'pub.copy': 'Copy',
    'pub.back': '← Back',
    'pub.backAll': '← All boards',
    'pub.changelog': '✓ changelog',
    /* dynamic (JS-built) strings — {a}/{b}/{x} are interpolated via tReplace() */
    'cmp.loading': 'Loading {a} vs {b}…',
    'cmp.failed': 'Could not start compare mode.',
    'cmp.bSyncing': 'syncing board B…',
    'cmp.bSynced': 'board B synced · {x}',
    'cmp.bFailed': '⚠ board B failed to sync — pick another',
    'cmp.cSyncing': 'syncing board C…',
    'cmp.cSynced': 'board C synced · {x}',
    'cmp.cFailed': '⚠ board C failed to sync — pick another',
    'cmp.dupSlot': 'That board is already compared in the other slot',
    'cmp.count': 'A: {a} issues · B: {b} issues',
    'cmp.prompt': 'Compare mode — pick a second board in the bar above to overlay every chart and metric.',
    'cmp.even': '— even', 'cmp.identical': 'identical on both boards', 'cmp.noData': 'no data to compare',
    'cmp.vsQ': '{a} vs ? — pick board B above',
    'insight.throughput': 'Throughput', 'insight.speed': 'Speed', 'insight.load': 'Open load',
    'insight.completion': 'Completion', 'insight.blocked': 'Blocked work', 'insight.intake': 'Intake gap',
    'kpi.syncing': 'syncing…',
    'dash.noWip': 'Nothing in progress — everything is done 🎉',
    'dash.trend': 'vs prior 30d',
    'dash.allBoardsScope': 'all boards', 'dash.thisBoardScope': 'this board',
    'pub.bLoading': 'Loading…', 'pub.bFailed': 'Failed to load board B — try again.',
    'pub.cmpPrompt': 'Compare mode — pick a second board in the bar above to overlay every chart and metric.',
    'pub.cmpCount': 'A: {a} issues · B: {b} issues',
    'pub.orgBoards': '[P] Org boards', 'pub.otherBoards': 'All other boards',
    'pub.openDash': 'Open dashboard →',
    'pub.cmpFrom': 'compare · {a} vs {b}',
    'board.pickA': 'click a card to slot it as A', 'board.pickB': 'now click a second card as B', 'board.pickReady': 'ready — open the side-by-side view',
    'health.healthy': 'healthy', 'health.watch': 'watch', 'health.atRisk': 'at risk',
    'toast.noConn': 'Connect to Jira first.',
    'toast.boardsLoading': 'Board list is still loading — try again in a moment.',
    'toast.openBoard': 'Open a board first.',
    'toast.hiddenChart': 'Chart hidden — restore it from the link below the grid.',
    'confirm.deleteChart': 'Delete chart "{title}"?',
    'toast.chartReset': 'Chart reset to default.',
    'toast.chartDeleted': 'Chart deleted.',
    'toast.copied': 'Copied to clipboard.',
    'toast.refreshing': 'Refreshing board data…',
    'toast.diagCleared': 'Diagnostics cleared.',
    'toast.copyFail': 'Could not copy.',
    'chart.empty': 'No charts yet — press ＋ New chart to build your first one.',
    'chart.hiddenLink': '{n} hidden chart(s) — click to restore',
    'data.noChangelog': '⚠ No changelog', 'data.noOpen': '⚠ No open issues', 'data.noData': '⚠ No data', 'data.ok': '✓ Changelog',
    'scope.all': 'All boards', 'scope.board': 'This board',
    'chartmodal.kind.line': 'Line', 'chartmodal.kind.bar': 'Bars', 'chartmodal.kind.hbar': 'Horizontal', 'chartmodal.kind.doughnut': 'Donut',
    'pub.emailPh': 'you@caucasusauto.com',
    /* chart engine constants */
    'metric.flow': 'Created vs resolved over time', 'metric.created': 'Issues created over time',
    'metric.resolved': 'Issues resolved over time', 'metric.netflow': 'Cumulative net flow (backlog size)',
    'metric.count': 'Issue count by group', 'metric.blockedCount': 'Blocked / canceled by status',
    'metric.avgCycle': 'Avg cycle time by group', 'metric.openAge': 'Current age of open issues',
    'metric.avgStatusTime': 'Avg time in status by group',
    'group.time': 'Time', 'group.status': 'Status', 'group.assignee': 'Assignee', 'group.type': 'Issue type',
    'group.priority': 'Priority', 'group.label': 'First label', 'group.bottleneck': 'Bottleneck stage',
    'group.stage': 'Stakeholder vs team', 'group.ageBucket': 'Age bucket', 'group.assigneeState': 'Assigned vs unassigned',
    'group.complexity': 'Complexity', 'group.noComplexity': 'No complexity',
    'range.7': 'Last 7 days', 'range.14': 'Last 2 weeks', 'range.30': 'Last 30 days', 'range.90': 'Last 90 days',
    'range.182': 'Last 6 months', 'range.365': 'Last 12 months', 'range.0': 'All time',
    'range.custom': 'Custom range', 'range.pickCustom': 'Calendar…', 'range.from': 'From', 'range.to': 'To',
    'range.apply': 'Apply', 'range.title': 'Time range', 'range.invalid': 'Pick a valid from–to window',
    'range.now': 'now',
    'age.le2d': '≤ 2d', 'age.3_7d': '3–7d', 'age.1_2w': '1–2w', 'age.2_4w': '2–4w',
    'age.1_3mo': '1–3mo', 'age.3_6mo': '3–6mo', 'age.6moPlus': '6mo+',
    'chart.title.pipeline': 'Incoming vs Completed', 'chart.sub.pipeline': 'Created vs resolved over time',
    'chart.title.throughput': 'Monthly Throughput', 'chart.sub.throughput': 'Completed issues per month (Done/Approved/Babysitting/Released)',
    'chart.title.createdTrend': 'Issues Created', 'chart.sub.createdTrend': 'Weekly creation trend',
    'chart.title.resolvedTrend': 'Issues Resolved', 'chart.sub.resolvedTrend': 'Monthly completion trend',
    'chart.title.backlogGrowth': 'Backlog Trend', 'chart.sub.backlogGrowth': 'Cumulative open work (created − resolved)',
    'chart.title.blockedDist': 'Blocked & Canceled', 'chart.sub.blockedDist': 'Work sitting on blocked/canceled/rejected statuses · all time',
    'chart.title.bottlenecks': 'Active Bottlenecks', 'chart.sub.bottlenecks': 'Where open work is parked',
    'chart.title.statusDist': 'Status Distribution', 'chart.sub.statusDist': 'All issues by current status',
    'chart.title.statusTime': 'Avg Time in Status', 'chart.sub.statusTime': 'Lifetime average per status · changelog',
    'chart.title.phaseDelays': 'Stakeholder vs Team Delays', 'chart.sub.phaseDelays': 'Avg days per stage · stakeholder gates vs team work · changelog',
    'chart.title.typeDist': 'Issue Type Breakdown', 'chart.sub.typeDist': 'Open issues by type',
    'chart.title.assigneeLoad': 'Assignee Workload', 'chart.sub.assigneeLoad': 'Open issues per assignee',
    'chart.title.priorityDist': 'Priority Distribution', 'chart.sub.priorityDist': 'Open issues by priority',
    'chart.title.doneByAssignee': 'Done by Assignee', 'chart.sub.doneByAssignee': 'Completed tasks per assignee',
    'chart.title.ageBuckets': 'Age vs Demand', 'chart.sub.ageBuckets': 'How long each open issue has been waiting, grouped by wait time',
    'chart.title.unassigned': 'Assignment Gaps', 'chart.sub.unassigned': 'Who owns the open work — spot the load imbalance',
    'chart.title.assigneeCycle': 'Cycle Time Leaderboard', 'chart.sub.assigneeCycle': 'Avg create → resolve per assignee · resolved issues only',
    'chart.title.complexityDist': 'Complexity Distribution', 'chart.sub.complexityDist': 'Open issues by Change Request Complexity (S/M/L/XL)',
    'chart.title.complexityDone': 'Complexity Completed', 'chart.sub.complexityDone': 'Completed issues by Change Request Complexity (S/M/L/XL)',
    /* auth · connect · publish · misc dynamic strings */
    'auth.sending': 'Sending…',
    'auth.codeSent': 'Code sent to {email} — check your inbox (and spam).',
    'auth.codeFailed': 'Could not send the code. Check the address and try again.',
    'auth.verifying': 'Verifying…',
    'auth.wrongCode': 'Wrong or expired code — try again.',
    'auth.welcome': 'Welcome! You are signed in for this session.',
    'auth.signedInAs': 'Signed in as {name}',
    'auth.googleOnly': 'Only @caucasusauto.com Google accounts can view published boards.',
    'auth.enterEmail': 'Enter your @caucasusauto.com email first.',
    'auth.invalidEmail': 'That does not look like a @caucasusauto.com address.',
    'connect.connecting': 'Connecting…',
    'connect.ok': 'Connected to {domain} 🎉',
    'connect.failed': 'Could not reach {domain}. Check the site, email and token, then try again.',
    'connect.synced': 'Synced {n} boards',
    'connect.noBoards': 'No boards returned for this account.',
    'pub.copied': 'Share link copied to clipboard.',
    'pub.boardCopied': 'Board link copied.',
    'pub.viewerCopied': 'Viewer link copied — works on every device.',
    'pub.unpublished': 'Unpublished.',
    'pub.unpublishFailed': 'Unpublish failed: {m}',
    'pub.selectBoard': 'Select a board first.',
    'pub.noBoards': 'No boards to publish.',
    'pub.publishedLive': 'Published — viewer link copied. Data is always live; republish only when charts/boards change.',
    'pub.publishedNext': 'Published. Viewers will see it on next sign-in.',
    'pub.publishFailed': 'Publish failed: {m}',
    'auth.sessionRejected': 'Session rejected by Jira ({s}). Please reconnect with a fresh API token.',
    'cmp.startFailed': 'Could not start compare mode.',
    'chart.noneYet': 'No charts on this board yet — click ＋ New chart to build one.',
    'chart.hiddenStrip': 'Hidden charts:',
    'chart.restored': 'Chart restored.',
    'chart.titleRequired': 'Please enter a chart title.',
    'chart.addedAll': 'Chart added to all boards.',
    'chart.addedBoard': 'Chart added to this board.',
    'chart.updated': 'Chart updated.',
    'chart.updatedAll': 'Chart updated for all boards.',
    'debug.copied': 'Diagnostics copied.',
    'debug.copyFailed': 'Could not copy diagnostics.',
    'pub.published': 'Published — share this link:',
    'pub.created': 'Snapshot created — share the link below.',
    'pub.createFailed': 'Could not create the snapshot.',
    'pub.loadingList': 'Loading published snapshots…',
    'pub.emptyList': 'No snapshots yet — create one above.',
    'pub.removed': 'Snapshot removed.',
    'pub.deleteFailed': 'Could not delete the snapshot.',
    'pub.notPublished': 'This board is not published yet — create a snapshot first.',
    'pub.badgeYes': 'Published', 'pub.badgeNo': 'Not published',
    'pub.actCopy': 'Copy', 'pub.actOpen': 'Open', 'pub.actDelete': 'Delete',
    'pub.creating': 'Creating snapshot…',
    'pub.manageHint': 'You are signed in as an admin — you can manage published boards here.',
    'pub.issuesCount': '{n} issues',
    'pub.loadingData': 'Loading live data from Jira…',
    'pub.dataFailed': 'Could not load live data — showing cached stats.',
    'pub.noCharts': 'No charts published for this board yet.',
    'pub.allTitle': 'All boards',
    'pub.boardTitle': '{b} · published stats',
    'pub.subtitleAll': 'Live delivery analytics for your organization.',
    'pub.subtitleBoard': 'Live stats for this board, refreshed from Jira.',
    'pub.orgTitle': 'Organization board stats',
    'pub.orgSubtitle': 'Every published board · streaming live from Jira',
    'pub.liveSubtitle': 'Live metrics · streaming from Jira in real time',
    'pub.liveBadge': 'live',
    'pub.noBoardsPublished': 'No boards published yet — the admin can publish the board list from the admin panel.',
    'pub.nBoards': '{n} boards',
    'pub.zeroBoards': '0 boards',
    'pub.copyBoardLink': 'Copy link to this board',
    'pub.signedInAdmin': 'Signed in as {e} · Admin',
    'pub.cfgTitle': 'Publish boards (configuration only)',
    'pub.cfgOnlyTitle': 'Publish configuration',
    'pub.currentlyPublished': 'Currently published: <b>{n} board(s)</b>{saved}',
    'pub.savedAt': ' · saved {s}',
    'pub.viewerLiveNote': 'Viewers always see <b>live Jira data</b> — republish only needed when charts or the board list change.',
    'pub.nothingPublished': 'Nothing published yet. Publish the board list so org members see it after sign-in.',
    'pub.copyViewerLink': 'copy viewer link',
    'pub.unpublishBtn': 'unpublish',
    'pub.publishToOrg': 'Publish to organization',
    'pub.publishing': 'Publishing…',
    'pub.restricted': 'Access is restricted to @{d} accounts.',
    'pub.googleLoading': 'Google sign-in is still loading… try again in a few seconds.',
    'pub.googleFailed': 'Google sign-in could not start. Use your @{d} email instead.',
    'pub.signOut': '⎋ Sign out',
    'pub.signOutTitle': 'Sign out and return to the login screen',
    'pub.signedOut': 'Signed out — see you soon!',
    'pub.sendCode': 'Send code',
    'pub.resendCode': 'Resend code',
    'pub.sending': 'Sending your code to {email}…',
    'pub.sentTo': 'Code sent to {email}. Check your inbox, then enter it below.',
    'pub.sendFailed': 'Could not email the code ({m}). Use Sign in with Google instead.',
    'pub.wrongCode': 'Wrong code. Please try again.',
    'pub.invalidEmail': 'Please enter a valid @{d} email.',
    'pub.signinAll': 'Sign in with your @{d} email to view the published board stats.',
    'pub.signinBoard': 'Sign in with your @{d} email to view this board snapshot.',
    'pub.headBoard': 'Board',
    'pub.activateFirst': 'First time for this email — FormSubmit has emailed an activation link to {email}. Click it, then press "Resend code".',
    'pub.deliverFailed': 'Could not deliver the code right now ({m}). Use Sign in with Google instead.',
    'confirm.unpublish': 'Unpublish? Viewers will no longer see the boards after sign-in.',
    'settings.saved': 'Settings saved.',
    'settings.savedRelay': 'Relay settings saved. Now connect to Jira.',
    'settings.cleared': 'Local data cleared — reloading…',
    'chart.deleted': 'Chart deleted.',
    'chart.saved': 'Chart saved.',
    'err.generic': 'Something went wrong — open Diagnostics for details.',
    'err.loadBoard': 'Could not load the board',
    'err.status401': 'Check your email / API token in Settings.',
    'err.status403': 'Your account does not have access to this board.',
    'err.status404': 'Board not found — it may have been deleted.',
    'err.status429': 'Rate limited by Jira — wait a moment and retry.',
    'err.status5xx': 'Jira server error — try again shortly.',
    'err.network': 'Could not reach Jira — check your connection or relay settings.',
    'sync.updated': 'updated {t}',
    'sync.failed': 'failed to load',
    'err.loadIssues': 'Failed to load board issues.',
    'err.connectFailed': 'Connection failed.',
    'dash.syncing': 'syncing…',
    'dash.syncingDash': 'Syncing your dashboard…',
    'dash.loadingBoard': 'Loading {b}',
    'dash.thisBoard': 'this board',
    'dash.issuesOnBoard': 'issues on this board',
    'dash.vsPrior30d': 'vs prior 30d',
    'dash.completionRate': '{p}% completion rate',
    'dash.createResolve': 'create → resolve',
    'dash.fasterThan': 'faster than prior 30d',
    'dash.slowerThan': 'slower than prior 30d',
    'dash.issuesAnalyzed': '{n} issues analyzed',
    'dash.changelogNotice': '⚠ Status-time analytics unavailable — this board may be team-managed or your token lacks changelog permissions. Showing core metrics only.',
    'insight.throughputText': '{r} resolved in the last 30 days ({d}/day avg).',
    'insight.speedText': 'Average cycle time is {c} across {n} resolved issues.',
    'insight.loadText': '{w} issues in progress right now · {o} open overall.',
    'insight.completionText': '{p}% of all issues on this board are done.',
    'insight.blockedText': '{b} issues are blocked or canceled right now.',
    'insight.intakeText': 'Intake vs delivery: {c} created vs {r} resolved in 30 days.',
    'cmp.kpiTotal': 'Issues analyzed',
    'cmp.kpiTotalSub': 'on the board',
    'cmp.kpiCreated': 'Created · 30 days',
    'cmp.kpiCreatedSub': 'new issues',
    'cmp.kpiDone': 'Done overall',
    'cmp.kpiDoneSub': 'completed',
    'cmp.kpiResolved': 'Resolved · 30 days',
    'cmp.kpiResolvedSub': 'shipped recently',
    'cmp.kpiCycle': 'Avg cycle time',
    'cmp.kpiCycleSub': 'create → resolve',
    'cmp.kpiWip': 'Work in progress',
    'cmp.kpiWipSub': 'not yet done',
    'cmp.badgeBoth': '{na}: {a} issues · {nb}: {b} issues',
    'cmp.hintBar': 'Compare mode — pick a second board in the bar above to overlay every chart and metric.',
    'cmp.aFaster': '{n} is faster',
    'cmp.bFaster': '{n} is faster',
    'cmp.aHigher': '{n} higher',
    'cmp.bHigher': '{n} higher',
    'cmp.aAbove': '{a} is {p}% above {b}',
    'cmp.aBelow': '{a} is {p}% below {b}',
    'cmp.even': 'even',
    'cmp.identical': 'identical on both boards',
    'cmp.noData': 'no data to compare',
    'cmp.pickBHint': 'pick board B above',
    'cmp.outerRing': 'outer ring',
    'cmp.outerRingC': 'outer ring',
    'cmp.shownGreen': 'shown in green',
    'cmp.lblThroughput': 'Throughput',
    'cmp.lblSpeed': 'Speed',
    'cmp.lblOpenLoad': 'Open load',
    'cmp.lblCompletion': 'Completion',
    'cmp.lblBlocked': 'Blocked work',
    'cmp.lblIntake': 'Intake gap',
    'cmp.lblMomentum': 'Momentum',
    'cmp.lblFlow': 'Flow balance',
    'cmp.lblSpeedQuality': 'Speed & quality',
    'cmp.lblRisk': 'Risk radar',
    'cmp.insVerdictTitle': '{n} leads overall',
    'cmp.insVerdictTieTitle': 'Dead-even duel',
    'cmp.insVerdict': '{a} wins {w} of {m} cross-checks against {b} — stronger where it matters.',
    'cmp.insVerdictTie': 'Both boards split {m} cross-checks evenly — no clear leader.',
    'cmp.wins.throughput': 'throughput',
    'cmp.wins.speed': 'speed',
    'cmp.wins.completion': 'completion',
    'cmp.wins.load': 'lean WIP',
    'cmp.wins.blocked': 'fewer blocked',
    'cmp.insMomentum': '{n} is accelerating faster — recent 30-day output grew more vs the prior 30 days.',
    'cmp.insMomentumMixed': 'Momentum diverges — one board is speeding up while the other cools off.',
    'cmp.insFlow': '{n} keeps flow balanced — intake exceeds delivery by only {a}, vs {b} on the other board.',
    'cmp.insSpeed': '{n} closes work faster on average ({a} vs {b}) — pair that with completion below.',
    'cmp.insRisk': '{n} carries less stalled work ({a} blocked vs {b}) — healthier delivery pipeline.',
    'cmp.insRiskEven': 'Blocked work is level on both boards — risk sits elsewhere.',
    'cmp.insStatsIssues': ' issues',
    'cmp.insStatsShipped': ' shipped 30d',
    'cmp.insStatsCycle': ' avg cycle',
    'cmp.insStatsDone': ' done',
    'cmp.insStatsBlocked': ' blocked',
    'cmp.insStatsWip': ' WIP',
    'cmp.insStatsInOut': ' in ▸ out 30d',
    'cmp.insStatsNowPrev': ' now vs prior 30d',
    'cmp.chartWinsA': '{n} leads by {p}%',
    'cmp.chartWinsB': '{n} leads by {p}%',
    'cmp.scoreTitle': 'Score',
    'cmp.scoreSub': 'head-to-head wins across all metrics',
    'cmp.scoreLeads': 'leads {n} of {m} metrics',
    'cmp.scoreTie': 'dead even — {n} : {n} metrics',
    'bc.measuring': 'measuring…',
    'bc.newTitle': 'New issues · last 30 days',
    'bc.new30': 'new 30D',
    'bc.wipTitle': 'Work in progress',
    'bc.active': 'active',
    'bc.netTitle': 'Net flow · last 30 days (resolved − created)',
    'bc.net30d': 'net 30D',
    'bc.done': 'done',
    'bc.unavailable': 'stats unavailable',
    'card.openDash': 'Open dashboard →',
    'card.copyLinkTitle': 'Copy link to this board',
    'card.orgBoards': '[P] Org boards',
    'card.otherBoards': 'All other boards',
    'master.pName': 'All [P] boards',
    'master.cardChip': 'master view',
    'master.cardDesc': 'All [P] boards united',
    'master.syncing': 'Loading all [P] boards…',
    'master.savedAs': 'Board-scoped charts are not available on the master [P] view',
    'pick.selectedAs': 'Selected as {s} — click to remove',
    'pick.clickPickA': 'Click to pick as A',
    'pick.clickPickB': 'Click to pick as B',
    'pick.clickPickC': 'Click to pick as C',
    'hl.blocked': '{b} blocked',
    'hl.allClear': 'All clear — nothing in progress',
    'hl.backlogGrowing': 'Backlog growing',
    'hl.strongOutflow': 'Strong outflow',
    'hl.steadyFlow': 'Steady flow',
    'badge.noChangelogTitle': 'Changelog not available for this board',
    'badge.noChangelog': 'No changelog',
    'badge.noOpenTitle': 'No open issues on this board',
    'badge.noOpen': 'No open issues',
    'badge.noDataTitle': 'No data matches the current filters',
    'badge.noData': 'No data',
    'badge.changelogOkTitle': 'Changelog data available',
    'badge.changelog': 'Changelog',
    'ins.bottleneck': '<b>{n}</b> open issue{ns} currently sitting in <b>{cat}</b>',
    'ins.slowest': 'Slowest stage right now: <b>{s}</b> · {d} average',
    'ins.throughput': 'Throughput <b>{p}%</b> vs the previous 30 days',
    'ins.aged': '<b>{n}</b> open issue{ns} stuck longer than 14 days',
    'ins.netFlow': 'Net flow <b>{n}</b> issues in 30 days — backlog {w}',
    'ins.shrinking': 'shrinking',
    'ins.growing': 'growing',
    'cmp.noDataEither1': 'No data on either board',
    'cmp.noDataEither2': 'for this chart',
    'cmp.boardsNoData': 'no data on {n}',
    'cmp.noDataA': 'No data on board A for this chart',
    'cmp.noComparable': 'No comparable data',
    'cmp.shownCyan': 'shown in cyan',
    'cmp.only': 'only',
    'cmp.oneBoardNoData': 'one board has no data here',
    'cmp.avg': 'avg',
    'cmp.issues': 'issues',
    'cmp.tie': 'a tie',
    'pub.liveUnavailable': 'live data unavailable',
    'pub.noBoardSelected': 'No board selected.',
    'pub.loadingLive': 'loading live data from Jira…',
    'pub.loadFailed': 'Could not load live data ({m}).',
    'pub.nIssues': '{n} issues',
    'pub.noCharts': 'No charts configured for this board.',
    'chart.newTitle': 'New chart',
    'chart.configureTitle': 'Configure “{title}”',
    'chart.segLine': 'Line',
    'chart.segBar': 'Bars',
    'chart.segHbar': 'Horizontal',
    'chart.segDoughnut': 'Donut',
    'chart.segBoard': 'This board only',
    'chart.segGlobal': 'All boards',
    'chart.scopeBoard': 'this board',
    'chart.scopeGlobal': 'all boards',
    'chart.btnEdit': 'Configure this chart',
    'chart.btnReset': 'Reset to default',
    'chart.btnHide': 'Hide this chart',
    'chart.btnDelete': 'Delete this chart',
    'series.registered': 'Registered',
    'series.completed': 'Completed',
    'series.openBacklog': 'Open backlog',
    'series.netflowDesc': 'cumulative open backlog (created − resolved)',
    'series.pBacklog': 'Backlog (Bug / Backlog / System Improvements)',
    'series.pNetflowDesc': 'cumulative backlog — Bug, Backlog & System Improvements statuses (created − resolved)',
    'series.createdVsResolved': 'registered vs completed',
    'series.created': 'created',
    'series.resolved': 'resolved',
    'series.perBucket': 'per {b}',
    'series.openNow': 'open now',
    'series.avg': 'avg',
    'series.count': 'count',
    'series.byGroup': 'by {g}',
    'statusTime.noChangelog1': 'Changelog unavailable on this board',
    'statusTime.noChangelog2': '— status-time charts need it',
    'statusTime.noTransitions': 'No status transition data found',
    'statusTime.noStages': 'No stakeholder / team stage transitions detected',
    'statusTime.subStage': 'avg days · stakeholder vs team · changelog',
    'statusTime.subStatus': 'avg days per status · lifetime · changelog',
    'statusTime.subSplit': 'avg days parked per stage · changelog',
    'statusTime.stakeholderAvg': 'Stakeholder gates avg',
    'statusTime.teamAvg': 'Team phases avg',
    'stage.stakeholder': 'Stakeholder gates',
    'stage.team': 'Team phases',
    'stage.it': 'IT Committee',
    'statusTime.itAvg': 'IT Committee avg',
    'group.unassigned': 'Unassigned',
    'group.assigned': 'Assigned',
    'group.other': 'Other',
    'err.unknownMetric': 'Unknown metric',
    'cat.noResolved': 'No resolved issues to measure yet',
    'cat.noIssues': 'No issues match this chart yet',
    'filter.openOnly': 'open only',
    'filter.doneOnly': 'done only',
    'bn.pendingReview': 'Pending Review',
    'bn.techAnalysis': 'Technical Analysis',
    'bn.inDevelopment': 'In Development',
    'bn.testing': 'Testing',
    'bn.uat': 'UAT',
    'bn.readyForRelease': 'Ready for Release',
    'lang.en': 'English',
    'lang.ka': 'ქართული',
    'lang.title': 'Switch language',
    'theme.title': 'Switch color theme',
    'theme.dark': 'Dark theme',
    'theme.light': 'Light theme',
  },
  ka: {
    'nav.allBoards': 'ყველა დაფა',
    'nav.syncBoards': 'დაფების სინქრონიზაცია',
    'nav.diagnostics': 'დიაგნოსტიკა',
    'nav.boards': 'დაფები',
    'nav.refresh': 'განახლება',
    'nav.publicView': 'საჯარო ხედი',
    'nav.compareBoards': '⇄ დაფების შედარება',
    'nav.compare': '⇄ შედარება',
    'nav.admin': 'ადმინი',
    'nav.org': 'ორგ.',
    'nav.ribbon': '⚙ მართვა',
    'nav.manage': '⚙ გამოქვეყნება / დაფების მართვა',
    'nav.settings': 'პარამეტრები',
    'nav.disconnect': 'გათიშვა',
    'nav.toBoards': 'ყველა დაფაზე გადასვლა',
    'setup.title': 'შენი Jira,<br /><span class="grad-text">ლამაზად ვიზუალიზებული.</span>',
    'setup.lead': 'დაუკავშირდით Jira-ს API ტოკენით და მიიღეთ მყისიერი ანალიტიკა — რამდენ ხანს დგას დავალება თითოეულ სტატუსში, რა გაეგზავნა ბოლო 30&nbsp;დღეში, გუნდის პროდუქტიულობა და სხვა. თქვენი მონაცემები ბრაუზერს არ ტოვებს.',
    'setup.site': 'Jira-ს საიტი',
    'setup.email': 'ელფოსტა',
    'setup.token': 'API ტოკენი',
    'setup.tokenPh': 'მიამაგრეთ თქვენი Jira API ტოკენი',
    'setup.connect': 'Jira-სთან დაკავშირება',
    'setup.relay': '⚙ Relay-ის პარამეტრები',
    'setup.relayTitle': 'CORS relay-ის კონფიგურაცია — აგვარებს „ვერ დაუკავშირდა" შეცდომებს',
    'setup.helpSummary': 'როგორ მივიღო API ტოკენი?',
    'setup.help1': 'გახსენით <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener">id.atlassian.com → API ტოკენები</a>',
    'setup.help2': 'დააჭირეთ <b>Create API token</b>-ს, დაარქვით სახელი და დააკოპირეთ მნიშვნელობა',
    'setup.help3': 'ჩასვით საიტის მისამართი, ანგარიშის ელფოსტა და ტოკენი ზემოთ',
    'setup.privacy': 'ეს აპლიკაცია მთლიანად ბრაუზერში მუშაობს. თქვენი მონაცემები ინახება მხოლოდ ამ ბრაუზერის ლოკალურ საცავში და პირდაპირ (ან სურვილისამებრ CORS პროქსით) იგზავნება თქვენს Jira საიტზე.',
    'setup.privacyAdmin': 'ეს ადმინისტრატორის პანელი მთლიანად ბრაუზერში მუშაობს. თქვენი მონაცემები ინახება მხოლოდ ამ ბრაუზერის ლოკალურ საცავში და პირდაპირ (ან სურვილისამებრ CORS პროქსით) იგზავნება თქვენს Jira საიტზე.',
    'setup.adminTitle': 'ადმინისტრატორის პანელი<br /><span class="grad-text">მართეთ თქვენი მიწოდების სტატისტიკა.</span>',
    'setup.adminLead': 'ეს არის <b>JiraPulse-ის ადმინისტრატორის პანელი</b>. დაუკავშირდით თქვენს Jira ანგარიშს დაფების სტატისტიკის გასამოქვეყნებლად, გასაზიარებელი ბმულების შესაქმნელად და იმის საკონტროლოდ, თუ რას ხედავს თქვენი ორგანიზაცია. თქვენი მონაცემები ბრაუზერს არ ტოვებს.',
    'boards.choose': 'აირჩიეთ დაფა',
    'boards.sub': 'უშუალოდ თქვენი Jira-დან არის სინქრონიზებული. დააჭირეთ ნებისმიერ ბარათს ანალიტიკური დაშბორდის გასახსნელად.',
    'boards.subAdmin': 'უშუალოდ თქვენი Jira-დან არის სინქრონიზებული. დააჭირეთ ნებისმიერ ბარათს ადმინისტრატორის დაშბორდის გასახსნელად.',
    'boards.publishAll': '⟳ ყველას გამოქვეყნება',
    'boards.publishAllTitle': 'ყველა დაფის გამოქვეყნება თქვენი ორგანიზაციისთვის',
    'boards.loading': 'დაფების მიღება Jira-დან…',
    'boards.empty': 'ამ ანგარიშისთვის დაფები ვერ მოიძებნა.<br />დარწმუნდით, რომ თქვენს Jira მომხმარებელს წვდომა აქვს კომპანიის ან გუნდის დაფებზე.',
    'pick.title': '⇄ დაფების შედარება',
    'pick.slotA': 'აირჩიეთ დაფა A',
    'pick.slotB': 'აირჩიეთ დაფა B',
    'pick.slotC': 'აირჩიეთ დაფა C (არასავალდებულო)',
    'pick.go': 'შედარება →',
    'pick.cancel': 'გაუქმება',
    'pick.hintA': 'დააჭირეთ ბარათს დაფა A-სთვის',
    'pick.hintB': 'ახლა დააჭირეთ მეორე ბარათს დაფა B-სთვის',
    'pick.hintC': 'არასავალდებულო — დააჭირეთ მესამე ბარათს დაფა C-სთვის, ან უბრალოდ შეადარეთ',
    'pick.hintGo': 'მზადაა — გახსენით გვერდით-გვერდ ხედი',
    'kpi.total': 'გაანალიზებული დავალებები',
    'kpi.totalSub': 'ამ დაფაზე',
    'kpi.created': 'შექმნილი · 30 დღე',
    'kpi.createdSub': 'ახალი დავალებები',
    'kpi.done': 'ჯამურად დასრულებული',
    'kpi.doneSub': 'დასრულების მაჩვენებელი',
    'kpi.resolved': 'დახურული · 30 დღე',
    'kpi.resolvedSub': 'ცოტა ხნის წინ გაიგზავნა',
    'kpi.cycle': 'საშ. ციკლის დრო',
    'kpi.cycleSub': 'შექმნა → დასრულება',
    'kpi.wip': 'მიმდინარე სამუშაო',
    'kpi.wipSub': 'ჯერ არ არის მზად',
    'cmp.roleA': 'დაფა A · მიმდინარე',
    'cmp.roleB': 'დაფა B · შედარებული',
    'cmp.roleC': 'დაფა C · შედარებული',
    'cmp.loadingBoards': 'დაფების ჩატვირთვა…',
    'cmp.pickB': 'აირჩიეთ დაფა შედარებისთვის',
    'cmp.pickC': 'არასავალდებულო: აირჩიეთ მესამე დაფა შედარებისთვის',
    'cmp.exit': '✕ შედარებიდან გასვლა',
    'cmp.exitTitle': 'დატოვეთ შედარების რეჟიმი და დაბრუნდით ერთი დაფის დაშბორდზე',
    'cmp.compareTitle': 'შეადარეთ ეს დაფა სხვა დაფას — ყველა გრაფიკი და მეტრიკა გადაფარვით',
    'cmp.pickTitle': 'შეადარეთ ორი დაფა გვერდით-გვერდ — ყველა გრაფიკი და მეტრიკა გადაფარვით',
    'cmp.pubBtn': '⇄ დაფების შედარება',
    'cmp.pubExit': '✕ შედარებიდან გასვლა',
    'cmp.pubExitTitle': 'დატოვეთ გვერდით-გვერდ შედარება და დაბრუნდით დაფების სიაში',
    'cmp.pubPickTitle': '⇄ დაფების შედარება',
    'cmp.pubPickHintA': 'დააჭირეთ ბარათს დაფა A-სთვის',
    'cmp.pubPickHintB': 'ახლა დააჭირეთ მეორე ბარათს დაფა B-სთვის',
    'cmp.pubPickHintGo': 'მზადაა — გახსენით გვერდით-გვერდ ხედი',
    'cmp.pubLoading': 'იტვირთება {a} vs {b}…',
    'cmp.pubLoadFailed': 'დაფა „{b}"-ის ჩატვირთვა შედარებისთვის ვერ მოხერხდა.',
    'cmp.pubSlotA': 'აირჩიეთ დაფა A',
    'cmp.pubSlotB': 'აირჩიეთ დაფა B',
    'cmp.pubSelectedAs': 'არჩეულია როგორც {s} — დააჭირეთ მოსაშორებლად',
    'cmp.pubClickPickA': 'აირჩიეთ A-დ',
    'cmp.pubClickPickB': 'აირჩიეთ B-დ',
    'cmp.pubClickPickC': 'აირჩიეთ C-დ',
    'cmp.pubSlotC': 'აირჩიეთ დაფა C (არასავალდებულო)',
    'cmp.pubPickHintC': 'არასავალდებულო — დააჭირეთ მესამე ბარათს დაფა C-სთვის, ან უბრალოდ შეადარეთ',
    'cmp.pubC': 'დაფა C',
    'cmp.pubGo': 'შედარება →',
    'cmp.pubCancel': 'გაუქმება',
    'cmp.pubSyncing': 'განახლება…',
    'cmp.pubSynced': 'განახლდა · {x}',
    'cmp.pubA': 'დაფა A',
    'cmp.pubB': 'დაფა B',
    'table.title': 'ყველაზე დიდხანს დგას მიმდინარე სტატუსში',
    'table.titleSub': '· ღია სამუშაო',
    'th.key': 'გასაღები', 'th.summary': 'დავალების სახელი', 'th.status': 'სტატუსი',
    'th.timeInStatus': 'დრო სტატუსში', 'th.type': 'ტიპი', 'th.assignee': 'შემსრულებელი', 'th.created': 'შექმნის თარიღი',
    'th.updated': 'განახლების თარიღი',
    'tl.title': 'ბოლოს განახლებული დავალებები', 'tl.titleSub': '· პირდაპირ დაფიდან',
    'tl.sortLast': 'ბოლო განახლებული წინ', 'tl.sortOldest': 'უძველესი განახლებული წინ',
    'tl.sortTitle': 'დავალებების დალაგება', 'tl.filterTitle': 'დავალებების ფილტრი',
    'tl.any': 'ყველა', 'tl.searchPh': 'დავალებების ძებნა…',
    'tl.count': '{n} დავალება', 'tl.empty': 'ფილტრებს ვერცერთი დავალება არ ერგება.',
    'ilist.empty': 'ამ შერჩევისთვის დავალების მონაცემები არ არის.',
    'ilist.count': '{n} დავალება',
    'ilist.openJira': 'Jira-ში გახსნა',
    'ilist.noLink': 'დაუკავშირდით Jira-ს დავალებების გასახსნელად',
    'ilist.unassigned': 'დაუნიშნავი',
    'footer': 'JiraPulse · ანალიტიკა პირდაპირ თქვენს ბრაუზერში — თქვენი მონაცემები არსად მიდის',
    'footerAdmin': 'JiraPulse · ადმინისტრატორის პანელი — თქვენი მონაცემები არსად მიდის',
    'proxyBadge': 'relay-ით',
    'proxyBadgeTitle': 'მოთხოვნები გადის JiraPulse-ის ჰოსტირებულ relay-ზე (100k მოთხოვნა/დღე, უფასო).',
    'pub.publish': '⟳ გამოქვეყნება',
    'settings.title': 'პარამეტრები',
    'settings.site': 'Jira-ს საიტი',
    'settings.email': 'ელფოსტა',
    'settings.token': 'API ტოკენი',
    'settings.tokenKeep': '(ცარიელი დატოვეთ მიმდინარეს შესანარჩუნებლად)',
    'settings.relayOnly': 'მხოლოდ relay-ის რეჟიმი',
    'settings.relayOnlyDesc': 'მოთხოვნები ყოველთვის ჰოსტირებულ relay-ზე გადის (ნაგულისხმევი: ჩაშენებული relay → სათადარიგოები → პირდაპირ). ჩართვისას გამოიტოვება ბოლო პირდაპირი მცდელობა ბრაუზერიდან Jira-მდე, რომელსაც Jira მაინც ბლოკავს (CORS).',
    'settings.proxyKey': 'corsproxy.io API გასაღები',
    'settings.optional': '(სურვილისამებრ)',
    'settings.proxyKeyPh': 'ჩასვით გასაღები მაღალი ლიმიტებისთვის',
    'settings.customRelay': 'საკუთარი relay URL',
    'settings.customRelaySub': '(სურვილისამებრ, პირველად გამოიყენება)',
    'settings.clearData': 'ლოკალური მონაცემების გასუფთავება',
    'settings.close': 'დახურვა',
    'settings.save': 'შენახვა',
    'debug.title': 'დიაგნოსტიკა',
    'debug.desc': 'თუ დაფა ვერ ჩაიტვირთა, გახსენით ეს პანელი და დააკოპირეთ ლოგი. ის მოიცავს თითოეულ Jira მოთხოვნას, სათადარიგო სტრატეგიას და პასუხის კოდს.',
    'debug.none': 'დიაგნოსტიკა ჯერ არ არის ჩაწერილი.',
    'debug.clear': 'ლოგის გასუფთავება',
    'debug.copy': 'ლოგის კოპირება',
    'chart.new': 'ახალი გრაფიკი',
    'chart.edit': 'გრაფიკის რედაქტირება',
    'chart.titleLabel': 'გრაფიკის სახელი',
    'chart.titlePh': 'მაგ. ბაგების რაოდენობა კვირაში',
    'chart.type': 'გრაფიკის ტიპი',
    'chart.scope': 'ვრცელდება',
    'chart.metric': 'მეტრიკა',
    'chart.groupBy': 'დაჯგუფება',
    'chart.range': 'დროის დიაპაზონი',
    'chart.bucket': 'ინტერვალი',
    'chart.filter': 'ფილტრი',
    'chart.split': 'გაყოფა',
    'chart.top': 'მაქს. ჯგუფი',
    'chart.accent': 'ფერი',
    'chart.wide': 'სრული სიგანის გრაფიკი',
    'chart.scopeNote': 'ეს ჩაშენებული გრაფიკია. აქ რედაქტირება ყველა <b>დაფაზე</b> განაახლებს მას.',
    'chart.delete': 'წაშლა',
    'chart.reset': 'ნაგულისხმევზე დაბრუნება',
    'chart.save': 'გრაფიკის შენახვა',
    'bucket.day': 'დღე', 'bucket.week': 'კვირა', 'bucket.month': 'თვე',
    'filter.all': 'ყველა დავალება', 'filter.open': 'მხოლოდ ღია', 'filter.done': 'მხოლოდ დასრულებული',
    'split.none': 'არაფერი', 'split.stage': 'სტეიკჰოლდერი vs გუნდი',
    'accent.indigo': 'ინდიგო', 'accent.cyan': 'ცისფერი', 'accent.green': 'მწვანე',
    'accent.amber': 'ქვიშისფერი', 'accent.violet': 'იისფერი', 'accent.pink': 'ვარდისფერი',
    'pub.modal.title': 'დაფის სტატისტიკის გამოქვეყნება',
    'pub.modal.desc': 'შექმენით საჯარო სნაპშოტი, რომელსაც თქვენი ორგანიზაციის ყველა ნახავს. გააზიარეთ ბმული — მნახველები შედიან <b>@caucasusauto.com</b> ელფოსტით და ერთჯერადი კოდით.',
    'pub.scope': 'მოცულობა',
    'pub.scopeAll': 'ყველა დაფა',
    'pub.scopeBoard': 'ეს დაფა',
    'pub.board': 'დაფა',
    'pub.create': 'სნაპშოტის შექმნა',
    'pub.list': 'გამოქვეყნებული სნაპშოტები',
    'th.board': 'დაფა', 'th.scope': 'მოცულობა', 'th.created': 'შექმნის თარიღი', 'th.token': 'ტოკენი', 'th.actions': 'მოქმედებები',
    'pub.title': 'გამოქვეყნებული სტატისტიკა',
    'pub.subtitle': 'შედით @caucasusauto.com ელფოსტით ამ დაფის სნაპშოტის სანახავად.',
    'pub.google': 'Google-ით შესვლა',
    'pub.orEmail': '— ან ელფოსტით —',
    'pub.send': 'კოდის გაგზავნა',
    'pub.accessCode': 'წვდომის კოდი',
    'pub.codePh': '6-ციფრიანი კოდი',
    'pub.verify': 'დადასტურება',
    'pub.mailLink': 'კოდი ელფოსტით გამომიგზავნეთ',
    'pub.share': '🔗 გაზიარების ბმული',
    'pub.shareNote': 'ეს ბმული მხოლოდ თქვენ (ადმინს) ხედავთ. მნახველები ავთენტიფიცირდებიან @caucasusauto.com Google ან ელფოსტის ანგარიშით.',
    'pub.copy': 'კოპირება',
    'pub.back': '← უკან',
    'pub.backAll': '← ყველა დაფა',
    'pub.changelog': '✓ ცვლილებების ჟურნალი',
    /* dynamic strings — Georgian */
    'cmp.loading': 'იტვირთება {a} vs {b}…',
    'cmp.failed': 'შედარების რეჟიმის გაშვება ვერ მოხერხდა.',
    'cmp.bSyncing': 'დაფა B განახლდება…',
    'cmp.bSynced': 'დაფა B განახლდა · {x}',
    'cmp.bFailed': '⚠ დაფა B ვერ განახლდა — აირჩიეთ სხვა',
    'cmp.cSyncing': 'დაფა C განახლდება…',
    'cmp.cSynced': 'დაფა C განახლდა · {x}',
    'cmp.cFailed': '⚠ დაფა C ვერ განახლდა — აირჩიეთ სხვა',
    'cmp.dupSlot': 'ეს დაფა უკვე შედარებულია მეორე სლოტში',
    'cmp.count': 'A: {a} დავალება · B: {b} დავალება',
    'cmp.prompt': 'შედარების რეჟიმი — აირჩიეთ მეორე დაფა ზემოთა ზოლში, რომ ყველა გრაფიკი და მეტრიკა გადაფარვით ნახოთ.',
    'cmp.even': 'თანაბარი', 'cmp.identical': 'ორივე დაფაზე იდენტურია', 'cmp.noData': 'შედარების მონაცემები არ არის',
    'cmp.vsQ': '{a} vs ? — აირჩიეთ დაფა B ზემოთ',
    'insight.throughput': 'პროდუქტიულობა', 'insight.speed': 'სიჩქარე', 'insight.load': 'ღია დავალებები',
    'insight.completion': 'დასრულება', 'insight.blocked': 'დაბლოკილი სამუშაო', 'insight.intake': 'შემოდინების სხვაობა',
    'kpi.syncing': 'სინქრონიზაცია…',
    'dash.noWip': 'მიმდინარე სამუშაო არ არის — ყველაფერი მზადაა 🎉',
    'dash.trend': 'წინა 30 დღესთან შედარებით',
    'dash.allBoardsScope': 'ყველა დაფა', 'dash.thisBoardScope': 'ეს დაფა',
    'pub.bLoading': 'იტვირთება…', 'pub.bFailed': 'დაფა B ვერ ჩაიტვირთა — სცადეთ ხელახლა.',
    'pub.cmpPrompt': 'შედარების რეჟიმი — აირჩიეთ მეორე დაფა ზემოთა ზოლში, რომ ყველა გრაფიკი და მეტრიკა გადაფარვით ნახოთ.',
    'pub.cmpCount': 'A: {a} დავალება · B: {b} დავალება',
    'pub.orgBoards': '[P] ორგანიზაციის დაფები', 'pub.otherBoards': 'დანარჩენი დაფები',
    'pub.openDash': 'დაშბორდის გახსნა →',
    'pub.cmpFrom': 'შედარება · {a} vs {b}',
    'board.pickA': 'დააჭირეთ ბარათს, რომ დაფა A-დ ჩაიწეროს', 'board.pickB': 'ახლა დააჭირეთ მეორე ბარათს როგორც B', 'board.pickReady': 'მზადაა — გახსენით გვერდით-გვერდ ხედი',
    'health.healthy': 'ჯანმრთელი', 'health.watch': 'თვალყური', 'health.atRisk': 'რისკის ქვეშ',
    'toast.noConn': 'ჯერ Jira-სთან დაუკავშირდით.',
    'toast.boardsLoading': 'დაფების სია ჯერ იტვირთება — სცადეთ ცოტა ხანში.',
    'toast.openBoard': 'ჯერ გახსენით დაფა.',
    'toast.hiddenChart': 'გრაფიკი დამალულია — აღადგინეთ ბმულით ბადის ქვემოთ.',
    'confirm.deleteChart': 'წავშალოთ გრაფიკი „{title}"?',
    'toast.chartReset': 'გრაფიკი ნაგულისხმევზე დაბრუნდა.',
    'toast.chartDeleted': 'გრაფიკი წაიშალა.',
    'toast.copied': 'კოპირებულია ბუფერში.',
    'toast.refreshing': 'დაფის მონაცემები განახლდება…',
    'toast.diagCleared': 'დიაგნოსტიკა გასუფთავდა.',
    'toast.copyFail': 'ვერ დაკოპირდა.',
    'chart.empty': 'გრაფიკები ჯერ არ არის — დააჭირეთ ＋ ახალი გრაფიკს პირველის შესაქმნელად.',
    'chart.hiddenLink': '{n} დამალული გრაფიკი — დააჭირეთ აღსადგენად',
    'data.noChangelog': '⚠ ჟურნალი არ არის', 'data.noOpen': '⚠ ღია დავალებები არ არის', 'data.noData': '⚠ მონაცემები არ არის', 'data.ok': '✓ ჟურნალი',
    'scope.all': 'ყველა დაფა', 'scope.board': 'ეს დაფა',
    'chartmodal.kind.line': 'წრფივი', 'chartmodal.kind.bar': 'სვეტები', 'chartmodal.kind.hbar': 'ჰორიზონტალური', 'chartmodal.kind.doughnut': 'რგოლი',
    'pub.emailPh': 'you@caucasusauto.com',
    /* chart engine constants — Georgian */
    'metric.flow': 'შექმნა vs დახურვა დროში', 'metric.created': 'შექმნილი დავალებები დროში',
    'metric.resolved': 'დახურული დავალებები დროში', 'metric.netflow': 'კუმულაციური ნაკადი (ბექლოგის ზომა)',
    'metric.count': 'დავალებების რაოდენობა ჯგუფებად', 'metric.blockedCount': 'დაბლოკილი / გაუქმებული სტატუსებით',
    'metric.avgCycle': 'საშ. ციკლის დრო ჯგუფებად', 'metric.openAge': 'ღია დავალებების ასაკი',
    'metric.avgStatusTime': 'საშ. დრო სტატუსში ჯგუფებად',
    'group.time': 'დრო', 'group.status': 'სტატუსი', 'group.assignee': 'შემსრულებელი', 'group.type': 'დავალების ტიპი',
    'group.priority': 'პრიორიტეტი', 'group.label': 'პირველი ჭდე', 'group.bottleneck': 'გამავრობის შემზღუდავი ეტაპი',
    'group.stage': 'სტეიკჰოლდერი vs გუნდი', 'group.ageBucket': 'ასაკის დიაპაზონი', 'group.assigneeState': 'განაწილებული vs დაუნიშნავი',
    'group.complexity': 'სირთულე', 'group.noComplexity': 'სირთულე მითითებული არაა',
    'range.7': 'ბოლო 7 დღე', 'range.14': 'ბოლო 2 კვირა', 'range.30': 'ბოლო 30 დღე', 'range.90': 'ბოლო 90 დღე',
    'range.182': 'ბოლო 6 თვე', 'range.365': 'ბოლო 12 თვე', 'range.0': 'მთელი ისტორია',
    'range.custom': 'არჩეული პერიოდი', 'range.pickCustom': 'კალენდარი…', 'range.from': 'საიდან', 'range.to': 'სადამდე',
    'range.apply': 'მიღება', 'range.title': 'დროის პერიოდი', 'range.invalid': 'აირჩიეთ სწორი პერიოდი',
    'range.now': 'ახლა',
    'age.le2d': '≤ 2 დღე', 'age.3_7d': '3–7 დღე', 'age.1_2w': '1–2 კვირა', 'age.2_4w': '2–4 კვირა',
    'age.1_3mo': '1–3 თვე', 'age.3_6mo': '3–6 თვე', 'age.6moPlus': '6 თვე+',
    'chart.title.pipeline': 'შემოსვლა vs დასრულება', 'chart.sub.pipeline': 'შექმნა vs დახურვა დროში',
    'chart.title.throughput': 'თვიური პროდუქტიულობა', 'chart.sub.throughput': 'დასრულებული დავალებები თვეში (Done/Approved/Babysitting/Released)',
    'chart.title.createdTrend': 'შექმნილი დავალებები', 'chart.sub.createdTrend': 'კვირაში შექმნის ტენდენცია',
    'chart.title.resolvedTrend': 'დახურული დავალებები', 'chart.sub.resolvedTrend': 'თვიური დასრულების ტენდენცია',
    'chart.title.backlogGrowth': 'ბექლოგის ტენდენცია', 'chart.sub.backlogGrowth': 'კუმულაციური ღია სამუშაო (შექმნა − დახურვა)',
    'chart.title.blockedDist': 'დაბლოკილი და გაუქმებული', 'chart.sub.blockedDist': 'სამუშაო, რომელიც დაბლოკილ/გაუქმებულ/უარყოფილ სტატუსებში დგას · მთელი ისტორია',
    'chart.title.bottlenecks': 'აქტიური გამავრობის შემზღუდავი ეტაპები', 'chart.sub.bottlenecks': 'სად გროვდება ღია სამუშაო',
    'chart.title.statusDist': 'სტატუსების განაწილება', 'chart.sub.statusDist': 'ყველა დავალება მიმდინარე სტატუსით',
    'chart.title.statusTime': 'საშ. დრო სტატუსში', 'chart.sub.statusTime': 'საშუალო დრო თითოეულ სტატუსში · ჟურნალი',
    'chart.title.phaseDelays': 'სტეიკჰოლდერი vs გუნდის დაგვიანებები', 'chart.sub.phaseDelays': 'საშუალო დღეები ეტაპზე · დაინტერესებულ მხარეთა შეთანხმების ეტაპები და გუნდური მუშაობა · ცვლილებების ჟურნალი',
    'chart.title.typeDist': 'ტიპების განაწილება', 'chart.sub.typeDist': 'ღია დავალებები ტიპებად',
    'chart.title.assigneeLoad': 'შემსრულებლების დატვირთვა', 'chart.sub.assigneeLoad': 'ღია დავალებები შემსრულებლებთან',
    'chart.title.priorityDist': 'პრიორიტეტების განაწილება', 'chart.sub.priorityDist': 'ღია დავალებები პრიორიტეტებად',
    'chart.title.doneByAssignee': 'შესრულებული შემსრულებლების მიხედვით', 'chart.sub.doneByAssignee': 'შესრულებული დავალებები შემსრულებლებთან',
    'chart.title.ageBuckets': 'ასაკი vs მოთხოვნილება', 'chart.sub.ageBuckets': 'რამდენ ხანს ელოდება თითოეული ღია დავალება — დაჯგუფებული ლოდინის დროის მიხედვით',
    'chart.title.unassigned': 'დანიშვნის ხარვეზები', 'chart.sub.unassigned': 'ვინ ფლობს ღია სამუშაოს — დატვირთვის დისბალანსის აღმოჩენა',
    'chart.title.assigneeCycle': 'ციკლის დროის ლიდერბორდი', 'chart.sub.assigneeCycle': 'საშუალოდ შექმნილი - დასრულებული შემსრულებლისგან · დახურული საკითხები',
    'chart.title.complexityDist': 'სირთულის განაწილება', 'chart.sub.complexityDist': 'ღია დავალებები ცვლილების მოთხოვნის სირთულით (S/M/L/XL)',
    'chart.title.complexityDone': 'დასრულებული სირთულით', 'chart.sub.complexityDone': 'დასრულებული დავალებები ცვლილების მოთხოვნის სირთულით (S/M/L/XL)',
    /* auth · connect · publish · misc dynamic strings — Georgian */
    'auth.sending': 'იგზავნება…',
    'auth.codeSent': 'კოდი გაიგზავნა {email}-ზე — შეამოწმეთ შემოსულები (და სპამი).',
    'auth.codeFailed': 'კოდი ვერ გაიგზავნა. შეამოწმეთ მისამართი და სცადეთ ხელახლა.',
    'auth.verifying': 'მოწმდება…',
    'auth.wrongCode': 'კოდი არასწორი ან ვადაგასულია — სცადეთ ხელახლა.',
    'auth.welcome': 'მოგესალმებით! ამ სესიისთვის შესული ხართ.',
    'auth.signedInAs': 'შესული ხართ როგორც {name}',
    'auth.googleOnly': 'გამოქვეყნებულ დაფებს ხედავს მხოლოდ @caucasusauto.com Google ანგარიშები.',
    'auth.enterEmail': 'ჯერ შეიყვანეთ თქვენი @caucasusauto.com ელფოსტა.',
    'auth.invalidEmail': 'ეს არ ჰგავს @caucasusauto.com მისამართს.',
    'connect.connecting': 'მიმდინარეობს დაკავშირება…',
    'connect.ok': 'დაკავშირებულია {domain}-თან 🎉',
    'connect.failed': '{domain}-თან დაკავშირება ვერ მოხერხდა. შეამოწმეთ საიტი, ელფოსტა და ტოკენი, და სცადეთ ხელახლა.',
    'connect.synced': 'სინქრონიზებულია {n} დაფა',
    'connect.noBoards': 'ამ ანგარიშისთვის დაფები არ დაბრუნდა.',
    'pub.copied': 'გაზიარების ბმული კოპირებულია ბუფერში.',
    'pub.boardCopied': 'დაფის ბმული დაკოპირებულია.',
    'pub.viewerCopied': 'მნახველის ბმული დაკოპირებულია — მუშაობს ყველა მოწყობილობაზე.',
    'pub.unpublished': 'გაუქმდა გამოქვეყნება.',
    'pub.unpublishFailed': 'გამოქვეყნების გაუქმება ვერ მოხერხდა: {m}',
    'pub.selectBoard': 'ჯერ აირჩიეთ დაფა.',
    'pub.noBoards': 'გასამოქვეყნებლად დაფები არ არის.',
    'pub.publishedLive': 'გამოქვეყნდა — მნახველის ბმული დაკოპირებულია. მონაცემები ყოველთვის პირდაპირია; ხელახლა გამოქვეყნება მხოლოდ გრაფიკების/დაფების ცვლილებისას არის საჭირო.',
    'pub.publishedNext': 'გამოქვეყნდა. მნახველები შემდეგი შესვლისას დაინახავენ.',
    'pub.publishFailed': 'გამოქვეყნება ვერ მოხერხდა: {m}',
    'auth.sessionRejected': 'Jira-მ სესია უარყო ({s}). გახსენით ხელახლა კავშირი ახალი API ტოკენით.',
    'cmp.startFailed': 'შედარების რეჟიმი ვერ დაიწყო.',
    'chart.restored': 'გრაფიკი აღდგენილია.',
    'chart.titleRequired': 'გთხოვთ, შეიყვანეთ გრაფიკის სათაური.',
    'chart.addedAll': 'გრაფიკი დაემატა ყველა დაფას.',
    'chart.addedBoard': 'გრაფიკი დაემატა ამ დაფას.',
    'chart.updated': 'გრაფიკი განახლდა.',
    'chart.updatedAll': 'გრაფიკი განახლდა ყველა დაფისთვის.',
    'debug.copied': 'დიაგნოსტიკა დაკოპირებულია.',
    'debug.copyFailed': 'დიაგნოსტიკა ვერ დაკოპირდა.',
    'pub.published': 'გამოქვეყნდა — გააზიარეთ ეს ბმული:',
    'pub.created': 'სნაპშოტი შეიქმნა — გააზიარეთ ქვემოთა ბმული.',
    'pub.createFailed': 'სნაპშოტის შექმნა ვერ მოხერხდა.',
    'pub.loadingList': 'გამოქვეყნებული სნაპშოტების ჩატვირთვა…',
    'pub.emptyList': 'სნაპშოტები ჯერ არ არის — შექმენით ზემოთ.',
    'pub.removed': 'სნაპშოტი წაიშალა.',
    'pub.deleteFailed': 'სნაპშოტის წაშლა ვერ მოხერხდა.',
    'pub.notPublished': 'ეს დაფა ჯერ არ არის გამოქვეყნებული — ჯერ შექმენით სნაპშოტი.',
    'pub.badgeYes': 'გამოქვეყნებული', 'pub.badgeNo': 'არ არის გამოქვეყნებული',
    'pub.actCopy': 'კოპირება', 'pub.actOpen': 'გახსნა', 'pub.actDelete': 'წაშლა',
    'pub.creating': 'სნაპშოტი იქმნება…',
    'pub.manageHint': 'შესული ხართ როგორც ადმინისტრატორი — აქ შეგიძლიათ გამოქვეყნებული დაფების მართვა.',
    'pub.issuesCount': '{n} დავალება',
    'pub.loadingData': 'მიმდინარეობს მონაცემების ჩატვირთვა Jira-დან…',
    'pub.dataFailed': 'მონაცემები ვერ ჩაიტვირთა — ნაჩვენებია კეშირებული სტატისტიკა.',
    'pub.noCharts': 'ამ დაფისთვის გრაფიკები ჯერ არ არის გამოქვეყნებული.',
    'pub.allTitle': 'ყველა დაფა',
    'pub.boardTitle': '{b} · გამოქვეყნებული სტატისტიკა',
    'pub.subtitleAll': 'მიწოდების ანალიტიკა თქვენი ორგანიზაციისთვის.',
    'pub.subtitleBoard': 'ამ დაფის მიმდინარე სტატისტიკა, განახლებული Jira-დან.',
    'pub.orgTitle': 'ორგანიზაციის დაფების სტატისტიკა',
    'pub.orgSubtitle': 'ყველა გამოქვეყნებული დაფა ერთ სივრცეში · პირდაპირი ნაკადი Jira-დან',
    'pub.liveSubtitle': 'ცოცხალი მეტრიკები · პირდაპირ Jira-დან, რეალურ დროში',
    'pub.liveBadge': 'პირდაპირი',
    'pub.noBoardsPublished': 'დაფები ჯერ არ არის გამოქვეყნებული — ადმინისტრატორს შეუძლია დაფების სიის გამოქვეყნება ადმინისტრატორის პანელიდან.',
    'pub.nBoards': '{n} დაფა',
    'pub.zeroBoards': '0 დაფა',
    'pub.copyBoardLink': 'ამ დაფის ბმულის დაკოპირება',
    'pub.signedInAdmin': 'შესული ხართ როგორც {e} · ადმინი',
    'pub.cfgTitle': 'დაფების გამოქვეყნება (მხოლოდ კონფიგურაცია)',
    'pub.cfgOnlyTitle': 'კონფიგურაციის გამოქვეყნება',
    'pub.currentlyPublished': 'ამჟამად გამოქვეყნებულია: <b>{n} დაფა</b>{saved}',
    'pub.savedAt': ' · შენახულია {s}',
    'pub.viewerLiveNote': 'მნახველები ყოველთვის ხედავენ <b>პირდაპირ Jira-ს მონაცემებს</b> — ხელახლა გამოქვეყნება მხოლოდ გრაფიკების ან დაფების სიის ცვლილებისას არის საჭირო.',
    'pub.nothingPublished': 'ჯერ არაფერია გამოქვეყნებული. გამოაქვეყნეთ დაფების სია, რომ ორგანიზაციის წევრებმა შესვლის შემდეგ დაინახონ.',
    'pub.copyViewerLink': 'მნახველის ბმულის დაკოპირება',
    'pub.unpublishBtn': 'გაუქმება',
    'pub.publishToOrg': 'ორგანიზაციისთვის გამოქვეყნება',
    'pub.publishing': 'მიმდინარეობს გამოქვეყნება…',
    'pub.restricted': 'წვდომა შეზღუდულია @{d} ანგარიშებზე.',
    'pub.googleLoading': 'Google-ით შესვლა ჯერ იტვირთება… სცადეთ რამდენიმე წამში.',
    'pub.googleFailed': 'Google-ით შესვლა ვერ დაიწყო. გამოიყენეთ თქვენი @{d} ფოსტა.',
    'pub.signOut': '⎋ გასვლა',
    'pub.signOutTitle': 'გასვლა და დაბრუნება შესვლის ეკრანზე',
    'pub.signedOut': 'გასულხართ სისტემიდან — ნახვამდის!',
    'pub.sendCode': 'კოდის გაგზავნა',
    'pub.resendCode': 'კოდის ხელახლა გაგზავნა',
    'pub.sending': 'კოდი იგზავნება {email} მისამართზე…',
    'pub.sentTo': 'კოდი გაიგზავნა {email} მისამართზე. შეამოწმეთ შემომავალი და შეიყვანეთ ქვემოთ.',
    'pub.sendFailed': 'კოდის გაგზავნა ვერ მოხერხდა ({m}). გამოიყენეთ Google-ით შესვლა.',
    'pub.wrongCode': 'კოდი არასწორია. სცადეთ ხელახლა.',
    'pub.invalidEmail': 'გთხოვთ, შეიყვანეთ სწორი @{d} ფოსტა.',
    'pub.signinAll': 'შედით თქვენი @{d} ფოსტით გამოქვეყნებული დაფების სტატისტიკის სანახავად.',
    'pub.signinBoard': 'შედით თქვენი @{d} ფოსტით ამ დაფის სტატისტიკის სანახავად.',
    'pub.headBoard': 'დაფა',
    'pub.activateFirst': 'ეს ფოსტა პირველად გამოიყენება — FormSubmit-მა {email} მისამართზე გააქტივაციის ბმული გაგზავნა. დააჭირეთ მას და შემდეგ აირჩიეთ „კოდის ხელახლა გაგზავნა".',
    'pub.deliverFailed': 'კოდი ამჟამად ვერ მიეწოდა ({m}). გამოიყენეთ Google-ით შესვლა.',
    'confirm.unpublish': 'გავაუქმოთ გამოქვეყნება? მნახველები შესვლის შემდეგ დაფებს ვეღარ დაინახავენ.',
    'settings.saved': 'პარამეტრები შენახულია.',
    'settings.savedRelay': 'Relay-ის პარამეტრები შენახულია. ახლა დაუკავშირდით Jira-ს.',
    'settings.cleared': 'ლოკალური მონაცემები გასუფთავდა — ხდება გადატვირთვა…',
    'chart.deleted': 'გრაფიკი წაიშალა.',
    'chart.saved': 'გრაფიკი შენახულია.',
    'err.generic': 'რაღაც არასწორად წავიდა — დეტალებისთვის გახსენით დიაგნოსტიკა.',
    'err.loadBoard': 'დაფის ჩატვირთვა ვერ მოხერხდა',
    'err.status401': 'შეამოწმეთ ელფოსტა / API ტოკენი პარამეტრებში.',
    'err.status403': 'თქვენს ანგარიშს ამ დაფაზე წვდომა არ აქვს.',
    'err.status404': 'დაფა ვერ მოიძებნა — შესაძლოა წაშლილია.',
    'err.status429': 'Jira-მ მოთხოვნები შემოიზღუდა — დაელოდეთ და სცადეთ ხელახლა.',
    'err.status5xx': 'Jira-ს სერვერის შეცდომა — ცოტა ხანში სცადეთ.',
    'err.network': 'Jira-სთან დაკავშირება ვერ მოხერხდა — შეამოწმეთ კავშირი ან relay-ის პარამეტრები.',
    'sync.updated': 'განახლდა {t}',
    'sync.failed': 'ვერ ჩაიტვირთა',
    'err.loadIssues': 'დაფის დავალებების ჩატვირთვა ვერ მოხერხდა.',
    'err.connectFailed': 'დაკავშირება ვერ მოხერხდა.',
    'dash.syncing': 'სინქრონიზაცია…',
    'dash.syncingDash': 'მიმდინარეობს დაშბორდის სინქრონიზაცია…',
    'dash.loadingBoard': 'იტვირთება {b}',
    'dash.thisBoard': 'ეს დაფა',
    'dash.issuesOnBoard': 'დავალება ამ დაფაზე',
    'dash.vsPrior30d': 'წინა 30 დღესთან შედარებით',
    'dash.completionRate': '{p}% დასრულების მაჩვენებელი',
    'dash.createResolve': 'შექმნა → დახურვა',
    'dash.fasterThan': 'უფრო სწრაფია წინა 30 დღესთან შედარებით',
    'dash.slowerThan': 'უფრო ნელია წინა 30 დღესთან შედარებით',
    'dash.issuesAnalyzed': '{n} დავალება ანალიზდება',
    'dash.changelogNotice': '⚠ სტატუსების დროის ანალიზი მიუწვდომელია — ეს დაფა შესაძლოა team-managed იყოს ან თქვენს ტოკენს არ აქვს changelog-ის უფლება. ნაჩვენებია მხოლოდ ძირითადი მეტრიკები.',
    'insight.throughputText': '{r} დახურულია ბოლო 30 დღეში ({d}/დღე საშ.).',
    'insight.speedText': 'საშუალო ციკლის დროა {c} — {n} დახურულ დავალებაზე.',
    'insight.loadText': 'ახლა {w} დავალება მიმდინარეობს · სულ {o} ღიაა.',
    'insight.completionText': 'ამ დაფაზე დავალებების {p}% მზადაა.',
    'insight.blockedText': '{b} დავალება ახლა დაბლოკილი ან გაუქმებულია.',
    'insight.intakeText': 'შემოდინება vs მიწოდება: 30 დღეში {c} შეიქმნა vs {r} დაიხურა.',
    'cmp.kpiTotal': 'დაანალიზებული დავალებები',
    'cmp.kpiTotalSub': 'დაფაზე',
    'cmp.kpiCreated': 'შექმნილი · 30 დღე',
    'cmp.kpiCreatedSub': 'ახალი დავალებები',
    'cmp.kpiDone': 'ჯამურად დასრულებული',
    'cmp.kpiDoneSub': 'დასრულებული',
    'cmp.kpiResolved': 'დახურული · 30 დღე',
    'cmp.kpiResolvedSub': 'ცოტა ხნის წინ გაიგზავნა',
    'cmp.kpiCycle': 'საშ. ციკლის დრო',
    'cmp.kpiCycleSub': 'შექმნა → დახურვა',
    'cmp.kpiWip': 'მიმდინარე სამუშაო',
    'cmp.kpiWipSub': 'ჯერ არ დასრულებულა',
    'cmp.badgeBoth': '{na}: {a} დავალება · {nb}: {b} დავალება',
    'cmp.hintBar': 'შედარების რეჟიმი — აირჩიეთ მეორე დაფა ზემოთა ზოლში, რომ ყველა გრაფიკი და მეტრიკა გადაფაროთ.',
    'cmp.aFaster': '{n} უფრო სწრაფია',
    'cmp.bFaster': '{n} უფრო სწრაფია',
    'cmp.aHigher': '{n} უფრო მაღალია',
    'cmp.bHigher': '{n} უფრო მაღალია',
    'cmp.aAbove': '{a} {p}%-ით მაღლაა {b}-ზე',
    'cmp.aBelow': '{a} {p}%-ით დაბლაა {b}-ზე',
    'cmp.even': 'თანაბარი',
    'cmp.identical': 'ორივე დაფაზე იდენტურია',
    'cmp.noData': 'შედარების მონაცემები არ არის',
    'cmp.pickBHint': 'აირჩიეთ დაფა B ზემოთ',
    'cmp.outerRing': 'გარე რგოლი',
    'cmp.outerRingC': 'გარე რგოლი',
    'cmp.shownGreen': 'ნაჩვენებია მწვანედ',
    'cmp.lblThroughput': 'გამტარუნარიანობა',
    'cmp.lblSpeed': 'სიჩქარე',
    'cmp.lblOpenLoad': 'ღია დატვირთვა',
    'cmp.lblCompletion': 'დასრულება',
    'cmp.lblBlocked': 'დაბლოკილი სამუშაო',
    'cmp.lblIntake': 'შემოდინების სხვაობა',
    'cmp.lblMomentum': 'დინამიკა',
    'cmp.lblFlow': 'ნაკადის ბალანსი',
    'cmp.lblSpeedQuality': 'სიჩქარე და ხარისხი',
    'cmp.lblRisk': 'რისკის რადარი',
    'cmp.insVerdictTitle': '{n} ლიდერობს ჯამში',
    'cmp.insVerdictTieTitle': 'თანაბარი დუელი',
    'cmp.insVerdict': '{a} გამარჯვებულია {m} ჯვარედინი შემოწმებიდან {w}-ში {b}-ს წინააღმდეგ — ძლიერია იქ, სადაც მნიშვნელოვანია.',
    'cmp.insVerdictTie': 'ორივე დაფა {m} ჯვარედინ შემოწმებას თანაბრად ინაწილებს — მკვეთრი ლიდერი არ ჩანს.',
    'cmp.wins.throughput': 'გამტარუნარიანობა',
    'cmp.wins.speed': 'სიჩქარე',
    'cmp.wins.completion': 'დასრულება',
    'cmp.wins.load': 'მსუბუქი WIP',
    'cmp.wins.blocked': 'ნაკლები ბლოკი',
    'cmp.insMomentum': '{n} უფრო სწრაფად აჩქარებს — ბოლო 30 დღის გამომავალმა წინა 30 დღესთან შედარებით მეტი ზრდა აჩვენა.',
    'cmp.insMomentumMixed': 'დინამიკა იშლება — ერთი დაფა აჩქარებს, მეორე კლებულობს.',
    'cmp.insFlow': '{n} ნაკადს აბალანსებს — შემოდინება მიწოდებას მხოლოდ {a}-ით აღემატება, მეორე დაფაზე კი {b}-ით.',
    'cmp.insSpeed': '{n} სამუშაოს საშუალოდ უფრო სწრაფად ხურავს ({a} vs {b}) — დასრულების მაჩვენებელთან ერთად შეაფასეთ.',
    'cmp.insRisk': '{n} ნაკლებ გაჩერებულ სამუშაოს ატარებს ({a} დაბლოკილი vs {b}) — მიწოდების ჯანსაღი ხაზი.',
    'cmp.insRiskEven': 'დაბლოკილი სამუშაო ორივე დაფაზე თანაბარია — რისკი სხვაგან ზის.',
    'cmp.insStatsIssues': ' დავალება',
    'cmp.insStatsShipped': ' დახურული 30დ',
    'cmp.insStatsCycle': ' საშ. ციკლი',
    'cmp.insStatsDone': ' მზადაა',
    'cmp.insStatsBlocked': ' დაბლოკილი',
    'cmp.insStatsWip': ' WIP',
    'cmp.insStatsInOut': ' შემოსული ▸ გასული 30დ',
    'cmp.insStatsNowPrev': ' ახლა vs წინა 30დ',
    'cmp.chartWinsA': '{n} ლიდერობს {p}%-ით',
    'cmp.chartWinsB': '{n} ლიდერობს {p}%-ით',
    'cmp.scoreTitle': 'ანგარიში',
    'cmp.scoreSub': 'პირისპირ გამარჯვებები ყველა მეტრიკაზე',
    'cmp.scoreLeads': 'ლიდერობს {m} მეტრიკადან {n}-ში',
    'cmp.scoreTie': 'ტოლფასია — {n} : {n} მეტრიკა',
    'bc.measuring': 'იზომება…',
    'bc.newTitle': 'ახალი დავალებები · ბოლო 30 დღე',
    'bc.new30': 'ახალი',
    'bc.wipTitle': 'მიმდინარე სამუშაო',
    'bc.active': 'აქტიური',
    'bc.netTitle': 'ნაკადი · ბოლო 30 დღე (დახურული − შექმნილი)',
    'bc.net30d': 'ნაკადი',
    'bc.done': 'მზადაა',
    'bc.unavailable': 'სტატისტიკა მიუწვდომელია',
    'card.openDash': 'გახსენით დაშბორდი →',
    'card.copyLinkTitle': 'დაფის ლინკის კოპირება',
    'card.orgBoards': '[P] ორგანიზაციის დაფები',
    'card.otherBoards': 'დანარჩენი დაფები',
    'master.pName': 'ყველა [P] დაფა',
    'master.cardChip': 'გაერთიანებული ხედი',
    'master.cardDesc': 'ყველა [P] დაფა ერთად',
    'master.syncing': 'იტვირთება ყველა [P] დაფა…',
    'master.savedAs': 'დაფაზე მიბმული გრაფიკები გაერთიანებულ [P] ხედში მიუწვდომელია',
    'pick.selectedAs': 'არჩეულია როგორც {s} — დააჭირეთ მოსაშორებლად',
    'pick.clickPickA': 'აირჩიეთ A-დ',
    'pick.clickPickB': 'აირჩიეთ B-დ',
    'pick.clickPickC': 'აირჩიეთ C-დ',
    'hl.blocked': '{b} დაბლოკილია',
    'hl.allClear': 'ყველაფერი რიგზეა — არაფერი მიმდინარეობს',
    'hl.backlogGrowing': 'ბექლოგი იზრდება',
    'hl.strongOutflow': 'ძლიერი გამოდინება',
    'hl.steadyFlow': 'სტაბილური ნაკადი',
    'badge.noChangelogTitle': 'ამ დაფაზე changelog მიუწვდომელია',
    'badge.noChangelog': 'changelog არ არის',
    'badge.noOpenTitle': 'ამ დაფაზე ღია დავალებები არ არის',
    'badge.noOpen': 'ღია დავალებები არ არის',
    'badge.noDataTitle': 'მოქმედი ფილტრებით მონაცემები არ მოიძებნა',
    'badge.noData': 'მონაცემები არ არის',
    'badge.changelogOkTitle': 'changelog-ის მონაცემები ხელმისაწვდომია',
    'badge.changelog': 'Changelog',
    'chart.noneYet': 'ამ დაფაზე დიაგრამები ჯერ არ არის — დაამატეთ „＋ ახალი დიაგრამა".',
    'chart.hiddenStrip': 'დამალული დიაგრამები:',
    'ins.bottleneck': '<b>{n}</b> ღია დავალება ახლა იდგება <b>{cat}</b>-ში',
    'ins.slowest': 'ახლა ყველაზე ნელი ეტაპია: <b>{s}</b> · საშ. {d}',
    'ins.throughput': 'გამტარუნარიანობა <b>{p}%</b> წინა 30 დღესთან შედარებით',
    'ins.aged': '<b>{n}</b> ღია დავალება 14 დღეზე მეტხანსაა ჩაძრახული',
    'ins.netFlow': '30 დღეში წმინდა ნაკადი <b>{n}</b> დავალება — ბექლოგი {w}',
    'ins.shrinking': 'მცირდება',
    'ins.growing': 'იზრდება',
    'cmp.noDataEither1': 'ორივე დაფაზე მონაცემები არ არის',
    'cmp.noDataEither2': 'ამ გრაფიკისთვის',
    'cmp.boardsNoData': '{n}-ზე მონაცემები არ არის',
    'cmp.noDataA': 'დაფა A-ზე ამ გრაფიკის მონაცემები არ არის',
    'cmp.noComparable': 'შედარებადი მონაცემები არ არის',
    'cmp.shownCyan': 'ნაჩვენებია ცისფრად',
    'cmp.only': 'მხოლოდ',
    'cmp.oneBoardNoData': 'ერთ დაფაზე აქ მონაცემები არ არის',
    'cmp.avg': 'საშ.',
    'cmp.issues': 'დავალება',
    'cmp.tie': 'თანაბარია',
    'pub.liveUnavailable': 'პირდაპირი მონაცემები მიუწვდომელია',
    'pub.noBoardSelected': 'დაფა არ არის არჩეული.',
    'pub.loadingLive': 'მიმდინარეობს პირდაპირი მონაცემების ჩატვირთვა Jira-დან…',
    'pub.loadFailed': 'პირდაპირი მონაცემების ჩატვირთვა ვერ მოხერხდა ({m}).',
    'pub.nIssues': '{n} დავალება',
    'pub.noCharts': 'ამ დაფისთვის გრაფიკები კონფიგურირებული არ არის.',
    'chart.newTitle': 'ახალი გრაფიკი',
    'chart.configureTitle': 'კონფიგურაცია — „{title}“',
    'chart.segLine': 'ხაზოვანი',
    'chart.segBar': 'სვეტები',
    'chart.segHbar': 'ჰორიზონტალური',
    'chart.segDoughnut': 'რგოლი',
    'chart.segBoard': 'მხოლოდ ეს დაფა',
    'chart.segGlobal': 'ყველა დაფა',
    'chart.scopeBoard': 'ეს დაფა',
    'chart.scopeGlobal': 'ყველა დაფა',
    'chart.btnEdit': 'გრაფიკის კონფიგურაცია',
    'chart.btnReset': 'ნაგულისხმევზე დაბრუნება',
    'chart.btnHide': 'გრაფიკის დამალვა',
    'chart.btnDelete': 'გრაფიკის წაშლა',
    'series.registered': 'რეგისტრირებული',
    'series.completed': 'დასრულებული',
    'series.openBacklog': 'ღია ბექლოგი',
    'series.netflowDesc': 'დაგროვილი ღია ბექლოგი (შექმნა − დახურვა)',
    'series.pBacklog': 'ბექლოგი (Bug / Backlog / System Improvements)',
    'series.pNetflowDesc': 'დაგროვილი ბექლოგი — Bug, Backlog და System Improvements სტატუსები (შექმნა − დახურვა)',
    'series.createdVsResolved': 'შექმნილი vs დასრულებული',
    'series.created': 'შექმნა',
    'series.resolved': 'დახურვა',
    'series.perBucket': '{b}ში',
    'series.openNow': 'ახლა ღიაა',
    'series.avg': 'საშ. მნიშვნელობა',
    'series.count': 'რაოდენობა',
    'series.byGroup': '{g}-ის მიხედვით',
    'statusTime.noChangelog1': 'ამ დაფაზე ცვლილებების ისტორია მიუწვდომელია',
    'statusTime.noChangelog2': '— სტატუსის დროის გრაფიკებს ეს სჭირდება',
    'statusTime.noTransitions': 'სტატუსის გადასვლების მონაცემები ვერ მოიძებნა',
    'statusTime.noStages': 'სტეიკჰოლდერის / გუნდის ეტაპების გადასვლები ვერ მოიძებნა',
    'statusTime.subStage': 'საშ. დღეები · სტეიკჰოლდერი vs გუნდი · ცვლილებების ისტორია',
    'statusTime.subStatus': 'საშ. დღეები სტატუსის მიხედვით · სრული ვადა · ცვლილებების ისტორია',
    'statusTime.subSplit': 'საშ. დღეები ეტაპზე ყოფნისთვის · ცვლილებების ისტორია',
    'statusTime.stakeholderAvg': 'სტეიკჰოლდერის ეტაპების საშ.',
    'statusTime.teamAvg': 'გუნდის ეტაპების საშ.',
    'stage.stakeholder': 'სტეიკჰოლდერის ეტაპები',
    'stage.team': 'გუნდის ეტაპები',
    'stage.it': 'IT კომიტეტი',
    'statusTime.itAvg': 'IT კომიტეტის საშ.',
    'group.unassigned': 'დაუნიშნავი',
    'group.assigned': 'დანიშნული',
    'group.other': 'სხვა',
    'err.unknownMetric': 'უცნობი მეტრიკა',
    'cat.noResolved': 'გასაზომად დახურული დავალებები ჯერ არ არის',
    'cat.noIssues': 'ამ გრაფიკს დავალებები ჯერ არ ერგება',
    'filter.openOnly': 'მხოლოდ ღია',
    'filter.doneOnly': 'მხოლოდ დახურული',
    'bn.pendingReview': 'განხილვის პროცესში',
    'bn.techAnalysis': 'ტექნიკური ანალიზი',
    'bn.inDevelopment': 'შემუშავებაში',
    'bn.testing': 'ტესტირება',
    'bn.uat': 'UAT',
    'bn.readyForRelease': 'მზადაა გამოსაშვებად',
    'lang.en': 'English',
    'lang.ka': 'ქართული',
    'lang.title': 'ენის გადამრთველი',
    'theme.title': 'ფერის თემის გადამრთველი',
    'theme.dark': 'მუქი თემა',
    'theme.light': 'ღია თემა',
  },
};

function t(key, fallback) {
  const d = I18N[LANG] || I18N.en;
  const v = d[key];
  if (v != null && v !== '') return v;
  const e = I18N.en[key];
  if (e != null && e !== '') return e;
  return fallback != null ? fallback : key;
}

/* format helpers that respect the active language */
function tReplace(key, subs, fallback) {
  let s = t(key, fallback);
  for (const [k, v] of Object.entries(subs || {})) s = s.split('{' + k + '}').join(String(v));
  return s;
}

/* ── dark / light theme switcher ───────────────────────────────────
   Dark is the default (unchanged look); a user can flip to light.
   Persisted in localStorage, applied as body[data-theme] so all CSS
   variables + surfaces restyle, and charts re-render with theme-aware
   colors. Mirrors the language switcher's persistence pattern. */
const LS_THEME = 'jp_theme_v1';
let THEME = 'dark';
try { THEME = localStorage.getItem(LS_THEME) === 'light' ? 'light' : 'dark'; } catch (_) {}

/* theme-aware colors for canvas-drawn content (charts can't use CSS vars) */
function themeColors() {
  const light = THEME === 'light';
  return {
    light,
    text: light ? '#3f4660' : '#e9edf8',
    muted: light ? '#5d6584' : '#8b93ad',
    grid: light ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.05)',
    tooltipBg: light ? 'rgba(255, 255, 255, 0.97)' : 'rgba(13, 18, 38, 0.95)',
    tooltipText: light ? '#1e2540' : '#e9edf8',
    tooltipBorder: light ? 'rgba(15, 23, 42, 0.12)' : 'rgba(255, 255, 255, 0.09)',
    emptyMsg: light ? '#5d6584' : '#8b93ad',
    /* slice/point edge color (doughnut borders, line point borders) */
    edge: light ? 'rgba(255, 255, 255, 0.9)' : 'rgba(10, 15, 34, 0.9)',
    edgeHover: light ? '#4f46e5' : '#fff',
  };
}

function applyThemeClass() {
  document.body.classList.toggle('light', THEME === 'light');
  document.querySelectorAll('.theme-btn').forEach((b) => {
    b.classList.toggle('active', (b.dataset.theme === 'light') === (THEME === 'light'));
  });
}

function setTheme(theme) {
  THEME = (theme === 'light') ? 'light' : 'dark';
  try { localStorage.setItem(LS_THEME, THEME); } catch (_) {}
  applyThemeClass();
  /* re-render charts + canvas messages so hardcoded canvas colors follow the theme */
  try {
    if (state.inShareScreen) { renderPubContent(); }
    else if (state.lastBoard && state.lastMetrics && !$('#dashScreen').classList.contains('hidden')) {
      renderCharts(effectiveCharts(), state.lastMetrics);
    }
  } catch (err) { logDiag('theme rerender failed: ' + err.message); }
}

function applyI18n(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n')); });
  scope.querySelectorAll('[data-i18n-text]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n-text')); });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
}

function setLang(lang) {
  LANG = (lang === 'ka') ? 'ka' : 'en';
  try { localStorage.setItem(LS_LANG, LANG); } catch (_) {}
  document.documentElement.setAttribute('lang', LANG === 'ka' ? 'ka' : 'en');
  applyI18n();
  document.querySelectorAll('.lang-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === LANG);
  });
  /* re-render dynamic surfaces so runtime-built strings follow the language */
  try {
    if (state.inShareScreen) { renderPubContent(); }
    else if (state.lastBoard && state.lastMetrics && !$('#dashScreen').classList.contains('hidden')) {
      /* compare mode: renderDashboard() would restoreKpiGrid() and wipe the
         3-way compare KPI cards — re-render the compare layout instead */
      const kpiGrid = document.querySelector('.kpi-grid');
      if (kpiGrid && kpiGrid.classList.contains('kpi-grid-compare')) {
        renderCompareDashboard();
      } else {
        renderDashboard(state.lastBoard, state.lastMetrics);
      }
      renderCharts(effectiveCharts(), state.lastMetrics);
    } else if (state.boards.length && !$('#boardsScreen').classList.contains('hidden')) {
      renderBoardCards();
    }
  } catch (err) { logDiag('i18n rerender failed: ' + err.message); }
}

/* the public app root path — always strips a trailing /admin/ so share links and
   board links built anywhere (admin panel included) point at the *public* app. */
function publicRootPath() {
  return location.pathname.replace(/\/admin\/?$/i, '').replace(/\/+$/, '') + '/';
}

/* ── public board publishing (relay-backed config + LIVE data) ────────
   The publish CONFIG (which boards are visible) lives on the relay, so
   viewers on ANY device see it right after sign-in. The DATA is never
   stored: every view fetches live Jira numbers via ?cmd=board. "Republish"
   therefore only carries configuration changes (chart types, board show/
   hide) — numbers are always real-time by design. */
const PUB_RELAY = 'https://gensweaty--65df49bca6d911f19f231607ee4eb77e.web.val.run/';
const PUB_ADMIN_TOKEN = 'jp_k9R2vTq7Lm4wXy8Zp3nB6dF1sH5jC';   /* shared admin secret (x-jp-admin) */

/* call a relay publish command. admin=true adds the x-jp-admin header (writes). */
async function pubCmd(cmd, { method = 'GET', body = null, admin = false, timeoutMs = 25000 } = {}) {
  const url = PUB_RELAY + '?cmd=' + encodeURIComponent(cmd);
  const headers = { 'Accept': 'application/json' };
  if (admin) headers['x-jp-admin'] = PUB_ADMIN_TOKEN;
  if (body != null) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch (_) { /* non-json */ }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.detail)) || `Relay command failed (HTTP ${res.status})`);
      err.status = res.status;
      logDiag('warn', 'Publish relay command failed', { cmd, status: res.status, data });
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* fetch the org-wide publish config (null when nothing published yet).
   Cached in sessionStorage briefly so navigating back/forth doesn't re-hit
   the relay on every render — but always re-fetched on page load, so an
   admin republish reaches every viewer on their very next visit. */
let _pubConfigCache = { cfg: undefined, ts: 0 };
const PUB_CFG_TTL = 60 * 1000;   /* 60 s in-memory TTL */
async function pubConfigGet({ force = false } = {}) {
  if (!force && _pubConfigCache.cfg !== undefined && Date.now() - _pubConfigCache.ts < PUB_CFG_TTL) {
    return _pubConfigCache.cfg;
  }
  try {
    const r = await pubCmd('config:get');
    const cfg = r?.config ?? null;
    _pubConfigCache = { cfg, ts: Date.now() };
    return cfg;
  } catch (e) {
    logDiag('warn', 'config:get failed', { message: e?.message });
    return null;
  }
}

/* store the full publish config on the relay (admin only). Instant — no Jira calls. */
async function pubConfigSet(config) {
  const r = await pubCmd('publish:set', { method: 'POST', body: config, admin: true });
  _pubConfigCache = { cfg: config, ts: Date.now() };
  return r;
}

/* store the admin's Jira creds ONCE so viewers without their own connection
   still get live data through the relay (relay uses them server-side only). */
async function pubCredsSet(conn) {
  await pubCmd('creds:set', {
    method: 'POST',
    admin: true,
    body: { domain: conn.domain, email: conn.email, token: conn.token },
  });
}

/* ── viewer → relay live board fetch ─────────────────────────────────
   Asks the relay for one board's issues. When the viewer has their own Jira
   connection the Authorization header is forwarded (their creds, zero stored
   secrets); otherwise the relay falls back to the admin's stored creds. */
async function pubFetchBoardLive(boardId, mode = 'full') {
  const domain = state.conn?.domain ? String(state.conn.domain).replace(/^https?:\/\//, '') : '';
  const url = PUB_RELAY + '?cmd=board&bid=' + encodeURIComponent(boardId) + '&mode=' + encodeURIComponent(mode) +
    (domain ? '&domain=' + encodeURIComponent(domain) : '');
  const headers = { 'Accept': 'application/json' };
  if (state.conn) headers['Authorization'] = 'Basic ' + btoa(state.conn.email + ':' + state.conn.token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch (_) { /* non-json */ }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.detail)) || `Live board fetch failed (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;   /* { ok, boardId, source, mode, hasChangelog, count, fetchedAt, issues } */
  } finally {
    clearTimeout(timer);
  }
}

/* ── org access auth (unchanged) ───────────────────────────────────── */
const PUBLISH_DOMAIN = 'caucasusauto.com';   /* allowed email domain */
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

/* deterministic 6-digit code from seed + email */
function publishCode(seed, email) {
  let h = 0;
  const s = seed + '|' + email.toLowerCase().trim();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(Math.abs(h) % 1000000).padStart(6, '0');
}

/* is this email in the allowed domain? */
function publishEmailOk(email) {
  const e = (email || '').toLowerCase().trim();
  return e.endsWith('@' + PUBLISH_DOMAIN) && e.split('@')[1] === PUBLISH_DOMAIN;
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
  pickCompare: null,       /* { a, b, c } board ids while the user is picking boards to compare (c optional) */
  compare: null,           /* { a, b, c?, nameA, nameB, nameC?, recA, recB, recC? } active pub compare view */
  compareGen: 0,           /* staleness guard for in-flight compare loads */
};

/* ── viewer session persistence (refresh keeps you signed in) ─────────
   After a Google sign-in or a verified email code we remember the viewer
   (email + timestamp) in localStorage. On the next page load the org gate
   is skipped and the viewer lands straight back on the board they were
   viewing. Sign-out wipes it. Sessions expire after 30 days. */
const LS_PUB_SESSION = 'jp_pub_session_v1';
const PUB_SESSION_TTL = 30 * 24 * 60 * 60 * 1000;   /* 30 days */

function pubSaveSession(extra = {}) {
  try {
    if (!pubState.verified || !pubState.email) return;
    localStorage.setItem(LS_PUB_SESSION, JSON.stringify({
      email: pubState.email,
      ts: Date.now(),
      ...extra,
    }));
  } catch { /* storage unavailable — non-fatal */ }
}

function pubRestoreSession() {
  try {
    const raw = localStorage.getItem(LS_PUB_SESSION);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.email || !publishEmailOk(s.email)) return null;
    if (!s.ts || Date.now() - s.ts > PUB_SESSION_TTL) {
      localStorage.removeItem(LS_PUB_SESSION);
      return null;
    }
    return s;
  } catch { return null; }
}

function pubClearSession() {
  try { localStorage.removeItem(LS_PUB_SESSION); } catch { /* noop */ }
}

/* shared "viewer verified" path: hide the gate, show the content, render.
   Used by Google sign-in, the email code and the session restore. Also does
   the full screen swap (hide setup/app chrome, show the pub overlay) because
   the session-restore boot path lands here WITHOUT showPubScreen() having
   run — without this the default-visible setup screen stays on screen. */
function pubEnterVerified() {
  hide($('#setupScreen'));
  hide($('#topbar'));
  hide($('#dashScreen'));
  hide($('#boardsScreen'));
  state.inShareScreen = true;
  show($('#pubScreen'));
  $('#pubContent').classList.remove('hidden');
  $('#pubAuthBox').classList.add('hidden');
  updatePubUserChip();
  renderPubContent();
}

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
    $('#pubStatus').textContent = tReplace('pub.restricted', { d: PUBLISH_DOMAIN });
    $('#pubStatus').className = 'error';
    return;
  }
  pubState.email = email;
  pubState.verified = true;
  pubState.isAdmin = isAdminEmail(email);
  /* remember the viewer so a refresh skips the login gate */
  pubSaveSession();
  /* no "verified · loading" message here — the charts appearing IS the feedback;
     the status line is reserved for errors only */
  pubEnterVerified();
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
          $('#pubStatus').textContent = t('pub.googleLoading');
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
      $('#pubStatus').textContent = tReplace('pub.googleFailed', { d: PUBLISH_DOMAIN });
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

/* topbar identity chip on the share view: shows the signed-in org member's
   profile (initial avatar + email) — the same spot where the admin panel shows
   its Admin badge. Everyone here is a viewer, so no admin wording. */
function updatePubUserChip() {
  const chip = $('#pubUserChip');
  if (!chip) return;
  const email = pubState.email || '';
  if (!pubState.verified || !email) {
    chip.classList.add('hidden');
    return;
  }
  const name = String(email).split('@')[0] || '?';
  const avatar = $('#pubUserAvatar');
  avatar.textContent = name.charAt(0).toUpperCase();
  $('#pubUserName').textContent = email;
  chip.title = email;
  chip.classList.remove('hidden');
}

/* sign-out menu on the topbar identity chip: clicking the chip toggles a small
   dropdown with a Sign out item. Signing out wipes the verified session and
   returns the viewer to the login gate (Google 1-click + email code) — exactly
   the state a fresh share-link visit shows. */
function togglePubSignOut(ev) {
  if (ev) ev.stopPropagation();
  const chip = $('#pubUserChip');
  const menu = $('#pubSignOutBtn');
  if (!chip || !menu) return;
  const open = !menu.classList.contains('hidden');
  if (open) {
    menu.classList.add('hidden');
    chip.classList.remove('signout-open');
  } else {
    menu.classList.remove('hidden');
    chip.classList.add('signout-open');
  }
}

function closePubSignOut() {
  const chip = $('#pubUserChip');
  const menu = $('#pubSignOutBtn');
  if (menu) menu.classList.add('hidden');
  if (chip) chip.classList.remove('signout-open');
}

function pubSignOut() {
  closePubSignOut();
  /* stop any in-flight compare/board work and clear the whole viewer session */
  pubState.compareGen = (pubState.compareGen || 0) + 1;
  pubState.compare = null;
  pubState.pickCompare = null;
  pubState.currentBoard = null;
  pubState.allSnapshot = null;
  document.body.classList.remove('cmp-view');
  pubState.verified = false;
  pubState.email = '';
  pubState.codeSent = false;
  pubState.isAdmin = false;
  pubClearSession();   /* forget the persisted viewer session */
  /* let Google forget the chosen account so the next sign-in shows the chooser */
  if (googleReady()) {
    try { window.google.accounts.id.disableAutoSelect(); } catch { /* noop */ }
  }
  updatePubUserChip();          /* hides the chip (and its menu with it) */
  renderPubAuthGate();          /* fresh login screen: Google button + email code */
  toast(t('pub.signedOut'), 'ok');
}

/* reset the login gate to its pristine state without re-fetching the snapshot —
   shared by sign-out and the initial screen reset */
function renderPubAuthGate() {
  const snap = pubState.snapshot;
  if (!snap) return;
  /* title depends on scope */
  if (snap.scope === 'all') {
    setPubTitleAccent(t('pub.orgTitle'));
    $('#pubSubtitle').textContent = tReplace('pub.signinAll', { d: PUBLISH_DOMAIN });
    $('#pubHeadTitle').textContent = t('pub.allTitle');
  } else {
    setPubTitleAccent(tReplace('pub.boardTitle', { b: snap.boardName }));
    $('#pubSubtitle').textContent = tReplace('pub.signinBoard', { d: PUBLISH_DOMAIN });
    $('#pubHeadTitle').textContent = snap.boardName || t('pub.headBoard');
  }
  $('#pubEmail').value = '';
  $('#pubEmail').disabled = false;
  $('#pubEmail').placeholder = 'you@' + PUBLISH_DOMAIN;
  $('#pubCodeWrap').classList.add('hidden');
  $('#pubCode').value = '';
  $('#pubCode').disabled = false;
  $('#pubSendBtn').textContent = t('pub.sendCode');
  $('#pubSendBtn').disabled = false;
  $('#pubVerifyBtn').textContent = t('pub.verify');
  $('#pubVerifyBtn').classList.add('hidden');
  $('#pubStatus').textContent = '';
  $('#pubStatus').className = 'muted';
  $('#pubContent').classList.add('hidden');
  $('#pubAuthBox').classList.remove('hidden');
  $('#pubAuthBox').classList.add('glass');
  $('#pubAdminBar').classList.add('hidden');
  $('#pubBoardsList').classList.add('hidden');
  $('#pubChartsGrid').classList.add('hidden');
  $('#pubCompareBar').classList.add('hidden');
  $('#pubKpiGrid').classList.add('hidden');
  $('#pubInsightsStrip').classList.add('hidden');
  $('#pubBoardKpis').classList.add('hidden');
  $('#pubBoardKpis').innerHTML = '';
  $('#pubTaskListCard').classList.add('hidden');
  $('#pubTlBody').innerHTML = '';
  hide($('#pubPickBar'));
  /* re-render Google's official button — GSI wipes it when the gate was hidden */
  initGoogleButton();
}

function showPubScreen(snapshot) {
  pubState.snapshot = snapshot;
  pubState.email = '';
  pubState.verified = false;
  pubState.codeSent = false;
  pubState.isAdmin = false;
  pubState.currentBoard = null;
  pubState.allSnapshot = null;
  pubState.pickCompare = null;
  pubState.compare = null;
  pubState.compareGen = (pubState.compareGen || 0) + 1;
  updatePubUserChip();   /* reset the topbar profile chip for a fresh sign-in */

  /* title depends on scope */
  if (snapshot.scope === 'all') {
    setPubTitleAccent(t('pub.orgTitle'));
    $('#pubSubtitle').textContent = tReplace('pub.signinAll', { d: PUBLISH_DOMAIN });
    $('#pubHeadTitle').textContent = t('pub.allTitle');
  } else {
    setPubTitleAccent(tReplace('pub.boardTitle', { b: snapshot.boardName }));
    $('#pubSubtitle').textContent = tReplace('pub.signinBoard', { d: PUBLISH_DOMAIN });
    $('#pubHeadTitle').textContent = snapshot.boardName || t('pub.headBoard');
  }
  $('#pubEmail').value = '';
  $('#pubEmail').disabled = false;
  $('#pubEmail').placeholder = 'you@' + PUBLISH_DOMAIN;
  $('#pubCodeWrap').classList.add('hidden');
  $('#pubCode').value = '';
  $('#pubCode').disabled = false;
  $('#pubSendBtn').textContent = t('pub.sendCode');
  $('#pubVerifyBtn').textContent = t('pub.verify');
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

/* stable seed for the access code — the relay config's shareSeed is a
   constant, so a viewer's personal code NEVER changes when the admin
   republishes (republish only changes boards/chart config, not access) */
function pubCodeSeed(snap) {
  return (snap && snap.shareSeed) || 'org';
}

/* Send the access code to the user's email using FormSubmit (free, no backend).
   We NEVER display the code on-screen — it goes only to the recipient's inbox.
   FormSubmit requires a one-time activation email to the recipient address before
   the first delivery; after that each code is emailed automatically. */
async function pubSendCode() {
  const email = $('#pubEmail').value.trim();
  if (!publishEmailOk(email)) {
    $('#pubStatus').textContent = tReplace('pub.invalidEmail', { d: PUBLISH_DOMAIN });
    $('#pubStatus').className = 'error';
    return;
  }
  pubState.email = email;
  pubState.isAdmin = isAdminEmail(email);
  const code = publishCode(pubCodeSeed(pubState.snapshot), email);
  pubState.codeSent = true;

  const btn = $('#pubSendBtn');
  btn.disabled = true;
  btn.textContent = t('auth.sending');
  $('#pubStatus').textContent = tReplace('pub.sending', { email });
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
        ? tReplace('pub.activateFirst', { email })
        : tReplace('pub.deliverFailed', { m: reason });
      $('#pubStatus').className = activating ? 'warn' : 'error';
      $('#pubCodeWrap').classList.remove('hidden');
      $('#pubVerifyBtn').classList.remove('hidden');
      $('#pubMailLink').classList.add('hidden');
      $('#pubSendBtn').textContent = t('pub.resendCode');
      return;
    }
    $('#pubStatus').textContent = tReplace('pub.sentTo', { email });
    $('#pubStatus').className = 'ok';
    $('#pubCodeWrap').classList.remove('hidden');
    $('#pubVerifyBtn').classList.remove('hidden');
    $('#pubMailLink').classList.add('hidden');
    $('#pubSendBtn').textContent = t('pub.resendCode');
  } catch (e) {
    logDiag('warn', 'pubSendCode failed', { email, message: e.message });
    $('#pubStatus').textContent = tReplace('pub.sendFailed', { m: e.message });
    $('#pubStatus').className = 'error';
    $('#pubMailLink').classList.add('hidden');
  } finally {
    btn.disabled = false;
    if (!btn.textContent.startsWith('Resend') && !btn.textContent.startsWith('კოდის ხელახლა')) btn.textContent = t('pub.sendCode');
  }
}

function pubVerifyCode() {
  const entered = $('#pubCode').value.trim();
  const expected = publishCode(pubCodeSeed(pubState.snapshot), pubState.email);
  if (entered === expected) {
    pubState.verified = true;
    pubState.isAdmin = isAdminEmail(pubState.email);
    /* remember the viewer so a refresh skips the login gate */
    pubSaveSession();
    /* success = charts appearing; status line stays reserved for errors */
    pubEnterVerified();
  } else {
    $('#pubStatus').textContent = t('pub.wrongCode');
    $('#pubStatus').className = 'error';
  }
}

/* ── LIVE render engine ─────────────────────────────────────────────
   The publish snapshot only carries the config (which boards, chart defs).
   Every render fetches fresh Jira data through the relay and computes the
   charts on the spot, so viewers always see real-time numbers. */
const _pubBoardCache = new Map();   /* boardId:mode → { rec, ts } per-session memo (30 s) */
const PUB_LIVE_TTL = 30 * 1000;

/* fetch live issues for a board + compute the full chart set.
   mode: 'full' (changelog, for chart views) | 'light' (metrics-only, fast). */
async function pubLoadBoardLive(boardId, mode = 'full') {
  const memoKey = boardId + ':' + mode;
  const memo = _pubBoardCache.get(memoKey);
  if (memo && Date.now() - memo.ts < PUB_LIVE_TTL) {
    /* cache hit: the RAW fetch is memoized, but the chart set is rebuilt with
       the current language (dataset labels/subtitles/empty messages are
       translated at build time — a cached copy would mix languages). */
    return _pubBuildBoardRec(memo.rec, boardId);
  }
  logDiag('info', 'Publish view: fetching live board data', { boardId, mode });
  const rec = await pubFetchBoardLive(boardId, mode);
  _pubBoardCache.set(memoKey, { rec, ts: Date.now() });
  return _pubBuildBoardRec(rec, boardId);
}

/* assemble the render record from a raw fetch result: metrics + freshly
   translated chart data (see pubLoadBoardLive — charts are never cached) */
function _pubBuildBoardRec(rec, boardId) {
  const issues = Array.isArray(rec.issues) ? rec.issues : [];
  const m = computeMetrics(issues);
  rememberDoneStatuses(issues);                       /* learn custom done-status names */
  detectComplexityField(issues);                      /* learn the complexity custom field id */
  const defs = pubState.chartDefs;                    /* snapshot-configured chart defs */
  /* viewer-local per-chart range overrides (own localStorage map, not the
     admin store) — applied at build time so charts re-window instantly */
  const rStore = pubRangeStore();
  const effDefs = defs.map((def) => {
    const o = rStore[def.id];
    return o ? { ...def, ...o } : def;
  });
  const charts = effDefs.map((def) => ({ def, data: buildChartData(def, m, issues, rec.hasChangelog) }));
  return {
    boardId,
    issues,
    metrics: m,
    issuesCount: rec.count ?? issues.length,
    hasChangelog: !!rec.hasChangelog,
    fetchedAt: rec.fetchedAt || Date.now(),
    source: rec.source || '',
    charts,
  };
}

/* destroy any live Chart.js instances before re-rendering a grid */
function destroyPubCharts() {
  if (pubState._liveCharts && pubState._liveCharts.length) {
    for (const c of pubState._liveCharts) { try { c.destroy(); } catch (_) { /* noop */ } }
  }
  pubState._liveCharts = [];
}

/* track charts created inside the publish view so they can be torn down */
function mkPubChart(canvasId, cfg) {
  const ch = mkChart(canvasId, cfg);
  if (ch) pubState._liveCharts.push(ch);
  return ch;
}

/* the chart defs the admin published (with this viewer's local overrides applied
   when the viewer is also connected) — falls back to the built-in set.
   Old snapshots may still reference charts removed from BUILTIN_DEFS (e.g. the
   'unassigned' Assignment Gaps doughnut) — filter those out at render time.
   Custom charts ('c'+base36 ids) always pass through untouched. */
const REMOVED_BUILTIN_IDS = new Set(['unassigned']);
/* the old 'ageDist' (Open Issue Age) builtin was replaced by 'doneByAssignee'
   (Done by Assignee); published snapshots still carry the old def — upgrade it
   in place so every board shows the new chart without re-publishing. */
function upgradedBuiltinDef(id) {
  return id === 'ageDist' ? BUILTIN_DEFS.find((d) => d.id === 'doneByAssignee') : null;
}
function pubChartDefs() {
  return (pubState.snapshot?.chartDefs || [])
    .filter((d) => !REMOVED_BUILTIN_IDS.has(d.id))
    .map((d) => {
      /* upgraded built-ins are spread from the raw BUILTIN_DEFS entry, which does
         NOT carry the builtin flag (effectiveCharts() adds it only in the admin
         app) — without it defTitle()/defSubtitle() skip the i18n maps and render
         the hardcoded English title (the "untranslated chart" bug). */
      const up = d.builtin && upgradedBuiltinDef(d.id);
      return up ? { ...up, builtin: true, scope: 'global' } : { ...d };
    });
}

/* ---------- chart click → issue list modal ---------- */

/* the Jira base URL for issue links: the signed-in connection first, then the
   domain the admin baked into the published snapshot (viewer-only path).
   Last resort: derive the origin from an issue's own `self` API URL
   (covers snapshots published before the domain field existed). */
function jiraIssueBase() {
  /* Jira site origin used to build /browse/KEY links from the issue list modal.
     Chain: the viewer's own connection → the published config's stored domain
     (v2+ snapshots) → a parent 'all' snapshot (board drill-down keeps it). */
  let d = state.conn?.domain || pubState.snapshot?.domain || pubState.allSnapshot?.domain || '';
  d = String(d).trim();
  if (!d) {
    /* derive from any cached issue's self URL: …/rest/api/3/search/... */
    const pools = [state.issues || []];
    if (_pubBoardCache) for (const c of _pubBoardCache.values()) if (c?.rec?.issues?.length) pools.push(c.rec.issues);
    for (const pool of pools) {
      for (const iss of pool) {
        const self = iss?.self || iss?.fields?.self || '';
        const m = String(self).match(/^https:\/\/([a-z0-9.-]+\.atlassian\.net)/i);
        if (m) { d = m[1]; break; }
      }
      if (d) break;
    }
  }
  if (!d) return '';
  return d.startsWith('http') ? d.replace(/\/+$/, '') : 'https://' + d.replace(/^\/+|\/+$/g, '');
}

/* ---------- pub insights (compare view) — also language-sensitive ---------- */

/* resolve issue keys (or issue objects) into display rows, preferring the live
   pool (admin: state.issues · pub: per-board cache) for freshest field data */
function resolveIssueRows(keys) {
  const arr = Array.isArray(keys) ? keys : [];
  const pools = [];
  if (state.issues?.length) pools.push(state.issues);
  if (_pubBoardCache) {
    for (const c of _pubBoardCache.values()) if (c?.rec?.issues?.length) pools.push(c.rec.issues);
  }
  const byKey = new Map();
  for (const pool of pools) {
    for (const iss of pool) if (iss?.key && !byKey.has(iss.key)) byKey.set(iss.key, iss);
  }
  return arr.map((k) => {
    if (k && typeof k === 'object') return normIssueRow(k);   // raw or flat issue
    const iss = byKey.get(k);
    if (iss) return normIssueRow(iss);
    return { key: k, summary: '', status: '', assignee: '', created: null, updated: null };
  });
}

/* flatten a raw Jira issue ({ key, fields: {...} }) into display fields */
function normIssueRow(iss) {
  if (!iss) return { key: '', summary: '', status: '', assignee: '', created: null, updated: null };
  if (iss.fields) {
    return {
      key: iss.key,
      summary: iss.fields.summary || '',
      status: iss.fields.status?.name || '',
      assignee: iss.fields.assignee?.displayName || '',
      created: iss.fields.created ? Date.parse(iss.fields.created) : null,
      updated: iss.fields.updated ? Date.parse(iss.fields.updated) : null,
    };
  }
  return { ...iss };   // already flat
}

function fmtDateLong(v) {
  if (!v) return '—';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function openIssueListModal(chartTitle, pointLabel, keys, seriesLabel) {
  const rows = resolveIssueRows(keys);
  const base = jiraIssueBase();
  $('#issueListTitle').textContent = `${chartTitle}${seriesLabel ? ' — ' + seriesLabel : ''} · ${pointLabel || ''}`;
  $('#issueListSub').textContent = rows.length
    ? `${tReplace('ilist.count', { n: rows.length })}${base ? '' : ' · ' + t('ilist.noLink')}`
    : t('ilist.empty');
  const body = $('#issueListBody');
  body.innerHTML = rows.length
    ? rows.map((r) => {
        const link = base
          ? `<a href="${escapeHtml(base)}/browse/${encodeURIComponent(r.key)}" target="_blank" rel="noopener" title="${t('ilist.openJira')}">${escapeHtml(r.key)}<span class="ilist-ext" aria-hidden="true">↗</span></a>`
          : `<span class="muted">${escapeHtml(r.key)}</span>`;
        return `<tr>
          <td>${link}</td>
          <td>${escapeHtml(r.summary || '—')}</td>
          <td>${escapeHtml(r.status || '—')}</td>
          <td>${r.assignee ? escapeHtml(r.assignee) : `<span class="muted">${escapeHtml(t('ilist.unassigned'))}</span>`}</td>
          <td>${fmtDateLong(r.created)}</td>
          <td>${fmtDateLong(r.updated)}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="6" class="muted">${t('ilist.empty')}</td></tr>`;
  show($('#issueListModal'));
}

/* close wiring for the issue list modal (called from the DOMContentLoaded init) */
function wireIssueListModal() {
  $('#closeIssueListBtn').addEventListener('click', () => hide($('#issueListModal')));
  $('#issueListModal').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) hide($('#issueListModal')); });
}

/* ---------- single-board view: KPI stat boxes + live task list ---------- */

/* the six admin-style KPI cards, rendered for the public board view from the
   live board metrics (same data, same layout, same i18n keys as the admin app) */
function pubBoardKpiHtml() {
  const card = (icon, color, labelKey, valId, subId) => `
    <div class="kpi glass">
      <div class="kpi-top"><span class="kpi-icon ic-${color}">${icon}</span><span class="kpi-label" data-i18n="${labelKey}">${escapeHtml(t(labelKey))}</span></div>
      <div class="kpi-value" id="${valId}">…</div>
      <div class="kpi-sub muted" id="${subId}"></div>
    </div>`;
  return [
    card('▦', 'indigo', 'kpi.total', 'pkpiTotal', 'pkpiTotalSub'),
    card('＋', 'cyan', 'kpi.created', 'pkpiCreated', 'pkpiCreatedSub'),
    card('✓', 'green', 'kpi.done', 'pkpiDone', 'pkpiDoneSub'),
    card('↻', 'green', 'kpi.resolved', 'pkpiResolved', 'pkpiResolvedSub'),
    card('⏱', 'violet', 'kpi.cycle', 'pkpiCycle', 'pkpiCycleSub'),
    card('◔', 'amber', 'kpi.wip', 'pkpiWip', 'pkpiWipSub'),
  ].join('');
}

/* fill the public board KPI boxes from live metrics (mirror of renderDashboard) */
function fillPubBoardKpis(m) {
  animateValue($('#pkpiTotal'), m.total);
  $('#pkpiTotalSub').textContent = t('dash.issuesOnBoard');
  animateValue($('#pkpiCreated'), m.created30);
  $('#pkpiCreatedSub').innerHTML = trendBadge(m.createdPrev30, m.created30, t('dash.vsPrior30d'), 'neutral');
  animateValue($('#pkpiDone'), m.done);
  $('#pkpiDoneSub').textContent = tReplace('dash.completionRate', { p: m.doneRate });
  animateValue($('#pkpiResolved'), m.resolved30);
  $('#pkpiResolvedSub').innerHTML = trendBadge(m.resolvedPrev30, m.resolved30, t('dash.vsPrior30d'), 'up-good');
  $('#pkpiCycle').textContent = m.cycleAvg != null ? fmtDuration(m.cycleAvg) : '—';
  $('#pkpiCycle').classList.toggle('muted', m.cycleAvg == null);
  if (m.cycleRecentAvg != null && m.cyclePrevAvg != null) {
    const d = pctDelta(m.cyclePrevAvg, m.cycleRecentAvg);
    $('#pkpiCycleSub').innerHTML = d === null
      ? `<span class="muted">${escapeHtml(t('dash.createResolve'))}</span>`
      : `<span class="trend ${d <= 0 ? 'trend-good' : 'trend-bad'}">${d <= 0 ? '▼' : '▲'} ${Math.abs(d)}%</span> <span class="muted">${escapeHtml(d <= 0 ? tReplace('dash.fasterThan', { p: Math.abs(d) }) : tReplace('dash.slowerThan', { p: Math.abs(d) }))}</span>`;
  } else {
    $('#pkpiCycleSub').innerHTML = `<span class="muted">${escapeHtml(t('dash.createResolve'))}</span>`;
  }
  animateValue($('#pkpiWip'), m.wip);
}

/* live task list state — reset whenever the viewer switches to another board */
function pubTaskListState(boardId) {
  if (!pubState.tl || pubState.tl.boardId !== boardId) {
    pubState.tl = { boardId, sort: 'updated-desc', assignee: '', status: '', type: '', q: '' };
  }
  return pubState.tl;
}

/* filter bar: sort (last/oldest updated), assignee, status, type + free-text search */
function pubTaskListFilters(issues, st) {
  const uniq = (arr) => Array.from(new Set(arr)).filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const assignees = uniq(issues.map((i) => i.fields?.assignee?.displayName || ''));
  const statuses = uniq(issues.map((i) => i.fields?.status?.name || ''));
  const types = uniq(issues.map((i) => i.fields?.issuetype?.name || ''));
  const opt = (v, label, sel) => `<option value="${escapeHtml(v)}"${sel ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const sel = (id, arr, cur) => `
    <select class="tl-select" id="${id}" title="${escapeHtml(t('tl.filterTitle'))}">
      ${opt('', t('tl.any'), !cur)}
      ${arr.map((v) => opt(v, v, cur === v)).join('')}
    </select>`;
  return `
    <select class="tl-select" id="tlSort" title="${escapeHtml(t('tl.sortTitle'))}">
      <option value="updated-desc"${st.sort === 'updated-desc' ? ' selected' : ''}>${escapeHtml(t('tl.sortLast'))}</option>
      <option value="updated-asc"${st.sort === 'updated-asc' ? ' selected' : ''}>${escapeHtml(t('tl.sortOldest'))}</option>
    </select>
    ${sel('tlAssignee', assignees, st.assignee)}
    ${sel('tlStatus', statuses, st.status)}
    ${sel('tlType', types, st.type)}
    <input id="tlSearch" class="tl-search" type="search" placeholder="${escapeHtml(t('tl.searchPh'))}" value="${escapeHtml(st.q)}" />`;
}

/* apply the active filters + sort to the board's issues */
function pubTaskListFiltered(issues) {
  const st = pubState.tl;
  const q = String(st.q || '').trim().toLowerCase();
  const rows = issues.filter((i) => {
    const f = i.fields || {};
    const assignee = f.assignee?.displayName || '';
    const status = f.status?.name || '';
    const type = f.issuetype?.name || '';
    if (st.assignee && assignee !== st.assignee) return false;
    if (st.status && status !== st.status) return false;
    if (st.type && type !== st.type) return false;
    if (q) {
      const hay = `${i.key || ''} ${f.summary || ''} ${assignee} ${status} ${type}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const ts = (i) => Date.parse(i.fields?.updated || '') || 0;
  rows.sort((a, b) => (st.sort === 'updated-asc' ? ts(a) - ts(b) : ts(b) - ts(a)));
  return rows;
}

/* table rows for the filtered task list (capped so huge boards stay snappy) */
function pubTaskListRows(issues) {
  const MAX = 50;
  const all = pubTaskListFiltered(issues);
  const rows = all.slice(0, MAX);
  const base = jiraIssueBase();
  const html = rows.map((i) => {
    const f = i.fields || {};
    const assignee = f.assignee?.displayName || '';
    const link = base
      ? `<a href="${escapeHtml(base)}/browse/${encodeURIComponent(i.key)}" target="_blank" rel="noopener" title="${t('ilist.openJira')}">${escapeHtml(i.key)}<span class="ilist-ext" aria-hidden="true">↗</span></a>`
      : `<span class="muted">${escapeHtml(i.key)}</span>`;
    return `<tr>
      <td>${link}</td>
      <td>${escapeHtml(f.summary || '—')}</td>
      <td><span class="status-pill">${escapeHtml(f.status?.name || '—')}</span></td>
      <td class="muted">${fmtDateLong(f.updated)}</td>
      <td><span class="type-chip">${escapeHtml(f.issuetype?.name || '—')}</span></td>
      <td class="muted">${assignee ? escapeHtml(assignee) : `<span class="muted">${escapeHtml(t('ilist.unassigned'))}</span>`}</td>
      <td class="muted">${fmtDateLong(f.created)}</td>
    </tr>`;
  }).join('');
  return html || `<tr><td colspan="7" class="muted" style="text-align:center;padding:22px">${escapeHtml(t('tl.empty'))}</td></tr>`;
}

function updatePubTlCount(issues) {
  const el = $('#tlCount');
  if (el) el.textContent = tReplace('tl.count', { n: pubTaskListFiltered(issues).length });
}

/* render + wire the task list card for the current board */
function renderPubTaskList(issues) {
  const st = pubTaskListState(pubState.snapshot?.boardId);
  const bar = $('#pubTlFilterBar');
  bar.innerHTML = pubTaskListFilters(issues, st) + `<span class="tl-count muted" id="tlCount"></span>`;
  const rerenderRows = () => {
    $('#pubTlBody').innerHTML = pubTaskListRows(issues);
    updatePubTlCount(issues);
  };
  $('#tlSort').addEventListener('change', (e) => { st.sort = e.target.value; rerenderRows(); });
  [['tlAssignee', 'assignee'], ['tlStatus', 'status'], ['tlType', 'type']].forEach(([id, k]) => {
    $('#' + id).addEventListener('change', (e) => { st[k] = e.target.value; rerenderRows(); });
  });
  let deb;
  $('#tlSearch').addEventListener('input', (e) => {
    clearTimeout(deb);
    deb = setTimeout(() => { st.q = e.target.value; rerenderRows(); }, 250);
  });
  rerenderRows();
}

/* hero title with a gradient-accented trailing word — the last word (or the
   part after the last '·') gets the indigo→cyan gradient, echoing the brand */
function setPubTitleAccent(text) {
  const el = $('#pubTitle');
  const s = String(text || '');
  const m = s.match(/^(.*?)(\S+)$/);   /* last word */
  if (m && m[1]) el.innerHTML = escapeHtml(m[1]) + '<span class="grad-accent">' + escapeHtml(m[2]) + '</span>';
  else el.textContent = s;
}

/* live badge with a pulsing dot — replaces the static ⟳ glyph */
function setPubLiveBadge(text) {
  const el = $('#pubChangelogBadge');
  el.innerHTML = '<span class="live-dot" aria-hidden="true"></span>' + escapeHtml(text);
}

async function renderPubContent() {
  const snap = pubState.snapshot;
  if (!snap) return;
  /* an active compare view owns the whole pub content area — re-render it
     (this also covers setLang re-renders while comparing) */
  if (pubState.compare) { renderPubCompareView(); return; }
  /* keep the topbar identity chip + org badge in sync on every render */
  updatePubUserChip();
  const orgBadge = $('#pubOrgBadge');
  if (orgBadge) orgBadge.textContent = String(state.conn?.domain || PUBLISH_DOMAIN).replace(/^https?:\/\//, '').split('.')[0] || 'Org';
  /* admin powers on the public share view are granted ONLY when inside the /admin/
     panel. On the public app the admin account is treated like any org member, so it
     can test the exact user experience (no admin bar, no manage/publish button). */
  const admin = pubState.isAdmin && ADMIN_PANEL;

  /* admin bar — visible only to the admin INSIDE the admin panel */
  const adminBar = $('#pubAdminBar');
  if (admin) {
    adminBar.classList.remove('hidden');
    $('#pubAdminText').textContent = tReplace('pub.signedInAdmin', { e: pubState.email });
    $('#pubManageBtn').style.display = '';
  } else {
    adminBar.classList.add('hidden');
  }

  /* admin share-link box — only visible to admin once they're inside a board view */
  const linkBox = $('#pubLinkBox');
  if (admin && snap.scope === 'board') {
    $('#pubLinkInput').value = location.origin + publicRootPath() + '?share=' + encodeURIComponent(snap.shareSeed || 'org');
    linkBox.classList.remove('hidden');
  } else {
    linkBox.classList.add('hidden');
  }

  /* title/subtitle — data is LIVE now, so the subtitle reflects freshness, not a date.
     The topbar center title mirrors the admin app's "All boards" header. */
  if (snap.scope === 'all') {
    setPubTitleAccent(t('pub.orgTitle'));
    $('#pubSubtitle').textContent = t('pub.orgSubtitle');
    $('#pubHeadTitle').textContent = t('pub.allTitle');
  } else {
    setPubTitleAccent(snap.boardName || 'Board');
    $('#pubSubtitle').textContent = t('pub.liveSubtitle');
    $('#pubHeadTitle').textContent = snap.boardName || 'Board';
  }

  setPubLiveBadge(t('pub.liveBadge'));
  $('#pubChangelogBadge').className = 'data-badge ok';

  /* Back button: hidden on the main all-boards page (nothing to go back to);
     shown on every sub-page — single board, drilled-in board, pick mode.
     The compare view manages its own visibility in renderPubCompareView(). */
  const pubBackBtn = $('#pubBackBtn');
  if (pubBackBtn) {
    const onMainPage = snap.scope === 'all' && !pubState.pickCompare;
    pubBackBtn.classList.toggle('hidden', onMainPage);
    /* label follows the drill-in state so language switches stay in sync */
    if (!onMainPage) pubBackBtn.textContent = pubBackBtn.dataset.fromAll === '1' ? t('pub.backAll') : t('pub.back');
  }

  /* compare button in the pub header — available to EVERY viewer on the
     all-boards view (feature 1: compare for users, not only admins) */
  const pubCmpBtn = $('#pubCompareBtn');
  if (pubCmpBtn) pubCmpBtn.classList.toggle('hidden', snap.scope !== 'all');
  /* pick mode body class drives card hover/label styling (shared CSS) */
  document.body.classList.toggle('pick-mode', !!pubState.pickCompare);

  const boardsList = $('#pubBoardsList');
  const chartsGrid = $('#pubChartsGrid');
  destroyPubCharts();

  pubState.chartDefs = pubChartDefs();

  if (snap.scope === 'all') {
    /* ── all-boards view: one LIVE stats summary per board ── */
    chartsGrid.classList.add('hidden');
    boardsList.classList.remove('hidden');
    /* board-scoped KPI boxes + task list only belong to the single-board view */
    $('#pubBoardKpis').classList.add('hidden');
    $('#pubBoardKpis').innerHTML = '';
    $('#pubTaskListCard').classList.add('hidden');
    $('#pubTlBody').innerHTML = '';
    const boards = snap.boards || [];
    if (!boards.length) {
      boardsList.innerHTML = '<div class="card glass chart-card wide" style="text-align:center;padding:34px;color:var(--muted)">' + escapeHtml(t('pub.noBoardsPublished')) + '</div>';
      $('#pubIssueCount').textContent = t('pub.zeroBoards');
      return;
    }
    $('#pubIssueCount').textContent = tReplace('pub.nBoards', { n: boards.length });
    /* SAME card design as the admin all-boards view: gradient avatar + type chips,
       4-up metric grid, done% bar, health pill — the share view is the admin view
       minus admin-only chrome. Stats arrive live (4 in parallel) and each card
       updates in place, exactly like the admin page. */
    const pubCard = (b, i) => {
      const initial = escapeHtml((b.name || '?').trim().charAt(0).toUpperCase());
      const pBoard = /^\[P\]/i.test(b.projectName || '') || /^\[P\]/i.test(b.name || '');
      /* pick-compare mode: cards become selectable slots (A/B) instead of links */
      const pick = pubState.pickCompare;
      const pickedA = pick && pick.a === b.boardId;
      const pickedB = pick && pick.b === b.boardId;
      const pickedC = pick && pick.c === b.boardId;
      const picked = pickedA || pickedB || pickedC;
      const openLabel = pick
        ? (picked
          ? tReplace('cmp.pubSelectedAs', { s: pickedA ? 'A' : pickedB ? 'B' : 'C' })
          : (pick.a == null ? t('cmp.pubClickPickA') : pick.b == null ? t('cmp.pubClickPickB') : t('cmp.pubClickPickC')))
        : t('card.openDash');
      return `
        <div class="board-card glass${pBoard ? ' p-board' : ''}${picked ? ' pick-sel' : ''}${pickedA ? ' pick-a' : ''}${pickedB ? ' pick-b' : ''}${pickedC ? ' pick-c' : ''}" data-bid="${b.boardId}" style="animation-delay:${Math.min(i * 35, 400)}ms">
          <div class="board-card-head">
            <div class="board-avatar" aria-hidden="true">${initial}</div>
            <div class="board-id-block">
              <h3 title="${escapeHtml(b.name)}">${escapeHtml(b.name)}</h3>
              <div class="board-meta">
                ${!pBoard && b.projectName ? `<span class="chip" title="${escapeHtml(b.projectName)}">${escapeHtml(b.projectName)}</span>` : ''}
              </div>
            </div>
            ${pBoard ? '<span class="chip chip-p board-p-flag" title="[P]">[P]</span>' : ''}
            <div class="board-head-side">
              ${admin ? `<button class="link-btn board-copy-link" data-copyboard="${b.boardId}" data-i18n-title="pub.copyBoardLink" title="${escapeHtml(t('card.copyLinkTitle'))}" aria-label="${escapeHtml(t('card.copyLinkTitle'))}">🔗</button>` : ''}
            </div>
          </div>
          <div class="board-stats" id="pubbstats_${b.boardId}">${boardStatsChipHtml(null)}</div>
          <div class="board-card-foot">
            <span class="board-open">${escapeHtml(openLabel)}</span>
            ${b.projectName ? `<span class="board-proj muted" title="${escapeHtml(b.projectName)}">${escapeHtml(b.projectName)}</span>` : ''}
          </div>
        </div>`;
    };
    const P = boards.filter((b) => /^\[P\]/i.test(b.name || '') || /^\[P\]/i.test(b.projectName || ''));
    const others = boards.filter((b) => !(/^\[P\]/i.test(b.name || '') || /^\[P\]/i.test(b.projectName || '')));
    let html = '';
    if (P.length) html += `<div class="board-group"><span class="board-group-title">${escapeHtml(t('card.orgBoards'))}</span><div class="boards-grid">${P.map(pubCard).join('')}</div></div>`;
    if (others.length) html += `<div class="board-group"><span class="board-group-title">${escapeHtml(t('card.otherBoards'))}</span><div class="boards-grid">${others.map(pubCard).join('')}</div></div>`;
    boardsList.className = '';
    boardsList.innerHTML = html;

    boardsList.querySelectorAll('.board-card .board-copy-link').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const link = location.origin + publicRootPath() + '?share=' + encodeURIComponent(snap.shareSeed || 'org');
        navigator.clipboard.writeText(link).then(() => toast(t('pub.boardCopied'), 'ok')).catch(() => toast(t('toast.copyFail'), 'warn'));
      });
    });
    boardsList.querySelectorAll('.board-card').forEach((card) => {
      card.addEventListener('click', () => {
        const bid = parseInt(card.dataset.bid, 10);
        const b = boards.find((x) => x.boardId === bid);
        if (!b) return;
        /* pick-compare mode: cards fill the A/B slots instead of opening */
        if (pubState.pickCompare) { togglePubPickCompare(b); return; }
        openBoardSnapshot(b);
      });
    });

    /* fetch every board's live stats in parallel (4 at a time; light mode =
       fast, no changelog) and update the cards in place as each result lands */
    const PUB_CONCURRENCY = 4;
    let pubCursor = 0;
    const pubWorker = async () => {
      while (pubCursor < boards.length) {
        const b = boards[pubCursor++];
        try {
          const rec = await pubLoadBoardLive(b.boardId, 'light');
          const m = rec.metrics;
          const box = document.getElementById('pubbstats_' + b.boardId);
          if (box) box.innerHTML = boardStatsChipHtml({
            ts: Date.now(),
            total: m.total, done: m.done, wip: m.wip,
            doneRate: m.doneRate, cycleAvg: m.cycleAvg,
            created30: m.created30, resolved30: m.resolved30,
            blocked: m.blockedCount,
          });
        } catch (e) {
          logDiag('warn', 'Publish all-boards: live stats failed', { boardId: b.boardId, message: e?.message });
          const box = document.getElementById('pubbstats_' + b.boardId);
          if (box) box.innerHTML = `<span class="bstat bstat-skip">${escapeHtml(t('pub.liveUnavailable'))}</span>`;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PUB_CONCURRENCY, boards.length) }, pubWorker));
  } else {
    /* ── single-board view: fetch LIVE issues, then render the charts ── */
    boardsList.classList.add('hidden');
    chartsGrid.classList.remove('hidden');
    const grid = chartsGrid;
    const defs = pubState.chartDefs;
    if (!snap.boardId) {
      grid.innerHTML = `<div class="card glass chart-card wide" style="text-align:center;padding:34px;color:var(--muted)">${escapeHtml(t('pub.noBoardSelected'))}</div>`;
      return;
    }
    grid.innerHTML = `<div class="card glass chart-card wide" style="text-align:center;padding:34px;color:var(--muted)"><span class="spinner spinner-sm"></span> ${escapeHtml(t('pub.loadingLive'))}</div>`;
    let rec;
    try {
      rec = await pubLoadBoardLive(snap.boardId);
    } catch (e) {
      logDiag('warn', 'Publish board view: live fetch failed', { boardId: snap.boardId, message: e?.message });
      grid.innerHTML = `<div class="card glass chart-card wide" style="text-align:center;padding:34px;color:var(--muted)">⚠ ${escapeHtml(tReplace('pub.loadFailed', { m: e?.message || t('err.generic') }))}</div>`;
      return;
    }
    const charts = rec.charts;
    $('#pubIssueCount').textContent = tReplace('pub.nIssues', { n: rec.issuesCount });
    $('#pubChangelogBadge').textContent = rec.hasChangelog ? t('badge.changelog') : t('badge.noChangelog');
    $('#pubChangelogBadge').className = 'data-badge ' + (rec.hasChangelog ? 'ok' : 'missing');

    /* KPI stat boxes — same six cards as the admin dashboard, from live metrics */
    const kpiWrap = $('#pubBoardKpis');
    kpiWrap.innerHTML = pubBoardKpiHtml();
    kpiWrap.classList.remove('hidden');
    applyI18n(kpiWrap);
    fillPubBoardKpis(rec.metrics || {});

    /* live task list under the charts (last-updated sort + filters + search) */
    const tlCard = $('#pubTaskListCard');
    tlCard.classList.remove('hidden');
    applyI18n(tlCard);
    renderPubTaskList(rec.issues || []);

    if (!charts.length) {
      grid.innerHTML = `<div class="card glass chart-card wide" style="text-align:center;padding:34px;color:var(--muted)">${escapeHtml(t('pub.noCharts'))}</div>`;
      return;
    }
    grid.innerHTML = charts.map((c) => chartCardHTML(c.def, false)).join('');
    /* viewer-side per-chart time-range dropdowns */
    wireChartRangeControls(grid, charts.map((c) => c.def));
    const theme = chartTheme();
    for (const c of charts) {
      const def = c.def;
      const data = c.data;
      const canvasId = 'chart_' + def.id;
      if (!data || data.empty) {
        drawCanvasMessage(canvasId, Array.isArray(data?.empty) ? data.empty : [data ? data.empty : t('cmp.noData')]);
        continue;
      }
      mkPubChart(canvasId, chartConfigFor(def, data, theme, canvasId));
    }
  }
}

/* helper: when viewing an 'all' snapshot and a viewer clicks a board, show that board's LIVE charts */
function openBoardSnapshot(boardRec) {
  const snap = pubState.snapshot;
  pubState.currentBoard = boardRec;
  pubState.allSnapshot = snap;   /* remember parent for Back */
  const sub = {
    shareSeed: snap.shareSeed || 'org',
    boardId: boardRec.boardId,
    boardName: boardRec.name,
    scope: 'board',
    createdAt: snap.createdAt,
    chartDefs: snap.chartDefs || pubState.chartDefs || [],
    domain: snap.domain || '',
  };
  pubState.snapshot = sub;
  $('#pubBackBtn').dataset.fromAll = '1';   /* set BEFORE render so the label logic sees it */
  pubSaveSession({ boardId: boardRec.boardId });   /* remember the board for refresh */
  renderPubContent();
  $('#pubBackBtn').textContent = t('pub.backAll');
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
   API-token form. Fetch the published board CONFIG from the relay (shared by
   every device) and show the org sign-in gate (Google 1-click / email code).
   Data itself is fetched live at render time.
   `restore = true` → a persisted viewer session exists: skip the gate and go
   straight back to the board the viewer was on before the refresh. */
async function showPublicLanding(restore = false) {
  const cfg = await pubConfigGet();
  const boards = (cfg && Array.isArray(cfg.boards)) ? cfg.boards : [];
  const snapshot = {
    shareSeed: (cfg && cfg.shareSeed) || 'org',
    boardId: null,
    boardName: 'All boards',
    scope: 'all',
    createdAt: (cfg && cfg.savedAt) || Date.now(),
    chartDefs: (cfg && cfg.chartDefs) || [],
    boards,
    domain: (cfg && cfg.domain) || '',
  };
  /* restore the persisted viewer session (refresh keeps you signed in) */
  const sess = restore ? pubRestoreSession() : null;
  if (sess) {
    pubState.email = sess.email;
    pubState.verified = true;
    pubState.isAdmin = false;   /* the public app never grants admin powers */
    pubState.snapshot = snapshot;
    pubEnterVerified();
    /* land on the same board the viewer was reading (if it still exists) */
    if (sess.boardId) {
      const b = boards.find((x) => x.boardId === sess.boardId);
      if (b) { openBoardSnapshot(b); return; }
    }
    return;
  }
  showPubScreen(snapshot);
}

/* ── publish modal (admin only) ───────────────────────────────────────
   Publishing saves the CONFIG to the relay (which boards + chart defs) —
   instant, zero Jira calls. Data is ALWAYS live for viewers, so there is
   no "data refresh" step to repeat; republish only when the layout changes. */
let pubModalState = { mode: 'all' /* 'all' | 'board' */, boardId: null };

function shareLink() {
  return location.origin + publicRootPath() + '?share=org';
}

async function openPublishModal() {
  const connected = !!(state.conn && state.boards.length);

  /* hide the "create" area when not connected (admins can still copy the link) */
  const createWrap = $('#pubCreateWrap');
  if (createWrap) createWrap.style.display = connected ? '' : 'none';

  if (connected) {
    $('#pubBoardSelect').innerHTML = state.boards.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  }

  $('#pubModalTitle').textContent = connected ? t('pub.cfgTitle') : t('pub.cfgOnlyTitle');
  const cfg = await pubConfigGet();
  const cfgBoardCount = cfg && Array.isArray(cfg.boards) ? cfg.boards.length : 0;
  const savedAt = cfg && cfg.savedAt ? new Date(cfg.savedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : null;
  $('#pubListBody').innerHTML =
    `<tr>
      <td colspan="4" style="padding:10px 6px">
        ${cfg
          ? `<div>${tReplace('pub.currentlyPublished', { n: cfgBoardCount, saved: savedAt ? tReplace('pub.savedAt', { s: escapeHtml(savedAt) }) : '' })}</div>
             <div class="muted" style="margin-top:4px">${t('pub.viewerLiveNote')}</div>`
          : `<div class="muted">${t('pub.nothingPublished')}</div>`}
      </td>
      <td style="text-align:right;white-space:nowrap">
        <button class="link-btn" data-copyorg="">${escapeHtml(t('pub.copyViewerLink'))}</button>
        ${cfg ? `<button class="link-btn" data-unpub="" style="color:#f87171">${escapeHtml(t('pub.unpublishBtn'))}</button>` : ''}
      </td>
    </tr>`;

  $('#pubListBody').querySelectorAll('[data-copyorg]').forEach((b) => {
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(shareLink()).then(() => toast(t('pub.viewerCopied'), 'ok')).catch(() => toast(t('toast.copyFail'), 'warn'));
    });
  });
  $('#pubListBody').querySelectorAll('[data-unpub]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm(t('confirm.unpublish'))) return;
      try { await pubCmd('publish:clear', { method: 'POST', admin: true }); toast(t('pub.unpublished'), 'ok'); }
      catch (e) { toast(tReplace('pub.unpublishFailed', { m: e?.message || 'unknown' }), 'warn'); }
      openPublishModal();
    });
  });

  $('#pubCreateBtn').textContent = connected ? t('pub.publishToOrg') : t('pub.publishToOrg');
  show($('#pubModal'));
}

/* publish (or republish) the config: which boards + which chart defs.
   Also stores the admin's Jira creds once, so viewers WITHOUT their own
   connection still get live data through the relay. Instant — no per-board
   Jira fetching, nothing to wait for. */
async function createSnapshotFromModal() {
  const scope = $('#pubScope').querySelector('button.active').dataset.v;
  const boardId = scope === 'all' ? null : parseInt($('#pubBoardSelect').value, 10);
  if (scope === 'board' && !boardId) { toast(t('pub.selectBoard'), 'warn'); return; }

  /* pick the board set: every board for 'all', or just one board */
  const boards = scope === 'all' ? state.boards : state.boards.filter((b) => b.id === boardId);
  if (!boards.length) { toast(t('pub.noBoards'), 'warn'); return; }

  /* chart config = the current admin layout (built-ins incl. overrides + customs).
     Uses the board context of the FIRST published board so board-scoped custom
     charts survive; the defs are shared across all boards in this version. */
  const prevBoardId = state.boardId;
  state.boardId = boards[0].id;
  const defs = effectiveCharts().map((d) => ({ ...d }));
  state.boardId = prevBoardId;

  const config = {
    version: 2,
    shareSeed: 'org',
    savedAt: Date.now(),
    domain: state.conn?.domain || '',
    chartDefs: defs,
    boards: boards.map((b) => ({ boardId: b.id, name: b.name, projectName: b.location?.projectName || '' })),
  };

  const btn = $('#pubCreateBtn');
  btn.disabled = true;
  btn.textContent = t('pub.publishing');
  try {
    await pubConfigSet(config);
    /* store admin creds once (best-effort — viewers with their own Jira sign-in
       never need them, but this keeps the viewer-only path working too) */
    try { await pubCredsSet(state.conn); } catch (e) { logDiag('warn', 'creds:set failed', { message: e?.message }); }
    navigator.clipboard.writeText(shareLink()).then(() =>
      toast(t('pub.publishedLive'), 'ok')
    ).catch(() => toast(t('pub.publishedNext'), 'ok'));
    hide($('#pubModal'));
    openPublishModal();
  } catch (e) {
    toast(tReplace('pub.publishFailed', { m: e?.message || 'unknown error' }), 'warn');
  } finally {
    btn.disabled = false;
    btn.textContent = t('pub.publishToOrg');
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
  ctx.fillStyle = themeColors().emptyMsg;
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
  /* Clicking the logo must ALWAYS land on the all-boards view. The list is
     already on screen, so a failed refresh (e.g. an expired Jira session
     answering 401/403) must never yank the user to the login/setup screen —
     just toast the error and keep the cached cards. The login gate only
     appears when there is genuinely nothing to show (no boards loaded). */
  loadBoards({ autoOpenLast: false }).catch((e) => {
    if (state.boards.length) {
      logDiag('warn', 'Boards refresh failed — keeping the loaded list', { message: e?.message, status: e?.status });
      toast(e?.message || t('err.generic'), 'err');
    } else {
      handleAuthError(e);
    }
  });
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
    /* master [P] board deep link (#/board/900000001): boards must be loaded
       first so the merged pool knows which [P] boards to fetch */
    if (bid === MASTER_P_ID) {
      loadBoards({ autoOpenLast: false }).then(() => openBoard(masterPBoard())).catch((e) => handleAuthError(e));
      return;
    }
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
    toast(tReplace('auth.sessionRejected', { s: e.status }), 'err');
  } else {
    toast(e?.message || t('err.generic'), 'err');
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
  toast(tReplace('connect.ok', { domain: domain.replace('https://', '') }) + ' 🎉', 'ok');
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
   localStorage for 30 minutes, and enriched 4 boards at a time in the
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
  /* FAST PATH: the publish relay computes the identical metric set server-side
     in ONE call (same fields incl. resolutiondate → same cycle-time quality;
     only the unused changelog weight is skipped for light mode). This collapses
     ~10-15 client round-trips per board into 1. Falls back to the original
     direct-Jira path when the relay is unreachable or returns no data. */
  try {
    const rec = await pubFetchBoardLive(board.id, 'light');
    if (rec && Array.isArray(rec.issues) && rec.issues.length) {
      const m = computeMetrics(rec.issues);
      rememberDoneStatuses(rec.issues);
      return {
        ts: Date.now(),
        total: m.total, done: m.done, wip: m.wip,
        doneRate: m.doneRate, cycleAvg: m.cycleAvg,
        created30: m.created30, resolved30: m.resolved30,
        blocked: m.blockedCount,
      };
    }
  } catch (e) {
    logDiag('warn', 'Board stats relay fast path failed — falling back to direct Jira', { boardId: board.id, status: e?.status, message: e?.message });
  }

  /* SLOW PATH (fallback): resolve the board's projects/filter directly and page
     the issues through the user's own Jira connection. */
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
    blocked: m.blockedCount,
  };
}

/* background loop: fetch stats for boards that have none/fresh — 4 boards in
   parallel, updating cards in place as each result lands. Concurrency is capped
   so the relay/Jira are not hammered and rate limits stay far away. */
const BSTATS_CONCURRENCY = 4;

async function enrichBoardStats() {
  if (_bstatsRunning || !state.conn) return;
  _bstatsRunning = true;
  const pending = state.boards.filter((b) => !cachedBoardStats(b.id) && !_bstatsInflight.has(b.id));
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const b = pending[cursor++];
      _bstatsInflight.add(b.id);
      try {
        const rec = await fetchBoardStats(b);
        if (rec) { saveBoardStats(b.id, rec); updateBoardStatsDom(b.id, rec); }
        else updateBoardStatsDom(b.id, null);
      } finally {
        _bstatsInflight.delete(b.id);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(BSTATS_CONCURRENCY, pending.length) }, worker));
  } finally {
    _bstatsRunning = false;
    /* the master [P] card aggregates every [P] board's stats — refresh it once
       the last per-board enrichment lands so it flips from pending to live */
    if (state.boards.some(isPBoard)) {
      const mRec = masterPStats();
      if (mRec) updateBoardStatsDom(MASTER_P_ID, mRec);
    }
  }
}

/* one-line health verdict derived from the board's own numbers.
   Blocked/canceled work is informational (amber, quiet) — not an alarm. */
function boardHealth(rec) {
  if (!rec) return null;
  const blocked = rec.blocked || 0;
  const net = (rec.resolved30 || 0) - (rec.created30 || 0);
  if (blocked > 0) return { cls: 'hl-info', icon: '⏸', label: `${blocked} blocked · ${rec.wip} active` };
  if ((rec.total || 0) > 0 && (rec.wip || 0) === 0) return { cls: 'hl-good', icon: '✓', label: 'All clear — nothing in progress' };
  if (net <= -3) return { cls: 'hl-warn', icon: '↓', label: 'Backlog growing' };
  if (net >= 3) return { cls: 'hl-good', icon: '↑', label: 'Strong outflow' };
  return { cls: 'hl-neutral', icon: '◈', label: 'Steady flow' };
}

/* health label resolved through i18n at render time (labels stay stable in the record) */
function boardHealthLabel(h) {
  if (!h) return '';
  if (h.cls === 'hl-info') return tReplace('hl.blocked', { b: (h.label.match(/^(\d+)/) || [0, 0])[1] });
  if (h.cls === 'hl-good' && h.icon === '✓') return t('hl.allClear');
  if (h.cls === 'hl-warn') return t('hl.backlogGrowing');
  if (h.cls === 'hl-good') return t('hl.strongOutflow');
  return t('hl.steadyFlow');
}

/* card stats body: compact 3-stat grid + slim progress bar + one quiet info line.
   (loading pill keeps the `bstat` class so placeholder state is testable) */
function boardStatsChipHtml(rec) {
  if (!rec) return `<span class="bstat bstat-pending"><span class="spinner spinner-sm"></span> ${escapeHtml(t('bc.measuring'))}</span>`;
  const net = (rec.resolved30 || 0) - (rec.created30 || 0);
  const netCls = net > 0 ? 'bc-pos' : net < 0 ? 'bc-neg' : '';
  const netTxt = net > 0 ? `+${net}` : String(net);
  const pct = Math.max(0, Math.min(100, rec.doneRate || 0));
  const h = boardHealth(rec);
  return `
    <div class="bc-grid">
      <div class="bc-stat bstat" title="${escapeHtml(t('bc.newTitle'))}"><span class="bc-v">${rec.created30 || 0}</span><span class="bc-l">${escapeHtml(t('bc.new30'))}</span></div>
      <div class="bc-stat bstat" title="${escapeHtml(t('bc.wipTitle'))}"><span class="bc-v">${rec.wip}</span><span class="bc-l">${escapeHtml(t('bc.active'))}</span></div>
      <div class="bc-stat bstat ${netCls}" title="${escapeHtml(t('bc.netTitle'))}"><span class="bc-v">${netTxt}</span><span class="bc-l">${escapeHtml(t('bc.net30d'))}</span></div>
    </div>
    <div class="bc-bar" title="${pct}% ${escapeHtml(t('bc.done'))}">
      <i style="width:${pct}%"></i>
      <span class="bc-bar-txt">${pct}% ${escapeHtml(t('bc.done'))}</span>
    </div>
    ${h ? `<div class="bc-health ${h.cls}"><span class="bc-hi">${h.icon}</span>${escapeHtml(boardHealthLabel(h))}</div>` : ''}`;
}

/* update one card's stats row in place (cards animate in — never re-render the grid) */
function updateBoardStatsDom(boardId, rec) {
  const box = document.getElementById('bstats_' + boardId);
  if (box) box.innerHTML = rec ? boardStatsChipHtml(rec) : `<span class="bstat bstat-skip">${escapeHtml(t('bc.unavailable'))}</span>`;
}

/* aggregate card stats for the master [P] board: the cached per-board records
   of every [P] board, summed. Renders instantly from cache; refreshes to live
   values once every [P] board's own enrichment has completed. */
function masterPStats() {
  const pBoards = state.boards.filter(isPBoard);
  const recs = pBoards.map((b) => cachedBoardStats(b.id));
  if (!recs.length || recs.some((r) => !r)) return null;
  const sum = (k) => recs.reduce((a, r) => a + (r[k] || 0), 0);
  const totalIssues = sum('total');
  const rec = {
    total: totalIssues, done: sum('done'), wip: sum('wip'),
    created30: sum('created30'), resolved30: sum('resolved30'),
    doneRate: recs.reduce((a, r) => a + (r.doneRate || 0) * (r.total || 0), 0) / Math.max(1, totalIssues),
    cycleAvg: (() => {
      const c = recs.filter((r) => r.cycleAvg != null);
      if (!c.length) return null;
      const w = c.reduce((a, r) => a + (r.resolved30 || 0), 0);
      return w ? c.reduce((a, r) => a + (r.cycleAvg || 0) * (r.resolved30 || 0), 0) / w
               : c.reduce((a, r) => a + (r.cycleAvg || 0), 0) / c.length;
    })(),
  };
  return rec;
}

/* ── Master [P] board ──────────────────────────────────────────────
   A synthetic board that merges the issue pools of EVERY [P] org board into
   one dashboard. It is not a real Jira board: the id is reserved, it never
   goes into state.boards, and its issues are fetched per-board via the
   project-wide search (the same strategy single [P] boards prefer). */
const MASTER_P_ID = 900000001;
function isMasterPBoard(b) { return !!b && b.id === MASTER_P_ID; }
function masterPBoard() {
  return { id: MASTER_P_ID, name: t('master.pName'), type: 'master', location: null };
}

/* is this board one of the "[P]" org boards? Its project name (e.g. "[P] Automarket")
   marks it as a shared org-flow Kanban board with the same statuses → shown first.
   The synthetic master [P] board counts too (its name starts with "All", so the
   prefix test alone would miss it — but its charts need the [P] backlog semantics). */
function isPBoard(b) {
  if (isMasterPBoard(b)) return true;
  return /^\[P\]/i.test(b.location?.projectName || '') || /^\[P\]/i.test(b.name || '');
}

/* render a single board card (shared by the grouped list + the sorter).
   In pick-compare mode cards switch from "open dashboard" to "select A/B". */
function boardCardHTML(b, i) {
  const pick = state.pickCompare;
  const pickedA = pick && pick.a === b.id;
  const pickedB = pick && pick.b === b.id;
  const pickedC = pick && pick.c === b.id;
  const picked = pickedA || pickedB || pickedC;
  const openLabel = pick
    ? (picked
      ? tReplace('pick.selectedAs', { s: pickedA ? 'A' : pickedB ? 'B' : 'C' })
      : (pick.a == null ? t('pick.clickPickA') : pick.b == null ? t('pick.clickPickB') : t('pick.clickPickC')))
    : t('card.openDash');
  const initial = escapeHtml((b.name || '?').trim().charAt(0).toUpperCase());
  const pBoard = isPBoard(b);
  const cached = cachedBoardStats(b.id);
  return `
    <div class="board-card glass${pBoard ? ' p-board' : ''}${picked ? ' pick-sel' : ''}${pickedA ? ' pick-a' : ''}${pickedB ? ' pick-b' : ''}${pickedC ? ' pick-c' : ''}" data-id="${b.id}" style="animation-delay:${Math.min(i * 35, 400)}ms">
      <div class="board-card-head">
        <div class="board-avatar" aria-hidden="true">${initial}</div>
        <div class="board-id-block">
          <h3 title="${escapeHtml(b.name)}">${escapeHtml(b.name)}</h3>
          <div class="board-meta">
            ${b.type ? `<span class="${boardTypeClass(b.type)}">${escapeHtml(b.type)}</span>` : ''}
            ${b.location?.projectKey ? `<span class="chip">${escapeHtml(b.location.projectKey)}</span>` : ''}
          </div>
        </div>
        ${pBoard ? '<span class="chip chip-p board-p-flag" title="[P]">[P]</span>' : ''}
        <div class="board-head-side">
          <button class="link-btn board-copy-link" data-copyboard="${b.id}" title="${escapeHtml(t('card.copyLinkTitle'))}" aria-label="${escapeHtml(t('card.copyLinkTitle'))}">🔗</button>
        </div>
      </div>
      <div class="board-stats" id="bstats_${b.id}">${boardStatsChipHtml(cached)}</div>
      <div class="board-card-foot">
        <span class="board-open">${openLabel}</span>
        ${b.location?.projectName ? `<span class="board-proj muted" title="${escapeHtml(b.location.projectName)}">${escapeHtml(b.location.projectName)}</span>` : ''}
      </div>
    </div>`;
}

/* dedicated card for the synthetic master [P] board (precedes the real [P] cards).
   It has no Jira identity — no copy-link, no compare-pick — just an "open merged
   dashboard" affordance with the live aggregate stats of every [P] board. */
function masterBoardCardHTML(i) {
  const b = masterPBoard();
  const initial = '∑';
  const cached = masterPStats();
  return `
    <div class="board-card glass p-board master-p-board" data-id="${b.id}" style="animation-delay:${Math.min(i * 35, 400)}ms">
      <div class="board-card-head">
        <div class="board-avatar" aria-hidden="true">${initial}</div>
        <div class="board-id-block">
          <h3 title="${escapeHtml(b.name)}">${escapeHtml(b.name)}</h3>
          <div class="board-meta"><span class="chip chip-master">${escapeHtml(t('master.cardChip'))}</span></div>
        </div>
        <span class="chip chip-p board-p-flag" title="[P]">[P]</span>
      </div>
      <div class="board-stats" id="bstats_${b.id}">${boardStatsChipHtml(cached)}</div>
      <div class="board-card-foot">
        <span class="board-open">${escapeHtml(t('card.openDash'))}</span>
        <span class="board-proj muted" title="${escapeHtml(t('master.cardDesc'))}">${escapeHtml(t('master.cardDesc'))}</span>
      </div>
    </div>`;
}

function renderBoardCards() {
  const grid = $('#boardsGrid');
  const pBoards = state.boards.filter(isPBoard);
  const otherBoards = state.boards.filter((b) => !isPBoard(b));
  let html = '';
  if (pBoards.length) {
    html += `<div class="board-group"><span class="board-group-title">${escapeHtml(t('card.orgBoards'))}</span><div class="boards-grid">${masterBoardCardHTML(0)}${pBoards.map((b, ci) => boardCardHTML(b, ci + 1)).join('')}</div></div>`;
  }
  if (otherBoards.length) {
    html += `<div class="board-group"><span class="board-group-title">${escapeHtml(t('card.otherBoards'))}</span><div class="boards-grid">${otherBoards.map((b, ci) => boardCardHTML(b, ci)).join('')}</div></div>`;
  }
  grid.innerHTML = html;
  /* event wiring is shared for all cards (grouped grids are still DOM children) */
  grid.querySelectorAll('.board-card .board-copy-link').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const b = state.boards.find((x) => x.id === parseInt(btn.dataset.copyboard, 10));
      if (b) {
        const link = boardLink(b.id);
        navigator.clipboard.writeText(link).then(() => toast(t('pub.boardCopied'), 'ok')).catch(() => toast(t('toast.copyFail'), 'warn'));
      }
    });
  });
  grid.querySelectorAll('.board-card').forEach((card) => {
    card.addEventListener('click', () => {
      const b = state.boards.find((x) => x.id === parseInt(card.dataset.id, 10));
      if (!b && !isMasterPBoard({ id: parseInt(card.dataset.id, 10) })) return;
      if (state.pickCompare) { togglePickCompare(b); return; }   // pick mode → cards select instead of open
      $('#boardSelect').value = String(b?.id ?? card.dataset.id);
      openBoard(b || masterPBoard());
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

/* master [P] board loader: fetch every [P] board's issue pool (project-wide
   search with changelog, same as a single [P] board's primary strategy) in
   parallel and concatenate. A board whose search fails is skipped with a
   warning — a partial master view beats a dead one. Tagging each issue with
   its source board keeps per-board attribution available downstream. */
const MASTER_P_TAG = '_srcBoardName';
async function loadMasterPIssues() {
  const pBoards = state.boards.filter(isPBoard).filter((b) => !isMasterPBoard(b));
  if (!pBoards.length) throw new Error('No [P] boards found to merge.');
  await discoverComplexityFieldId();

  const results = await Promise.all(pBoards.map(async (b) => {
    try {
      const ctx = await resolveBoardContext(b);
      const keys = ctx.projectKeys.length ? ctx.projectKeys : [];
      if (!keys.length) throw new Error('no projects resolvable');
      const issues = await searchIssuesByJql(
        `project in (${keys.map((k) => `"${k}"`).join(', ')}) ORDER BY created DESC`, true);
      logDiag('info', 'Master [P] board segment loaded', { boardId: b.id, name: b.name, issues: issues.length });
      return { board: b, issues, err: null };
    } catch (e) {
      logDiag('warn', 'Master [P] board segment failed — skipped', { boardId: b.id, name: b.name, status: e?.status, message: e?.message });
      return { board: b, issues: [], err: e };
    }
  }));

  const ok = results.filter((r) => !r.err);
  const failed = results.filter((r) => r.err);
  if (!ok.length) {
    const e = new Error(`No [P] board could be loaded. Last error: ${failed[0]?.err?.message || 'unknown'}`);
    e.status = failed[0]?.err?.status || 500;
    throw e;
  }
  const merged = [];
  for (const r of ok) {
    for (const iss of r.issues) {
      try { iss[MASTER_P_TAG] = r.board.name; } catch (_) { /* frozen object — attribution is best-effort */ }
      merged.push(iss);
    }
  }
  state.hasChangelog = ok.some((r) => hasChangelogData(r.issues));
  state.boardLoadMeta = {
    source: `Master [P] — ${ok.length} board${ok.length === 1 ? '' : 's'} merged`,
    note: failed.length
      ? `${failed.length} board${failed.length === 1 ? '' : 's'} could not be loaded and ${failed.length === 1 ? 'is' : 'are'} excluded.`
      : '',
  };
  rememberDoneStatuses(merged);
  detectComplexityField(merged);
  return merged;
}

async function loadBoardIssues(board) {
  state.hasChangelog = true;
  state.boardLoadMeta = { source: '', note: '' };
  const ctx = await resolveBoardContext(board);
  /* resolve the complexity custom field id BEFORE fetching so the first search
     already requests it (Jira silently drops unknown field ids, so guessing is futile) */
  await discoverComplexityFieldId();

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
      /* learn the "Change Request Complexity" custom field id (S/M/L/XL ladder) */
      detectComplexityField(issues);
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
  state.compareC = null;
  state.compareGen = (state.compareGen || 0) + 1;
  hide($('#compareBar'));
  $('#compareBtn').classList.remove('active');

  $('#dashBoardName').textContent = board.name;
  $('#syncedAt').textContent = '';

  /* clear the previous board's data immediately so it never lingers during sync */
  showDashLoading(board.name);

  try {
    logDiag('info', 'Board selected', { boardId: board.id, name: board.name, type: board.type, location: board.location || null });
    const issues = isMasterPBoard(board) ? await loadMasterPIssues() : await loadBoardIssues(board);
    /* only replace data AFTER a successful load — never lose the previous board on failure */
    state.issues = issues;
    const m = computeMetrics(issues);
    state.lastBoard = board;
    state.lastMetrics = m;

    hide($('#errorBanner'));

    renderDashboard(board, m);
    $('#syncedAt').textContent = tReplace('sync.updated', { t: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) });
  } catch (e) {
    /* keep the previous board's dashboard intact — just warn */
    $('#issueCountBadge').textContent = t('sync.failed');
    const banner = $('#errorBanner');
    let msg = e?.message || t('err.loadIssues');
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

/* per-status issue-key tracker for the statusTime charts (click → issue list).
   Also feeds the statusTime stage-split charts (stakeholder / team phases). */
function addStatusKey(map, name, key) {
  if (!name || !key) return;
  const arr = map.get(name) || [];
  arr.push(key);
  map.set(name, arr);
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
    statusKeys: new Map(),
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
      /* cycle time = real flow time only. Blocked/Canceled/On-Hold issues are
         excluded — their months of parked time are not delivery speed and were
         inflating the Avg cycle time KPI (canceled issues often carry a
         resolutiondate, which made them look "resolved"). */
      if (created && !isBlockedStatus(f)) {
        m.cycles.push(resolved - created);
        if (NOW - resolved < 30 * DAY) m.cycleRecent.push(resolved - created);
        else if (NOW - resolved < 60 * DAY) m.cyclePrev.push(resolved - created);
      }
    }
    if (created) {
      const pwIdx = WEEKS - 1 - Math.floor((NOW - created) / (7 * DAY));
      if (pwIdx >= 0 && pwIdx < WEEKS) m.pipelineWeekly[pwIdx].created++;
    }
    /* done = Jira's statusCategory=done OR an org-flow "green" completed status
       (Released / Babysitting / Done Approved… — these carry no resolutiondate on
       [P] boards, so the name check is what recognises them everywhere else).
       Blocked/Canceled work is neither done nor active — tracked separately. */
    if (doneCat || isCompletedStatus(f, false)) m.done++;
    else if (!isBlockedStatus(f)) m.wip++;

    m.statusDist.set(statusName, (m.statusDist.get(statusName) || 0) + 1);

    /* blocked / canceled / rejected work — counted separately (shown in its own chart) */
    if (isBlockedStatus(f)) {
      m.blockedCount++;
      m.blockedDist.set(statusName, (m.blockedDist.get(statusName) || 0) + 1);
    }

    /* time-in-status from changelog. Issues CURRENTLY in an excluded status
       (done / canceled / blocked) are skipped entirely — their earlier statuses'
       time must not inflate "Avg Time in Status" or "Stakeholder vs Team Delays"
       (a blocked issue's Development days are not real flow time). */
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
      if (ev.ts > prevTs && !excludedNow && !isExcludedStatus({ status: { name: prevName } })) {
        addTime(m.statusTime, prevName, ev.ts - prevTs);
        addStatusKey(m.statusKeys, prevName, iss.key);
      }
      prevTs = ev.ts;
      if (ev.to) prevName = ev.to;
    }
    const curAge = Math.max(0, NOW - prevTs);
    if (!excludedNow && !isExcludedStatus({ status: { name: prevName } })) {
      addTime(m.statusTime, prevName, curAge);
      addStatusKey(m.statusKeys, prevName, iss.key);
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
  let shSum = 0, shN = 0, tmSum = 0, tmN = 0, itSum = 0, itN = 0;
  for (const r of m.phaseDelays) {
    if (r.side === 'stakeholder') { shSum += r.sum; shN += r.n; }
    else if (r.side === 'itcommittee') { itSum += r.sum; itN += r.n; }
    else { tmSum += r.sum; tmN += r.n; }
  }
  m.stakeholderAvgMs = shN ? shSum / shN : null;
  m.teamAvgMs = tmN ? tmSum / tmN : null;
  m.itCommitteeAvgMs = itN ? itSum / itN : null;

  return m;
}

/* ══════════════════ compare mode (board A vs board B) ══════════════════ */
/* Enter compare mode: board A = the dashboard currently open, board B is picked
   from the dropdown. Every KPI shows both values + a winner chip + delta, every
   chart overlays both boards as two datasets, and a "who wins what" strip
   replaces the auto-insights. Leaving compare restores the normal dashboard. */
async function enterCompareMode() {
  if (!state.conn) { toast(t('toast.noConn'), 'warn'); return; }
  if (!state.boards.length) {
    toast(t('toast.boardsLoading'), 'warn');
    return;
  }
  if (!state.lastBoard || !state.lastMetrics) { toast(t('toast.openBoard'), 'warn'); return; }

  const btn = $('#compareBtn');
  btn.classList.add('active');

  /* populate the board pickers (exclude the board we're currently viewing).
     B is required; C is optional — leave it on "" for a 2-board comparison. */
  const others = state.boards.filter((b) => b.id !== state.lastBoard.id);
  const optHtml = others.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
  const sel = $('#cmpBoardSelect');
  sel.innerHTML = `<option value="">${escapeHtml(t('cmp.pickB'))}</option>` + optHtml;
  if (state.compare?.boardId && state.boards.some((b) => b.id === state.compare.boardId)) {
    sel.value = String(state.compare.boardId);
  } else {
    sel.value = '';
  }
  const selC = $('#cmpBoardSelectC');
  if (selC) {
    selC.innerHTML = `<option value="">${escapeHtml(t('cmp.pickC'))}</option>` + optHtml;
    selC.value = state.compareC?.boardId && state.boards.some((b) => b.id === state.compareC.boardId)
      ? String(state.compareC.boardId) : '';
  }

  show($('#compareBar'));
  $('#cmpNameA').textContent = state.lastBoard.name;
  $('#cmpSynced').textContent = state.compare ? t('cmp.bSynced') : '';
  renderCompareDashboard();   /* re-render KPIs in compare layout (even before B is chosen) */
  if (state.compare) renderCharts(effectiveCharts(), state.lastMetrics);
}

function exitCompareMode() {
  state.compare = null;
  state.compareC = null;
  /* bump the generation so any in-flight compare-board load knows it is stale */
  state.compareGen = (state.compareGen || 0) + 1;
  hide($('#compareBar'));
  $('#compareBtn').classList.remove('active');
  restoreKpiGrid();   /* bring back the original six KPI cards before re-rendering */
  if (state.lastBoard && state.lastMetrics) {
    renderDashboard(state.lastBoard, state.lastMetrics);
  }
}

/* shared loader for compare slots B and C. `slot` is 'b' or 'c'; state.compare /
   state.compareC holds the result; each slot has its own dropdown + staleness
   guard so a slow B load can never be written into C's slot (or vice versa). */
async function onCompareSlotChange(slot, ev) {
  const sel = slot === 'b' ? $('#cmpBoardSelect') : $('#cmpBoardSelectC');
  const id = parseInt(ev.target.value, 10);
  if (!id || !state.lastBoard) return;
  const existing = slot === 'b' ? state.compare : state.compareC;
  if (existing && existing.boardId === id) return;
  /* a board already compared in the other slot must not be picked twice */
  const other = slot === 'b' ? state.compareC : state.compare;
  if (other && other.boardId === id) {
    if (sel) sel.value = existing ? String(existing.boardId) : '';
    toast(t('cmp.dupSlot'), 'warn');
    return;
  }

  const board = state.boards.find((b) => b.id === id);
  if (!board) return;

  if (sel) sel.disabled = true;
  $('#cmpSynced').innerHTML = `<span class="spinner spinner-sm"></span> ${escapeHtml(t(slot === 'b' ? 'cmp.bSyncing' : 'cmp.cSyncing'))}`;

  /* staleness guard: the user may switch boards (or exit compare) while a compare
     board is loading. Capture board A's id + a compare generation now and re-verify
     after the await — a stale load must NEVER resurrect compare mode onto a different
     board's dashboard, and exiting compare during the load must discard the result. */
  const boardAId = state.lastBoard?.id;
  const genAtStart = state.compareGen || 0;
  const isStale = () => !state.lastBoard || state.lastBoard.id !== boardAId || (state.compareGen || 0) !== genAtStart;

  try {
    logDiag('info', 'Compare board load started', { slot, boardId: board.id, name: board.name });
    const issues = await loadBoardIssues(board);
    if (isStale()) {
      logDiag('info', 'Compare load discarded — board changed during sync', { slot, boardId: board.id });
      return;
    }
    const m = computeMetrics(issues);
    /* save-then-restore: loadBoardIssues writes hasChangelog/boardLoadMeta into
       global state for the MAIN board — snapshot it for the compare board's charts */
    const rec = {
      boardId: board.id, board, issues, metrics: m,
      hasChangelog: state.hasChangelog,
      syncedAt: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    };
    if (slot === 'b') state.compare = rec; else state.compareC = rec;
    $('#cmpSynced').textContent = tReplace(slot === 'b' ? 'cmp.bSynced' : 'cmp.cSynced', { x: rec.syncedAt });
    logDiag('info', 'Compare board loaded', { slot, boardId: board.id, issues: issues.length, hasChangelog: state.hasChangelog });
    renderCompareDashboard();
    renderCharts(effectiveCharts(), state.lastMetrics);
  } catch (e) {
    if (isStale()) return; /* board switched during a failing load — stay silent */
    $('#cmpSynced').textContent = t(slot === 'b' ? 'cmp.bFailed' : 'cmp.cFailed');
    toast(tReplace('cmp.loadFailed', { name: board.name }), 'warn');
    logDiag('error', 'Compare board load failed', { slot, boardId: board.id, message: e?.message, status: e?.status });
    if (slot === 'b' && !state.compare) sel.value = '';
    if (slot === 'c' && !state.compareC) sel.value = '';
  } finally {
    if (sel) sel.disabled = false;
  }
}
const onCompareBoardChange = (ev) => onCompareSlotChange('b', ev);   /* slot B entry point */

/* KPI metric descriptors for compare mode — label/sub resolved via i18n at render time */
const CMP_KPIS = [
  { key: 'total',    label: 'cmp.kpiTotal',    icon: '▦', cls: 'ic-indigo',     fmt: (v) => String(v),                          winner: 'more',  sub: 'cmp.kpiTotalSub' },
  { key: 'created30',label: 'cmp.kpiCreated',  icon: '＋', cls: 'ic-cyan',      fmt: (v) => String(v),                          winner: 'more',  sub: 'cmp.kpiCreatedSub' },
  { key: 'done',     label: 'cmp.kpiDone',     icon: '✓', cls: 'ic-green',      fmt: (v) => String(v),                          winner: 'more',  sub: 'cmp.kpiDoneSub' },
  { key: 'resolved30',label: 'cmp.kpiResolved',icon: '↻', cls: 'ic-green',      fmt: (v) => String(v),                          winner: 'more',  sub: 'cmp.kpiResolvedSub' },
  { key: 'cycleAvg', label: 'cmp.kpiCycle',    icon: '⏱', cls: 'ic-violet',     fmt: (v) => (v != null ? fmtDuration(v) : '—'), winner: 'less',  sub: 'cmp.kpiCycleSub' },
  { key: 'wip',      label: 'cmp.kpiWip',      icon: '◔', cls: 'ic-amber',      fmt: (v) => String(v),                          winner: 'less',  sub: 'cmp.kpiWipSub' },
];

/* ── KPI grid restore ─────────────────────────────────────────────────────
   renderCompareDashboard() REPLACES the dashboard's .kpi-grid innerHTML with
   compare cards. The original six KPI cards (kpiTotal/kpiCreated/… with their
   sub-elements) must be restored before renderDashboard()/showDashLoading()
   write into them again — otherwise $('#kpiTotalSub') is null and the app
   crashes on exit from compare. Capture the pristine markup once at boot and
   swap it back whenever the grid is still in compare layout. */
let KPI_GRID_ORIGINAL = null;
function restoreKpiGrid() {
  const grid = document.querySelector('.kpi-grid');
  if (!grid || !KPI_GRID_ORIGINAL) return;
  if (!grid.classList.contains('kpi-grid-compare')) return;
  grid.classList.remove('kpi-grid-compare');
  grid.innerHTML = KPI_GRID_ORIGINAL;
}

/* compact board name for chips/tags/badges — full names overflow small pills */
function shortBoardName(name) {
  const s = String(name || '').trim();
  if (!s) return s;
  return s.length > 24 ? s.slice(0, 23).trimEnd() + '…' : s;
}

/* re-render the six KPI cards in compare layout (A value vs B value + winner + delta).
   All inputs are explicit params so BOTH the admin dashboard and the public share
   view can render the same compare layout: admin passes the live state values,
   pub passes its own snapshot-derived ones (defaults fall back to state). */
function renderCompareDashboard(opts = {}) {
  const A = opts.metricsA != null ? opts.metricsA : state.lastMetrics;
  const B = opts.metricsB != null ? opts.metricsB : state.compare?.metrics;
  const C = opts.metricsC != null ? opts.metricsC : state.compareC?.metrics;
  const nameA = opts.nameA || state.lastBoard?.name || t('cmp.pubA');
  const nameB = opts.nameB || state.compare?.board?.name || null;
  const nameC = opts.nameC || state.compareC?.board?.name || null;
  const grid = opts.gridEl || document.querySelector('.kpi-grid');
  if (!grid) return;
  const badgeEl = opts.badgeEl || $('#issueCountBadge');
  const stripEl = opts.stripEl || $('#insightsStrip');
  /* boards list: A is always present; B/C join as their metrics arrive.
     Letter drives the side color (a=indigo, b=cyan, c=green) everywhere. */
  const boards = [{ letter: 'a', name: nameA, m: A }];
  if (B) boards.push({ letter: 'b', name: nameB || 'B', m: B });
  if (C) boards.push({ letter: 'c', name: nameC || 'C', m: C });
  for (const bd of boards) bd.short = shortBoardName(bd.name) || bd.letter.toUpperCase();
  const compared = boards.length >= 2;   /* B chosen → real comparison is on */

  grid.classList.add('kpi-grid-compare');
  grid.innerHTML = CMP_KPIS.map((k) => {
    const vals = boards.map((bd) => (bd.m && bd.m[k.key] != null && isFinite(bd.m[k.key])) ? bd.m[k.key] : null);
    const have = vals.filter((v) => v != null);
    const valuesHtml = compared
      ? `<div class="cmp-values">` + boards.map((bd, i) =>
          `<span class="cmp-val cmp-val-${bd.letter}" title="${escapeHtml(bd.name)}"><span class="cmp-val-num">${k.fmt(vals[i])}</span><span class="cmp-val-tag">${escapeHtml(bd.short)}</span></span>`
        ).join(`<span class="cmp-vs-inline">/</span>`) + `</div>`
      : `<div class="cmp-values"><span class="cmp-val-num" style="color:var(--muted)">—</span></div>`;

    let winnerHtml = '', deltaHtml = '';
    if (compared && have.length >= 2) {
      const best = k.winner === 'less' ? Math.min(...have) : Math.max(...have);
      const leaders = boards.filter((bd, i) => vals[i] === best);
      const rest = have.filter((v) => v !== best);
      if (!rest.length) {
        /* every loaded board is identical on this metric */
        winnerHtml = `<span class="cmp-winner cmp-winner-even">— ${escapeHtml(t('cmp.even'))}</span>`;
        deltaHtml = `<div class="cmp-delta even">${escapeHtml(t('cmp.identical'))}</div>`;
      } else if (leaders.length === 1) {
        const leadIdx = boards.findIndex((bd, i) => vals[i] === best);
        const lead = boards[leadIdx];
        const runVal = k.winner === 'less' ? Math.min(...rest) : Math.max(...rest);
        const run = boards.find((bd, i) => i !== leadIdx && vals[i] === runVal);
        winnerHtml = `<span class="cmp-winner cmp-winner-${lead.letter}" title="${boards.map((bd) => escapeHtml(bd.name)).join(' vs ')}">▲ ${escapeHtml(tReplace('cmp.aHigher', { n: lead.short }))}</span>`;
        const d = pctDelta(run.m[k.key], best);
        deltaHtml = `<div class="cmp-delta ${d > 0 ? 'up' : 'down'}">${escapeHtml(
          d > 0
            ? tReplace('cmp.aAbove', { a: lead.short, b: run.short, p: Math.abs(d) })
            : tReplace('cmp.aBelow', { a: lead.short, b: run.short, p: Math.abs(d) })
        )}</div>`;
      } else {
        /* tie at the top between 2+ boards while another trails */
        winnerHtml = `<span class="cmp-winner cmp-winner-even">— ${escapeHtml(t('cmp.even'))}</span>`;
        deltaHtml = `<div class="cmp-delta even">${escapeHtml(t('cmp.identical'))}</div>`;
      }
    } else if (compared) {
      deltaHtml = `<div class="cmp-delta even">${escapeHtml(t('cmp.noData'))}</div>`;
    } else {
      deltaHtml = `<div class="cmp-delta even">${escapeHtml(nameA)} vs <b>?</b> — ${escapeHtml(t('cmp.pickBHint'))}</div>`;
    }

    return `<div class="kpi glass compare">
      <div class="kpi-top"><span class="kpi-icon ${k.cls}">${k.icon}</span><span class="kpi-label">${escapeHtml(t(k.label))}</span></div>
      ${valuesHtml}
      ${winnerHtml}
      ${deltaHtml}
    </div>`;
  }).join('');

  /* keep the header badge informative — board names, not A/B */
  if (badgeEl) badgeEl.textContent = compared
    ? boards.map((bd) => `${bd.short}: ${bd.m?.total ?? 0} ${t('cmp.issues')}`).join(' · ')
    : tReplace('dash.issuesAnalyzed', { n: A?.total ?? 0 });

  /* head-to-head score: count the compare metrics each board wins and show it
     as a live "3 : 1" tally inside the compare bar — the at-a-glance verdict.
     With 3 boards the tally becomes a 3-way count (the C number + separator
     are simply hidden again when only two boards are compared). */
  const scoreEl = opts.scoreEl || $('#cmpScore');
  if (scoreEl) {
    if (compared) {
      const wins = { a: 0, b: 0, c: 0 };
      for (const k of CMP_KPIS) {
        const loaded = boards.filter((bd) => bd.m && bd.m[k.key] != null && isFinite(bd.m[k.key]));
        if (loaded.length < 2) continue;
        const best = k.winner === 'less' ? Math.min(...loaded.map((bd) => bd.m[k.key])) : Math.max(...loaded.map((bd) => bd.m[k.key]));
        const leaders = loaded.filter((bd) => bd.m[k.key] === best);
        /* a metric with a tie at the top awards no board a point */
        if (leaders.length !== 1) continue;
        wins[leaders[0].letter]++;
      }
      const sA = scoreEl.querySelector('.cmp-score-a');
      const sB = scoreEl.querySelector('.cmp-score-b');
      const sC = scoreEl.querySelector('.cmp-score-c');
      const sSepC = scoreEl.querySelector('.cmp-score-sep-c');
      const sSub = scoreEl.querySelector('.cmp-score-sub');
      if (sA) sA.textContent = String(wins.a);
      if (sB) sB.textContent = String(wins.b);
      if (sC) sC.textContent = String(wins.c);
      if (sSepC) sSepC.style.display = C ? '' : 'none';
      if (sC) sC.style.display = C ? '' : 'none';
      const totalWins = wins.a + wins.b + (C ? wins.c : 0);
      const topWins = Math.max(wins.a, wins.b, C ? wins.c : 0);
      const topCount = [wins.a, wins.b, C ? wins.c : 0].filter((w) => w === topWins).length;
      if (sSub) sSub.textContent = topCount > 1
        ? tReplace('cmp.scoreTie', { n: topWins })
        : tReplace('cmp.scoreLeads', { n: topWins, m: CMP_KPIS.length });
      scoreEl.classList.toggle('cmp-score-tied', topCount > 1 || totalWins === 0);
      show(scoreEl);
    } else {
      hide(scoreEl);
    }
  }

  /* insights strip → compare winners strip */
  const strip = stripEl;
  if (!strip) return;
  if (compared) {
    const ins = buildCompareInsights(boards);
    strip.innerHTML = ins.map((x, i) =>
      `<div class="cmp-insight cmp-insight-${x.kind}" style="animation-delay:${i * 70}ms">` +
        `<span class="ins-icon">${x.icon}</span>` +
        `<div class="cmp-ins-body">` +
          `<div class="cmp-ins-title">${x.title}</div>` +
          `<div class="cmp-ins-text">${x.html}</div>` +
          (x.stats ? `<div class="cmp-ins-stats">${x.stats}</div>` : '') +
        `</div>` +
      `</div>`
    ).join('');
    show(strip);
  } else {
    strip.innerHTML = `<div class="cmp-insight"><span class="ins-icon">⇄</span><div class="cmp-ins-body"><div class="cmp-ins-text">${escapeHtml(t('cmp.hintBar'))}</div></div></div>`;
    show(strip);
  }
}

/* "who wins what" summary for the compare strip. Each card cross-references
   SEVERAL datapoints (trend vs prior 30d, cycle-time trend, completion rate,
   WIP vs throughput) so conclusions read like an analyst verdict, not a
   single-number echo. Cards are structured: label → headline → supporting
   stats row. Takes the shared `boards` array ({ letter, name, short, m }) so
   the same code serves 2-board and 3-board comparisons. */
function buildCompareInsights(boards) {
  const loaded = boards.filter((bd) => bd.m);
  if (loaded.length < 2) return [];
  const [A, B] = loaded.map((bd) => bd.m);
  const C = loaded[2]?.m || null;
  const out = [];
  const sOf = (bd) => bd.short;
  /* board-name span with its side color — used in headlines and verdict rows */
  const tag = (bd) => `<span class="cmp-ins-board cmp-ins-${bd.letter}" title="${escapeHtml(bd.name)}">${escapeHtml(bd.short)}</span>`;
  const stat = (v, cls) => `<span class="cmp-ins-stat${cls ? ' ' + cls : ''}">${v}</span>`;
  const delta = (a, b) => {
    const d = pctDelta(b, a);
    return d == null ? '' : `<span class="cmp-ins-delta ${d > 0 ? 'pos' : 'neg'}">${d > 0 ? '+' : ''}${d}%</span>`;
  };
  /* per-board metric getter with a null filter — every check below runs on
     the boards that actually have the value, so a 2-board comparison inside
     a 3-board session still produces sensible verdicts */
  const mvals = (key) => loaded.map((bd) => (bd.m[key] != null && isFinite(bd.m[key])) ? bd.m[key] : null);
  /* pick the single best board for a metric ('more'/'less'), or null on ties
     or when fewer than two boards carry the value */
  const bestBoard = (key, dir) => {
    const withV = loaded.filter((bd) => bd.m[key] != null && isFinite(bd.m[key]));
    if (withV.length < 2) return null;
    const vals = withV.map((bd) => bd.m[key]);
    const best = dir === 'less' ? Math.min(...vals) : Math.max(...vals);
    const leaders = withV.filter((bd) => bd.m[key] === best);
    return leaders.length === 1 ? leaders[0] : null;
  };
  const fmtList = (fn) => loaded.map((bd) => fn(bd.m)).join(' / ');

  /* ── 1. overall verdict: cross-reference size, throughput, speed, completion ── */
  {
    const wins = [];
    for (const [key, what, dir] of [
      ['resolved30', 'throughput', 'more'],
      ['cycleAvg', 'speed', 'less'],
      ['doneRate', 'completion', 'more'],
      ['wip', 'load', 'less'],
      ['blockedCount', 'blocked', 'less'],
    ]) {
      const lead = bestBoard(key, dir);
      if (lead) wins.push({ who: lead, what });
    }
    if (wins.length) {
      const tally = { a: 0, b: 0, c: 0 };
      for (const w of wins) tally[w.who.letter]++;
      const topWins = Math.max(tally.a, tally.b, tally.c);
      const topBoards = loaded.filter((bd) => tally[bd.letter] === topWins && topWins > 0);
      const lead = topBoards.length === 1 ? topBoards[0] : null;
      const verdict = lead
        ? tReplace('cmp.insVerdict', { a: lead.short, b: loaded.filter((bd) => bd !== lead).map((bd) => bd.short).join(', '), w: topWins, m: wins.length })
        : tReplace('cmp.insVerdictTie', { m: wins.length });
      out.push({
        icon: '🏆', kind: 'verdict',
        title: lead ? tReplace('cmp.insVerdictTitle', { n: lead.short }) : t('cmp.insVerdictTieTitle'),
        html: verdict + ' ' + wins.slice(0, 3).map((w) => `<span class="cmp-ins-chip chip-${w.who.letter}">${escapeHtml(t('cmp.wins.' + w.what))}</span>`).join(''),
        stats:
          stat(fmtList((m) => `${m.total}`), '') + t('cmp.insStatsIssues') +
          stat(fmtList((m) => `${m.resolved30}`)) + t('cmp.insStatsShipped') +
          stat(fmtList((m) => (m.cycleAvg != null ? fmtDuration(m.cycleAvg) : '—'))) + t('cmp.insStatsCycle'),
      });
    }
  }

  /* ── 2. momentum: 30d throughput vs the prior 30d on every board ── */
  {
    const trends = loaded.map((bd) => ({
      bd,
      t: bd.m.resolvedPrev30 ? pctDelta(bd.m.resolvedPrev30, bd.m.resolved30) : null,
    })).filter((x) => x.t != null);
    if (trends.length >= 2) {
      const bestT = Math.max(...trends.map((x) => x.t));
      const leaders = trends.filter((x) => x.t === bestT);
      const lead = leaders.length === 1 ? leaders[0].bd : null;
      out.push({
        icon: '📈', kind: 'trend',
        title: t('cmp.lblMomentum'),
        html: lead
          ? tReplace('cmp.insMomentum', { n: tag(lead) })
          : escapeHtml(t('cmp.insMomentumMixed')),
        stats:
          trends.map((x) =>
            stat(`${x.bd.m.resolved30} vs ${x.bd.m.resolvedPrev30}`, x.t > 0 ? 'pos' : x.t < 0 ? 'neg' : '') + delta(x.bd.m.resolvedPrev30, x.bd.m.resolved30) + t('cmp.insStatsNowPrev')
          ).join(''),
      });
    }
  }

  /* ── 3. flow balance: intake vs delivery + WIP pressure on every board ── */
  {
    const bals = loaded.map((bd) => ({ bd, bal: bd.m.created30 - bd.m.resolved30 }));
    const distinct = new Set(bals.map((x) => x.bal));
    if (distinct.size > 1) {
      const bestBal = Math.min(...bals.map((x) => x.bal));   /* smaller intake surplus = healthier */
      const leaders = bals.filter((x) => x.bal === bestBal);
      const lead = leaders.length === 1 ? leaders[0].bd : null;
      out.push({
        icon: '⚖️', kind: 'flow',
        title: t('cmp.lblFlow'),
        html: lead
          ? tReplace('cmp.insFlow', { n: tag(lead), a: Math.abs(lead.m.created30 - lead.m.resolved30), b: Math.abs(bals.filter((x) => x.bd !== lead)[0]?.bal ?? 0) })
          : escapeHtml(t('cmp.insRiskEven')),
        stats:
          bals.map((x) =>
            stat(`${x.bd.m.created30} ▸ ${x.bd.m.resolved30}`, x.bal > 0 ? 'neg' : 'pos') + t('cmp.insStatsInOut')
          ).join('') +
          stat(fmtList((m) => `${m.wip}`)) + t('cmp.insStatsWip'),
      });
    }
  }

  /* ── 4. speed + quality: cycle time vs completion rate combined ── */
  {
    const cycleLead = bestBoard('cycleAvg', 'less');
    const doneLead = bestBoard('doneRate', 'more');
    const hasCycle = loaded.every((bd) => bd.m.cycleAvg != null);
    if (hasCycle && (cycleLead || doneLead)) {
      const lead = cycleLead || doneLead;
      const runner = loaded.filter((bd) => bd !== lead)[0];
      out.push({
        icon: '⏱️', kind: 'speed',
        title: t('cmp.lblSpeedQuality'),
        html: tReplace('cmp.insSpeed', { n: tag(lead), a: fmtDuration(lead.m.cycleAvg), b: fmtDuration(runner.m.cycleAvg) }),
        stats:
          loaded.map((bd) =>
            stat(fmtDuration(bd.m.cycleAvg), cycleLead === bd ? 'pos' : 'neg') + t('cmp.insStatsCycle')
          ).join('') +
          stat(fmtList((m) => `${m.doneRate}%`)) + t('cmp.insStatsDone') +
          stat(fmtList((m) => `${m.blockedCount}`)) + t('cmp.insStatsBlocked'),
      });
    }
  }

  /* ── 5. risk radar: blocked work + aging backlog together ── */
  {
    const blockedLead = bestBoard('blockedCount', 'less');
    const wipLead = bestBoard('wip', 'less');
    if (blockedLead || wipLead) {
      const lead = blockedLead || wipLead;
      const runner = loaded.filter((bd) => bd !== lead)[0];
      out.push({
        icon: '🛡️', kind: 'risk',
        title: t('cmp.lblRisk'),
        html: blockedLead
          ? tReplace('cmp.insRisk', { n: tag(lead), a: lead.m.blockedCount, b: runner.m.blockedCount })
          : escapeHtml(t('cmp.insRiskEven')),
        stats:
          loaded.map((bd) =>
            stat(`${bd.m.blockedCount}`, blockedLead ? (blockedLead === bd ? 'pos' : 'neg') : '') + t('cmp.insStatsBlocked')
          ).join('') +
          stat(fmtList((m) => `${m.wip}`)) + t('cmp.insStatsWip') +
          stat(fmtList((m) => `${m.doneRate}%`)) + t('cmp.insStatsDone'),
      });
    }
  }

  return out.slice(0, 4);
}

/* ══════════════════ compare from the MAIN page (pick 2-3 boards) ══════════════════
   "⇄ Compare boards" turns the board grid into a picker: click any card to slot it
   as A, another as B, optionally a third as C, then "Compare →" loads all of them
   and opens the dashboard with every KPI + chart overlaid. Available on the admin
   panel AND the public user view. */
function togglePickCompareMode() {
  if (state.pickCompare) { state.pickCompare = null; updatePickBar(); renderBoardCards(); return; }
  if (!state.boards.length) { toast(t('toast.boardsLoading'), 'warn'); return; }
  state.pickCompare = { a: null, b: null, c: null };
  updatePickBar();
  renderBoardCards();
}

/* card click inside pick mode: fill A, then B, then C (optional); click a picked
   card to un-pick it (later slots cascade down); click an unpicked card when all
   slots are full → replace the last slot (C, else B) */
function togglePickCompare(board) {
  const pick = state.pickCompare;
  if (!pick) return;
  if (pick.a === board.id) { pick.a = pick.b; pick.b = pick.c; pick.c = null; }
  else if (pick.b === board.id) { pick.b = pick.c; pick.c = null; }
  else if (pick.c === board.id) { pick.c = null; }
  else if (pick.a == null) { pick.a = board.id; }
  else if (pick.b == null) { pick.b = board.id; }
  else if (pick.c == null) { pick.c = board.id; }
  else { pick.c = board.id; }
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
  const nameOf = (id) => id != null ? (state.boards.find((x) => x.id === id) || {}).name : null;
  const nameA = nameOf(pick.a), nameB = nameOf(pick.b), nameC = nameOf(pick.c);
  $('#pickSlotA').textContent = nameA || t('pick.slotA');
  $('#pickSlotA').classList.toggle('filled', !!nameA);
  $('#pickSlotB').textContent = nameB || t('pick.slotB');
  $('#pickSlotB').classList.toggle('filled', !!nameB);
  const slotC = $('#pickSlotC');
  if (slotC) {
    slotC.textContent = nameC || t('pick.slotC');
    slotC.classList.toggle('filled', !!nameC);
  }
  $('#pickGoBtn').disabled = !(nameA && nameB);
  $('#pickHint').textContent = !nameA ? t('pick.hintA')
    : !nameB ? t('pick.hintB')
    : nameC ? t('pick.hintGo')
    : t('pick.hintC');
  show(bar);
}

/* load ALL picked boards (B required, C optional) and open the dashboard in
   compare mode. Reuses the whole existing pipeline: selectBoard() for A,
   enterCompareMode() + onCompareSlotChange() for B and C — identical code
   path as the in-dashboard picker. */
async function openPickCompareDashboard() {
  const pick = state.pickCompare;
  if (!pick || pick.a == null || pick.b == null) return;
  const boardA = state.boards.find((x) => x.id === pick.a);
  const boardB = state.boards.find((x) => x.id === pick.b);
  const boardC = pick.c != null ? state.boards.find((x) => x.id === pick.c) : null;
  if (!boardA || !boardB || (pick.c != null && !boardC)) return;

  /* leave pick mode first (bar hidden, cards clickable normally again) */
  state.pickCompare = null;
  updatePickBar();

  toast(tReplace('cmp.loading', { a: boardA.name, b: boardC ? `${boardB.name} + ${boardC.name}` : boardB.name }));
  await selectBoard(boardA);
  if (!state.lastBoard || state.lastBoard.id !== boardA.id) return;   // A failed → error banner already shown

  /* enter compare on A's dashboard and sync B (and optionally C) through the
     standard picker path */
  await enterCompareMode();
  const sel = $('#cmpBoardSelect');
  if (!sel.querySelector(`option[value="${boardB.id}"]`)) { toast(t('cmp.failed'), 'warn'); return; }
  sel.value = String(boardB.id);
  await onCompareBoardChange({ target: sel });
  if (boardC) {
    const selC = $('#cmpBoardSelectC');
    if (!selC || !selC.querySelector(`option[value="${boardC.id}"]`)) return;
    selC.value = String(boardC.id);
    await onCompareSlotChange('c', { target: selC });
  }
}

/* ══════════════════ compare on the PUBLIC share view (pick 2-3 boards) ══════════════════
   Mirrors the admin pick-compare flow but runs entirely on the relay-backed live
   loader (pubLoadBoardLive) — no Jira session is needed, so org members get the
   same side-by-side comparison without any admin powers. */
function pubBoardsList() {
  return (pubState.snapshot?.boards) || [];
}

function togglePubPickCompareMode() {
  if (pubState.pickCompare) { pubState.pickCompare = null; updatePubPickBar(); renderPubContent(); return; }
  if (pubState.snapshot?.scope !== 'all') return;   /* pick mode lives on the all-boards view */
  const boards = pubBoardsList();
  if (!boards.length) { toast(t('toast.boardsLoading'), 'warn'); return; }
  pubState.pickCompare = { a: null, b: null, c: null };
  updatePubPickBar();
  renderPubContent();
}

/* pub card click inside pick mode: fill A, then B, then C (optional); click a
   picked card to un-pick (later slots cascade); full slots → replace the last */
function togglePubPickCompare(board) {
  const pick = pubState.pickCompare;
  if (!pick) return;
  if (pick.a === board.boardId) { pick.a = pick.b; pick.b = pick.c; pick.c = null; }
  else if (pick.b === board.boardId) { pick.b = pick.c; pick.c = null; }
  else if (pick.c === board.boardId) { pick.c = null; }
  else if (pick.a == null) { pick.a = board.boardId; }
  else if (pick.b == null) { pick.b = board.boardId; }
  else if (pick.c == null) { pick.c = board.boardId; }
  else { pick.c = board.boardId; }
  updatePubPickBar();
  renderPubContent();
}

/* sync the pub floating pick bar with pubState.pickCompare */
function updatePubPickBar() {
  document.body.classList.toggle('pick-mode', !!pubState.pickCompare);
  const bar = $('#pubPickBar');
  if (!bar) return;
  const pick = pubState.pickCompare;
  if (!pick) { hide(bar); return; }
  const boards = pubBoardsList();
  const nameOf = (id) => id != null ? (boards.find((x) => x.boardId === id) || {}).name : null;
  const nameA = nameOf(pick.a), nameB = nameOf(pick.b), nameC = nameOf(pick.c);
  $('#pubPickSlotA').textContent = nameA || t('cmp.pubSlotA');
  $('#pubPickSlotA').classList.toggle('filled', !!nameA);
  $('#pubPickSlotB').textContent = nameB || t('cmp.pubSlotB');
  $('#pubPickSlotB').classList.toggle('filled', !!nameB);
  const slotC = $('#pubPickSlotC');
  if (slotC) {
    slotC.textContent = nameC || t('cmp.pubSlotC');
    slotC.classList.toggle('filled', !!nameC);
  }
  $('#pubPickGoBtn').disabled = !(nameA && nameB);
  $('#pubPickHint').textContent = !nameA ? t('cmp.pubPickHintA')
    : !nameB ? t('cmp.pubPickHintB')
    : nameC ? t('cmp.pubPickHintGo')
    : t('cmp.pubPickHintC');
  show(bar);
}

/* load ALL picked boards (B required, C optional — live via the relay) and
   open the pub compare view */
async function openPubPickCompareDashboard() {
  const pick = pubState.pickCompare;
  if (!pick || pick.a == null || pick.b == null) return;
  const boards = pubBoardsList();
  const boardA = boards.find((x) => x.boardId === pick.a);
  const boardB = boards.find((x) => x.boardId === pick.b);
  const boardC = pick.c != null ? boards.find((x) => x.boardId === pick.c) : null;
  if (!boardA || !boardB || (pick.c != null && !boardC)) return;

  /* leave pick mode first (bar hidden, cards clickable normally again) */
  pubState.pickCompare = null;
  updatePubPickBar();

  const loadLabel = tReplace('cmp.pubLoading', { a: boardA.name, b: boardC ? `${boardB.name} + ${boardC.name}` : boardB.name });
  toast(loadLabel);
  const genAtStart = pubState.compareGen || 0;
  const isStale = () => (pubState.compareGen || 0) !== genAtStart;

  $('#pubBoardsList').innerHTML = `<div class="card glass chart-card wide" style="text-align:center;padding:42px;color:var(--muted)"><span class="spinner spinner-lg"></span><div style="margin-top:14px">${escapeHtml(loadLabel)}</div></div>`;

  let recA = null, recB = null, recC = null;
  try {
    [recA, recB, recC] = await Promise.all([
      pubLoadBoardLive(boardA.boardId, 'full'),
      pubLoadBoardLive(boardB.boardId, 'full'),
      ...(boardC ? [pubLoadBoardLive(boardC.boardId, 'full')] : [Promise.resolve(null)]),
    ]);
  } catch (e) {
    if (isStale()) return;
    const failed = !recA ? boardA.name : (!recB ? boardB.name : (boardC?.name || ''));
    toast(tReplace('cmp.pubLoadFailed', { b: failed }), 'warn');
    logDiag('error', 'Pub compare load failed', { boardA: boardA.boardId, boardB: boardB.boardId, boardC: boardC?.boardId, message: e?.message });
    renderPubContent();
    return;
  }
  if (isStale()) return;   /* user exited / re-entered the share screen during the load */

  pubState.compare = { a: boardA.boardId, b: boardB.boardId, c: boardC?.boardId ?? null, nameA: boardA.name, nameB: boardB.name, nameC: boardC?.name ?? null, recA, recB, recC };
  renderPubCompareView();
}

/* render the side-by-side compare dashboard inside the pub view */
function renderPubCompareView() {
  const cmp = pubState.compare;
  if (!cmp) return;
  destroyPubCharts();
  $('#pubBoardsList').classList.add('hidden');
  $('#pubChartsGrid').classList.add('hidden');
  $('#pubBoardKpis').classList.add('hidden');
  $('#pubBoardKpis').innerHTML = '';
  $('#pubTaskListCard').classList.add('hidden');
  $('#pubTlBody').innerHTML = '';
  $('#pubBackBtn').dataset.fromAll = '';
  $('#pubBackBtn').textContent = t('pub.back');
  $('#pubBackBtn').classList.remove('hidden');   /* compare is a sub-page — Back always shows */
  setPubTitleAccent(t('cmp.pubPickTitle'));
  const cmpNames = [cmp.nameA, cmp.nameB, cmp.nameC].filter(Boolean);
  $('#pubSubtitle').textContent = tReplace('cmp.pubLoading', { a: cmpNames[0], b: cmpNames.slice(1).join(' + ') }).replace('…', '') + ' · ' + t('pub.liveSubtitle');
  $('#pubHeadTitle').textContent = t('cmp.pubPickTitle');
  const cmpRecs = [cmp.recA, cmp.recB, cmp.recC].filter(Boolean);
  $('#pubIssueCount').textContent = cmpRecs.map((rec, i) =>
    `${shortBoardName(cmpNames[i])}: ${rec.issuesCount ?? rec.metrics?.total ?? 0} ${t('cmp.issues')}`
  ).join(' · ');
  $('#pubChangelogBadge').textContent = cmpRecs.every((rec) => rec.hasChangelog) ? t('badge.changelog') : t('badge.noChangelog');
  $('#pubChangelogBadge').className = 'data-badge ' + (cmpRecs.every((rec) => rec.hasChangelog) ? 'ok' : 'missing');

  show($('#pubCompareBar'));
  $('#pubCmpNameA').textContent = cmp.nameA;
  $('#pubCmpNameB').textContent = cmp.nameB;
  const nameCEl = $('#pubCmpNameC');
  const sideCEl = $('#pubCmpSideC');
  if (nameCEl) nameCEl.textContent = cmp.nameC || '—';
  if (sideCEl) sideCEl.style.display = cmp.nameC ? '' : 'none';
  $('#pubCmpSynced').textContent = tReplace('cmp.pubSynced', { x: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) });

  const kpiGrid = $('#pubKpiGrid');
  kpiGrid.classList.remove('hidden');
  renderCompareDashboard({
    metricsA: cmp.recA.metrics,
    metricsB: cmp.recB.metrics,
    metricsC: cmp.recC?.metrics ?? null,
    nameA: cmp.nameA,
    nameB: cmp.nameB,
    nameC: cmp.nameC ?? null,
    gridEl: kpiGrid,
    badgeEl: null,          /* the pub badge lives outside the dashboard chrome */
    stripEl: $('#pubInsightsStrip'),   /* dedicated insights strip (charts grid is reused by chart cards) */
  });

  /* charts: overlay boards B (and C) onto every chart via the shared compare engine.
     The grid was hidden above — the compare view MUST re-show it, otherwise
     the KPI cards render with no charts beneath them (the "empty compare page"
     bug). Compare cards also get a colored left border + winner chip so the
     side-by-side story reads at a glance. */
  const defs = pubChartDefs();
  const grid = $('#pubChartsGrid');
  grid.classList.remove('hidden');
  document.body.classList.add('cmp-view');
  if (!defs.length) {
    grid.innerHTML = `<div class="card glass chart-card wide" style="text-align:center;padding:34px;color:var(--muted)">${escapeHtml(t('pub.noCharts'))}</div>`;
    return;
  }
  grid.innerHTML = defs.map((d) => chartCardHTML(d, false)).join('');
  const theme = chartTheme();
  for (const def of defs) {
    const canvasId = 'chart_' + def.id;
    const data = buildCompareChartData(
      def,
      { metrics: cmp.recA.metrics, issues: cmp.recA.issues, hasChangelog: cmp.recA.hasChangelog, name: cmp.nameA },
      { metrics: cmp.recB.metrics, issues: cmp.recB.issues, hasChangelog: cmp.recB.hasChangelog, name: cmp.nameB },
      ...(cmp.recC ? [{ metrics: cmp.recC.metrics, issues: cmp.recC.issues, hasChangelog: cmp.recC.hasChangelog, name: cmp.nameC }] : []),
    );
    const card = grid.querySelector(`.chart-card[data-cid="${def.id}"]`);
    const sub = document.getElementById('sub_' + def.id);
    if (sub) {
      const base = data.subtitle || def.subtitle || '';
      sub.innerHTML = escapeHtml(base) + (data.extraSub ? ` <span class="sub-extra">· ${data.extraSub}</span>` : '');
    }
    /* per-chart winner chip: which board "wins" this chart's headline number */
    if (card) {
      const chip = compareChartWinnerChip(def, data, cmp);
      if (chip) card.querySelector('.chart-actions')?.insertAdjacentHTML('afterbegin', chip);
    }
    if (data.empty) {
      drawCanvasMessage(canvasId, Array.isArray(data.empty) ? data.empty : [data.empty]);
      if (card) card.classList.add('empty');
      continue;
    }
    if (card) card.classList.remove('empty');
    mkPubChart(canvasId, chartConfigFor(def, data, theme, canvasId));
  }
}

/* winner chip for a compare-mode chart card: derived from the chart's headline
   total (centerValue) — higher wins for counts, lower wins for durations.
   Doughnuts compare too (ring charts): open-work charts read "less = wins".
   N-board aware: the single best board gets the chip; ties at the top read
   "even" (no winner is awarded, matching the KPI/score semantics).
   Returns '' for unmapped charts and empty charts. */
function compareChartWinnerChip(def, data, cmp) {
  if (data.empty || !cmp) return '';
  /* collect every loaded board — recC/nameC are simply absent for 2-way compares */
  const boards = [
    { letter: 'a', name: cmp.nameA, m: cmp.recA?.metrics },
    { letter: 'b', name: cmp.nameB, m: cmp.recB?.metrics },
    { letter: 'c', name: cmp.nameC, m: cmp.recC?.metrics },
  ].filter((bd) => bd.m);
  if (boards.length < 2) return '';
  /* pick the metric that matches this chart's headline number */
  const MAP = {
    pipeline: ['total', 'more'], throughput: ['resolved30', 'more'], createdTrend: ['created30', 'more'],
    statusDist: ['total', 'more'], blockedDist: ['blockedCount', 'less'], backlogGrowth: ['wip', 'less'],
    assigneeLoad: ['wip', 'less'], ageBuckets: ['wip', 'less'], assigneeCycle: ['cycleAvg', 'less'],
    phaseDelays: ['cycleAvg', 'less'], statusTime: ['cycleAvg', 'less'],
    /* complexity charts (cm2): open complexity slices = parked work (less wins);
       completed complexity = delivered volume (more wins) */
    complexityDist: ['wip', 'less'], complexityDone: ['resolved30', 'more'],
    /* ring doughnuts: open-work slices — the board with fewer parked issues wins */
    typeDist: ['wip', 'less'], priorityDist: ['wip', 'less'], bottlenecks: ['wip', 'less'],
  };
  const hit = MAP[def.id];
  if (!hit) return '';
  const [key, dir] = hit;
  const loaded = boards
    .map((bd) => ({ ...bd, v: bd.m[key] }))
    .filter((bd) => bd.v != null && isFinite(bd.v));
  if (loaded.length < 2) {
    return `<span class="cmp-winner cmp-winner-even cmp-chart-winner">— ${escapeHtml(t('cmp.even'))}</span>`;
  }
  const best = dir === 'less' ? Math.min(...loaded.map((bd) => bd.v)) : Math.max(...loaded.map((bd) => bd.v));
  const leaders = loaded.filter((bd) => bd.v === best);
  if (leaders.length !== 1) {
    return `<span class="cmp-winner cmp-winner-even cmp-chart-winner">— ${escapeHtml(t('cmp.even'))}</span>`;
  }
  const lead = leaders[0];
  /* delta vs the closest runner-up in the winning direction */
  const rest = loaded.filter((bd) => bd !== lead);
  const second = rest.reduce((b, bd) => ((dir === 'less' ? bd.v < b.v : bd.v > b.v) ? bd : b), rest[0]);
  const pct = Math.abs(pctDelta(second.v, lead.v));
  const short = shortBoardName(lead.name) || lead.letter.toUpperCase();
  const label = tReplace('cmp.chartWinsA', { n: short, p: pct });
  const full = lead.name || short;
  return `<span class="cmp-winner cmp-winner-${lead.letter} cmp-chart-winner" title="${escapeHtml(full)}">${dir === 'less' ? '▼' : '▲'} ${escapeHtml(label)}</span>`;
}

/* leave the pub compare view → back to the all-boards list */
function exitPubCompare() {
  pubState.compare = null;
  pubState.compareGen = (pubState.compareGen || 0) + 1;
  document.body.classList.remove('cmp-view');
  hide($('#pubCompareBar'));
  hide($('#pubInsightsStrip'));
  $('#pubKpiGrid').classList.add('hidden');
  $('#pubKpiGrid').innerHTML = '';
  renderPubContent();
}

/* ── compare-mode chart merging: overlay boards B (and C) onto each chart ──
   nameA/nameB/nameC are explicit params so the public share view can pass its
   own board names (defaults fall back to the admin compare state).
   srcs = [{ metrics, issues, hasChangelog, name }] for every loaded board —
   A first, then B, then C. Series colors follow the side convention:
   a=indigo, b=cyan, c=green. */
const CMP_SERIES = [
  /* literals (not ACCENT_RGB refs) — this const sits earlier in the file than
     ACCENT_RGB and a TDZ reference here would crash the whole script */
  { color: '#6366f1', rgb: '99,102,241' },
  { color: '#22d3ee', rgb: '34,211,238' },
  { color: '#34d399', rgb: '52,211,153' },
];
const CMP_RING_SUB = ['cmp.outerRing', 'cmp.outerRingC'];

const CMP_SERIES_SUB = ['cmp.shownCyan', 'cmp.shownGreen'];

function buildCompareChartData(def, ...srcsIn) {
  const srcs = srcsIn.filter((s) => s && s.metrics);
  const first = srcs[0] || {};
  const dataA = buildChartData(def, first.metrics, first.issues, first.hasChangelog);
  const emptyA = dataA.empty;
  const nameA = first.name || state.lastBoard?.name || t('cmp.pubA');
  /* per-board chart data for boards 2..N */
  const rest = srcs.slice(1).map((s, i) => ({
    idx: i + 1,
    name: s.name || (i === 0 ? (state.compare?.board?.name || t('cmp.pubB')) : (state.compareC?.board?.name || t('cmp.pubC'))),
    data: buildChartData(def, s.metrics, s.issues, s.hasChangelog),
    ...CMP_SERIES[i + 1],
  }));
  const allData = [dataA, ...rest.map((r) => r.data)];
  if (emptyA && rest.every((r) => r.data.empty)) return { empty: [t('cmp.noDataEither1'), t('cmp.noDataEither2')] };

  /* doughnuts compare ALL boards as concentric rings on a shared label union:
     inner ring = board A, then B, then C. Each category keeps the same hue in
     every ring (rings 2+ softened) so slices stay comparable at a glance. */
  if (def.type === 'doughnut') {
    if (emptyA && rest.every((r) => r.data.empty)) return { empty: [t('cmp.noDataEither1'), t('cmp.noDataEither2')] };
    const emptyBoards = [
      ...(emptyA ? [{ name: nameA }] : []),
      ...rest.filter((r) => r.data.empty).map((r) => ({ name: r.name })),
    ];
    if (emptyBoards.length) {
      const only = emptyA ? rest.find((r) => !r.data.empty)?.data : dataA;
      const firstName = emptyA ? rest.find((r) => !r.data.empty)?.name : nameA;
      return {
        ...only,
        extraSub: `${escapeHtml(firstName || '')} ${t('cmp.only')} · ${tReplace('cmp.boardsNoData', { n: emptyBoards.map((b) => escapeHtml(b.name)).join(', ') })}`,
      };
    }
    const rawLabels = [];
    const seen = new Set();
    const collect = (d) => (d.labels || []).forEach((l) => { if (!seen.has(l)) { seen.add(l); rawLabels.push(l); } });
    collect(dataA);
    for (const r of rest) collect(r.data);
    const maps = allData.map((d) => new Map((d.labels || []).map((l, i) => [l, i])));
    const alignV = (mi, l) => { const i = maps[mi].get(l); const vals = allData[mi].datasets?.[0]?.data || []; return i != null ? (vals[i] ?? 0) : 0; };
    const scored = rawLabels.map((l) => {
      const vals = maps.map((_, mi) => alignV(mi, l));
      return { l, vals, score: Math.max(...vals) };
    });
    /* ordered-ladder groupings keep their intrinsic order in compare mode too */
    if (def.groupBy === 'ageBucket') scored.sort((x, y) => AGE_BUCKETS.findIndex(([b]) => b === x.l) - AGE_BUCKETS.findIndex(([b]) => b === y.l));
    else scored.sort((x, y) => y.score - x.score);
    const labels = scored.map((r) => r.l);
    /* per-label color: prefer the earliest board's palette entry so a category
       keeps the same hue in every ring; later rings are drawn softened */
    const colors = labels.map((l) => {
      for (let mi = 0; mi < allData.length; mi++) {
        const i = maps[mi].get(l);
        const cols = allData[mi].colors || [];
        if (i != null && cols[i]) return cols[i];
      }
      return '#64748b';
    });
    const datasets = allData.map((d, mi) => {
      const keys = d.datasets?.[0]?.__keys || [];
      const map = maps[mi];
      return {
        label: mi === 0 ? nameA : rest[mi - 1].name,
        data: labels.map((l) => alignV(mi, l)),
        __keys: labels.map((l) => { const i = map.get(l); return i != null ? (keys[i] || []) : []; }),
        __src: srcs[mi]?.issues,
      };
    });
    return {
      labels,
      datasets,
      colors,
      duration: allData.some((d) => d.duration),
      subtitle: dataA.subtitle || def.subtitle || '',
      extraSub: rest.map((r, i) => `${escapeHtml(r.name)} ${t(CMP_RING_SUB[i] || 'cmp.outerRing')}`).join(' · '),
      centerValues: datasets.map((ds) => Math.round(ds.data.reduce((s, v) => s + v, 0))),
      centerLabel: dataA.centerLabel || t('cmp.issues'),
    };
  }

  /* time-series charts bucket from "now" backwards on every board, so the
     label at the same index means the same date — plain index alignment is
     correct. Pad the shorter series with nulls. Datasets get board-name
     prefixes so the legend tells the boards apart. */
  const isTime = def.metric === 'flow' || def.metric === 'created' || def.metric === 'resolved' || def.metric === 'netflow';
  if (isTime) {
    const labels = allData.reduce((acc, d) => ((d.labels || []).length > acc.length ? d.labels : acc), []);
    const n = Math.max(labels.length, ...allData.map((d) => (d.datasets?.[0]?.data || []).length));
    const pad = (arr) => Array.from({ length: n }, (_, i) => arr[i] ?? null);
    const relabel = (ds, boardName) => ({
      ...ds,
      data: pad(ds.data),
      label: allData.some((d) => d.datasets?.length > 1) ? `${boardName} · ${ds.label}` : boardName,
    });
    const datasets = [];
    if (!emptyA) datasets.push(...dataA.datasets.map((ds) => relabel({ ...ds, __src: first.issues }, nameA)));
    for (const r of rest) {
      if (!r.data.empty) datasets.push(...r.data.datasets.map((ds) => relabel({ ...ds, color: r.color, rgb: r.rgb, __src: r.issues ?? srcs[r.idx]?.issues }, r.name)));
    }
    if (!datasets.length) return { empty: [t('cmp.noComparable')] };
    return {
      labels: labels,
      datasets,
      duration: false,
      subtitle: allData.find((d) => d.subtitle)?.subtitle || def.subtitle,
      extraSub: rest.map((r, i) => `${escapeHtml(r.name)} ${t(CMP_SERIES_SUB[i] || 'cmp.shownCyan')}`).join(' · '),
    };
  }

  /* category / statusTime charts: merge on the union of labels, one value per
     board, then re-sort by the max across the series so grouped bars stay
     readable (single-board charts sort by value; compared boards need a shared
     order) */
  const rawLabels = [];
  const seen = new Set();
  const collect = (d) => (d.labels || []).forEach((l) => { if (!seen.has(l)) { seen.add(l); rawLabels.push(l); } });
  if (!emptyA) collect(dataA);
  for (const r of rest) if (!r.data.empty) collect(r.data);

  const maps = allData.map((d) => new Map((d.labels || []).map((l, i) => [l, i])));
  const align = (mi, l) => {
    const i = maps[mi].get(l);
    const vals = allData[mi].datasets?.[0]?.data || [];
    return i != null ? (vals[i] ?? null) : null;
  };

  const scored = rawLabels.map((l) => {
    const vals = maps.map((_, mi) => align(mi, l));
    return { l, vals, score: Math.max(...vals.map((v) => v ?? 0)) };
  });
  /* per-label issue keys for every board (click a data point → issue list) */
  const alignKeys = (mi, l) => {
    const i = maps[mi].get(l);
    const keys = allData[mi].datasets?.[0]?.__keys || [];
    return i != null ? (keys[i] || []) : [];
  };
  /* ordered-ladder groupings (age buckets) keep their intrinsic order in compare
     mode too — sorting by value would scramble the ≤2d → 6mo+ narrative */
  if (def.groupBy === 'ageBucket') scored.sort((x, y) => AGE_BUCKETS.findIndex(([b]) => b === x.l) - AGE_BUCKETS.findIndex(([b]) => b === y.l));
  else scored.sort((x, y) => y.score - x.score);

  const topN = def.topN || 0;
  const picked = topN ? scored.slice(0, topN) : scored;

  const isDuration = allData.some((d) => d.duration);
  let labels = picked.map((r) => r.l);
  const dsVals = allData.map((_, mi) => picked.map((r) => align(mi, r.l)));
  let keyIdx = picked.map((r) => r.l);           /* raw-label order for key alignment */
  if (def.type === 'hbar') {
    labels = labels.slice().reverse();
    for (let mi = 0; mi < dsVals.length; mi++) dsVals[mi] = dsVals[mi].slice().reverse();
    keyIdx = keyIdx.slice().reverse();
  }

  const datasets = [];
  if (!emptyA) {
    datasets.push({ label: nameA, data: dsVals[0], color: CMP_SERIES[0].color, rgb: CMP_SERIES[0].rgb, __keys: keyIdx.map((l) => alignKeys(0, l)), __src: first.issues });
  }
  for (const r of rest) {
    if (!r.data.empty) datasets.push({ label: r.name, data: dsVals[r.idx], color: r.color, rgb: r.rgb, __keys: keyIdx.map((l) => alignKeys(r.idx, l)), __src: srcs[r.idx]?.issues });
  }

  const base = emptyA ? rest.find((r) => !r.data.empty)?.data : dataA;
  const emptyNames = [
    ...(emptyA ? [nameA] : []),
    ...rest.filter((r) => r.data.empty).map((r) => r.name),
  ];
  const extraSub = emptyNames.length
    ? `${escapeHtml(emptyNames[0])} ${t('cmp.only')} · ${tReplace('cmp.boardsNoData', { n: emptyNames.map((nm) => escapeHtml(nm)).join(', ') })}`
    : rest.map((r, i) => `${escapeHtml(r.name)} ${t(CMP_SERIES_SUB[i] || 'cmp.shownCyan')}`).join(' · ');

  return {
    labels,
    datasets,
    colors: undefined,       /* per-bar colors make no sense with multi-series */
    duration: isDuration,
    subtitle: base?.subtitle || def.subtitle || '',
    extraSub,
    centerValue: isDuration
      ? fmtDuration(avgOf(datasets.flatMap((ds) => ds.data)) * DAY)
      : Math.round(datasets.flatMap((ds) => ds.data).reduce((s, v) => s + (v || 0), 0)),
    centerLabel: isDuration ? t('cmp.avg') : t('cmp.issues'),
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
  netflow:       { label: 'Cumulative net flow (backlog size)', kind: 'time' },
  count:         { label: 'Issue count by group',          kind: 'category' },
  blockedCount:  { label: 'Blocked / canceled by status',  kind: 'category', blockedOnly: true },
  avgCycle:      { label: 'Avg cycle time by group',       kind: 'category', duration: true, resolvedOnly: true },
  openAge:       { label: 'Current age of open issues',    kind: 'category', duration: true, openOnly: true },
  avgStatusTime: { label: 'Avg time in status by group',   kind: 'statusTime', duration: true },
};

const GROUP_LABELS = {
  time: 'Time', status: 'Status', assignee: 'Assignee', type: 'Issue type',
  priority: 'Priority', label: 'First label', bottleneck: 'Bottleneck stage',
  stage: 'Stakeholder vs team', ageBucket: 'Age bucket', assigneeState: 'Assigned vs unassigned',
  complexity: 'Complexity',
};

/* which groupings each metric kind supports */
const GROUPS_FOR_KIND = {
  time: [['time', 'Time (bucketed)']],
  category: [
    ['status', 'Status'], ['assignee', 'Assignee'], ['type', 'Issue type'],
    ['priority', 'Priority'], ['label', 'First label'], ['bottleneck', 'Bottleneck stage'],
    ['ageBucket', 'Age bucket'], ['assigneeState', 'Assigned vs unassigned'],
    ['complexity', 'Complexity'],
  ],
  statusTime: [['status', 'Each status'], ['stage', 'Stakeholder vs team']],
};

const RANGE_OPTIONS = [
  [7, 'Last 7 days'], [14, 'Last 2 weeks'], [30, 'Last 30 days'], [90, 'Last 90 days'],
  [182, 'Last 6 months'], [365, 'Last 12 months'], [0, 'All time'],
];
/* def.range === -1 marks a custom calendar window (rangeFrom/rangeTo on the def) */
const RANGE_CUSTOM = -1;

/* i18n keys for the chart-constant labels above (resolved at render time via t()) */
const METRIC_I18N = {
  flow: 'metric.flow', created: 'metric.created', resolved: 'metric.resolved', netflow: 'metric.netflow',
  count: 'metric.count', blockedCount: 'metric.blockedCount', avgCycle: 'metric.avgCycle',
  openAge: 'metric.openAge', avgStatusTime: 'metric.avgStatusTime',
};
const GROUP_I18N = {
  time: 'group.time', status: 'group.status', assignee: 'group.assignee', type: 'group.type',
  priority: 'group.priority', label: 'group.label', bottleneck: 'group.bottleneck',
  stage: 'group.stage', ageBucket: 'group.ageBucket', assigneeState: 'group.assigneeState',
  complexity: 'group.complexity',
};
const RANGE_I18N = ['range.7', 'range.14', 'range.30', 'range.90', 'range.182', 'range.365', 'range.0'];
const AGE_BUCKET_I18N = ['age.le2d', 'age.3_7d', 'age.1_2w', 'age.2_4w', 'age.1_3mo', 'age.3_6mo', 'age.6moPlus'];
const STATUS_TIME_TITLE_I18N = 'chart.title.statusTime';
const BUILTIN_TITLE_I18N = {
  pipeline: 'chart.title.pipeline', throughput: 'chart.title.throughput', createdTrend: 'chart.title.createdTrend',
  resolvedTrend: 'chart.title.resolvedTrend', backlogGrowth: 'chart.title.backlogGrowth', blockedDist: 'chart.title.blockedDist',
  bottlenecks: 'chart.title.bottlenecks', statusDist: 'chart.title.statusDist', statusTime: 'chart.title.statusTime',
  phaseDelays: 'chart.title.phaseDelays', typeDist: 'chart.title.typeDist', assigneeLoad: 'chart.title.assigneeLoad',
  priorityDist: 'chart.title.priorityDist', doneByAssignee: 'chart.title.doneByAssignee', ageBuckets: 'chart.title.ageBuckets',
  unassigned: 'chart.title.unassigned', assigneeCycle: 'chart.title.assigneeCycle',
  complexityDist: 'chart.title.complexityDist', complexityDone: 'chart.title.complexityDone',
};
const BUILTIN_SUB_I18N = {
  pipeline: 'chart.sub.pipeline', throughput: 'chart.sub.throughput', createdTrend: 'chart.sub.createdTrend',
  resolvedTrend: 'chart.sub.resolvedTrend', backlogGrowth: 'chart.sub.backlogGrowth', blockedDist: 'chart.sub.blockedDist',
  bottlenecks: 'chart.sub.bottlenecks', statusDist: 'chart.sub.statusDist', statusTime: 'chart.sub.statusTime',
  phaseDelays: 'chart.sub.phaseDelays', typeDist: 'chart.sub.typeDist', assigneeLoad: 'chart.sub.assigneeLoad',
  priorityDist: 'chart.sub.priorityDist', doneByAssignee: 'chart.sub.doneByAssignee', ageBuckets: 'chart.sub.ageBuckets',
  unassigned: 'chart.sub.unassigned', assigneeCycle: 'chart.sub.assigneeCycle',
  complexityDist: 'chart.sub.complexityDist', complexityDone: 'chart.sub.complexityDone',
};
/* translated view of a chart def (built-ins only; custom defs keep their own titles) */
function defTitle(def) { return def.builtin ? t(BUILTIN_TITLE_I18N[def.id], def.title) : def.title; }
function defSubtitle(def) { return def.builtin ? t(BUILTIN_SUB_I18N[def.id], def.subtitle) : def.subtitle; }
function metricLabel(m) { return t(METRIC_I18N[m], METRIC_DEFS[m]?.label || m); }
function groupLabel(g) { return t(GROUP_I18N[g], GROUP_LABELS[g] || g); }
function rangeLabel(days) {
  if (days === RANGE_CUSTOM) return t('range.custom');
  const i = RANGE_OPTIONS.findIndex(([d]) => d === days);
  return i >= 0 ? t(RANGE_I18N[i], RANGE_OPTIONS[i][1]) : String(days);
}
/* the effective day-window of a def: preset day counts, or the calendar span of
   a custom range (def.rangeFrom/rangeTo ISO dates). Returns {from,to} in ms
   (null = unbounded) so the data engine can window issues, not just count days. */
function rangeWindowOf(def) {
  if (def.range === RANGE_CUSTOM) {
    const from = def.rangeFrom ? Date.parse(def.rangeFrom) : null;
    const to = def.rangeTo ? Date.parse(def.rangeTo) : null;
    if (from || to) return { from: from || null, to: to || null };
  }
  if (def.range > 0) return { from: null, to: null, days: def.range };
  return { from: null, to: null, days: 0 };   /* all time */
}
function ageBucketLabel(label) {
  const i = AGE_BUCKETS.findIndex(([l]) => l === label);
  return i >= 0 ? t(AGE_BUCKET_I18N[i], label) : label;
}

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
  { id: 'backlogGrowth', title: 'Backlog Trend', subtitle: 'Cumulative open work (created − resolved)', type: 'line', metric: 'netflow', groupBy: 'time', bucket: 'month', range: 182, filter: 'all', topN: 0, split: 'none', color: 'violet', wide: false, centerTotal: true },
  { id: 'blockedDist', title: 'Blocked & Canceled', subtitle: 'Work sitting on blocked/canceled/rejected statuses', type: 'hbar', metric: 'blockedCount', groupBy: 'status', bucket: 'week', range: 0, filter: 'all', topN: 10, split: 'none', color: 'pink', wide: false, centerTotal: false },
  { id: 'bottlenecks', title: 'Active Bottlenecks', subtitle: 'Where open work is parked', type: 'doughnut', metric: 'count', groupBy: 'bottleneck', bucket: 'week', range: 0, filter: 'open', topN: 0, split: 'none', color: 'indigo', wide: false, centerTotal: true },
  { id: 'statusDist', title: 'Status Distribution', subtitle: 'All issues by current status', type: 'doughnut', metric: 'count', groupBy: 'status', bucket: 'week', range: 0, filter: 'all', topN: 8, split: 'none', color: 'violet', wide: false, centerTotal: true },
  { id: 'statusTime', title: 'Avg Time in Status', subtitle: 'Lifetime average per status · changelog', type: 'hbar', metric: 'avgStatusTime', groupBy: 'status', bucket: 'week', range: 0, filter: 'all', topN: 12, split: 'none', color: 'violet', wide: false, centerTotal: false },
  { id: 'phaseDelays', title: 'Stakeholder vs Team Delays', subtitle: 'Avg days per stage · stakeholder gates vs team work · changelog', type: 'hbar', metric: 'avgStatusTime', groupBy: 'status', bucket: 'week', range: 182, filter: 'all', topN: 8, split: 'stage', color: 'amber', wide: false, centerTotal: false },
  { id: 'typeDist', title: 'Issue Type Breakdown', subtitle: 'Open issues by type', type: 'doughnut', metric: 'count', groupBy: 'type', bucket: 'week', range: 0, filter: 'open', topN: 8, split: 'none', color: 'cyan', wide: false, centerTotal: true },
  { id: 'assigneeLoad', title: 'Assignee Workload', subtitle: 'Open issues per assignee', type: 'hbar', metric: 'count', groupBy: 'assignee', bucket: 'week', range: 0, filter: 'open', topN: 12, split: 'none', color: 'pink', wide: false, centerTotal: false },
  { id: 'priorityDist', title: 'Priority Distribution', subtitle: 'Open issues by priority', type: 'doughnut', metric: 'count', groupBy: 'priority', bucket: 'week', range: 0, filter: 'open', topN: 8, split: 'none', color: 'amber', wide: false, centerTotal: true },
  { id: 'doneByAssignee', title: 'Done by Assignee', subtitle: 'Completed tasks per assignee', type: 'hbar', metric: 'count', groupBy: 'assignee', bucket: 'week', range: 0, filter: 'done', topN: 10, split: 'none', color: 'green', wide: false, centerTotal: false },
  { id: 'ageBuckets', title: 'Age vs Demand', subtitle: 'How long the open backlog has been waiting', type: 'hbar', metric: 'count', groupBy: 'ageBucket', bucket: 'week', range: 0, filter: 'open', topN: 0, split: 'none', color: 'amber', wide: false, centerTotal: false },
  /* 'unassigned' (Assignment Gaps) removed — it left a solo chart in the last
     grid row; the remaining 14 standard charts pair up evenly */
  { id: 'assigneeCycle', title: 'Cycle Time Leaderboard', subtitle: 'Avg create → resolve per assignee · resolved issues only', type: 'hbar', metric: 'avgCycle', groupBy: 'assignee', bucket: 'week', range: 182, filter: 'done', topN: 10, split: 'none', color: 'cyan', wide: false, centerTotal: false },
  /* Complexity Distribution pair — the [P] boards carry a "Change Request Complexity"
     select field (Small (S) / Medium (M) / Large (L) / eXtra Large (XL)). Two variants
     keep the dashboard grid paired: open work and completed work. */
  { id: 'complexityDist', title: 'Complexity Distribution', subtitle: 'Open issues by Change Request Complexity (S/M/L/XL)', type: 'doughnut', metric: 'count', groupBy: 'complexity', bucket: 'week', range: 0, filter: 'open', topN: 0, split: 'none', color: 'violet', wide: false, centerTotal: true },
  { id: 'complexityDone', title: 'Complexity Completed', subtitle: 'Completed issues by Change Request Complexity (S/M/L/XL)', type: 'hbar', metric: 'count', groupBy: 'complexity', bucket: 'week', range: 182, filter: 'done', topN: 0, split: 'none', color: 'green', wide: false, centerTotal: false },
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
  /* the master [P] board is synthetic — board-scoped custom charts made on a
     real board must not leak into it */
  if (isMasterPBoard(state.lastBoard)) {
    return list.filter((d) => d.builtin || d.scope !== 'board');
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

/* [P] org boards: the intake/backlog lanes. On these boards "the backlog" is NOT
   "everything open" — it is work parked in one of these three statuses (bugs,
   planned backlog items, system improvements). The Backlog Trend chart counts
   only issues sitting in these statuses when the viewed board is a [P] board. */
const P_BACKLOG_STATUSES = ['Bug', 'Backlog', 'System Improvements'];
function isPBacklogStatus(f) {
  return P_BACKLOG_STATUSES.includes(String(f?.status?.name || '').trim());
}

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

/* open-age bucket: how long has this issue been waiting? (fixed, ordered ladder) */
const AGE_BUCKETS = [
  ['≤ 2d', 0, 2], ['3–7d', 2, 7], ['1–2w', 7, 14], ['2–4w', 14, 28],
  ['1–3mo', 28, 91], ['3–6mo', 91, 182], ['6mo+', 182, Infinity],
];
function ageBucketOf(f) {
  const created = f.created ? Date.parse(f.created) : null;
  if (created == null || !isFinite(created)) return AGE_BUCKETS[AGE_BUCKETS.length - 1][0];
  const days = (Date.now() - created) / DAY;
  for (const [label, lo, hi] of AGE_BUCKETS) if (days >= lo && days < hi) return label;
  return AGE_BUCKETS[AGE_BUCKETS.length - 1][0];
}

function groupKeyOf(def, f) {
  switch (def.groupBy) {
    case 'assignee': return f.assignee?.displayName || 'Unassigned';
    case 'assigneeState': return f.assignee ? 'Assigned' : 'Unassigned';
    case 'ageBucket': return ageBucketOf(f);
    case 'type': return f.issuetype?.name || 'Task';
    case 'priority': return f.priority?.name || 'None';
    case 'label': return Array.isArray(f.labels) && f.labels.length ? f.labels[0] : 'No label';
    case 'bottleneck': return classifyBottleneck(f.status?.name);
    case 'complexity': return complexityOf(f) || 'No complexity';
    default: return f.status?.name || 'Unknown';
  }
}

function stageLabel(k) {
  if (k === 'Stakeholder gates') return t('stage.stakeholder');
  if (k === 'Team phases') return t('stage.team');
  if (k === 'IT Committee') return t('stage.it');
  return k;
}

/* display label for a raw group key — data values (names) pass through, constant keys translate */
function groupKeyLabel(def, k) {
  if (def.groupBy === 'ageBucket') return ageBucketLabel(k);
  if (def.groupBy === 'bottleneck') return bottleneckLabel(k);
  if (def.groupBy === 'stage') return stageLabel(k);
  if (def.groupBy === 'complexity') {
    /* compact the long select values ("Small (S)") into the ladder letters */
    return k === 'No complexity' ? t('group.noComplexity') : complexityShortLabel(k);
  }
  if (def.groupBy === 'assigneeState') {
    if (k === 'Unassigned') return t('group.unassigned');
    if (k === 'Assigned') return t('group.assigned');
  }
  return k;
}

function filterPool(def, issues) {
  if (def.filter === 'open') {
    /* "open" = genuinely active work only: exclude Jira-done (statusCategory=done),
       org-flow completed statuses (Released / Babysitting / Done Approved… — no
       resolutiondate, recognised by name) and blocked/canceled/rejected work. */
    return issues.filter((i) => {
      const f = i.fields || {};
      return !statusIsDone(f) && !isExcludedStatus(f);
    });
  }
  if (def.filter === 'done') return issues.filter((i) => statusIsDone(i.fields || {}));
  return issues;
}

/* build time-bucketed series for created / resolved / flow */
function buildTimeSeries(def, issues, ctx) {
  const NOW = Date.now();
  const isNet = def.metric === 'netflow';
  const wantCreated = def.metric !== 'resolved' || isNet;
  const wantResolved = def.metric !== 'created' || isNet;
  /* [P] boards: the backlog = work parked in the Bug / Backlog / System Improvements
     statuses — not "everything open". When the chart is being built for such a board,
     both the "created" inflow and the netflow line count only those issues. */
  const isP = isPBoard({ name: ctx?.boardName || '' });
  const inScope = isNet && isP ? (f) => isPBacklogStatus(f) : () => true;
  let rangeDays = def.range || 0;
  /* custom calendar window (per-chart dropdown → "Calendar…"): buckets count
     back from the window END, not from "now", so a historical from–to range
     renders exactly the picked months/weeks. */
  const customWin = def.range === RANGE_CUSTOM && def.rangeFrom && def.rangeTo
    ? { from: Date.parse(def.rangeFrom), to: Date.parse(def.rangeTo) }
    : null;
  const hasCustom = !!(customWin && isFinite(customWin.from) && isFinite(customWin.to) && customWin.to > customWin.from);
  const ANCHOR = hasCustom ? customWin.to : NOW;
  if (hasCustom) rangeDays = Math.ceil((customWin.to - customWin.from) / DAY) + 1;

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
  rangeDays = Math.max(hasCustom ? 1 : 7, rangeDays);

  /* pick bucket size, auto-upgrading so we never draw 400 bars */
  let bucket = def.bucket || 'week';
  let nBuckets = bucket === 'day' ? rangeDays : bucket === 'week' ? Math.ceil(rangeDays / 7) : Math.ceil(rangeDays / 30.4);
  if (bucket === 'day' && nBuckets > 120) { bucket = 'week'; nBuckets = Math.ceil(rangeDays / 7); }
  if (bucket === 'week' && nBuckets > 104) { bucket = 'month'; nBuckets = Math.ceil(rangeDays / 30.4); }
  nBuckets = Math.min(nBuckets, 400);
  const bucketMs = bucket === 'day' ? DAY : 7 * DAY;
  /* calendar-month alignment: months have uneven lengths, so a ceil(days/30.4)
     bucket count misaligns counts vs labels (the oldest labeled month shows a
     partial slice — e.g. Apr reads 0 while its issues land in an unlabeled
     phantom bucket). Snap the window to full calendar months instead. */
  if (bucket === 'month') {
    const nowD = new Date(ANCHOR);
    const oldestD = new Date(hasCustom ? Math.max(customWin.from, oldest) : oldest);
    nBuckets = Math.max(1,
      (nowD.getFullYear() * 12 + nowD.getMonth()) - (oldestD.getFullYear() * 12 + oldestD.getMonth()) + 1);
    nBuckets = Math.min(nBuckets, 400);
  }

  const createdCounts = Array(nBuckets).fill(0);
  const resolvedCounts = Array(nBuckets).fill(0);
  /* per-bucket issue keys — power the click-a-data-point → issue-list modal */
  const createdKeys = Array.from({ length: nBuckets }, () => []);
  const resolvedKeys = Array.from({ length: nBuckets }, () => []);
  const nowMonthIdx = new Date(ANCHOR).getFullYear() * 12 + new Date(ANCHOR).getMonth();

  for (const iss of issues) {
    const f = iss.fields || {};
    if (!inScope(f)) continue;   /* [P]-board backlog scope: only Bug / Backlog / System Improvements */
    if (wantCreated && f.created) {
      const ts = Date.parse(f.created);
      let idx;
      if (bucket === 'month') {
        const d = new Date(ts);
        idx = nBuckets - 1 - (nowMonthIdx - (d.getFullYear() * 12 + d.getMonth()));
      } else {
        idx = nBuckets - 1 - Math.floor((ANCHOR - ts) / bucketMs);
      }
      if (idx >= 0 && idx < nBuckets) { createdCounts[idx]++; createdKeys[idx].push(iss.key); }
    }
    if (wantResolved) {
      const ts = issueCompletedAt(f, iss.changelog);
      if (ts) {
        let idx;
        if (bucket === 'month') {
          const d = new Date(ts);
          idx = nBuckets - 1 - (nowMonthIdx - (d.getFullYear() * 12 + d.getMonth()));
        } else {
          idx = nBuckets - 1 - Math.floor((ANCHOR - ts) / bucketMs);
        }
        if (idx >= 0 && idx < nBuckets) { resolvedCounts[idx]++; resolvedKeys[idx].push(iss.key); }
      }
    }
  }

  const labels = [];
  for (let i = 0; i < nBuckets; i++) {
    if (bucket === 'month') {
      const back = nBuckets - 1 - i;
      const d = new Date(ANCHOR);
      d.setMonth(d.getMonth() - back);
      labels.push(d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
    } else {
      labels.push(fmtDate(ANCHOR - (nBuckets - 1 - i) * bucketMs));
    }
  }

  const datasets = [];
  let net = null;
  if (isNet) {
    /* cumulative net flow: created − resolved, running total → open-backlog shape.
       On [P] boards the series is scoped to the Bug / Backlog / System Improvements
       statuses, so the labels say "backlog" instead of "open backlog". */
    let acc = 0;
    net = createdCounts.map((c, i) => (acc += c - resolvedCounts[i]));
    datasets.push({ label: t(isP ? 'series.pBacklog' : 'series.openBacklog'), data: net, color: '#8b5cf6', rgb: ACCENT_RGB.violet, __keys: createdKeys, __src: issues });
  } else {
    if (wantCreated) datasets.push({ label: t('series.registered'), data: createdCounts, color: '#6366f1', rgb: ACCENT_RGB.indigo, __keys: createdKeys, __src: issues });
    if (wantResolved) datasets.push({ label: t('series.completed'), data: resolvedCounts, color: '#34d399', rgb: ACCENT_RGB.green, __keys: resolvedKeys, __src: issues });
  }

  const parts = [];
  if (isNet) parts.push(t(isP ? 'series.pNetflowDesc' : 'series.netflowDesc'));
  else if (wantCreated && wantResolved) parts.push(t('series.createdVsResolved'));
  else if (wantCreated) parts.push(t('series.created'));
  else parts.push(t('series.resolved'));
  const rangeTxt = hasCustom
    ? `${fmtDate(customWin.from)} – ${fmtDate(customWin.to)}`
    : rangeLabel(def.range);
  const subtitle = `${parts.join(' · ')} · ${tReplace('series.perBucket', { b: t('bucket.' + bucket).toLowerCase() })} · ${rangeTxt}`;

  const total = isNet
    ? (net && net.length ? net[net.length - 1] : 0)
    : (wantCreated ? createdCounts : resolvedCounts).reduce((a, b) => a + b, 0);
  return {
    labels, datasets, duration: false,
    subtitle,
    centerValue: total, centerLabel: isNet ? t('series.openNow') : t('cmp.issues'),
  };
}

/* category aggregation: count / avgCycle / openAge */
function buildCategoryData(def, issues) {
  const metric = METRIC_DEFS[def.metric];
  const NOW = Date.now();
  /* per-chart time range (dropdown): preset day counts and custom calendar
     windows also constrain category charts. Done-only charts window on the
     completion timestamp, everything else on the creation timestamp — issues
     without the relevant timestamp fall outside the window. */
  const win = def.range === RANGE_CUSTOM && def.rangeFrom && def.rangeTo
    ? { from: Date.parse(def.rangeFrom), to: Date.parse(def.rangeTo) }
    : (def.range > 0 ? { from: NOW - def.range * DAY, to: NOW } : null);
  const hasWin = !!(win && isFinite(win.from) && isFinite(win.to) && win.to > win.from);
  const inWindow = (f, iss) => {
    if (!hasWin) return true;
    const ts = def.filter === 'done' ? issueCompletedAt(f, iss.changelog) : (f.created ? Date.parse(f.created) : null);
    return ts != null && ts >= win.from && ts <= win.to;
  };
  const pool = filterPool(def, issues).filter((iss) => inWindow(iss.fields || {}, iss));
  const map = new Map();
  const keysByGroup = new Map();     /* group → issue keys (click → issue list) */
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
    const kArr = keysByGroup.get(key) || [];
    kArr.push(iss.key);
    keysByGroup.set(key, kArr);
  }
  if (!map.size) return { empty: def.metric === 'avgCycle' ? t('cat.noResolved') : t('cat.noIssues') };

  let rows = [...map.entries()].map(([k, r]) => ({
    k, v: metric.duration ? r.sum / r.n : r.sum, n: r.n,
  }));
  if (def.groupBy === 'bottleneck') rows.sort((a, b) => BOTTLENECK_ORDER.indexOf(a.k) - BOTTLENECK_ORDER.indexOf(b.k));
  else if (def.groupBy === 'ageBucket') rows.sort((a, b) => AGE_BUCKETS.findIndex(([l]) => l === a.k) - AGE_BUCKETS.findIndex(([l]) => l === b.k));
  else if (def.groupBy === 'complexity') rows.sort((a, b) => complexityRank(a.k) - complexityRank(b.k));
  else rows.sort((a, b) => b.v - a.v);

  let labels = rows.map((r) => r.k);
  let values = rows.map((r) => metric.duration ? +(r.v / DAY).toFixed(2) : r.v);
  let keys = rows.map((r) => keysByGroup.get(r.k) || []);   /* parallel to labels — click → issue list */
  let colors;
  if (def.groupBy === 'bottleneck') colors = labels.map(bottleneckColor);
  else if (def.groupBy === 'ageBucket') {
    /* heat ramp: fresh = green → ancient = red */
    const ramp = ['#34d399', '#a3e635', '#fbbf24', '#fb923c', '#f87171', '#ef4444', '#b91c1c'];
    colors = labels.map((l) => ramp[AGE_BUCKETS.findIndex(([b]) => b === l)] || '#64748b');
  }
  else if (def.groupBy === 'assigneeState') colors = labels.map((k) => (k === 'Unassigned' ? '#f87171' : '#34d399'));
  else if (def.groupBy === 'complexity') {
    /* fixed S→XL heat ramp: green → amber → orange → red; 'No complexity' stays grey */
    colors = labels.map((k) => (COMPLEXITY_COLORS[complexityShortLabel(k)] || '#64748b'));
  }
  else if (def.groupBy === 'stage') colors = labels.map((k) => (k === 'Stakeholder gates' ? '#fbbf24' : '#22d3ee'));
  else colors = labels.map((_, i) => PALETTE[i % PALETTE.length]);
  /* translate display labels only after color mapping (which matches on raw keys) */
  labels = rows.map((r) => groupKeyLabel(def, r.k));

  /* topN: doughnuts fold the tail into "Other", bars simply cut */
  const topN = def.topN || 0;
  if (topN && values.length > topN) {
    if (def.type === 'doughnut') {
      const headL = labels.slice(0, topN - 1), headV = values.slice(0, topN - 1);
      const rest = values.slice(topN - 1).reduce((a, b) => a + b, 0);
      labels = headL.concat([t('group.other')]);
      values = headV.concat([rest]);
      colors = colors.slice(0, topN - 1).concat(['#64748b']);
      keys = keys.slice(0, topN - 1).concat([keys.slice(topN - 1).flat()]);
    } else {
      labels = labels.slice(0, topN); values = values.slice(0, topN); colors = colors.slice(0, topN);
      keys = keys.slice(0, topN);
    }
  }
  if (def.type === 'hbar') { labels = labels.slice().reverse(); values = values.slice().reverse(); colors = colors.slice().reverse(); keys = keys.slice().reverse(); }

  const totalVal = metric.duration
    ? [...map.values()].reduce((a, r) => a + r.sum, 0) / [...map.values()].reduce((a, r) => a + r.n, 0)
    : values.reduce((a, b) => a + b, 0);

  const filterTxt = def.filter === 'open' ? ` · ${t('filter.openOnly')}` : def.filter === 'done' ? ` · ${t('filter.doneOnly')}` : '';
  const rangeTxt = hasWin
    ? (def.range === RANGE_CUSTOM ? ` · ${fmtDate(win.from)} – ${fmtDate(win.to)}` : ` · ${rangeLabel(def.range)}`)
    : '';
  const subtitle = `${metric.duration ? t('series.avg') : t('series.count')} ${tReplace('series.byGroup', { g: groupLabel(def.groupBy) || GROUP_LABELS[def.groupBy] || def.groupBy })}${metric.duration ? '' : filterTxt}${rangeTxt}`;
  return {
    labels,
    datasets: [{ label: def.title, data: values, color: ACCENT_HEX[def.color] || ACCENT_HEX.indigo, rgb: ACCENT_RGB[def.color] || ACCENT_RGB.indigo, __keys: keys, __src: issues }],
    colors,
    duration: metric.duration,
    subtitle,
    centerValue: metric.duration ? fmtDuration(totalVal) : Math.round(totalVal),
    centerLabel: metric.duration ? t('cmp.avg') : t('cmp.issues'),
  };
}

/* status-time aggregation from changelog (avgStatusTime metric) */
function buildStatusTimeData(def, m, hasChangelog, issues) {
  const hc = hasChangelog != null ? hasChangelog : state.hasChangelog;
  if (!hc || !m || !m.statusTime) return { empty: [t('statusTime.noChangelog1'), t('statusTime.noChangelog2')] };

  const keyMap = m.statusKeys || new Map();
  let rows = [...m.statusTime.entries()]
    .map(([k, v]) => ({ k, avg: v.sum / v.n, side: classifySide(k), sum: v.sum, n: v.n, keys: keyMap.get(k) || [] }));
  if (!rows.length) return { empty: [t('statusTime.noTransitions')] };

  let extraSub = '';
  let labels, values, colors;
  let keys = [];                     /* per-bar/per-point issue keys (click → issue list) */

  if (def.groupBy === 'stage') {
    const agg = { 'Stakeholder gates': { sum: 0, n: 0 }, 'Team phases': { sum: 0, n: 0 }, 'IT Committee': { sum: 0, n: 0 } };
    const aggKeys = { 'Stakeholder gates': [], 'Team phases': [], 'IT Committee': [] };
    for (const r of rows) {
      if (!r.side) continue;
      const t = r.side === 'stakeholder' ? 'Stakeholder gates' : r.side === 'itcommittee' ? 'IT Committee' : 'Team phases';
      agg[t].sum += r.sum; agg[t].n += r.n;
      aggKeys[t].push(...r.keys);
    }
    rows = Object.entries(agg).filter(([, r]) => r.n).map(([k, r]) => ({ k, avg: r.sum / r.n }));
    if (!rows.length) return { empty: [t('statusTime.noStages')] };
    rows.sort((a, b) => b.avg - a.avg);
    labels = rows.map((r) => stageLabel(r.k));
    values = rows.map((r) => +(r.avg / DAY).toFixed(2));
    colors = rows.map((r) => (r.k === 'Stakeholder gates' ? '#fbbf24cc' : r.k === 'IT Committee' ? '#8b5cf6cc' : '#22d3eecc'));
    keys = rows.map((r) => aggKeys[r.k] || []);
  } else if (def.split === 'stage') {
    const picked = rows.filter((r) => r.side).sort((a, b) => b.avg - a.avg).slice(0, def.topN || 8);
    if (!picked.length) return { empty: [t('statusTime.noStages')] };
    const sh = [], tm = [], it = [];
    picked.forEach((r) => {
      const d = +(r.avg / DAY).toFixed(1);
      if (r.side === 'stakeholder') { sh.push(d); tm.push(null); it.push(null); }
      else if (r.side === 'itcommittee') { it.push(d); sh.push(null); tm.push(null); }
      else { tm.push(d); sh.push(null); it.push(null); }
    });
    labels = picked.map((r) => titleize(r.k)).reverse();
    let shAvg = null, tmAvg = null, itAvg = null, sS = 0, sN = 0, tS = 0, tN = 0, iS = 0, iN = 0;
    picked.forEach((r) => { if (r.side === 'stakeholder') { sS += r.sum; sN++; } else if (r.side === 'itcommittee') { iS += r.sum; iN++; } else { tS += r.sum; tN++; } });
    if (sN) shAvg = sS / sN;
    if (tN) tmAvg = tS / tN;
    if (iN) itAvg = iS / iN;
    extraSub =
      `<span style="color:#fcd34d">●</span> ${t('statusTime.stakeholderAvg')} <b>${shAvg != null ? fmtDuration(shAvg) : '—'}</b>` +
      ` &nbsp;·&nbsp; <span style="color:#67e8f9">●</span> ${t('statusTime.teamAvg')} <b>${tmAvg != null ? fmtDuration(tmAvg) : '—'}</b>` +
      (itAvg != null ? ` &nbsp;·&nbsp; <span style="color:#a78bfa">●</span> ${t('statusTime.itAvg')} <b>${fmtDuration(itAvg)}</b>` : '');
    return {
      labels,
      datasets: [
        { label: t('stage.stakeholder'), data: sh.reverse(), color: '#fbbf24', rgb: ACCENT_RGB.amber, __keys: picked.map((r) => r.keys).reverse(), __src: issues },
        { label: t('stage.team'), data: tm.reverse(), color: '#22d3ee', rgb: ACCENT_RGB.cyan, __keys: picked.map((r) => r.keys).reverse(), __src: issues },
        { label: t('stage.it'), data: it.reverse(), color: '#8b5cf6', rgb: ACCENT_RGB.violet, __keys: picked.map((r) => r.keys).reverse(), __src: issues },
      ],
      duration: true,
      subtitle: t('statusTime.subSplit'),
      extraSub,
    };
  } else {
    rows.sort((a, b) => b.avg - a.avg);
    rows = rows.slice(0, def.topN || 10);
    labels = rows.map((r) => r.k).reverse();
    values = rows.map((r) => +(r.avg / DAY).toFixed(2)).reverse();
    colors = labels.map(() => (ACCENT_HEX[def.color] || '#8b5cf6') + 'cc');
    keys = rows.map((r) => r.keys).reverse();
  }

  return {
    labels,
    datasets: [{ label: def.title, data: values, color: ACCENT_HEX[def.color] || ACCENT_HEX.violet, rgb: ACCENT_RGB[def.color] || ACCENT_RGB.violet, __keys: keys, __src: issues }],
    colors,
    duration: true,
    subtitle: def.groupBy === 'stage' ? t('statusTime.subStage') : t('statusTime.subStatus'),
    extraSub,
  };
}

/* which board is the chart currently being built for?
   - public share view: the snapshot's board (or the clicked board inside an 'all' snapshot)
   - admin app: the currently selected dashboard board
   Used by the netflow metric to apply [P]-board backlog semantics. */
function currentChartBoardName() {
  if (state.inShareScreen) {
    return pubState.currentBoard?.name || pubState.snapshot?.boardName || '';
  }
  if (isMasterPBoard(state.lastBoard)) return state.lastBoard.name;   /* master [P] board */
  const b = state.boards.find((x) => x.id === state.boardId);
  return b?.name || '';
}

function buildChartData(def, m, issues, hasChangelog) {
  const metric = METRIC_DEFS[def.metric];
  const iss = issues || state.issues;
  const hc = hasChangelog != null ? hasChangelog : state.hasChangelog;
  if (!metric) return { empty: [t('err.unknownMetric')] };
  if (metric.kind === 'time') return buildTimeSeries(def, iss, { boardName: currentChartBoardName() });
  if (metric.kind === 'statusTime') return buildStatusTimeData(def, m, hc, iss);
  return buildCategoryData(def, iss);
}

/* ── chart card rendering ────────────────────────────────────────── */
const LEGEND_ON = { display: true, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, padding: 14 } };

function chartCardHTML(def, overridden) {
  const scopeClass = def.scope === 'global' ? ' global' : '';
  const scopeChip = def.builtin
    ? ''
    : `<span class="scope-chip${scopeClass}">${escapeHtml(def.scope === 'global' ? t('chart.scopeGlobal') : t('chart.scopeBoard'))}</span>`;
  const actions = canModify()
    ? (def.builtin
        ? `<button class="chart-btn" data-act="edit" data-id="${def.id}" title="${escapeHtml(t('chart.btnEdit'))}">✎</button>` +
          (overridden ? `<button class="chart-btn" data-act="reset" data-id="${def.id}" title="${escapeHtml(t('chart.btnReset'))}">↺</button>` : '') +
          `<button class="chart-btn" data-act="hide" data-id="${def.id}" title="${escapeHtml(t('chart.btnHide'))}">✕</button>`
        : `<button class="chart-btn" data-act="edit" data-id="${def.id}" title="${escapeHtml(t('chart.btnEdit'))}">✎</button>` +
          `<button class="chart-btn" data-act="del" data-id="${def.id}" title="${escapeHtml(t('chart.btnDelete'))}">🗑</button>`)
    : '';
  /* per-chart time-range dropdown (top-right of the card): shows the effective
     range, one-click presets + a calendar option that opens a from–to picker.
     avgStatusTime charts are changelog-lifetime aggregates — no range applies. */
  const rangeCapable = def.metric !== 'avgStatusTime';
  const rangeCtl = rangeCapable
    ? `<div class="chart-range" data-rid="${def.id}">
        <button type="button" class="chart-range-btn" data-act="range" data-id="${def.id}" title="${escapeHtml(t('range.title'))}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <span class="chart-range-label">${escapeHtml(rangeLabel(def.range))}</span>
          <span class="chart-range-caret">▾</span>
        </button>
        <div class="chart-range-menu hidden" data-rmenu="${def.id}">
          ${RANGE_OPTIONS.map(([v]) => `<button type="button" class="chart-range-opt${def.range === v ? ' active' : ''}" data-rv="${v}" data-rid="${def.id}">${escapeHtml(rangeLabel(v))}</button>`).join('')}
          <button type="button" class="chart-range-opt chart-range-custom${def.range === RANGE_CUSTOM ? ' active' : ''}" data-rv="${RANGE_CUSTOM}" data-rid="${def.id}">${escapeHtml(t('range.pickCustom'))}</button>
          <div class="chart-range-cal hidden" data-rcal="${def.id}">
            <label class="chart-range-cal-row"><span>${escapeHtml(t('range.from'))}</span><input type="date" class="chart-range-date" data-rfrom="${def.id}"></label>
            <label class="chart-range-cal-row"><span>${escapeHtml(t('range.to'))}</span><input type="date" class="chart-range-date" data-rto="${def.id}"></label>
            <button type="button" class="chart-range-apply" data-rapply="${def.id}">${escapeHtml(t('range.apply'))}</button>
          </div>
        </div>
      </div>`
    : '';
  return `<div class="card glass chart-card${def.wide ? ' wide' : ''}" data-cid="${def.id}">
    <div class="chart-head">
      <div class="chart-titles">
        <h3>${escapeHtml(defTitle(def))} ${scopeChip}</h3>
        <span class="chart-sub" id="sub_${def.id}">${escapeHtml(defSubtitle(def) || '')}</span>
      </div>
      <div class="chart-actions">${rangeCtl}${actions}</div>
    </div>
    <div class="canvas-wrap"><canvas id="chart_${def.id}"></canvas></div>
  </div>`;
}

/* ── per-chart time-range dropdown (shared by admin + pub + compare) ──
   Admin persists overrides in the regular chart store (↺ reset clears them);
   pub viewers get their own localStorage map (the admin store is keyed by the
   signed-in domain, which viewers don't have). */
const PUB_RANGE_KEY = 'jp_pub_chart_ranges_v1';

function pubRangeStore() {
  try { return JSON.parse(localStorage.getItem(PUB_RANGE_KEY) || '{}'); }
  catch (_) { return {}; }
}

/* apply a range change to one chart and re-render the active view */
function setChartRange(id, patch) {
  if (state.inShareScreen) {
    const s = pubRangeStore();
    s[id] = { ...(s[id] || {}), ...patch };
    try { localStorage.setItem(PUB_RANGE_KEY, JSON.stringify(s)); } catch (_) { /* non-fatal */ }
    renderPubContent();
    return;
  }
  const store = loadChartStore();
  if (BUILTIN_DEFS.some((b) => b.id === id)) {
    store.overrides[id] = { ...(store.overrides[id] || {}), ...patch };
  } else {
    const c = store.custom.find((x) => x.id === id);
    if (c) Object.assign(c, patch);
    else store.overrides[id] = { ...(store.overrides[id] || {}), ...patch };
  }
  saveChartStore(store);
  rerenderDashboard();
}

/* close every open range menu (outside-click + re-open hygiene) */
function closeChartRangeMenus(root) {
  (root || document).querySelectorAll('.chart-range-menu').forEach((m) => m.classList.add('hidden'));
  (root || document).querySelectorAll('.chart-range-cal').forEach((c) => c.classList.add('hidden'));
}

/* wire one grid's range dropdowns: button toggle, preset pick, calendar apply */
function wireChartRangeControls(root, defs) {
  if (!root) return;
  const defById = new Map((defs || []).map((d) => [d.id, d]));
  const iso = (ts) => new Date(ts).toISOString().slice(0, 10);

  root.querySelectorAll('.chart-range-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const menu = root.querySelector(`[data-rmenu="${btn.dataset.id}"]`);
      if (!menu) return;
      const wasOpen = !menu.classList.contains('hidden');
      closeChartRangeMenus(root);
      if (!wasOpen) {
        menu.classList.remove('hidden');
        /* prefill the calendar with the current custom window (or last 30 days) */
        const def = defById.get(btn.dataset.id) || {};
        const from = root.querySelector(`[data-rfrom="${btn.dataset.id}"]`);
        const to = root.querySelector(`[data-rto="${btn.dataset.id}"]`);
        if (from) from.value = def.rangeFrom || iso(Date.now() - 30 * DAY);
        if (to) to.value = def.rangeTo || iso(Date.now());
      }
    });
  });

  root.querySelectorAll('.chart-range-opt').forEach((opt) => {
    opt.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = opt.dataset.rid;
      const rv = parseInt(opt.dataset.rv, 10);
      if (rv === RANGE_CUSTOM) {
        /* reveal the calendar panel inside this menu */
        const cal = root.querySelector(`[data-rcal="${id}"]`);
        if (cal) cal.classList.remove('hidden');
        return;
      }
      setChartRange(id, { range: rv, rangeFrom: null, rangeTo: null });
    });
  });

  root.querySelectorAll('.chart-range-apply').forEach((apply) => {
    apply.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = apply.dataset.rapply;
      const from = root.querySelector(`[data-rfrom="${id}"]`);
      const to = root.querySelector(`[data-rto="${id}"]`);
      const f = from?.value ? Date.parse(from.value) : null;
      const tMs = to?.value ? Date.parse(to.value) : null;
      if (!f || !tMs || !isFinite(f) || !isFinite(tMs) || tMs < f) { toast(t('range.invalid'), 'warn'); return; }
      setChartRange(id, { range: RANGE_CUSTOM, rangeFrom: from.value, rangeTo: to.value });
    });
  });

  root.querySelectorAll('.chart-range-date').forEach((inp) => {
    inp.addEventListener('click', (ev) => ev.stopPropagation());
  });

  /* one outside-click closer per render batch */
  if (!wireChartRangeControls._docWired) {
    wireChartRangeControls._docWired = true;
    document.addEventListener('click', () => closeChartRangeMenus(document));
  }
}

function chartConfigFor(def, data, theme, canvasId) {
  const dur = data.duration;
  const fmtV = dur ? (v) => fmtDuration(v * DAY) : (v) => String(Math.round(v));
  const fmtNum = (v) => (v == null || !isFinite(v) ? '—' : String(Math.round(v)));
  const tc = themeColors();   /* theme-aware chart edge/hover colors */

  /* click a data point → open the issue-list modal for that slice/point.
     Doughnut: index → group label. Line/bar: index → bucket/group, dataset
     carries the per-point key list + the source issue pool (__keys/__src). */
  const chartOnClick = (evt, elements, chart) => {
    if (!elements || !elements.length) return;
    const el = elements[0];
    const dsIndex = el.datasetIndex ?? 0;
    const idx = el.index;
    const ds = data.datasets[dsIndex];
    if (!ds) return;
    const label = data.labels?.[idx];
    let issues = ds.__src || [];
    if (Array.isArray(ds.__keys) && ds.__keys[idx]) issues = ds.__keys[idx];
    const series = data.datasets.length > 1 ? (ds.label || '') : '';
    openIssueListModal(defTitle(def), label, issues, series);
  };
  const chartOnHover = (evt, els) => { if (evt.native) evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; };

  if (def.type === 'doughnut') {
    const multi = data.datasets.length > 1;
    const baseDs = (ds, i) => ({
      data: ds.data,
      borderColor: tc.edge,
      borderWidth: 2,
      hoverOffset: 10,
      hoverBorderColor: tc.edgeHover,
      __keys: ds.__keys,
      __src: ds.__src,
      /* ring 0 keeps the full palette; rings 1+ (boards B/C) are softened +
         outlined so the rings stay visually distinct without losing the hue
         match (softening deepens with each ring) */
      backgroundColor: multi && i > 0
        ? (data.colors || []).map((c) => c + (i === 1 ? 'b3' : '80'))
        : data.colors,
      label: multi ? (ds.label || '') : undefined,
    });
    return {
      type: 'doughnut',
      data: {
        labels: data.labels,
        datasets: data.datasets.map((ds, i) => baseDs(ds, i)),
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: def.centerTotal ? (multi ? (data.datasets.length > 2 ? '38%' : '44%') : '68%') : '62%',
        layout: { padding: 4 },
        onClick: chartOnClick,
        onHover: chartOnHover,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 12, font: { size: 11 } } },
          tooltip: {
            ...theme.plugins.tooltip,
            callbacks: {
              label: (c) => {
                const tot = c.dataset.data.reduce((a, b) => a + b, 0);
                const pct = tot ? Math.round(c.parsed / tot * 100) : 0;
                return multi ? ` ${c.dataset.label}: ${fmtV(c.parsed)} · ${pct}%` : ` ${fmtV(c.parsed)} · ${pct}%`;
              },
            },
          },
          centerText: def.centerTotal
            ? (multi
              ? { enable: true, values: data.centerValues, label: data.centerLabel }
              : { enable: true, value: data.centerValue, label: data.centerLabel })
            : { enable: false },
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
      g.addColorStop(0, `rgba(${rgb},.30)`);
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
          fill: true, tension: 0.35,
          pointRadius: 2, pointHoverRadius: 5,
          pointBackgroundColor: ds.color, pointBorderColor: tc.edge, pointBorderWidth: 1.5,
          borderWidth: 2.5,
          __keys: ds.__keys, __src: ds.__src,
        })),
      },
      options: {
        ...theme,
        interaction: { mode: 'index', intersect: false },
        onClick: chartOnClick,
        onHover: chartOnHover,
        plugins: {
          ...theme.plugins,
          legend: data.datasets.length > 1 ? LEGEND_ON : { display: false },
          tooltip: {
            ...theme.plugins.tooltip,
            callbacks: {
              label: (c) => {
                const tot = c.dataset.data.reduce((a, b) => a + (b || 0), 0);
                return ` ${c.dataset.label}: ${fmtNum(c.parsed.y)}${tot ? ` (${Math.round((c.parsed.y || 0) / tot * 100)}%)` : ''}`;
              },
            },
          },
        },
        elements: { line: { capBezierPoints: true } },
      },
    };
  }

  /* bar / hbar */
  const isH = def.type === 'hbar';
  const multi = data.datasets.length > 1;
  const hasPerBarColors = !multi && data.colors && data.colors.length === data.labels.length;
  const totSeries = data.datasets[0].data.reduce((a, b) => a + (b || 0), 0);
  return {
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: data.datasets.map((ds) => ({
        label: ds.label, data: ds.data,
        backgroundColor: multi ? ds.color + 'cc' : (hasPerBarColors ? data.colors : ds.color + 'cc'),
        hoverBackgroundColor: multi ? ds.color : (hasPerBarColors ? data.colors : ds.color),
        borderRadius: 7, borderSkipped: false,
        barPercentage: multi ? 0.58 : 0.68, categoryPercentage: 0.72,
        maxBarThickness: 46,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      indexAxis: isH ? 'y' : 'x',
      onClick: chartOnClick,
      onHover: chartOnHover,
      plugins: {
        legend: multi ? LEGEND_ON : { display: false },
        tooltip: {
          ...theme.plugins.tooltip,
          callbacks: {
            label: (c) => {
              const v = c.parsed[isH ? 'x' : 'y'];
              if (v == null) return '';
              /* single-series count charts get a share-of-total hint */
              if (!multi && !dur && totSeries > 0) {
                return ` ${fmtV(v)} · ${Math.round(v / totSeries * 100)}%`;
              }
              return ` ${fmtV(v)}`;
            },
          },
        },
      },
      scales: isH
        ? {
            x: { ...theme.scales.x, ...(dur ? { ticks: { callback: (v) => v + 'd' } } : {}), grid: { color: 'rgba(255,255,255,.05)' } },
            y: { grid: { display: false }, ticks: { precision: 0 } },
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
    grid.innerHTML = '<div class="card glass chart-card wide" style="text-align:center;padding:34px;color:var(--muted)">' + escapeHtml(t('chart.noneYet')) + '</div>';
  } else {
    grid.innerHTML = defs.map((d) => chartCardHTML(d, !d.builtin ? false : !!store.overrides[d.id])).join('');
  }

  /* hidden built-ins restore strip */
  const strip = $('#hiddenChartsStrip');
  if (store.hidden.length) {
    strip.innerHTML = escapeHtml(t('chart.hiddenStrip')) + ' ' + store.hidden.map((id) => {
      const b = BUILTIN_DEFS.find((x) => x.id === id);
      return `<button class="link-btn" data-restore="${id}">${escapeHtml(b ? b.title : id)} ↺</button>`;
    }).join(' ');
    show(strip);
  } else {
    hide(strip);
  }

  const theme = chartTheme();
  /* compare mode: overlay boards B (and C) onto every non-doughnut chart using
     the snapshots stored in state.compare / state.compareC */
  const cmp = state.compare && state.compare.metrics ? state.compare : null;
  const cmpC = state.compareC && state.compareC.metrics ? state.compareC : null;
  for (const def of defs) {
    const canvasId = 'chart_' + def.id;
    const data = cmp
      ? buildCompareChartData(
        def,
        { metrics: m, issues: state.issues, hasChangelog: state.hasChangelog },
        { metrics: cmp.metrics, issues: cmp.issues, hasChangelog: cmp.hasChangelog },
        ...(cmpC ? [{ metrics: cmpC.metrics, issues: cmpC.issues, hasChangelog: cmpC.hasChangelog }] : []),
      )
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

    /* compare mode: per-chart winner chip — same overlay verdict as the pub view */
    if (cmp && card) {
      const chip = compareChartWinnerChip(def, data, {
        recA: { metrics: m }, recB: { metrics: cmp.metrics },
        ...(cmpC ? { recC: { metrics: cmpC.metrics } } : {}),
        nameA: state.lastBoard?.name, nameB: cmp.board?.name, nameC: cmpC?.board?.name,
      });
      if (chip) card.querySelector('.chart-actions')?.insertAdjacentHTML('afterbegin', chip);
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
  /* per-chart time-range dropdowns (top-right of each card) */
  wireChartRangeControls(grid, defs);
  strip.querySelectorAll('[data-restore]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = loadChartStore();
      s.hidden = s.hidden.filter((id) => id !== btn.dataset.restore);
      saveChartStore(s);
      rerenderDashboard();
      toast(t('chart.restored'), 'ok');
    });
  });
}

/* determine if a chart will have meaningful data */
function getDataAvailabilityBadge(def, data, m) {
  if (data.empty) {
    if (def.metric === 'avgStatusTime' || def.split === 'stage') {
      if (!state.hasChangelog) {
        return `<span class="data-badge missing" title="${escapeHtml(t('badge.noChangelogTitle'))}">⚠ ${escapeHtml(t('badge.noChangelog'))}</span>`;
      }
    }
    if (def.metric === 'openAge' || def.filter === 'open') {
      if (!m.wip) return `<span class="data-badge missing" title="${escapeHtml(t('badge.noOpenTitle'))}">⚠ ${escapeHtml(t('badge.noOpen'))}</span>`;
    }
    return `<span class="data-badge warn" title="${escapeHtml(t('badge.noDataTitle'))}">⚠ ${escapeHtml(t('badge.noData'))}</span>`;
  }
  if (def.metric === 'avgStatusTime' || def.split === 'stage') {
    if (!state.hasChangelog) {
      return `<span class="data-badge missing" title="${escapeHtml(t('badge.noChangelogTitle'))}">⚠ ${escapeHtml(t('badge.noChangelog'))}</span>`;
    }
    return `<span class="data-badge ok" title="${escapeHtml(t('badge.changelogOkTitle'))}">✓ ${escapeHtml(t('badge.changelog'))}</span>`;
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
    toast(t('toast.hiddenChart'));
  } else if (act === 'reset') {
    delete store.overrides[id];
    store.hidden = store.hidden.filter((x) => x !== id);
    saveChartStore(store);
    rerenderDashboard();
    toast(t('toast.chartReset'), 'ok');
  } else if (act === 'del') {
    if (!custom) return;
    if (!confirm(tReplace('confirm.deleteChart', { title: custom.title }))) return;
    store.custom = store.custom.filter((c) => c.id !== id);
    saveChartStore(store);
    rerenderDashboard();
    toast(t('toast.chartDeleted'), 'ok');
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
    meta.mode === 'new' ? t('chart.newTitle') : tReplace('chart.configureTitle', { title: def.title });

  $('#cTitle').value = def.title || '';
  buildSeg($('#cType'), [['line', t('chart.segLine')], ['bar', t('chart.segBar')], ['hbar', t('chart.segHbar')], ['doughnut', t('chart.segDoughnut')]], def.type || 'bar');
  buildSeg($('#cScope'), [['board', t('chart.segBoard')], ['global', t('chart.segGlobal')]], def.scope === 'global' ? 'global' : 'board');

  $('#cMetric').innerHTML = Object.entries(METRIC_DEFS)
    .map(([k, v]) => `<option value="${k}">${escapeHtml(metricLabel(k))}</option>`).join('');
  $('#cMetric').value = def.metric || 'count';
  $('#cRange').innerHTML = RANGE_OPTIONS
    .map(([v], i) => `<option value="${v}">${escapeHtml(rangeLabel(v))}</option>`).join('')
    + `<option value="${RANGE_CUSTOM}">${escapeHtml(t('range.custom'))}</option>`;
  $('#cRange').value = String(def.range ?? 90);
  $('#cRangeCustomWrap').classList.toggle('hidden', String(def.range) !== String(RANGE_CUSTOM));
  $('#cRangeFrom').value = def.rangeFrom || '';
  $('#cRangeTo').value = def.rangeTo || '';
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
    $('#cGroup').innerHTML = opts.map(([v, l]) => `<option value="${v}">${escapeHtml(groupLabel(v) || l)}</option>`).join('');
    if (opts.some(([v]) => v === cur)) $('#cGroup').value = cur;
  }

  $('#cBucketWrap').classList.toggle('hidden', kind !== 'time');
  $('#cSplitWrap').classList.toggle('hidden', !(metric === 'avgStatusTime' && $('#cGroup').value === 'status'));
  $('#cRangeWrap').classList.toggle('hidden', metric === 'avgStatusTime');
  $('#cRangeCustomWrap').classList.toggle('hidden', metric === 'avgStatusTime' || $('#cRange').value !== String(RANGE_CUSTOM));
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
  if (def.range === RANGE_CUSTOM) {
    def.rangeFrom = $('#cRangeFrom').value || null;
    def.rangeTo = $('#cRangeTo').value || null;
    if (!def.rangeFrom || !def.rangeTo) { toast(t('range.invalid'), 'warn'); return null; }
  } else {
    def.rangeFrom = null;
    def.rangeTo = null;
  }
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
    toast(t('chart.titleRequired'), 'warn');
    return;
  }

  const store = loadChartStore();
  if (edit.mode === 'new') {
    const def = chartDefFromForm({
      id: 'c' + Date.now().toString(36),
      scope: segGet($('#cScope')) === 'global' ? 'global' : 'board',
      boardId: state.boardId,
    });
    if (!def) return;   /* invalid custom range — toast already shown */
    if (def.scope === 'global') def.boardId = null;
    store.custom.push(def);
    toast(def.scope === 'global' ? t('chart.addedAll') : t('chart.addedBoard'), 'ok');
  } else if (edit.mode === 'custom') {
    const def = chartDefFromForm(edit.def);
    if (!def) return;
    def.scope = segGet($('#cScope')) === 'global' ? 'global' : 'board';
    def.boardId = def.scope === 'global' ? null : state.boardId;
    store.custom = store.custom.map((c) => (c.id === def.id ? def : c));
    toast(t('chart.updated'), 'ok');
  } else if (edit.mode === 'builtin') {
    const def = chartDefFromForm(edit.def);
    if (!def) return;
    const override = {};
    for (const k of ['title', 'subtitle', 'type', 'metric', 'groupBy', 'bucket', 'range', 'rangeFrom', 'rangeTo', 'filter', 'topN', 'split', 'color', 'wide', 'centerTotal']) {
      override[k] = def[k];
    }
    store.overrides[edit.def.id] = override;
    store.hidden = store.hidden.filter((x) => x !== edit.def.id);
    toast(t('chart.updatedAll'), 'ok');
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
  toast(t('toast.chartReset'), 'ok');
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
  toast(t('toast.chartDeleted'), 'ok');
}

/* ── rendering ───────────────────────────────────────────────────── */
const PALETTE = ['#6366f1', '#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#38bdf8', '#fb923c'];

/* ── status intelligence ─────────────────────────────────────────── */
/* Stakeholder gates: approvals, sign-offs, external reviews.
   Team phases: development, testing, QA work. */
const RE_STAKEHOLDER = /(business\s*owner|internal\s*it|\bbd\b|business\s*development|approv|sign[\s-]?off|steering|compliance|\blegal\b|security\s*review|acceptance)/;
const RE_TEAM = /(dev|cod(e|ing)|build|implement|\bbug|\bqa\b|test|uat|verif|integrat|refactor|deploy|release)/;

/* IT-committee gate: "Internal IT Approval" and similar are the IT committee's
   responsibility — neither the stakeholder's nor the team's delay. Checked BEFORE
   the stakeholder regex (which would otherwise match 'internal it' + 'approv'). */
const RE_IT_COMMITTEE = /(internal\s*it|\bit\s*committe)/;

function classifySide(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return null;
  if (RE_IT_COMMITTEE.test(s)) return 'itcommittee';
  if (RE_STAKEHOLDER.test(s)) return 'stakeholder';
  if (RE_TEAM.test(s)) return 'team';
  return null;
}

/* Bottleneck buckets for open work. First matching rule wins, so order matters:
   UAT before Testing (so "UAT"/"UAT Approved" don't lump into Testing), and
   Ready-for-Release before the generic approval/review catch-all. */
const BOTTLENECK_RULES = [
  { cat: 'UAT',               color: '#f472b6', re: /\b(uat|user\s*acceptance)/ },
  { cat: 'Testing',           color: '#22d3ee', re: /\b(qa|test|verif|regression)/ },
  { cat: 'Ready for Release', color: '#34d399', re: /(ready\s*for\s*(release|deploy|prod)|awaiting\s*(release|deploy)|release\s*candidate|pre[\s-]*release|uat\s*(approved|passed))/ },
  { cat: 'In Development',    color: '#6366f1', re: /(ready\s*for\s*dev|\bdev|develop|\bbug|cod(e|ing)\b|in\s*progress|implement)/ },
  { cat: 'Pending Review',    color: '#fbbf24', re: /(pre[\s-]*analys|business\s*owner|product\s*owner|\bbd\b)/ },
  { cat: 'Technical Analysis', color: '#8b5cf6', re: /(technical|internal\s*it|analys|analyz|investigat|estimat|specificat|\bspec\b|solution|design)/ },
  { cat: 'Pending Review',    color: '#fbbf24', re: /(approv|review|pending|waiting|hold|block)/ },
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
const BOTTLENECK_ORDER = ['Pending Review', 'Technical Analysis', 'In Development', 'Testing', 'UAT', 'Ready for Release', 'Other'];
const BOTTLENECK_I18N = {
  'Pending Review': 'bn.pendingReview', 'Technical Analysis': 'bn.techAnalysis',
  'In Development': 'bn.inDevelopment', 'Testing': 'bn.testing',
  'UAT': 'bn.uat', 'Ready for Release': 'bn.readyForRelease', 'Other': 'group.other',
};
function bottleneckLabel(cat) { return t(BOTTLENECK_I18N[cat], cat); }

/* draws a big number + label inside doughnut holes. In compare mode the hole
   is wider, so every compared board's total is stacked around the label —
   A (indigo), B (cyan), C (green) — one glance answers "which board holds
   more". Three boards shrink the fonts to keep the stack inside the hole. */
const CMP_CENTER_COLORS = ['#a5b4fc', '#67e8f9', '#6ee7b7'];
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
    const values = Array.isArray(opts.values) ? opts.values : null;
    if (values && values.length) {
      /* N-board center: values stacked around the shared label.
         2 boards → A / label / B (16px steps); 3 boards → A / B / C with the
         label tucked under, fonts shrunk to fit the wider hole. */
      const n = values.length;
      const rows = [];
      if (n === 2) {
        rows.push({ txt: values[0], font: '800 20px Inter, system-ui', color: CMP_CENTER_COLORS[0], dy: -16 });
        rows.push({ txt: opts.label, font: '700 9px Inter, system-ui', color: themeColors().muted, dy: 0, upper: true });
        rows.push({ txt: values[1], font: '800 20px Inter, system-ui', color: CMP_CENTER_COLORS[1], dy: 16 });
      } else {
        const step = 15;
        const start = -((n - 1) / 2) * step;
        for (let i = 0; i < n; i++) {
          rows.push({ txt: values[i], font: '800 14px Inter, system-ui', color: CMP_CENTER_COLORS[i % CMP_CENTER_COLORS.length], dy: start + i * step });
        }
        rows.push({ txt: opts.label, font: '700 8px Inter, system-ui', color: themeColors().muted, dy: start + n * step, upper: true });
      }
      for (const r of rows) {
        ctx.font = r.font;
        ctx.fillStyle = r.color;
        ctx.fillText(r.upper ? String(r.txt ?? '').toUpperCase() : String(r.txt ?? ''), x, y + r.dy);
      }
    } else if (opts.valueB != null && opts.valueB !== '') {
      /* legacy two-board center: A value / shared label / B value */
      ctx.font = '800 20px Inter, system-ui';
      ctx.fillStyle = '#a5b4fc';
      ctx.fillText(String(opts.value ?? ''), x, y - 16);
      ctx.font = '700 9px Inter, system-ui';
      ctx.fillStyle = themeColors().muted;
      ctx.fillText(String(opts.label ?? '').toUpperCase(), x, y);
      ctx.font = '800 20px Inter, system-ui';
      ctx.fillStyle = '#67e8f9';
      ctx.fillText(String(opts.valueB), x, y + 16);
    } else {
      ctx.font = '800 26px Inter, system-ui';
      ctx.fillStyle = themeColors().text;
      ctx.fillText(String(opts.value ?? ''), x, y - 7);
      ctx.font = '700 10px Inter, system-ui';
      ctx.fillStyle = themeColors().muted;
      ctx.fillText(String(opts.label ?? '').toUpperCase(), x, y + 14);
    }
    ctx.restore();
  },
};
Chart.register(centerTextPlugin);

function chartTheme() {
  const tc = themeColors();
  Chart.defaults.color = tc.muted;
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: tc.tooltipBg,
        borderColor: tc.tooltipBorder,
        borderWidth: 1,
        padding: 10,
        cornerRadius: 9,
        titleFont: { weight: '700' },
        titleColor: tc.tooltipText,
        bodyColor: tc.tooltipText,
      },
    },
    scales: {
      x: { grid: { color: tc.grid }, ticks: { maxTicksLimit: 10, color: tc.muted } },
      y: { grid: { color: tc.grid }, ticks: { precision: 0, color: tc.muted } },
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
    out.push({ icon: '⛔', cls: 'ins-warn', html: tReplace('ins.bottleneck', { n, cat: escapeHtml(cat), ns: n === 1 ? '' : 's' }) });
  }
  if (m.phaseDelays.length) {
    const w = m.phaseDelays[0];
    out.push({ icon: '⏳', cls: 'ins-warn', html: tReplace('ins.slowest', { s: escapeHtml(titleize(w.status)), d: fmtDuration(w.avg) }) });
  }
  const thr = pctDelta(m.resolvedPrev30, m.resolved30);
  if (thr !== null) {
    out.push({ icon: thr >= 0 ? '📈' : '📉', cls: thr >= 0 ? 'ins-good' : 'ins-bad', html: tReplace('ins.throughput', { p: (thr >= 0 ? '+' : '') + thr }) });
  }
  const aged = m.slow.filter((r) => r.age > 14 * DAY).length;
  if (aged) {
    out.push({ icon: '🧊', cls: 'ins-bad', html: tReplace('ins.aged', { n: aged, ns: aged === 1 ? '' : 's' }) });
  }
  if (m.created30 || m.resolved30) {
    const net = m.resolved30 - m.created30;
    out.push({
      icon: net >= 0 ? '✅' : '📥',
      cls: net >= 0 ? 'ins-good' : 'ins-warn',
      html: tReplace('ins.netFlow', { n: (net >= 0 ? '+' : '') + net, w: net >= 0 ? t('ins.shrinking') : t('ins.growing') }),
    });
  }
  return out.slice(0, 4);
}

/* clear the dashboard and show a loading state while a new board syncs.
   This prevents the PREVIOUS board's charts/KPIs from lingering on screen during
   the (sometimes slow) fetch — the user never sees stale data from another board. */
function showDashLoading(boardName) {
  restoreKpiGrid();   /* compare layout may still own the grid — restore the real KPI cards first */
  ['kpiTotal', 'kpiCreated', 'kpiDone', 'kpiResolved', 'kpiCycle', 'kpiWip'].forEach((id) => ($('#' + id).textContent = '…'));
  ['kpiTotalSub', 'kpiCreatedSub', 'kpiDoneSub', 'kpiResolvedSub', 'kpiCycleSub', 'kpiWipSub'].forEach((id) => { const el = $('#' + id); if (el) el.textContent = t('dash.syncing'); });
  $('#issueCountBadge').textContent = isMasterPBoard(state.lastBoard) ? t('master.syncing') : t('dash.syncing');
  $('#slowTableBody').innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:26px"><span class="spinner spinner-sm"></span> ${escapeHtml(tReplace('dash.loadingBoard', { b: boardName || t('dash.thisBoard') }))}…</td></tr>`;
  hide($('#insightsStrip'));
  hide($('#changelogNotice'));
  /* destroy current chart canvases + replace the grid with a loading placeholder */
  Object.values(state.charts).forEach((c) => c && c.destroy());
  state.charts = {};
  $('#chartsGrid').innerHTML = `<div class="card glass chart-card wide" style="text-align:center;padding:42px;color:var(--muted)"><span class="spinner spinner-lg"></span><div style="margin-top:14px">${escapeHtml(t('dash.syncingDash'))}</div></div>`;
}

function renderDashboard(board, m) {
  restoreKpiGrid();   /* safety net: never render into the compare layout */
  /* KPIs (animated) */
  animateValue($('#kpiTotal'), m.total);
  $('#kpiTotalSub').textContent = t('dash.issuesOnBoard');
  animateValue($('#kpiCreated'), m.created30);
  $('#kpiCreatedSub').innerHTML = trendBadge(m.createdPrev30, m.created30, t('dash.vsPrior30d'), 'neutral');
  animateValue($('#kpiDone'), m.done);
  $('#kpiDoneSub').textContent = tReplace('dash.completionRate', { p: m.doneRate });
  animateValue($('#kpiResolved'), m.resolved30);
  $('#kpiResolvedSub').innerHTML = trendBadge(m.resolvedPrev30, m.resolved30, t('dash.vsPrior30d'), 'up-good');
  $('#kpiCycle').textContent = m.cycleAvg != null ? fmtDuration(m.cycleAvg) : '—';
  $('#kpiCycle').classList.toggle('muted', m.cycleAvg == null);
  if (m.cycleRecentAvg != null && m.cyclePrevAvg != null) {
    const d = pctDelta(m.cyclePrevAvg, m.cycleRecentAvg);
    $('#kpiCycleSub').innerHTML = d === null
      ? `<span class="muted">${escapeHtml(t('dash.createResolve'))}</span>`
      : `<span class="trend ${d <= 0 ? 'trend-good' : 'trend-bad'}">${d <= 0 ? '▼' : '▲'} ${Math.abs(d)}%</span> <span class="muted">${escapeHtml(d <= 0 ? tReplace('dash.fasterThan', { p: Math.abs(d) }) : tReplace('dash.slowerThan', { p: Math.abs(d) }))}</span>`;
  } else {
    $('#kpiCycleSub').innerHTML = `<span class="muted">${escapeHtml(t('dash.createResolve'))}</span>`;
  }
  animateValue($('#kpiWip'), m.wip);
  $('#issueCountBadge').textContent = tReplace('dash.issuesAnalyzed', { n: m.total });

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
    changelogNotice.textContent = t('dash.changelogNotice') + extraNote;
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
    toast(t('debug.copied'), 'ok');
  } catch (_) {
    toast(t('debug.copyFailed'), 'err');
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
  toast(hasSession ? t('settings.saved') : t('settings.savedRelay'), 'ok');
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
  /* snapshot the pristine KPI grid markup once — renderCompareDashboard() replaces
     it in compare mode and restoreKpiGrid() swaps it back on exit */
  const kpiGridEl = document.querySelector('.kpi-grid');
  if (kpiGridEl) KPI_GRID_ORIGINAL = kpiGridEl.innerHTML;
  $('#connectForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('#connectBtn');
    const errBox = $('#setupError');
    hide(errBox);
    setBtnBusy(btn, true);
    try {
      await connect($('#inDomain').value, $('#inEmail').value, $('#inToken').value);
    } catch (e) {
      errBox.textContent = '⚠️ ' + (e?.message || t('err.connectFailed'));
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
  /* compare mode wiring: ⇄ toggle, board B/C pickers, exit button */
  $('#compareBtn').addEventListener('click', enterCompareMode);
  $('#cmpExitBtn').addEventListener('click', exitCompareMode);
  $('#cmpBoardSelect').addEventListener('change', onCompareBoardChange);
  const cmpSelC = $('#cmpBoardSelectC');
  if (cmpSelC) cmpSelC.addEventListener('change', (ev) => onCompareSlotChange('c', ev));
  /* main-page compare: ⇄ pick mode toggle, floating bar actions */
  const pickToggle = $('#pickCompareBtn');
  if (pickToggle) pickToggle.addEventListener('click', togglePickCompareMode);
  $('#pickCancelBtn').addEventListener('click', togglePickCompareMode);
  $('#pickGoBtn').addEventListener('click', () => { openPickCompareDashboard().catch((e) => { toast(e?.message || t('cmp.failed'), 'warn'); logDiag('error', 'Pick-compare failed', { message: e?.message }); }); });
  $('#brandBtn').addEventListener('click', () => { location.hash = '#/'; showAllBoards(); });
  $('#brandBtn').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); location.hash = '#/'; showAllBoards(); }
  });
  $('#backToBoardsBtn').addEventListener('click', () => { location.hash = '#/'; showAllBoards(); });
  $('#openDebugBtn').addEventListener('click', openDiagnostics);
  $('#refreshBtn').addEventListener('click', () => {
    const b = state.boards.find((x) => x.id === state.boardId);
    if (isMasterPBoard(b) || (!b && isMasterPBoard(state.lastBoard))) {
      selectBoard(masterPBoard()); toast(t('toast.refreshing'));
    } else if (b) { selectBoard(b); toast(t('toast.refreshing')); }
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
    toast(t('toast.diagCleared'), 'ok');
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
  wireIssueListModal();
  $('#chartModal').addEventListener('click', (ev) => {
    if (ev.target === $('#chartModal')) { hide($('#chartModal')); state.chartEditing = null; }
  });
  ['#cMetric', '#cGroup', '#cType'].forEach((sel) => {
    $(sel).addEventListener('change', syncChartForm);
  });
  /* custom-range calendar fields in the chart modal — guard: admin/index.html
     may lag behind; a missing element must never break the whole init chain */
  const cRangeEl = $('#cRange');
  if (cRangeEl) {
    cRangeEl.addEventListener('change', () => {
      const wrap = $('#cRangeCustomWrap');
      if (wrap) wrap.classList.toggle('hidden', cRangeEl.value !== String(RANGE_CUSTOM));
    });
  }
  ['#cRangeFrom', '#cRangeTo'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('change', syncChartForm);
  });

  /* publish modal wiring */
  $('#publishBtn').addEventListener('click', openPublishModal);
  /* "Publish all" opens the same config-only publish modal pre-set to "all boards" —
     publishing is instant (config POST), data is always live for viewers. */
  $('#publishAllBtn').addEventListener('click', async () => {
    if (!state.conn) { toast(t('toast.noConn'), 'warn'); return; }
    if (!state.boards.length) { toast(t('toast.boardsLoading'), 'warn'); return; }
    await openPublishModal();
    /* pre-select the "All boards" scope so one click on "Publish to organization" finishes */
    const allBtn = $('#pubScope')?.querySelector('button[data-v="all"]');
    if (allBtn) allBtn.click();
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

  /* pub logo → main page (all boards): exit any active compare/pick state and,
     if we're inside a board, drill back out to the all-boards view */
  const goPubHome = () => {
    if (!pubState.verified) return;   /* on the login gate there is no "home" yet */
    if (pubState.compare) { exitPubCompare(); }
    if (pubState.pickCompare) { togglePubPickCompareMode(); }
    if (pubState.snapshot?.scope === 'board' && pubState.allSnapshot) {
      pubState.snapshot = pubState.allSnapshot;
      pubState.currentBoard = null;
      pubState.allSnapshot = null;
      $('#pubBackBtn').dataset.fromAll = '';
      pubSaveSession({ boardId: null });
      renderPubContent();
    }
  };
  $('#pubBrandBtn').addEventListener('click', goPubHome);
  $('#pubBrandBtn').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); goPubHome(); }
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
    if (val) navigator.clipboard.writeText(val).then(() => toast(t('pub.copied'), 'ok')).catch(() => toast(t('toast.copyFail'), 'warn'));
  });
  $('#pubBackBtn').addEventListener('click', () => {
    /* an active compare view is exited first — Back leaves compare, not the share */
    if (pubState.compare) { exitPubCompare(); return; }
    /* leaving pick mode is the second Back level */
    if (pubState.pickCompare) { togglePubPickCompareMode(); return; }
    /* if we drilled into a board from an all-boards snapshot, go back to the list */
    if ($('#pubBackBtn').dataset.fromAll === '1' && pubState.snapshot.scope === 'board' && pubState.allSnapshot) {
      pubState.snapshot = pubState.allSnapshot;
      pubState.currentBoard = null;
      pubState.allSnapshot = null;
      $('#pubBackBtn').dataset.fromAll = '';
      $('#pubBackBtn').textContent = t('pub.back');
      pubSaveSession({ boardId: null });   /* back to the all-boards view */
      renderPubContent();
      return;
    }
    hidePubScreen();
  });
  /* compare for users (feature 1): header button + pick bar + exit button */
  const pubCmpToggle = $('#pubCompareBtn');
  if (pubCmpToggle) pubCmpToggle.addEventListener('click', togglePubPickCompareMode);
  $('#pubPickGoBtn').addEventListener('click', () => {
    openPubPickCompareDashboard().catch((e) => logDiag('error', 'Pub compare open failed', { message: e?.message }));
  });
  $('#pubPickCancelBtn').addEventListener('click', togglePubPickCompareMode);
  $('#pubCmpExitBtn').addEventListener('click', exitPubCompare);
  /* sign-out: click the identity chip to reveal the menu, click the item to sign
     out; click anywhere else (or Escape) to close without signing out */
  $('#pubUserChip').addEventListener('click', togglePubSignOut);
  $('#pubSignOutBtn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    pubSignOut();
  });
  document.addEventListener('click', (ev) => {
    if (ev.target.closest && ev.target.closest('#pubUserChip')) return;
    closePubSignOut();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closePubSignOut();
  });
  $('#pubEmail').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') pubSendCode();
  });
  $('#pubCode').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') pubVerifyCode();
  });

  /* language switcher: one handler covers every .lang-btn on the page
     (topbar + share-view topbar, both screens) */
  document.querySelectorAll('.lang-btn').forEach((b) => {
    b.addEventListener('click', () => setLang(b.dataset.lang));
  });

  /* theme switcher: one handler covers every .theme-btn on the page — dark is default */
  document.querySelectorAll('.theme-btn').forEach((b) => {
    b.addEventListener('click', () => setTheme(b.dataset.theme));
  });
  applyThemeClass();

  /* route on hash change (back/forward navigation) — but not when opening a share link */
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#p=') || location.hash.startsWith('#share')) return;
    if (state.conn) route();
  });

  /* initialize Google sign-in button (only on the share screen) */
  initGoogleButton();

  /* ── boot routing ─────────────────────────────────────────────────────
     Share links (?share=org, or legacy #share / #p=) always open the org
     publish gate: the board/chart CONFIG comes from the relay (shared by
     every device) and the DATA is fetched live from Jira after sign-in.
     Anywhere else, restore the saved Jira session and enter the app. */
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

  const isShareLink = new URLSearchParams(location.search).has('share') ||
    location.hash.startsWith('#share') || location.hash.startsWith('#p=');
  if (isShareLink) {
    showPublicLanding();   /* async: fetches the relay config, then shows the gate */
  } else if (ADMIN_PANEL) {
    /* ADMIN PANEL: show the live, synced dashboard. If a session exists, enter the
       app; otherwise show the API-token connect flow (the only place it belongs). */
    if (saved) enterApp();
    else showSetup();
  } else {
    /* PUBLIC APP (root URL): org members land here. A persisted viewer session
       (Google sign-in or verified email code) skips the org gate entirely and
       re-opens the board the viewer was on before the refresh. Without a
       session, fall back to the secure published-boards gate. */
    if (saved) enterApp();
    else showPublicLanding(true);
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
