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
    'pick.go': 'Compare →',
    'pick.cancel': 'Cancel',
    'pick.hintA': 'click a card to slot it as A',
    'pick.hintB': 'now click a second card as B',
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
    'cmp.loadingBoards': 'Loading boards…',
    'cmp.pickB': 'Pick the board to compare against',
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
    'ilist.empty': 'No issue data available for this selection.',
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
    'range.30': 'Last 30 days', 'range.90': 'Last 90 days', 'range.182': 'Last 6 months',
    'range.365': 'Last 12 months', 'range.0': 'All time',
    'age.le2d': '≤ 2d', 'age.3_7d': '3–7d', 'age.1_2w': '1–2w', 'age.2_4w': '2–4w',
    'age.1_3mo': '1–3mo', 'age.3_6mo': '3–6mo', 'age.6moPlus': '6mo+',
    'chart.title.pipeline': 'Incoming vs Completed', 'chart.sub.pipeline': 'Created vs resolved over time',
    'chart.title.throughput': 'Monthly Throughput', 'chart.sub.throughput': 'Completed issues per month (Done/Approved/Babysitting/Released)',
    'chart.title.createdTrend': 'Issues Created', 'chart.sub.createdTrend': 'Weekly creation trend',
    'chart.title.resolvedTrend': 'Issues Resolved', 'chart.sub.resolvedTrend': 'Monthly completion trend',
    'chart.title.backlogGrowth': 'Backlog Trend', 'chart.sub.backlogGrowth': 'Cumulative open work (created − resolved)',
    'chart.title.blockedDist': 'Blocked & Canceled', 'chart.sub.blockedDist': 'Work sitting on blocked/canceled/rejected statuses',
    'chart.title.bottlenecks': 'Active Bottlenecks', 'chart.sub.bottlenecks': 'Where open work is parked',
    'chart.title.statusDist': 'Status Distribution', 'chart.sub.statusDist': 'All issues by current status',
    'chart.title.statusTime': 'Avg Time in Status', 'chart.sub.statusTime': 'Lifetime average per status · changelog',
    'chart.title.phaseDelays': 'Stakeholder vs Team Delays', 'chart.sub.phaseDelays': 'Avg days per stage · stakeholder gates vs team work · changelog',
    'chart.title.typeDist': 'Issue Type Breakdown', 'chart.sub.typeDist': 'Open issues by type',
    'chart.title.assigneeLoad': 'Assignee Workload', 'chart.sub.assigneeLoad': 'Open issues per assignee',
    'chart.title.priorityDist': 'Priority Distribution', 'chart.sub.priorityDist': 'Open issues by priority',
    'chart.title.ageDist': 'Open Issue Age', 'chart.sub.ageDist': 'How long issues have been open',
    'chart.title.ageBuckets': 'Age vs Demand', 'chart.sub.ageBuckets': 'How long the open backlog has been waiting',
    'chart.title.unassigned': 'Assignment Gaps', 'chart.sub.unassigned': 'Who owns the open work — spot the load imbalance',
    'chart.title.assigneeCycle': 'Cycle Time Leaderboard', 'chart.sub.assigneeCycle': 'Avg create → resolve per assignee · resolved issues only',
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
    'pub.orgSubtitle': 'All published boards · live data',
    'pub.liveSubtitle': 'Live data · real-time from Jira',
    'pub.liveBadge': '⟳ live',
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
    'pub.googleVerified': 'Verified via Google. Loading snapshot…',
    'pub.googleLoading': 'Google sign-in is still loading… try again in a few seconds.',
    'pub.googleFailed': 'Google sign-in could not start. Use your @{d} email instead.',
    'pub.sendCode': 'Send code',
    'pub.resendCode': 'Resend code',
    'pub.sending': 'Sending your code to {email}…',
    'pub.sentTo': 'Code sent to {email}. Check your inbox, then enter it below.',
    'pub.sendFailed': 'Could not email the code ({m}). Use Sign in with Google instead.',
    'pub.verified': 'Verified. Loading snapshot…',
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
    'dash.fasterThan': '{p}% faster than prior 30d',
    'dash.slowerThan': '{p}% slower than prior 30d',
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
    'cmp.badgeBoth': 'A: {a} issues · B: {b} issues',
    'cmp.hintBar': 'Compare mode — pick a second board in the bar above to overlay every chart and metric.',
    'cmp.aFaster': '{n} is faster',
    'cmp.bFaster': '{n} is faster',
    'cmp.aHigher': '{n} higher',
    'cmp.bHigher': '{n} higher',
    'cmp.aAbove': 'A is {p}% above B',
    'cmp.aBelow': 'A is {p}% below B',
    'cmp.even': 'even',
    'cmp.identical': 'identical on both boards',
    'cmp.noData': 'no data to compare',
    'cmp.pickBHint': 'pick board B above',
    'cmp.lblThroughput': 'Throughput',
    'cmp.lblSpeed': 'Speed',
    'cmp.lblOpenLoad': 'Open load',
    'cmp.lblCompletion': 'Completion',
    'cmp.lblBlocked': 'Blocked work',
    'cmp.lblIntake': 'Intake gap',
    'cmp.insShipped': 'shipped more in 30 days ({a} vs {b})',
    'cmp.insCloses': 'closes work faster ({a} vs {b})',
    'cmp.insWip': 'carries less WIP ({a} vs {b})',
    'cmp.insDone': '{a}% done vs {b}%',
    'cmp.insLess': 'has less ({a} vs {b})',
    'cmp.insIntake': '{n} created {a} vs {b} ({p}%)',
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
    'pick.selectedAs': 'Selected as {s} — click to remove',
    'pick.clickPickA': 'Click to pick as A',
    'pick.clickPickB': 'Click to pick as B',
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
    'setup.lead': 'დაუკავშირდით Jira-ს API ტოკენით და მიიღეთ მყისიერი ანალიტიკა — რამდენ ხანს დგას დავალება თითოეულ სტატუსში, რა გაეგზავნა ბოლო 30&nbsp;დღეში, გუნდის პროდუქტივობა და სხვა. თქვენი მონაცემები ბრაუზერს არ ტოვებს.',
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
    'pick.go': 'შედარება →',
    'pick.cancel': 'გაუქმება',
    'pick.hintA': 'დააჭირეთ ბარათს დაფა A-სთვის',
    'pick.hintB': 'ახლა დააჭირეთ მეორე ბარათს დაფა B-სთვის',
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
    'cmp.loadingBoards': 'დაფების ჩატვირთვა…',
    'cmp.pickB': 'აირჩიეთ დაფა შედარებისთვის',
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
    'ilist.empty': 'ამ შერჩევისთვის დავალების მონაცემები არ არის.',
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
    'cmp.count': 'A: {a} დავალება · B: {b} დავალება',
    'cmp.prompt': 'შედარების რეჟიმი — აირჩიეთ მეორე დაფა ზემოთა ზოლში, რომ ყველა გრაფიკი და მეტრიკა გადაფარვით ნახოთ.',
    'cmp.even': 'თანაბარი', 'cmp.identical': 'ორივე დაფაზე იდენტურია', 'cmp.noData': 'შედარების მონაცემები არ არის',
    'cmp.vsQ': '{a} vs ? — აირჩიეთ დაფა B ზემოთ',
    'insight.throughput': 'პროდუქტივობა', 'insight.speed': 'სიჩქარე', 'insight.load': 'ღია დავალებები',
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
    'range.30': 'ბოლო 30 დღე', 'range.90': 'ბოლო 90 დღე', 'range.182': 'ბოლო 6 თვე',
    'range.365': 'ბოლო 12 თვე', 'range.0': 'მთელი ისტორია',
    'age.le2d': '≤ 2 დღე', 'age.3_7d': '3–7 დღე', 'age.1_2w': '1–2 კვირა', 'age.2_4w': '2–4 კვირა',
    'age.1_3mo': '1–3 თვე', 'age.3_6mo': '3–6 თვე', 'age.6moPlus': '6 თვე+',
    'chart.title.pipeline': 'შემოსვლა vs დასრულება', 'chart.sub.pipeline': 'შექმნა vs დახურვა დროში',
    'chart.title.throughput': 'თვიური პროდუქტივობა', 'chart.sub.throughput': 'დასრულებული დავალებები თვეში (Done/Approved/Babysitting/Released)',
    'chart.title.createdTrend': 'შექმნილი დავალებები', 'chart.sub.createdTrend': 'კვირაში შექმნის ტენდენცია',
    'chart.title.resolvedTrend': 'დახურული დავალებები', 'chart.sub.resolvedTrend': 'თვიური დასრულების ტენდენცია',
    'chart.title.backlogGrowth': 'ბექლოგის ტენდენცია', 'chart.sub.backlogGrowth': 'კუმულაციური ღია სამუშაო (შექმნა − დახურვა)',
    'chart.title.blockedDist': 'დაბლოკილი და გაუქმებული', 'chart.sub.blockedDist': 'სამუშაო, რომელიც დაბლოკილ/გაუქმებულ/უარყოფილ სტატუსებში დგას',
    'chart.title.bottlenecks': 'აქტიური გამავრობის შემზღუდავი ეტაპები', 'chart.sub.bottlenecks': 'სად გროვდება ღია სამუშაო',
    'chart.title.statusDist': 'სტატუსების განაწილება', 'chart.sub.statusDist': 'ყველა დავალება მიმდინარე სტატუსით',
    'chart.title.statusTime': 'საშ. დრო სტატუსში', 'chart.sub.statusTime': 'საშუალო დრო თითოეულ სტატუსში · ჟურნალი',
    'chart.title.phaseDelays': 'სტეიკჰოლდერი vs გუნდის დაგვიანებები', 'chart.sub.phaseDelays': 'საშ. დღეები ეტაპზე · სტეიკჰოლდერის კარიბჭეები vs გუნდის სამუშაო · ჟურნალი',
    'chart.title.typeDist': 'ტიპების განაწილება', 'chart.sub.typeDist': 'ღია დავალებები ტიპებად',
    'chart.title.assigneeLoad': 'შემსრულებლების დატვირთვა', 'chart.sub.assigneeLoad': 'ღია დავალებები შემსრულებლებად',
    'chart.title.priorityDist': 'პრიორიტეტების განაწილება', 'chart.sub.priorityDist': 'ღია დავალებები პრიორიტეტებად',
    'chart.title.ageDist': 'ღია დავალებების ასაკი', 'chart.sub.ageDist': 'რამდენ ხანსაა დავალებები ღიაა',
    'chart.title.ageBuckets': 'ასაკი vs მოთხოვნილება', 'chart.sub.ageBuckets': 'რამდენ ხანს ელოდება ღია ბექლოგი',
    'chart.title.unassigned': 'დანიშვნის ხარვეზები', 'chart.sub.unassigned': 'ვინ ფლობს ღია სამუშაოს — დატვირთვის დისბალანსის აღმოჩენა',
    'chart.title.assigneeCycle': 'ციკლის დროის ლიდერბორდი', 'chart.sub.assigneeCycle': 'საშ. შექმნა → დასრულება შემსრულებლებად · მხოლოდ დახურული',
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
    'pub.orgSubtitle': 'ყველა გამოქვეყნებული დაფა · პირდაპირი მონაცემები',
    'pub.liveSubtitle': 'პირდაპირი მონაცემები · რეალურ დროში Jira-დან',
    'pub.liveBadge': '⟳ პირდაპირი',
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
    'pub.googleVerified': 'დადასტურებულია Google-ით. იტვირთება მონაცემები…',
    'pub.googleLoading': 'Google-ით შესვლა ჯერ იტვირთება… სცადეთ რამდენიმე წამში.',
    'pub.googleFailed': 'Google-ით შესვლა ვერ დაიწყო. გამოიყენეთ თქვენი @{d} ფოსტა.',
    'pub.sendCode': 'კოდის გაგზავნა',
    'pub.resendCode': 'კოდის ხელახლა გაგზავნა',
    'pub.sending': 'კოდი იგზავნება {email} მისამართზე…',
    'pub.sentTo': 'კოდი გაიგზავნა {email} მისამართზე. შეამოწმეთ შემომავალი და შეიყვანეთ ქვემოთ.',
    'pub.sendFailed': 'კოდის გაგზავნა ვერ მოხერხდა ({m}). გამოიყენეთ Google-ით შესვლა.',
    'pub.verified': 'დადასტურებულია. იტვირთება მონაცემები…',
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
    'dash.fasterThan': '{p}% უფრო სწრაფია წინა 30 დღესთან შედარებით',
    'dash.slowerThan': '{p}% უფრო ნელია წინა 30 დღესთან შედარებით',
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
    'cmp.badgeBoth': 'A: {a} დავალება · B: {b} დავალება',
    'cmp.hintBar': 'შედარების რეჟიმი — აირჩიეთ მეორე დაფა ზემოთა ზოლში, რომ ყველა გრაფიკი და მეტრიკა გადაფაროთ.',
    'cmp.aFaster': '{n} უფრო სწრაფია',
    'cmp.bFaster': '{n} უფრო სწრაფია',
    'cmp.aHigher': '{n} უფრო მაღალია',
    'cmp.bHigher': '{n} უფრო მაღალია',
    'cmp.aAbove': 'A {p}%-ით მაღლაა B-ზე',
    'cmp.aBelow': 'A {p}%-ით დაბლაა B-ზე',
    'cmp.even': 'თანაბარი',
    'cmp.identical': 'ორივე დაფაზე იდენტურია',
    'cmp.noData': 'შედარების მონაცემები არ არის',
    'cmp.pickBHint': 'აირჩიეთ დაფა B ზემოთ',
    'cmp.lblThroughput': 'გამტარუნარიანობა',
    'cmp.lblSpeed': 'სიჩქარე',
    'cmp.lblOpenLoad': 'ღია დატვირთვა',
    'cmp.lblCompletion': 'დასრულება',
    'cmp.lblBlocked': 'დაბლოკილი სამუშაო',
    'cmp.lblIntake': 'შემოდინების სხვაობა',
    'cmp.insShipped': '30 დღეში მეტი დახურა ({a} vs {b})',
    'cmp.insCloses': 'სამუშაოს უფრო სწრაფად ხურავს ({a} vs {b})',
    'cmp.insWip': 'ნაკლებ WIP აქვს ({a} vs {b})',
    'cmp.insDone': '{a}% მზადაა vs {b}%',
    'cmp.insLess': 'ნაკლები აქვს ({a} vs {b})',
    'cmp.insIntake': '{n} შექმნა {a} vs {b} ({p}%)',
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
    'pick.selectedAs': 'არჩეულია როგორც {s} — დააჭირეთ მოსაშორებლად',
    'pick.clickPickA': 'აირჩიეთ A-დ',
    'pick.clickPickB': 'აირჩიეთ B-დ',
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
    'ins.bottleneck': '<b>{n}</b> ღია დავალება ახლა იდგება <b>{cat}</b>-ში',
    'ins.slowest': 'ახლა ყველაზე ნელი ეტაპია: <b>{s}</b> · საშ. {d}',
    'ins.throughput': 'გამტარუნარიანობა <b>{p}%</b> წინა 30 დღესთან შედარებით',
    'ins.aged': '<b>{n}</b> ღია დავალება 14 დღეზე მეტხანსაა ჩაძრახული',
    'ins.netFlow': '30 დღეში წმინდა ნაკადი <b>{n}</b> დავალება — ბექლოგი {w}',
    'ins.shrinking': 'მცირდება',
    'ins.growing': 'იზრდება',
    'cmp.noDataEither1': 'ორივე დაფაზე მონაცემები არ არის',
    'cmp.noDataEither2': 'ამ გრაფიკისთვის',
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
      renderDashboard(state.lastBoard, state.lastMetrics);
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
  pickCompare: null,       /* { a, b } board ids while the user is picking two boards to compare */
  compare: null,           /* { a, b, recA, recB } active pub compare view (live records for both boards) */
  compareGen: 0,           /* staleness guard for in-flight compare loads */
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
    $('#pubStatus').textContent = tReplace('pub.restricted', { d: PUBLISH_DOMAIN });
    $('#pubStatus').className = 'error';
    return;
  }
  pubState.email = email;
  pubState.verified = true;
  pubState.isAdmin = isAdminEmail(email);
  $('#pubStatus').textContent = t('pub.googleVerified');
  $('#pubStatus').className = 'ok';
  $('#pubContent').classList.remove('hidden');
  $('#pubAuthBox').classList.add('hidden');
  updatePubUserChip();
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
    $('#pubTitle').textContent = t('pub.orgTitle');
    $('#pubSubtitle').textContent = tReplace('pub.signinAll', { d: PUBLISH_DOMAIN });
    $('#pubHeadTitle').textContent = t('pub.allTitle');
  } else {
    $('#pubTitle').textContent = tReplace('pub.boardTitle', { b: snapshot.boardName });
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
    $('#pubStatus').textContent = t('pub.verified');
    $('#pubStatus').className = 'ok';
    $('#pubContent').classList.remove('hidden');
    $('#pubAuthBox').classList.add('hidden');
    updatePubUserChip();
    renderPubContent();
  } else {
    $('#pubStatus').textContent = t('pub.wrongCode');
    $('#pubStatus').className = 'error';
  }
}

/* ── LIVE render engine ─────────────────────────────────────────────
   The publish snapshot only carries the config (which boards, chart defs).
   Every render fetches fresh Jira data through the relay and computes the
   charts on the spot, so viewers always see real-time numbers. */
const _pubBoardCache = new Map();   /* boardId → { rec, ts } per-session memo (30 s) */
const PUB_LIVE_TTL = 30 * 1000;

/* fetch live issues for a board + compute the full chart set.
   mode: 'full' (changelog, for chart views) | 'light' (metrics-only, fast). */
async function pubLoadBoardLive(boardId, mode = 'full') {
  const memoKey = boardId + ':' + mode;
  const memo = _pubBoardCache.get(memoKey);
  if (memo && Date.now() - memo.ts < PUB_LIVE_TTL) return memo.rec;
  logDiag('info', 'Publish view: fetching live board data', { boardId, mode });
  const rec = await pubFetchBoardLive(boardId, mode);
  const issues = Array.isArray(rec.issues) ? rec.issues : [];
  const m = computeMetrics(issues);
  rememberDoneStatuses(issues);                       /* learn custom done-status names */
  const defs = pubState.chartDefs;                    /* snapshot-configured chart defs */
  const charts = defs.map((def) => ({ def, data: buildChartData(def, m, issues, rec.hasChangelog) }));
  const out = {
    boardId,
    issues,
    metrics: m,
    issuesCount: rec.count ?? issues.length,
    hasChangelog: !!rec.hasChangelog,
    fetchedAt: rec.fetchedAt || Date.now(),
    source: rec.source || '',
    charts,
  };
  _pubBoardCache.set(memoKey, { rec: out, ts: Date.now() });
  return out;
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
   when the viewer is also connected) — falls back to the built-in set */
function pubChartDefs() {
  return (pubState.snapshot?.chartDefs || []).map((d) => ({ ...d }));
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
    ? `${rows.length} issue${rows.length === 1 ? '' : 's'}${base ? '' : ' · ' + t('ilist.noLink')}`
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
    $('#pubTitle').textContent = t('pub.orgTitle');
    $('#pubSubtitle').textContent = t('pub.orgSubtitle');
    $('#pubHeadTitle').textContent = t('pub.allTitle');
  } else {
    $('#pubTitle').textContent = snap.boardName || 'Board';
    $('#pubSubtitle').textContent = t('pub.liveSubtitle');
    $('#pubHeadTitle').textContent = snap.boardName || 'Board';
  }

  $('#pubChangelogBadge').textContent = t('pub.liveBadge');
  $('#pubChangelogBadge').className = 'data-badge ok';

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
      const picked = pickedA || pickedB;
      const openLabel = pick
        ? (picked ? tReplace('cmp.pubSelectedAs', { s: pickedA ? 'A' : 'B' }) : (pick.a == null ? t('cmp.pubClickPickA') : t('cmp.pubClickPickB')))
        : t('card.openDash');
      return `
        <div class="board-card glass${pBoard ? ' p-board' : ''}${picked ? ' pick-sel' : ''}${pickedA ? ' pick-a' : ''}${pickedB ? ' pick-b' : ''}" data-bid="${b.boardId}" style="animation-delay:${Math.min(i * 35, 400)}ms">
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
    if (!charts.length) {
      grid.innerHTML = `<div class="card glass chart-card wide" style="text-align:center;padding:34px;color:var(--muted)">${escapeHtml(t('pub.noCharts'))}</div>`;
      return;
    }
    grid.innerHTML = charts.map((c) => chartCardHTML(c.def, false)).join('');
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
  renderPubContent();
  $('#pubBackBtn').dataset.fromAll = '1';
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
   Data itself is fetched live at render time. */
async function showPublicLanding() {
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
    ? (picked ? tReplace('pick.selectedAs', { s: pickedA ? 'A' : 'B' }) : (pick.a == null ? t('pick.clickPickA') : t('pick.clickPickB')))
    : t('card.openDash');
  const initial = escapeHtml((b.name || '?').trim().charAt(0).toUpperCase());
  const pBoard = isPBoard(b);
  const cached = cachedBoardStats(b.id);
  return `
    <div class="board-card glass${pBoard ? ' p-board' : ''}${picked ? ' pick-sel' : ''}${pickedA ? ' pick-a' : ''}${pickedB ? ' pick-b' : ''}" data-id="${b.id}" style="animation-delay:${Math.min(i * 35, 400)}ms">
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

function renderBoardCards() {
  const grid = $('#boardsGrid');
  const pBoards = state.boards.filter(isPBoard);
  const otherBoards = state.boards.filter((b) => !isPBoard(b));
  let html = '';
  if (pBoards.length) {
    html += `<div class="board-group"><span class="board-group-title">${escapeHtml(t('card.orgBoards'))}</span><div class="boards-grid">${pBoards.map((b, ci) => boardCardHTML(b, ci)).join('')}</div></div>`;
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
  if (!state.conn) { toast(t('toast.noConn'), 'warn'); return; }
  if (!state.boards.length) {
    toast(t('toast.boardsLoading'), 'warn');
    return;
  }
  if (!state.lastBoard || !state.lastMetrics) { toast(t('toast.openBoard'), 'warn'); return; }

  const btn = $('#compareBtn');
  btn.classList.add('active');

  /* populate the board picker (exclude the board we're currently viewing) */
  const sel = $('#cmpBoardSelect');
  sel.innerHTML = `<option value="">${escapeHtml(t('cmp.pickB'))}</option>` +
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
  $('#cmpSynced').textContent = state.compare ? t('cmp.bSynced') : '';
  renderCompareDashboard();   /* re-render KPIs in compare layout (even before B is chosen) */
  if (state.compare) renderCharts(effectiveCharts(), state.lastMetrics);
}

function exitCompareMode() {
  state.compare = null;
  /* bump the generation so any in-flight compare-board load knows it is stale */
  state.compareGen = (state.compareGen || 0) + 1;
  hide($('#compareBar'));
  $('#compareBtn').classList.remove('active');
  restoreKpiGrid();   /* bring back the original six KPI cards before re-rendering */
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
  $('#cmpSynced').innerHTML = `<span class="spinner spinner-sm"></span> ${escapeHtml(t('cmp.bSyncing'))}`;

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
    $('#cmpSynced').textContent = tReplace('cmp.bSynced', { x: state.compare.syncedAt });
    logDiag('info', 'Compare board loaded', { boardId: board.id, issues: issues.length, hasChangelog: state.hasChangelog });
    renderCompareDashboard();
    renderCharts(effectiveCharts(), state.lastMetrics);
  } catch (e) {
    if (isStale()) return; /* board switched during a failing load — stay silent */
    $('#cmpSynced').textContent = t('cmp.bFailed');
    toast(tReplace('cmp.loadFailed', { name: board.name }), 'warn');
    logDiag('error', 'Compare board load failed', { boardId: board.id, message: e?.message, status: e?.status });
    if (!state.compare) { sel.value = ''; }
  } finally {
    sel.disabled = false;
  }
}

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

/* re-render the six KPI cards in compare layout (A value vs B value + winner + delta).
   All inputs are explicit params so BOTH the admin dashboard and the public share
   view can render the same compare layout: admin passes the live state values,
   pub passes its own snapshot-derived ones (defaults fall back to state). */
function renderCompareDashboard(opts = {}) {
  const A = opts.metricsA != null ? opts.metricsA : state.lastMetrics;
  const B = opts.metricsB != null ? opts.metricsB : state.compare?.metrics;
  const nameA = opts.nameA || state.lastBoard?.name || t('cmp.pubA');
  const nameB = opts.nameB || state.compare?.board?.name || null;
  const grid = opts.gridEl || document.querySelector('.kpi-grid');
  if (!grid) return;
  const badgeEl = opts.badgeEl || $('#issueCountBadge');
  const stripEl = opts.stripEl || $('#insightsStrip');

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
          ? (aWins ? tReplace('cmp.aFaster', { n: nameA }) : tReplace('cmp.bFaster', { n: nameB }))
          : (aWins ? tReplace('cmp.aHigher', { n: nameA }) : tReplace('cmp.bHigher', { n: nameB }));
        winnerHtml = `<span class="cmp-winner ${aWins ? 'cmp-winner-a' : 'cmp-winner-b'}">${aWins ? '▲' : '▼'} ${escapeHtml(label)}</span>`;
        deltaHtml = `<div class="cmp-delta ${d > 0 ? 'up' : 'down'}">${escapeHtml(d > 0 ? tReplace('cmp.aAbove', { p: Math.abs(d) }) : tReplace('cmp.aBelow', { p: Math.abs(d) }))}</div>`;
      } else if (numA != null && numB != null) {
        winnerHtml = `<span class="cmp-winner cmp-winner-even">— ${escapeHtml(t('cmp.even'))}</span>`;
        deltaHtml = `<div class="cmp-delta even">${escapeHtml(t('cmp.identical'))}</div>`;
      } else {
        deltaHtml = `<div class="cmp-delta even">${escapeHtml(t('cmp.noData'))}</div>`;
      }
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

  /* keep the header badge informative */
  if (badgeEl) badgeEl.textContent = B
    ? tReplace('cmp.badgeBoth', { a: A?.total ?? 0, b: B.total })
    : tReplace('dash.issuesAnalyzed', { n: A?.total ?? 0 });

  /* insights strip → compare winners strip */
  const strip = stripEl;
  if (!strip) return;
  if (B) {
    const ins = buildCompareInsights(A, B, nameA, nameB);
    strip.innerHTML = ins.map((x, i) =>
      `<div class="cmp-insight" style="animation-delay:${i * 70}ms"><span class="ins-icon">${x.icon}</span><span>${x.html}</span></div>`
    ).join('');
    show(strip);
  } else {
    strip.innerHTML = `<div class="cmp-insight"><span class="ins-icon">⇄</span><span>${escapeHtml(t('cmp.hintBar'))}</span></div>`;
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
    out.push({ icon: '⚡', html: `${t('cmp.lblThroughput')} · ${aWins ? wA(tReplace('cmp.insShipped', { a: `<b>${A.resolved30}</b>`, b: `<b>${B.resolved30}</b>` })) : wB(tReplace('cmp.insShipped', { a: `<b>${B.resolved30}</b>`, b: `<b>${A.resolved30}</b>` }))}` });
  }
  /* cycle time winner (lower is better) */
  if (A.cycleAvg != null && B.cycleAvg != null && Math.round(A.cycleAvg) !== Math.round(B.cycleAvg)) {
    const aWins = A.cycleAvg < B.cycleAvg;
    out.push({ icon: '⏱', html: `${t('cmp.lblSpeed')} · ${aWins ? wA(tReplace('cmp.insCloses', { a: fmtDuration(A.cycleAvg), b: fmtDuration(B.cycleAvg) })) : wB(tReplace('cmp.insCloses', { a: fmtDuration(B.cycleAvg), b: fmtDuration(A.cycleAvg) }))}` });
  }
  /* WIP (lower is healthier) */
  if (A.wip !== B.wip) {
    const aWins = A.wip < B.wip;
    out.push({ icon: '📋', html: `${t('cmp.lblOpenLoad')} · ${aWins ? wA(tReplace('cmp.insWip', { a: A.wip, b: B.wip })) : wB(tReplace('cmp.insWip', { a: B.wip, b: A.wip }))}` });
  }
  /* completion rate */
  if (A.doneRate !== B.doneRate) {
    const aWins = A.doneRate > B.doneRate;
    out.push({ icon: '🏁', html: `${t('cmp.lblCompletion')} · ${aWins ? wA(tReplace('cmp.insDone', { a: A.doneRate, b: B.doneRate })) : wB(tReplace('cmp.insDone', { a: B.doneRate, b: A.doneRate }))}` });
  }
  /* blocked work */
  if (A.blockedCount !== B.blockedCount) {
    const aWins = A.blockedCount < B.blockedCount;
    out.push({ icon: '⛔', html: `${t('cmp.lblBlocked')} · ${aWins ? wA(tReplace('cmp.insLess', { a: A.blockedCount, b: B.blockedCount })) : wB(tReplace('cmp.insLess', { a: B.blockedCount, b: A.blockedCount }))}` });
  }
  /* biggest divergence */
  const dd = d(A.created30, B.created30);
  if (dd !== null && Math.abs(dd) >= 25) {
    out.push({ icon: '📥', cls: '', html: `${t('cmp.lblIntake')} · ${tReplace('cmp.insIntake', { n: nameA, a: A.created30, b: B.created30, p: (dd > 0 ? '+' : '') + dd })}` });
  }
  return out.slice(0, 4);
}

/* ══════════════════ compare from the MAIN page (pick 2 boards) ══════════════════
   "⇄ Compare boards" turns the board grid into a picker: click any card to slot it
   as A, another as B, then "Compare →" loads both and opens the dashboard with every
   KPI + chart overlaid. Available on the admin panel AND the public user view. */
function togglePickCompareMode() {
  if (state.pickCompare) { state.pickCompare = null; updatePickBar(); renderBoardCards(); return; }
  if (!state.boards.length) { toast(t('toast.boardsLoading'), 'warn'); return; }
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
  $('#pickSlotA').textContent = nameA || t('pick.slotA');
  $('#pickSlotA').classList.toggle('filled', !!nameA);
  $('#pickSlotB').textContent = nameB || t('pick.slotB');
  $('#pickSlotB').classList.toggle('filled', !!nameB);
  $('#pickGoBtn').disabled = !(nameA && nameB);
  $('#pickHint').textContent = !nameA ? t('pick.hintA')
    : !nameB ? t('pick.hintB')
    : t('pick.hintGo');
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

  toast(tReplace('cmp.loading', { a: boardA.name, b: boardB.name }));
  await selectBoard(boardA);
  if (!state.lastBoard || state.lastBoard.id !== boardA.id) return;   // A failed → error banner already shown

  /* enter compare on A's dashboard and sync B through the standard picker path */
  await enterCompareMode();
  const sel = $('#cmpBoardSelect');
  if (!sel.querySelector(`option[value="${boardB.id}"]`)) { toast(t('cmp.failed'), 'warn'); return; }
  sel.value = String(boardB.id);
  await onCompareBoardChange({ target: sel });
}

/* ══════════════════ compare on the PUBLIC share view (pick 2 boards) ══════════════════
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
  pubState.pickCompare = { a: null, b: null };
  updatePubPickBar();
  renderPubContent();
}

/* pub card click inside pick mode: fill A, then B; click a picked card to un-pick;
   click an unpicked card when both slots are full → replace B */
function togglePubPickCompare(board) {
  const pick = pubState.pickCompare;
  if (!pick) return;
  if (pick.a === board.boardId) { pick.a = pick.b; pick.b = null; }
  else if (pick.b === board.boardId) { pick.b = null; }
  else if (pick.a == null) { pick.a = board.boardId; }
  else if (pick.b == null) { pick.b = board.boardId; }
  else { pick.b = board.boardId; }
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
  const nameA = pick.a != null ? (boards.find((x) => x.boardId === pick.a) || {}).name : null;
  const nameB = pick.b != null ? (boards.find((x) => x.boardId === pick.b) || {}).name : null;
  $('#pubPickSlotA').textContent = nameA || t('cmp.pubSlotA');
  $('#pubPickSlotA').classList.toggle('filled', !!nameA);
  $('#pubPickSlotB').textContent = nameB || t('cmp.pubSlotB');
  $('#pubPickSlotB').classList.toggle('filled', !!nameB);
  $('#pubPickGoBtn').disabled = !(nameA && nameB);
  $('#pubPickHint').textContent = !nameA ? t('cmp.pubPickHintA')
    : !nameB ? t('cmp.pubPickHintB')
    : t('cmp.pubPickHintGo');
  show(bar);
}

/* load BOTH picked boards (live via the relay) and open the pub compare view */
async function openPubPickCompareDashboard() {
  const pick = pubState.pickCompare;
  if (!pick || pick.a == null || pick.b == null) return;
  const boards = pubBoardsList();
  const boardA = boards.find((x) => x.boardId === pick.a);
  const boardB = boards.find((x) => x.boardId === pick.b);
  if (!boardA || !boardB) return;

  /* leave pick mode first (bar hidden, cards clickable normally again) */
  pubState.pickCompare = null;
  updatePubPickBar();

  toast(tReplace('cmp.pubLoading', { a: boardA.name, b: boardB.name }));
  const genAtStart = pubState.compareGen || 0;
  const isStale = () => (pubState.compareGen || 0) !== genAtStart;

  $('#pubBoardsList').innerHTML = `<div class="card glass chart-card wide" style="text-align:center;padding:42px;color:var(--muted)"><span class="spinner spinner-lg"></span><div style="margin-top:14px">${escapeHtml(tReplace('cmp.pubLoading', { a: boardA.name, b: boardB.name }))}</div></div>`;

  let recA = null, recB = null;
  try {
    [recA, recB] = await Promise.all([
      pubLoadBoardLive(boardA.boardId, 'full'),
      pubLoadBoardLive(boardB.boardId, 'full'),
    ]);
  } catch (e) {
    if (isStale()) return;
    const failed = !recA ? boardA.name : boardB.name;
    toast(tReplace('cmp.pubLoadFailed', { b: failed }), 'warn');
    logDiag('error', 'Pub compare load failed', { boardA: boardA.boardId, boardB: boardB.boardId, message: e?.message });
    renderPubContent();
    return;
  }
  if (isStale()) return;   /* user exited / re-entered the share screen during the load */

  pubState.compare = { a: boardA.boardId, b: boardB.boardId, nameA: boardA.name, nameB: boardB.name, recA, recB };
  renderPubCompareView();
}

/* render the side-by-side compare dashboard inside the pub view */
function renderPubCompareView() {
  const cmp = pubState.compare;
  if (!cmp) return;
  destroyPubCharts();
  $('#pubBoardsList').classList.add('hidden');
  $('#pubChartsGrid').classList.add('hidden');
  $('#pubBackBtn').dataset.fromAll = '';
  $('#pubBackBtn').textContent = t('pub.back');
  $('#pubTitle').textContent = t('cmp.pubPickTitle');
  $('#pubSubtitle').textContent = tReplace('cmp.pubLoading', { a: cmp.nameA, b: cmp.nameB }).replace('…', '') + ' · ' + t('pub.liveSubtitle');
  $('#pubHeadTitle').textContent = t('cmp.pubPickTitle');
  $('#pubIssueCount').textContent = tReplace('cmp.badgeBoth', { a: cmp.recA.issuesCount ?? cmp.recA.metrics?.total ?? 0, b: cmp.recB.issuesCount ?? cmp.recB.metrics?.total ?? 0 });
  $('#pubChangelogBadge').textContent = (cmp.recA.hasChangelog && cmp.recB.hasChangelog) ? t('badge.changelog') : t('badge.noChangelog');
  $('#pubChangelogBadge').className = 'data-badge ' + ((cmp.recA.hasChangelog && cmp.recB.hasChangelog) ? 'ok' : 'missing');

  show($('#pubCompareBar'));
  $('#pubCmpNameA').textContent = cmp.nameA;
  $('#pubCmpNameB').textContent = cmp.nameB;
  $('#pubCmpSynced').textContent = tReplace('cmp.pubSynced', { x: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) });

  const kpiGrid = $('#pubKpiGrid');
  kpiGrid.classList.remove('hidden');
  renderCompareDashboard({
    metricsA: cmp.recA.metrics,
    metricsB: cmp.recB.metrics,
    nameA: cmp.nameA,
    nameB: cmp.nameB,
    gridEl: kpiGrid,
    badgeEl: null,          /* the pub badge lives outside the dashboard chrome */
    stripEl: $('#pubInsightsStrip'),   /* dedicated insights strip (charts grid is reused by chart cards) */
  });

  /* charts: overlay board B onto every chart via the shared compare engine */
  const defs = pubChartDefs();
  const grid = $('#pubChartsGrid');
  if (!defs.length) {
    grid.innerHTML = `<div class="card glass chart-card wide" style="text-align:center;padding:34px;color:var(--muted)">${escapeHtml(t('pub.noCharts'))}</div>`;
    return;
  }
  grid.innerHTML = defs.map((d) => chartCardHTML(d, false)).join('');
  const theme = chartTheme();
  for (const def of defs) {
    const canvasId = 'chart_' + def.id;
    const data = buildCompareChartData(
      def, cmp.recA.metrics, cmp.recA.issues, cmp.recA.hasChangelog,
      cmp.recB.metrics, cmp.recB.issues, cmp.recB.hasChangelog, cmp.nameA, cmp.nameB,
    );
    const sub = document.getElementById('sub_' + def.id);
    if (sub) {
      const base = data.subtitle || def.subtitle || '';
      sub.innerHTML = escapeHtml(base) + (data.extraSub ? ` <span class="sub-extra">· ${data.extraSub}</span>` : '');
    }
    if (data.empty) {
      drawCanvasMessage(canvasId, Array.isArray(data.empty) ? data.empty : [data.empty]);
      const card = grid.querySelector(`.chart-card[data-cid="${def.id}"]`);
      if (card) card.classList.add('empty');
      continue;
    }
    const card = grid.querySelector(`.chart-card[data-cid="${def.id}"]`);
    if (card) card.classList.remove('empty');
    mkPubChart(canvasId, chartConfigFor(def, data, theme, canvasId));
  }
}

/* leave the pub compare view → back to the all-boards list */
function exitPubCompare() {
  pubState.compare = null;
  pubState.compareGen = (pubState.compareGen || 0) + 1;
  hide($('#pubCompareBar'));
  hide($('#pubInsightsStrip'));
  $('#pubKpiGrid').classList.add('hidden');
  $('#pubKpiGrid').innerHTML = '';
  renderPubContent();
}

/* ── compare-mode chart merging: overlay board B's data onto each chart ──
   nameA/nameB are explicit params so the public share view can pass its own
   board names (defaults fall back to the admin compare state). */
function buildCompareChartData(def, mA, issuesA, hcA, mB, issuesB, hcB, nameAParam, nameBParam) {
  const dataA = buildChartData(def, mA, issuesA, hcA);
  const dataB = buildChartData(def, mB, issuesB, hcB);
  const emptyA = dataA.empty, emptyB = dataB.empty;
  const nameB = nameBParam || state.compare?.board?.name || t('cmp.pubB');
  const nameA = nameAParam || state.lastBoard?.name || t('cmp.pubA');
  const B_SERIES = { label: nameB, color: '#22d3ee', rgb: ACCENT_RGB.cyan };
  if (emptyA && emptyB) return { empty: [t('cmp.noDataEither1'), t('cmp.noDataEither2')] };

  /* doughnuts render a single ring on one canvas — a second board cannot be
     overlaid legibly. They stay board-A only; KPI pairs + the insight strip
     already carry board B's numbers. Everything else gets a true overlay. */
  if (def.type === 'doughnut') {
    if (emptyA) return { empty: [t('cmp.noDataA')] };
    return dataA;
  }

  /* time-series charts bucket from "now" backwards on both boards, so the
     label at the same index means the same date — plain index alignment is
     correct. Pad the shorter series with nulls. Datasets get board-name
     prefixes so the legend tells the two boards apart. */
  const isTime = def.metric === 'flow' || def.metric === 'created' || def.metric === 'resolved' || def.metric === 'netflow';
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
    if (!emptyA) datasets.push(...dataA.datasets.map((ds) => relabel({ ...ds, __src: issuesA }, nameA)));
    if (!emptyB) datasets.push(...dataB.datasets.map((ds) => relabel({ ...ds, color: '#22d3ee', rgb: ACCENT_RGB.cyan, __src: issuesB }, nameB)));
    if (!datasets.length) return { empty: [t('cmp.noComparable')] };
    return {
      labels: labels,
      datasets,
      duration: false,
      subtitle: dataA.subtitle || dataB.subtitle || def.subtitle,
      extraSub: `${escapeHtml(nameB)} ${t('cmp.shownCyan')}`,
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
  /* per-label issue keys for both boards (click a data point → issue list) */
  const keysAraw = dataA.datasets?.[0]?.__keys || [];
  const keysBraw = dataB.datasets?.[0]?.__keys || [];
  const alignKeys = (map, keys, l) => { const i = map.get(l); return i != null ? (keys[i] || []) : []; };
  /* ordered-ladder groupings (age buckets) keep their intrinsic order in compare
     mode too — sorting by value would scramble the ≤2d → 6mo+ narrative */
  if (def.groupBy === 'ageBucket') scored.sort((x, y) => AGE_BUCKETS.findIndex(([b]) => b === x.l) - AGE_BUCKETS.findIndex(([b]) => b === y.l));
  else scored.sort((x, y) => y.score - x.score);

  const topN = def.topN || 0;
  const picked = topN ? scored.slice(0, topN) : scored;

  const isDuration = !!(dataA.duration || dataB.duration);
  let labels = picked.map((r) => r.l);
  let dsA = picked.map((r) => r.av);
  let dsB = picked.map((r) => r.bv);
  let keyIdx = picked.map((r) => r.l);           /* raw-label order for key alignment */
  if (def.type === 'hbar') {
    labels = labels.slice().reverse();
    dsA = dsA.slice().reverse();
    dsB = dsB.slice().reverse();
    keyIdx = keyIdx.slice().reverse();
  }

  const datasets = [];
  if (!emptyA) {
    datasets.push({ label: nameA, data: dsA, color: ACCENT_HEX[def.color] || ACCENT_HEX.indigo, rgb: ACCENT_RGB[def.color] || ACCENT_RGB.indigo, __keys: keyIdx.map((l) => alignKeys(aMap, keysAraw, l)), __src: issuesA });
  }
  if (!emptyB) {
    datasets.push({ ...B_SERIES, data: dsB, __keys: keyIdx.map((l) => alignKeys(bMap, keysBraw, l)), __src: issuesB });
  }

  const base = emptyA ? dataB : dataA;
  const extraSub = (emptyA || emptyB)
    ? `${emptyA ? escapeHtml(nameB) : escapeHtml(nameA)} ${t('cmp.only')} · ${t('cmp.oneBoardNoData')}`
    : `${escapeHtml(nameB)} ${t('cmp.shownCyan')}`;

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
};

/* which groupings each metric kind supports */
const GROUPS_FOR_KIND = {
  time: [['time', 'Time (bucketed)']],
  category: [
    ['status', 'Status'], ['assignee', 'Assignee'], ['type', 'Issue type'],
    ['priority', 'Priority'], ['label', 'First label'], ['bottleneck', 'Bottleneck stage'],
    ['ageBucket', 'Age bucket'], ['assigneeState', 'Assigned vs unassigned'],
  ],
  statusTime: [['status', 'Each status'], ['stage', 'Stakeholder vs team']],
};

const RANGE_OPTIONS = [
  [30, 'Last 30 days'], [90, 'Last 90 days'], [182, 'Last 6 months'],
  [365, 'Last 12 months'], [0, 'All time'],
];

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
};
const RANGE_I18N = ['range.30', 'range.90', 'range.182', 'range.365', 'range.0'];
const AGE_BUCKET_I18N = ['age.le2d', 'age.3_7d', 'age.1_2w', 'age.2_4w', 'age.1_3mo', 'age.3_6mo', 'age.6moPlus'];
const STATUS_TIME_TITLE_I18N = 'chart.title.statusTime';
const BUILTIN_TITLE_I18N = {
  pipeline: 'chart.title.pipeline', throughput: 'chart.title.throughput', createdTrend: 'chart.title.createdTrend',
  resolvedTrend: 'chart.title.resolvedTrend', backlogGrowth: 'chart.title.backlogGrowth', blockedDist: 'chart.title.blockedDist',
  bottlenecks: 'chart.title.bottlenecks', statusDist: 'chart.title.statusDist', statusTime: 'chart.title.statusTime',
  phaseDelays: 'chart.title.phaseDelays', typeDist: 'chart.title.typeDist', assigneeLoad: 'chart.title.assigneeLoad',
  priorityDist: 'chart.title.priorityDist', ageDist: 'chart.title.ageDist', ageBuckets: 'chart.title.ageBuckets',
  unassigned: 'chart.title.unassigned', assigneeCycle: 'chart.title.assigneeCycle',
};
const BUILTIN_SUB_I18N = {
  pipeline: 'chart.sub.pipeline', throughput: 'chart.sub.throughput', createdTrend: 'chart.sub.createdTrend',
  resolvedTrend: 'chart.sub.resolvedTrend', backlogGrowth: 'chart.sub.backlogGrowth', blockedDist: 'chart.sub.blockedDist',
  bottlenecks: 'chart.sub.bottlenecks', statusDist: 'chart.sub.statusDist', statusTime: 'chart.sub.statusTime',
  phaseDelays: 'chart.sub.phaseDelays', typeDist: 'chart.sub.typeDist', assigneeLoad: 'chart.sub.assigneeLoad',
  priorityDist: 'chart.sub.priorityDist', ageDist: 'chart.sub.ageDist', ageBuckets: 'chart.sub.ageBuckets',
  unassigned: 'chart.sub.unassigned', assigneeCycle: 'chart.sub.assigneeCycle',
};
/* translated view of a chart def (built-ins only; custom defs keep their own titles) */
function defTitle(def) { return def.builtin ? t(BUILTIN_TITLE_I18N[def.id], def.title) : def.title; }
function defSubtitle(def) { return def.builtin ? t(BUILTIN_SUB_I18N[def.id], def.subtitle) : def.subtitle; }
function metricLabel(m) { return t(METRIC_I18N[m], METRIC_DEFS[m]?.label || m); }
function groupLabel(g) { return t(GROUP_I18N[g], GROUP_LABELS[g] || g); }
function rangeLabel(days) {
  const i = RANGE_OPTIONS.findIndex(([d]) => d === days);
  return i >= 0 ? t(RANGE_I18N[i], RANGE_OPTIONS[i][1]) : String(days);
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
  { id: 'ageDist', title: 'Open Issue Age', subtitle: 'How long issues have been open', type: 'hbar', metric: 'openAge', groupBy: 'assignee', bucket: 'week', range: 0, filter: 'open', topN: 10, split: 'none', color: 'green', wide: false, centerTotal: false },
  { id: 'ageBuckets', title: 'Age vs Demand', subtitle: 'How long the open backlog has been waiting', type: 'hbar', metric: 'count', groupBy: 'ageBucket', bucket: 'week', range: 0, filter: 'open', topN: 0, split: 'none', color: 'amber', wide: false, centerTotal: false },
  { id: 'unassigned', title: 'Assignment Gaps', subtitle: 'Who owns the open work — spot the load imbalance', type: 'doughnut', metric: 'count', groupBy: 'assigneeState', bucket: 'week', range: 0, filter: 'open', topN: 0, split: 'none', color: 'pink', wide: false, centerTotal: true },
  { id: 'assigneeCycle', title: 'Cycle Time Leaderboard', subtitle: 'Avg create → resolve per assignee · resolved issues only', type: 'hbar', metric: 'avgCycle', groupBy: 'assignee', bucket: 'week', range: 182, filter: 'done', topN: 10, split: 'none', color: 'cyan', wide: false, centerTotal: false },
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
    default: return f.status?.name || 'Unknown';
  }
}

function stageLabel(k) {
  if (k === 'Stakeholder gates') return t('stage.stakeholder');
  if (k === 'Team phases') return t('stage.team');
  return k;
}

/* display label for a raw group key — data values (names) pass through, constant keys translate */
function groupKeyLabel(def, k) {
  if (def.groupBy === 'ageBucket') return ageBucketLabel(k);
  if (def.groupBy === 'bottleneck') return bottleneckLabel(k);
  if (def.groupBy === 'stage') return stageLabel(k);
  if (def.groupBy === 'assigneeState') {
    if (k === 'Unassigned') return t('group.unassigned');
    if (k === 'Assigned') return t('group.assigned');
  }
  return k;
}

function filterPool(def, issues) {
  if (def.filter === 'open') return issues.filter((i) => !statusIsDone(i.fields || {}));
  if (def.filter === 'done') return issues.filter((i) => statusIsDone(i.fields || {}));
  return issues;
}

/* build time-bucketed series for created / resolved / flow */
function buildTimeSeries(def, issues) {
  const NOW = Date.now();
  const isNet = def.metric === 'netflow';
  const wantCreated = def.metric !== 'resolved' || isNet;
  const wantResolved = def.metric !== 'created' || isNet;
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
  /* per-bucket issue keys — power the click-a-data-point → issue-list modal */
  const createdKeys = Array.from({ length: nBuckets }, () => []);
  const resolvedKeys = Array.from({ length: nBuckets }, () => []);
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
          idx = nBuckets - 1 - Math.floor((NOW - ts) / bucketMs);
        }
        if (idx >= 0 && idx < nBuckets) { resolvedCounts[idx]++; resolvedKeys[idx].push(iss.key); }
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
  let net = null;
  if (isNet) {
    /* cumulative net flow: created − resolved, running total → open-backlog shape */
    let acc = 0;
    net = createdCounts.map((c, i) => (acc += c - resolvedCounts[i]));
    datasets.push({ label: t('series.openBacklog'), data: net, color: '#8b5cf6', rgb: ACCENT_RGB.violet, __keys: createdKeys, __src: issues });
  } else {
    if (wantCreated) datasets.push({ label: t('series.registered'), data: createdCounts, color: '#6366f1', rgb: ACCENT_RGB.indigo, __keys: createdKeys, __src: issues });
    if (wantResolved) datasets.push({ label: t('series.completed'), data: resolvedCounts, color: '#34d399', rgb: ACCENT_RGB.green, __keys: resolvedKeys, __src: issues });
  }

  const parts = [];
  if (isNet) parts.push(t('series.netflowDesc'));
  else if (wantCreated && wantResolved) parts.push(t('series.createdVsResolved'));
  else if (wantCreated) parts.push(t('series.created'));
  else parts.push(t('series.resolved'));
  const subtitle = `${parts.join(' · ')} · ${tReplace('series.perBucket', { b: t('bucket.' + bucket).toLowerCase() })} · ${rangeLabel(def.range)}`;

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
  const pool = filterPool(def, issues);
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
  const subtitle = `${metric.duration ? t('series.avg') : t('series.count')} ${tReplace('series.byGroup', { g: groupLabel(def.groupBy) || GROUP_LABELS[def.groupBy] || def.groupBy })}${metric.duration ? '' : filterTxt}`;
  return {
    labels,
    datasets: [{ label: def.title, data: values, color: ACCENT_HEX[def.color] || ACCENT_HEX.indigo, rgb: ACCENT_RGB[def.color] || ACCENT_RGB.indigo, __keys: keys, __src: issues }],
    colors,
    duration: metric.duration,
    subtitle,
    centerValue: metric.duration ? fmtDuration(totalVal) : Math.round(totalVal),
    centerLabel: metric.duration ? 'avg' : 'issues',
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
    const agg = { 'Stakeholder gates': { sum: 0, n: 0 }, 'Team phases': { sum: 0, n: 0 } };
    const aggKeys = { 'Stakeholder gates': [], 'Team phases': [] };
    for (const r of rows) {
      if (!r.side) continue;
      const t = r.side === 'stakeholder' ? 'Stakeholder gates' : 'Team phases';
      agg[t].sum += r.sum; agg[t].n += r.n;
      aggKeys[t].push(...r.keys);
    }
    rows = Object.entries(agg).filter(([, r]) => r.n).map(([k, r]) => ({ k, avg: r.sum / r.n }));
    if (!rows.length) return { empty: [t('statusTime.noStages')] };
    rows.sort((a, b) => b.avg - a.avg);
    labels = rows.map((r) => stageLabel(r.k));
    values = rows.map((r) => +(r.avg / DAY).toFixed(2));
    colors = rows.map((r) => (r.k === 'Stakeholder gates' ? '#fbbf24cc' : '#22d3eecc'));
    keys = rows.map((r) => aggKeys[r.k] || []);
  } else if (def.split === 'stage') {
    const picked = rows.filter((r) => r.side).sort((a, b) => b.avg - a.avg).slice(0, def.topN || 8);
    if (!picked.length) return { empty: [t('statusTime.noStages')] };
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
      `<span style="color:#fcd34d">●</span> ${t('statusTime.stakeholderAvg')} <b>${shAvg != null ? fmtDuration(shAvg) : '—'}</b>` +
      ` &nbsp;·&nbsp; <span style="color:#67e8f9">●</span> ${t('statusTime.teamAvg')} <b>${tmAvg != null ? fmtDuration(tmAvg) : '—'}</b>`;
    return {
      labels,
      datasets: [
        { label: t('stage.stakeholder'), data: sh.reverse(), color: '#fbbf24', rgb: ACCENT_RGB.amber, __keys: picked.map((r) => r.keys).reverse(), __src: issues },
        { label: t('stage.team'), data: tm.reverse(), color: '#22d3ee', rgb: ACCENT_RGB.cyan, __keys: picked.map((r) => r.keys).reverse(), __src: issues },
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

function buildChartData(def, m, issues, hasChangelog) {
  const metric = METRIC_DEFS[def.metric];
  const iss = issues || state.issues;
  const hc = hasChangelog != null ? hasChangelog : state.hasChangelog;
  if (!metric) return { empty: [t('err.unknownMetric')] };
  if (metric.kind === 'time') return buildTimeSeries(def, iss);
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
  return `<div class="card glass chart-card${def.wide ? ' wide' : ''}" data-cid="${def.id}">
    <div class="chart-head">
      <div class="chart-titles">
        <h3>${escapeHtml(defTitle(def))} ${scopeChip}</h3>
        <span class="chart-sub" id="sub_${def.id}">${escapeHtml(defSubtitle(def) || '')}</span>
      </div>
      <div class="chart-actions">${actions}</div>
    </div>
    <div class="canvas-wrap"><canvas id="chart_${def.id}"></canvas></div>
  </div>`;
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
    return {
      type: 'doughnut',
      data: {
        labels: data.labels,
        datasets: [{
          data: data.datasets[0].data,
          backgroundColor: data.colors,
          borderColor: tc.edge,
          borderWidth: 2,
          hoverOffset: 10,
          hoverBorderColor: tc.edgeHover,
          __keys: data.datasets[0].__keys,
          __src: data.datasets[0].__src,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: def.centerTotal ? '68%' : '62%',
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
  $('#cRange').innerHTML = RANGE_OPTIONS.map(([v, l], i) => `<option value="${v}">${escapeHtml(t(RANGE_I18N[i], l))}</option>`).join('');
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
    $('#cGroup').innerHTML = opts.map(([v, l]) => `<option value="${v}">${escapeHtml(groupLabel(v) || l)}</option>`).join('');
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
    if (def.scope === 'global') def.boardId = null;
    store.custom.push(def);
    toast(def.scope === 'global' ? t('chart.addedAll') : t('chart.addedBoard'), 'ok');
  } else if (edit.mode === 'custom') {
    const def = chartDefFromForm(edit.def);
    def.scope = segGet($('#cScope')) === 'global' ? 'global' : 'board';
    def.boardId = def.scope === 'global' ? null : state.boardId;
    store.custom = store.custom.map((c) => (c.id === def.id ? def : c));
    toast(t('chart.updated'), 'ok');
  } else if (edit.mode === 'builtin') {
    const def = chartDefFromForm(edit.def);
    const override = {};
    for (const k of ['title', 'subtitle', 'type', 'metric', 'groupBy', 'bucket', 'range', 'filter', 'topN', 'split', 'color', 'wide', 'centerTotal']) {
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
const BOTTLENECK_I18N = {
  'Pending Review': 'bn.pendingReview', 'Technical Analysis': 'bn.techAnalysis',
  'In Development': 'bn.inDevelopment', 'Testing': 'bn.testing', 'Other': 'group.other',
};
function bottleneckLabel(cat) { return t(BOTTLENECK_I18N[cat], cat); }

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
    ctx.fillStyle = themeColors().text;
    ctx.fillText(String(opts.value ?? ''), x, y - 7);
    ctx.font = '700 10px Inter, system-ui';
    ctx.fillStyle = themeColors().muted;
    ctx.fillText(String(opts.label ?? '').toUpperCase(), x, y + 14);
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
    out.push({ icon: '⛔', cls: 'ins-warn', html: tReplace('ins.bottleneck', { n, cat: escapeHtml(cat) }) });
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
    out.push({ icon: '🧊', cls: 'ins-bad', html: tReplace('ins.aged', { n: aged }) });
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
  $('#issueCountBadge').textContent = t('dash.syncing');
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
  /* compare mode wiring: ⇄ toggle, board B picker, exit button */
  $('#compareBtn').addEventListener('click', enterCompareMode);
  $('#cmpExitBtn').addEventListener('click', exitCompareMode);
  $('#cmpBoardSelect').addEventListener('change', onCompareBoardChange);
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
    if (b) { selectBoard(b); toast(t('toast.refreshing')); }
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
    /* PUBLIC APP (root URL): org members land here. If a Jira session exists on this
       device, open the LIVE read-only dashboard so users see the same charts & design
       as the admin panel — but without any admin functions/buttons (no publish, no new
       chart, no settings, no diagnostics). Without a session, fall back to the secure
       published-boards gate (config from the relay, data live after sign-in). */
    if (saved) enterApp();
    else showPublicLanding();
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
