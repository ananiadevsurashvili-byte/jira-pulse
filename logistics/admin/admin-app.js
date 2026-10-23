'use strict';
/* JiraPulse · Logistics admin dashboard (standalone - no module imports)
   Auth: admin-whitelist (Google GSI or email code) → relay ?cmd=desk + lgPing/lgStats
   Metrics: KPIs, canvas charts, per-user & per-direction leaderboards, login activity. */

/* ═══ 1. Constants & state ═══ */
const PUB_RELAY = 'https://gensweaty--65df49bca6d911f19f231607ee4eb77e.web.val.run/';
const PUBLISH_DOMAIN = 'caucasusauto.com';
const GOOGLE_CLIENT_ID = '671098966570-21bp1aeud5o2glbjsliif3foi6n71gmh.apps.googleusercontent.com';
const JIRA_DOMAIN = 'caucasusauto.atlassian.net';
const JIRA_BASE = 'https://' + JIRA_DOMAIN + '/browse/';
const DESK_PROJECT = 'LOG';
const DESK_EXCLUDE_LABEL = 'internal';
const LOG_CODE_SEED = 'org';
const ADMIN_EMAILS = [
  'anania.devsurashvili@caucasusauto.com',
  'ani@caucasusauto.com'
];
const LS_THEME = 'jp_theme', LS_LANG = 'jp_lang', LS_CONN = 'jp_conn_v1';
const LS_ADM_SESSION = 'jp_adm_session_v1';
const LS_ADM_PERIOD = 'jp_adm_period_v1';
const LS_ADM_CHPERIOD = 'jp_adm_chperiod_v1';
const LS_ADM_FIELDIDS = 'jp_lg_fieldids_v1';
const LS_ADM_SLA_GOALS = 'jp_adm_sla_goals_v1';
const ADM_LIVE_TTL = 30 * 1000;
/* SLA goal defaults — the goals set in JSM (time to first response 2h,
   time to resolution 30h). Non-admin surfaces use the relay-stored values;
   the admin keeps the last-fetched copy locally so charts render instantly. */
const SLA_DEFAULT_GOALS = { respHours: 2, resHours: 30 };

/* Admin token for relay write commands (sla:set) — mirrors app.js */
const PUB_ADMIN_TOKEN = 'jp_k9R2vTq7Lm4wXy8Zp3nB6dF1sH5jC';

const adm = {
  email: '', verified: false, codeSent: false,
  rows: [], jqlTotal: 0, fetchedAt: 0, countIn: 0,
  fieldIds: { direction: null, title: null },
  period: { kind: '30d', fromMs: null, toMs: null },
  lastAggr: null, lastStats: null, statsTimer: null,
  lbSearch: { user: '', dir: '', login: '' },
  /* KPI drill-down: which dashboard number opened the task list (null = none) */
  dl: null,
  /* drill-list table engine (mirrors the desk's lgState): 100-row pages,
     Show-more grows by +100; q/filters/sort reset per new drill, page too */
  dlPage: 100, dlQ: '',
  dlFilters: { status: '', reporter: '', assignee: '', direction: '', sla: '' },
  dlSort: { col: 'created', dir: 'desc' },
  cardKey: null,   /* task detail popup (admOpenCard) */
  /* per-chart period overrides: chId → 'master' | '30d' | 'month' | … ('master' = follow the master period) */
  chPeriod: {},
  lbSort: { user: { col: 'resolved', dir: 'desc' }, dir: { col: 'total', dir: 'desc' }, login: { col: 'lastTs', dir: 'desc' } },
  charts: {}, loading: false, lang: 'en',
  /* SLA goals in HOURS — fetched from the relay (?cmd=sla:get), editable
     in the SLA card (?cmd=sla:set). Local copy seeded from localStorage. */
  slaGoals: Object.assign({}, SLA_DEFAULT_GOALS),
  slaSaving: false
};
let _admCache = null, _admAbort = null;

/* ═══ 2. DOM helpers ═══ */
const $ = (s, r) => (r || document).querySelector(s);
const escapeHtml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }
function toast(msg, ms) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; show(t);
  clearTimeout(toast._t); toast._t = setTimeout(() => hide(t), ms || 2600);
}

/* ═══ 3. I18N ═══ */
const I18N = {
  en: {
    'lg.toMain': 'Back to Logistics desk', 'lg.footer': 'JiraPulse · Logistics admin — live Jira data, admin-only access',
    'lg.loading': 'Loading tasks…', 'lg.refresh': 'Refresh',
    'adm.badge': 'Logistics Admin', 'adm.headTitle': 'Logistics admin',
    'adm.title': 'Logistics admin', 'adm.subtitle': 'Metrics and activity dashboard · admin accounts only',
    'adm.dashTitle': 'Dashboard', 'adm.dashSub': 'All LOG service-desk metrics · items labeled “Internal” are hidden',
    'adm.period': 'Period', 'adm.customRange': 'Custom range',
    'adm.p.30d': 'Last 30 days', 'adm.p.month': 'This month', 'adm.p.quarter': 'This quarter',
    'adm.p.year': 'This year', 'adm.p.all': 'All time', 'adm.p.custom': 'Custom…',
    'adm.kpi.total': 'Tasks · period', 'adm.kpi.today': 'Created today', 'adm.kpi.month': 'Created this month',
    'adm.kpi.resolved': 'Resolved · period', 'adm.kpi.open': 'Open (in period)', 'adm.kpi.resAll': 'Resolved (all time)',
    'adm.kpi.active': 'Active now', 'adm.kpi.logins': 'Logins today',
    'adm.kpi.avgRes': 'Avg resolution time', 'adm.kpi.inwork': 'In progress now',
    'adm.kpi.totalSub': 'created in selected period', 'adm.kpi.openSub': 'not resolved yet',
    'adm.kpi.basedOn': 'based on {n} tasks with resolution date',
    /* avg-resolution caption: TRUE description of the count — median over
       every task RESOLVED in the period (creation→resolution; Jira
       resolution date when present, last-activity otherwise) */
    'adm.kpi.medianOn': 'median of {n} tasks resolved in period (created → resolved)',
    'adm.kpi.medianNone': 'no tasks resolved in period',
    'adm.dl.title': 'Task list', 'adm.dl.tip': 'Show these tasks in list',
    'adm.dl.resMarker': 'resolved', 'adm.dl.openCard': 'Open task details',
    'adm.dl.searchPh': 'Search tasks…', 'adm.dl.filterAll': 'All',
    'adm.dl.fStatus': 'Status', 'adm.dl.fReporter': 'Reporter', 'adm.dl.fAssignee': 'Assignee',
    'adm.dl.fDirection': 'Direction', 'adm.dl.fSla': 'SLA',
    'adm.dl.shown': 'Showing {a}–{b} of {n}', 'adm.dl.showMore': 'Show more',
    /* detail-popup strings — mirror the desk's keys so admRenderCard can
       reuse the same labels (the desk's lg.* keys are NOT loaded here) */
    'lg.th.reporter': 'Reporter', 'lg.th.assignee': 'Assignee',
    'lg.th.created': 'Created', 'lg.th.updated': 'Updated', 'lg.th.sla': 'SLA',
    'lg.th.direction': 'Direction', 'lg.th.resolved': 'Resolved',
    'lg.th.comments': 'Comments', 'lg.descLabel': 'Description',
    'lg.card.noComments': 'No comments', 'lg.card.noDescription': 'No description',
    'lg.card.attachments': 'Attachments', 'lg.row.hasFiles': 'Has attachments',
    'lg.card.download': 'Download', 'lg.downloadFail': 'Download failed',
    'lg.unassigned': 'Unassigned',
    'adm.ch.daily': 'New vs resolved · selected period',
    'adm.ch.monthlyNew': 'New tasks per month · selected period',
    'adm.ch.monthlyDone': 'Resolved per month · selected period',
    'adm.ch.donut': 'Open vs resolved · selected period',
    'adm.ch.status': 'Work by status · selected period',
    'adm.ch.assignees': 'Top assignees · open, by period',
    'adm.ch.reporters': 'Top reporters · created, by period',
    'adm.ch.direction': 'Tasks per direction · selected period',
    'adm.ch.dirDone': 'Resolved per direction · selected period',
    'adm.ch.legResolved': 'Resolved', 'adm.ch.legOpen': 'Open / pending', 'adm.ch.legCreated': 'Created',
    'adm.lb.users': 'Users · created / resolved (period)', 'adm.lb.dirs': 'Departments (directions) · period',
    'adm.lb.user': 'User', 'adm.lb.created': 'Created', 'adm.lb.resolved': 'Resolved', 'adm.lb.open': 'Open',
    'adm.lb.direction': 'Direction', 'adm.lb.total': 'Total', 'adm.lb.nodata': 'No data for this period',
    'adm.lb.search': 'Search…', 'adm.act.lastTs': 'Last seen',
    'adm.activity': 'Platform usage & logins', 'adm.act.now': 'Active now', 'adm.act.today': 'Visitors today',
    'adm.act.week': 'This week', 'adm.act.total': 'Total users', 'adm.act.lastSeen': 'Last seen',
    'adm.act.sessions': 'Sessions', 'adm.act.state': 'State', 'adm.act.online': 'Online', 'adm.act.offline': 'Offline',
    'adm.act.desk': 'Logistics desk', 'adm.act.admin': 'Admin panel', 'adm.act.first': 'First visit',
    'adm.act.surface': 'Surface', 'adm.act.union': 'Overall platform', 'adm.act.dwell': 'Usage', 'adm.act.both': 'Desk + Admin',
    'adm.ch.period': 'Period', 'adm.ch.periodMaster': 'Master period',
    'adm.count.n': '{n} task(s)', 'adm.count.loading': 'Loading…', 'adm.fetched': 'Updated {t}',
    'settings.email': 'Email',
    'theme.title': 'Switch color theme', 'theme.dark': 'Dark theme', 'theme.light': 'Light theme',
    'pub.google': 'Sign in with Google', 'pub.orEmail': '— or with email —', 'pub.emailPh': 'you@caucasusauto.com',
    'pub.send': 'Send code', 'pub.accessCode': 'Access code', 'pub.codePh': '6-digit code', 'pub.verify': 'Verify',
    'pub.signOut': '⎋ Sign out', 'pub.signOutTitle': 'Sign out and return to the login screen',
    'auth.sending': 'Sending code…',
    'pub.sending': 'Sending code to {email}…', 'pub.invalidEmail': 'Email must end with @{d}',
    'pub.sentTo': 'Code sent to {email}', 'pub.resendCode': 'Resend code',
    'pub.activateFirst': 'First-time setup: FormSubmit sent a confirmation link to {email} — open it, then press Resend here.',
    'pub.deliverFailed': 'Email delivery failed: {m}', 'pub.sendFailed': 'Could not send the code: {m}',
    'pub.wrongCode': 'Wrong code',
    'pub.welcome': 'Signed in as {email}', 'pub.bye': 'Signed out',
    'auth.googleFail': 'Google sign-in failed', 'auth.adminOnly': 'This page is restricted to administrator accounts',
    'auth.googleFailed': 'Google sign-in failed · only @{d} accounts can access the admin',
    /* ── SLA (logistics service desk) ── */
    'adm.sla.title': 'SLA · first response & resolution (working hours)',
    'adm.sla.goals': 'SLA goals',
    'adm.sla.respGoal': 'First response within (working h)',
    'adm.sla.resGoal': 'Resolution within (working h)',
    'adm.sla.save': 'Save goals',
    'adm.sla.saving': 'Saving…',
    'adm.sla.saved': 'SLA goals saved: first response {rh} working h · resolution {sh} working h',
    'adm.sla.saveFail': 'Could not save SLA goals:',
    'adm.sla.invalid': 'SLA goals must be positive hours',
    'adm.sla.legend': 'Dashed line = SLA goal · green = inside SLA, red = out of SLA',
    'adm.sla.schedule': 'Working clock ticks Mon–Fri, 02:00–10:00 (Tbilisi) · goals are WORKING hours, not calendar hours',
    'adm.sla.respKpi': 'First response · SLA status',
    'adm.sla.resKpi': 'Resolution · SLA status',
    'adm.sla.respHist': 'First response · how fast replies came',
    'adm.sla.resHist': 'Resolution · how long tasks took',
    'adm.sla.medRespSub': 'median {t} working · {n} tasks with first reply',
    'adm.sla.medResSub': 'median {t} working · {n} tasks resolved',
    'adm.sla.nodataSub': 'no measured tasks in period',
    'adm.sla.inSla': 'In SLA', 'adm.sla.outSla': 'Out of SLA',
    'adm.sla.pending': 'Waiting (within goal)', 'adm.sla.overdue': 'Overdue (past goal)',
    'adm.sla.nodata': 'No first reply data',
    'adm.sla.nodataRes': 'No resolution data',
    'adm.sla.respBreaches': 'First-response breaches',
    'adm.sla.resBreaches': 'Resolution breaches',
    'adm.sla.respTitle': 'First response', 'adm.sla.resTitle': 'Resolution',
    'adm.sla.resRunning': 'Still open · elapsed',
    'adm.sla.dl.slaResp': 'First response · measured (met + breached)', 'adm.sla.dl.slaRes': 'Resolution · measured (met + breached)',
    'adm.sla.dl.slaRespIn': 'First response · in SLA', 'adm.sla.dl.slaResIn': 'Resolution · in SLA',
    'adm.sla.dl.slaRespOut': 'First response · breached', 'adm.sla.dl.slaResOut': 'Resolution · breached',
    'adm.sla.dl.slaRespPending': 'First response · still waiting (within goal)', 'adm.sla.dl.slaResPending': 'Resolution · still waiting (within goal)',
    'adm.sla.dl.slaRespOverdue': 'First response · overdue (past goal)', 'adm.sla.dl.slaResOverdue': 'Resolution · overdue (past goal)',
    'adm.sla.dl.slaRespNodata': 'First response · no reply data', 'adm.sla.dl.slaResNodata': 'Resolution · no data'
  },
  ka: {
    'lg.toMain': 'ლოგისტიკის მაგიდაზე', 'lg.footer': 'JiraPulse · ლოგისტიკის ადმინი — ცოცხალი მონაცემები, მხოლოდ ადმინისთვის',
    'lg.loading': 'დავალებები იტვირთება…', 'lg.refresh': 'განახლება',
    'adm.badge': 'ლოგისტიკის ადმინი', 'adm.headTitle': 'ლოგისტიკის ადმინი',
    'adm.title': 'ლოგისტიკის ადმინი', 'adm.subtitle': 'მეტრიკები და აქტივობები · მხოლოდ ადმინისთვის',
    'adm.dashTitle': 'დაშბორდი', 'adm.dashSub': 'LOG სერვის-დესკის სრული მეტრიკები · “Internal” ეტიკეტი მალუფებულია',
    'adm.period': 'პერიოდი', 'adm.customRange': 'თვითონ არჩეული',
    'adm.p.30d': 'ბოლო 30 დღე', 'adm.p.month': 'ეს თვე', 'adm.p.quarter': 'ეს კვარტალი',
    'adm.p.year': 'ეს წელი', 'adm.p.all': 'მთელი ისტორია', 'adm.p.custom': 'სხვა…',
    'adm.kpi.total': 'დავალებები · პერიოდში', 'adm.kpi.today': 'დღეს შექმნილი', 'adm.kpi.month': 'ამ თვეს შექმნილი',
    'adm.kpi.resolved': 'გადაწყვეტილი · პერიოდში', 'adm.kpi.open': 'ღია (პერიოდში)', 'adm.kpi.resAll': 'გადაწყვეტილი (მთელი ისტორია)',
    'adm.kpi.active': 'ახლა აქტიური', 'adm.kpi.logins': 'ლოგინები დღეს',
    'adm.kpi.avgRes': 'საშ. გადაწყვეტის დრო', 'adm.kpi.inwork': 'მიმდ. პროცესში',
    'adm.kpi.totalSub': 'შექმნილი არჩეულ პერიოდში', 'adm.kpi.openSub': 'ჯერ გადაუწყვეტელი',
    'adm.kpi.basedOn': 'ეყრდნობა {n} დავალებას გადაწყვეტის თარიღით',
    'adm.kpi.medianOn': 'მედიანა {n} პერიოდში გადაწყვეტილ დავალებაზე (შექმნიდან გადაწყვეტამდე)',
    'adm.kpi.medianNone': 'პერიოდში გადაწყვეტილი დავალება არ არის',
    'adm.dl.title': 'დავალებების სია', 'adm.dl.tip': 'ამ დავალებების სიაში ნახვა',
    'adm.dl.resMarker': 'გადაწყვეტილი', 'adm.dl.openCard': 'დავალების დეტალების გახსნა',
    'adm.dl.searchPh': 'ამოცანების ძებნა…', 'adm.dl.filterAll': 'ყველა',
    'adm.dl.fStatus': 'სტატუსი', 'adm.dl.fReporter': 'მომხსენებელი', 'adm.dl.fAssignee': 'აღმასრულებელი',
    'adm.dl.fDirection': 'მიმართულება', 'adm.dl.fSla': 'SLA',
    'adm.dl.shown': 'ნაჩვენებია {a}–{b} / {n}', 'adm.dl.showMore': 'მეტის ჩვენება',
    'lg.th.reporter': 'მომხსენებელი', 'lg.th.assignee': 'ასიგნებული',
    'lg.th.created': 'შექმნის თარიღი', 'lg.th.updated': 'განახლება', 'lg.th.sla': 'SLA',
    'lg.th.direction': 'მიმართულება', 'lg.th.resolved': 'გადაწყვეტის თარიღი',
    'lg.th.comments': 'კომენტარები', 'lg.descLabel': 'აღწერა',
    'lg.card.noComments': 'კომენტარები არ არის', 'lg.card.noDescription': 'აღწერა არ არის',
    'lg.card.attachments': 'ატვირთული ფაილები', 'lg.row.hasFiles': 'აქვს ფაილები',
    'lg.card.download': 'ჩამოტვირთვა', 'lg.downloadFail': 'ჩამოტვირთვა ვერ მოხდა',
    'lg.unassigned': 'დაუნიშნავი',
    'adm.ch.daily': 'ახალი vs გადაწყვეტილი · არჩეული პერიოდი',
    'adm.ch.monthlyNew': 'ახალი დავალებები თვეებში · არჩეული პერიოდი',
    'adm.ch.monthlyDone': 'გადაწყვეტილი თვეებში · არჩეული პერიოდი',
    'adm.ch.donut': 'ღია vs გადაწყვეტილი · არჩეული პერიოდი',
    'adm.ch.status': 'სტატუსები · არჩეული პერიოდი',
    'adm.ch.assignees': 'საუკ. შემსრულებლები · ღია, პერიოდში',
    'adm.ch.reporters': 'საუკ. ავტორები · შექმნილი, პერიოდში',
    'adm.ch.direction': 'დავალებები განზის მიხედვით · პერიოდი',
    'adm.ch.dirDone': 'გადაწყვეტილი განზის მიხედვით · პერიოდი',
    'adm.ch.legResolved': 'გადაწყვეტილი', 'adm.ch.legOpen': 'ღია / მოლოდინში', 'adm.ch.legCreated': 'შექმნილი',
    'adm.lb.users': 'მომხმარებლები · შექმნა/გად. (პერიოდი)', 'adm.lb.dirs': 'განზები · პერიოდი',
    'adm.lb.user': 'მომხმარებელი', 'adm.lb.created': 'შექმნილი', 'adm.lb.resolved': 'გადაწყვეტილი', 'adm.lb.open': 'ღია',
    'adm.lb.direction': 'განზი', 'adm.lb.total': 'სულ', 'adm.lb.nodata': 'ამ პერიოდის მონაცემები არ არის',
    'adm.lb.search': 'ძებნა…', 'adm.act.lastTs': 'ბოლო აქტიური',
    'adm.activity': 'პლატფორმის გამოყენება და ლოგინები', 'adm.act.now': 'ახლა აქტიური', 'adm.act.today': 'დღეს ვიზიტორი',
    'adm.act.week': 'ამ კვირაში', 'adm.act.total': 'სულ მომხმარებელი', 'adm.act.lastSeen': 'ბოლო აქტიური',
    'adm.act.sessions': 'სესიები', 'adm.act.state': 'სტატუსი', 'adm.act.online': 'ლოგინში', 'adm.act.offline': 'არ არის',
    'adm.act.desk': 'ლოგისტიკის მაგიდა', 'adm.act.admin': 'ადმინ პანელი', 'adm.act.first': 'პირველი ვიზიტი',
    'adm.act.surface': 'ზედაპირი', 'adm.act.union': 'მთლიანი პლატფორმა', 'adm.act.dwell': 'გამოყენება', 'adm.act.both': 'მაგიდა + ადმინი',
    'adm.ch.period': 'პერიოდი', 'adm.ch.periodMaster': 'ძირითადი პერიოდი',
    'adm.count.n': '{n} დავალება', 'adm.count.loading': 'იტვირთება…', 'adm.fetched': 'განახლდა {t}',
    /* ── SLA (logistics service desk) ── */
    'adm.sla.title': 'SLA · პირველი პასუხი და გადაწყვეტა (სამუშაო საათები)',
    'adm.sla.goals': 'SLA მიზნები',
    'adm.sla.respGoal': 'პირველი პასუხი (სამუშაო სთ)', 'adm.sla.resGoal': 'გადაწყვეტა (სამუშაო სთ)',
    'adm.sla.save': 'მიზნების შენახვა', 'adm.sla.saving': 'ინახება…',
    'adm.sla.saved': 'SLA მიზნები შენახულია: პირველი პასუხი {rh} სამუშაო სთ · გადაწყვეტა {sh} სამუშაო სთ',
    'adm.sla.saveFail': 'SLA მიზნების შენახვა ვერ მოხდა:',
    'adm.sla.invalid': 'SLA მიზნები უნდა იყოს დადებითი საათები',
    'adm.sla.legend': 'ტაშტირებული ხაზი = SLA მიზანი · მწვანე = SLA-ში, წითელი = SLA-გარე',
    'adm.sla.schedule': 'სამუშაო საათი ითვლება ორშ–პარ, 02:00–10:00 (თბილისი) · მიზნები სამუშაო საათებშია, არა კალენდარულში',
    'adm.sla.respKpi': 'პირველი პასუხი · SLA სტატუსი',
    'adm.sla.resKpi': 'გადაწყვეტა · SLA სტატუსი',
    'adm.sla.respHist': 'პირველი პასუხი · რამდენად სწრაფად მოვიდა',
    'adm.sla.resHist': 'გადაწყვეტა · რამდენ ხანში გადაიწყდა',
    'adm.sla.medRespSub': 'მედიანა {t} სამუშაო · {n} დავალება პასუხით',
    'adm.sla.medResSub': 'მედიანა {t} სამუშაო · {n} გადაწყვეტილი დავალება',
    'adm.sla.nodataSub': 'გაზომილი დავალება პერიოდში არ არის',
    'adm.sla.inSla': 'SLA-ში', 'adm.sla.outSla': 'SLA-გარე',
    'adm.sla.pending': 'ლოდინში (მიზანში)', 'adm.sla.overdue': 'ვადაგადაცილებული',
    'adm.sla.nodata': 'პირველი პასუხის მონაცემი არ არის',
    'adm.sla.nodataRes': 'გადაწყვეტის მონაცემი არ არის',
    'adm.sla.respBreaches': 'პირველი პასუხის დარღვევები',
    'adm.sla.resBreaches': 'გადაწყვეტის დარღვევები',
    'adm.sla.respTitle': 'პირველი პასუხი', 'adm.sla.resTitle': 'გადაწყვეტა',
    'adm.sla.resRunning': 'ღიაა · გასული',
    'adm.sla.dl.slaResp': 'პირველი პასუხი · გაზომილი (შესრულ. + დარღვეული)', 'adm.sla.dl.slaRes': 'გადაწყვეტა · გაზომილი (შესრულ. + დარღვეული)',
    'adm.sla.dl.slaRespIn': 'პირველი პასუხი · SLA-ში', 'adm.sla.dl.slaResIn': 'გადაწყვეტა · SLA-ში',
    'adm.sla.dl.slaRespOut': 'პირველი პასუხი · დარღვეული', 'adm.sla.dl.slaResOut': 'გადაწყვეტა · დარღვეული',
    'adm.sla.dl.slaRespPending': 'პირველი პასუხი · ლოდინში (მიზანში)', 'adm.sla.dl.slaResPending': 'გადაწყვეტა · ლოდინში (მიზანში)',
    'adm.sla.dl.slaRespOverdue': 'პირველი პასუხი · ვადაგადაცილებული', 'adm.sla.dl.slaResOverdue': 'გადაწყვეტა · ვადაგადაცილებული',
    'adm.sla.dl.slaRespNodata': 'პირველი პასუხი · მონაცემი არ არის', 'adm.sla.dl.slaResNodata': 'გადაწყვეტა · მონაცემი არ არის',
    'settings.email': 'ელფოსტა',
    'theme.title': 'თემის შეცვლა', 'theme.dark': 'მუქი თემა', 'theme.light': 'ღია თემა',
    'pub.google': 'Google-ით შესვლა', 'pub.orEmail': '— ან იმეილით —', 'pub.emailPh': 'you@caucasusauto.com',
    'pub.send': 'კოდის გაგზავნა', 'pub.accessCode': 'საკ. კოდი', 'pub.codePh': '6-ციფრიანი კოდი', 'pub.verify': 'დადასტ.',
    'pub.signOut': '⎋ გასვლა', 'pub.signOutTitle': 'გასვლა და დაბრუნება შესვლის ეკრანზე',
    'auth.sending': 'კოდი იგზავნება…',
    'pub.sending': 'კოდი იგზავნება {email}-ზე…', 'pub.invalidEmail': 'იმეილი უნდა ბოლოვდებოდეს @{d}-ს',
    'pub.sentTo': 'კოდი გაიგზავნა {email}-ზე', 'pub.resendCode': 'კოდის ხელახლა გაგზავნა',
    'pub.activateFirst': 'პირველი გამართვა: FormSubmit-მა დაატანა დადასტურების ბმული {email}-ზე — გახსენით ის, ხოლო აქ დააჭირეთ ხელახლა გაგზავნას.',
    'pub.deliverFailed': 'მსმ. ვერ შესრულდა: {m}', 'pub.sendFailed': 'კოდი ვერ გაიგზავნა: {m}',
    'pub.wrongCode': 'კოდი არასწორია',
    'pub.welcome': 'შესული ხართ როგორც {email}', 'pub.bye': 'გამოხვედით',
    'auth.googleFail': 'Google-ით შესვლა ჩავარდა', 'auth.adminOnly': 'გვერდი ხელმისაწვდომია მხოლოდ ადმინისთვის',
    'auth.googleFailed': 'Google-ით შესვლა ჩავარდა · მხოლოდ @{d} იმეილებით შესვლა შესაძლებელია'
  }
};
/* ═══ 4. i18n / theme helpers ═══ */
const t = (k) => (I18N[adm.lang] && I18N[adm.lang][k]) || I18N.en[k] || k;
const tReplace = (k, vars) => String(t(k)).replace(/\{(\w+)\}/g, (m, key) => (vars && vars[key] != null) ? vars[key] : m);
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
  document.documentElement.lang = adm.lang;
}
function setLangButtons() {
  document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === adm.lang));
}
function setLang(lang) {
  adm.lang = (lang === 'ka') ? 'ka' : 'en';
  try { localStorage.setItem(LS_LANG, adm.lang); } catch (e) {}
  setLangButtons(); applyI18n(); admRenderPeriodSelect(); renderAll();
}
function applyThemeClass() {
  let th = 'dark';
  try { th = localStorage.getItem(LS_THEME) || 'dark'; } catch (e) {}
  document.body.classList.toggle('light', th === 'light');
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === th));
}
function setTheme(th) {
  try { localStorage.setItem(LS_THEME, th); } catch (e) {}
  applyThemeClass(); redrawCharts();
}

/* ═══ 5. Auth core (publish code, email checks, JWT) ═══ */
function publishCode(seed, email) {
  const s = String(seed || '') + '|' + String(email || '').toLowerCase() + '|jp';
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0; h1 = (h1 * 0x01000193) >>> 0;
    h2 = (h2 + c * 31) >>> 0; h2 = (h2 ^ (h2 << 13)) >>> 0;
  }
  let out = String((h1 >>> 0) % 1000000);
  while (out.length < 6) out = '0' + out;
  let mix = (h2 >>> 0) % 97;
  out = String((parseInt(out, 10) + mix * 7) % 1000000);
  while (out.length < 6) out = '0' + out;
  return out;
}
function publishEmailOk(email) {
  const e = String(email || '').trim().toLowerCase();
  return /.+@([a-z0-9.-]*\.)?caucasusauto\.com$/i.test(e);
}
function adminEmailOk(email) {
  const e = String(email || '').trim().toLowerCase();
  return ADMIN_EMAILS.indexOf(e) !== -1;
}
function decodeJwt(token) {
  try {
    const p = String(token || '').split('.')[1];
    if (!p) return null;
    const b = p.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(atob(b).split('').map(c =>
      '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    return JSON.parse(json);
  } catch (e) { return null; }
}
function googleReady() { return !!(window.google && google.accounts && google.accounts.id); }

/* ═══ 6. Admin session storage ═══ */
function admSaveSession() {
  try { localStorage.setItem(LS_ADM_SESSION, JSON.stringify({ email: adm.email })); } catch (e) {}
}
function admRestoreSession() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_ADM_SESSION) || 'null');
    if (d && adminEmailOk(d.email)) { adm.email = d.email; adm.verified = true; return true; }
  } catch (e) {}
  return false;
}
function admClearSession() { try { localStorage.removeItem(LS_ADM_SESSION); } catch (e) {} }

function loadConn() {
  try { return JSON.parse(localStorage.getItem(LS_CONN) || 'null'); } catch (e) { return null; }
}
/* ═══ 7. Google GSI + email-code flow ═══ */
function handleAdmGoogleCredential(resp) {
  const p = decodeJwt(resp && resp.credential);
  if (!p || !p.email) { admGateMsg(t('auth.googleFail')); return; }
  const email = String(p.email).toLowerCase();
  if (!publishEmailOk(email) || !adminEmailOk(email)) {
    admGateMsg(tReplace('auth.googleFailed', { d: PUBLISH_DOMAIN }));
    try { if (googleReady()) google.accounts.id.disableAutoSelect(); } catch (e) {}
    return;
  }
  adm.email = email; adm.verified = true; admSaveSession();
  admGateMsg(''); admEnterVerified(tReplace('pub.welcome', { email }));
}
function initAdmGoogleButton() {
  const tryInit = () => {
    if (!googleReady()) return false;
    try {
      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleAdmGoogleCredential,
        auto_select: false, use_fedcm_for_prompt: false
      });
      google.accounts.id.renderButton($('#admGoogleBtn'), {
        theme: 'outline', size: 'large', width: 320, text: 'signin_with',
        locale: adm.lang === 'ka' ? 'ka' : 'en'
      });
      return true;
    } catch (e) { return false; }
  };
  const poll = setInterval(() => { if (tryInit()) clearInterval(poll); }, 200);
  setTimeout(() => clearInterval(poll), 20000);
}

async function admSendCode() {
  if (adm.sending) return;
  const email = ($('#admEmail') && $('#admEmail').value || '').trim();
  const el = $('#admEmail');
  if (!publishEmailOk(email)) { admGateMsg(tReplace('pub.invalidEmail', { d: PUBLISH_DOMAIN })); return; }
  if (!adminEmailOk(email)) { admGateMsg(t('auth.adminOnly')); return; }
  adm.emailDraft = email;
  adm.codeSent = true;
  const btn = $('#admSendBtn');
  btn.disabled = true; btn.textContent = t('auth.sending');
  admGateMsg(tReplace('pub.sending', { email }));
  const code = publishCode(LOG_CODE_SEED, email);
  const recipient = email;
  const subject = 'Your JiraPulse admin access code';
  const body =
    'Hello,\n\n' +
    'Your one-time access code for the JiraPulse Logistics admin dashboard is:\n\n' +
    code + '\n\n' +
    'Enter it on the admin page to view the dashboard.\n\n' +
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
        _captcha: 'false'
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || 'Email service error (' + res.status + ')';
      throw new Error(msg);
    }
    if (data && data.success === false) {
      const reason = (data && data.message) || 'the email service needs confirmation';
      const activating = /activat/i.test(reason);
      admGateMsg(activating
        ? tReplace('pub.activateFirst', { email })
        : tReplace('pub.deliverFailed', { m: reason }));
      show($('#admCodeWrap')); show($('#admVerifyBtn'));
      btn.textContent = t('pub.resendCode');
      return;
    }
    admGateMsg(tReplace('pub.sentTo', { email }));
    show($('#admCodeWrap')); show($('#admVerifyBtn'));
    btn.textContent = t('pub.resendCode');
    $('#admCode').focus();
  } catch (e) {
    admGateMsg(tReplace('pub.sendFailed', { m: (e && e.message) || 'network error' }));
  } finally {
    btn.disabled = false;
    if (!btn.textContent.startsWith('Resend') && !btn.textContent.startsWith('კოდის ხელახლა')) btn.textContent = t('pub.send');
  }
}
function admVerifyCode() {
  const email = ($('#admEmail').value || '').trim();
  const code = ($('#admCode').value || '').trim();
  if (!publishEmailOk(email) || !adminEmailOk(email)) { admGateMsg(t('auth.adminOnly')); return; }
  if (code && code === publishCode(LOG_CODE_SEED, email)) {
    adm.email = email.toLowerCase(); adm.verified = true; admSaveSession();
    admGateMsg(''); admEnterVerified(tReplace('pub.welcome', { email: adm.email }));
  } else admGateMsg(t('pub.wrongCode'));
}

/* ═══ 8. Gate / enter / sign-out / chip ═══ */
function admGateMsg(m) { const el = $('#admStatus'); if (el) el.textContent = m || ''; }
function renderAdmGate() {
  hide($('#admContent')); show($('#admGate')); admGateMsg('');
}
function admEnterVerified(msg) {
  hide($('#admGate')); show($('#admContent'));
  updateAdmUserChip();
  if (msg) toast(msg);
  admRestorePeriod(); admChRestorePeriods(); admRenderPeriodSelect(); admRenderCustomWrap();
  admLoadData();
}
function admSignOut() {
  adm.verified = false; adm.email = ''; admClearSession();
  closeAdmSignOut();
  try { if (googleReady()) google.accounts.id.disableAutoSelect(); } catch (e) {}
  adm.rows = []; _admCache = null; adm.countIn = 0;
  renderAdmGate(); toast(t('pub.bye'));
}
function updateAdmUserChip() {
  const chip = $('#admUserChip'); if (!chip) return;
  if (!adm.email) { hide(chip); return; }
  show(chip);
  $('#admUserName').textContent = adm.email.split('@')[0];
  const av = $('#admUserAvatar');
  av.textContent = (adm.email[0] || '?').toUpperCase();
}
function toggleAdmSignOut(ev) {
  ev.stopPropagation();
  const btn = $('#admSignOutBtn');
  if (btn.classList.contains('hidden')) show(btn); else hide(btn);
}
function closeAdmSignOut() { hide($('#admSignOutBtn')); }

/* ═══ 9. Login ping + stats ═══ */
async function lgSendAdmPing(email) {
  try {
    await fetch(PUB_RELAY + '?cmd=lgPing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, surface: 'admin' })
    });
  } catch (e) {}
}
async function fetchAdmStats() {
  try {
    const r = await fetch(PUB_RELAY + '?cmd=lgStats');
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.ok) ? j : null;
  } catch (e) { return null; }
}

/* ═══ 9b. SLA goals (relay ?cmd=sla:get/set) + per-row SLA computation ═══
   The goals set in JSM (first response 2h · resolution 30h) are stored on
   the relay so the admin charts and the public task list always agree.
   Rows get: respAtMs (earliest agent reply), respMs, resMs, respState/resState
   ∈ 'in' | 'out' | 'pending' | 'overdue' | 'nodata'. */
async function fetchAdmSlaGoals() {
  try {
    const r = await fetch(PUB_RELAY + '?cmd=sla:get');
    if (!r.ok) return null;
    const j = await r.json();
    if (j && j.ok && j.goals && isFinite(j.goals.respHours) && isFinite(j.goals.resHours)) {
      adm.slaGoals = { respHours: Number(j.goals.respHours), resHours: Number(j.goals.resHours) };
      try { localStorage.setItem(LS_ADM_SLA_GOALS, JSON.stringify(adm.slaGoals)); } catch (e) {}
      return adm.slaGoals;
    }
  } catch (e) {}
  try {
    const saved = JSON.parse(localStorage.getItem(LS_ADM_SLA_GOALS) || 'null');
    if (saved && isFinite(saved.respHours) && isFinite(saved.resHours)) adm.slaGoals = saved;
  } catch (e) {}
  return adm.slaGoals;
}
async function admSaveSlaGoals(rh, sh) {
  const r = await fetch(PUB_RELAY + '?cmd=sla:set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-jp-admin': PUB_ADMIN_TOKEN },
    body: JSON.stringify({ respHours: rh, resHours: sh })
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
  adm.slaGoals = { respHours: j.goals.respHours, resHours: j.goals.resHours };
  try { localStorage.setItem(LS_ADM_SLA_GOALS, JSON.stringify(adm.slaGoals)); } catch (e) {}
  return adm.slaGoals;
}
/* ═══ SLA WORKING-HOURS CLOCK ═══
   The service desk's SLA goals are WORKING hours (first response 2h,
   resolution 30h) and the clock ticks Mon–Fri 02:00–10:00 Tbilisi time.
   Georgia is UTC+4 year-round (no DST), so all measurements are done in
   shifted integer math (ms + 4h then treated as UTC) — the viewer's own
   local timezone can never skew the result. */
const SLA_TZ_OFF = 4 * 3600e3;        /* Tbilisi = UTC+4 */
const SLA_WIN_START = 2 * 3600e3;     /* working window opens 02:00 */
const SLA_WIN_END = 10 * 3600e3;      /* working window closes 10:00 */
/* how much of the wall-clock span [fromMs, toMs] falls INSIDE the working
   schedule Mon–Fri 02:00–10:00 (Tbilisi). Pure integer math — walks the
   shifted calendar day-by-day, 8 working hours per weekday. */
function whSpanMs(fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  const a = fromMs + SLA_TZ_OFF, b = toMs + SLA_TZ_OFF;
  const aD = Math.floor(a / 864e5), bD = Math.floor(b / 864e5);
  let total = 0;
  for (let d = aD; d <= bD; d++) {
    const wd = (d + 4) % 7;                 /* 1970-01-01 was a Thursday → 0=Sun */
    if (wd === 0 || wd === 6) continue;     /* Sat/Sun — clock paused */
    const day0 = d * 864e5;
    const lo = Math.max(a, day0 + SLA_WIN_START);
    const hi = Math.min(b, day0 + SLA_WIN_END);
    if (hi > lo) total += hi - lo;
  }
  return total;
}
/* SLA state per row — called from admNormalize AFTER each row is built.
   First response = earliest REAL comment we hold by someone other than the
   reporter. NOTE: the relay ships only the last 10 public comments per issue,
   so on long threads the agent's true first reply is missing — we then have
   no reliable first-response figure and mark the row 'nodata' for response
   (an approximation there would invent SLA breaches). Resolution = created →
   resolutiondate/last-update, measured in WORKING hours. Open tasks keep a
   live working-clock: 'pending' while inside the goal, 'overdue' past it. */
/* map one JSM-native SLA aspect ({elapsedMs, goalMs, breached, completed,
   startMs, stopMs}) into the row's SLA state — same keys admSlaRow
   produces, so cells/filters/drills keep working unchanged. Verdict
   (green/red) comes from Jira's own `breached` flag, NOT from our
   working-hours re-estimate: JSM's clock is the exact one the agent view
   shows. Ongoing cycles are ignored (a paused 0m tells nothing); the
   working clock keeps covering open tasks. */
function admSlaApplyNative(r, sla) {
  if (!sla || typeof sla !== 'object') return;
  /* Jira's NEW_SLA_FORMAT quirk: completed cycles often report
     elapsedTime "0m" even though startTime/stopTime hold the real
     settlement window — recompute the working-clock span then (wall-clock
     fallback for settlements outside working hours). Verdict stays Jira's
     own breached flag either way. */
  const mk = (a) => {
    if (!a || !a.completed) return null;
    let ms = Number(a.elapsedMs) || 0;
    if (!ms && a.stopMs && a.startMs) {
      ms = whSpanMs(Number(a.startMs), Number(a.stopMs)) ||
        (Number(a.stopMs) - Number(a.startMs));
    }
    return { ms, state: a.breached ? 'out' : 'in' };
  };
  const resp = mk(sla.resp);
  const res = mk(sla.res);
  if (resp) { r.respMs = resp.ms; r.respAtMs = Number(sla.resp.stopMs) || r.respAtMs; r.respState = resp.state; r._natResp = true; }
  if (res) { r.resMs = res.ms; r.resolvedMs = res.ms; r.resState = res.state; r._natRes = true; }
  /* keep the native payload so the popup can show exact settled times */
  r.slaNative = sla;
}

function admSlaRow(r) {
  const g = adm.slaGoals || SLA_DEFAULT_GOALS;
  const respGoal = (g.respHours || 2) * 3600e3;   /* working-ms */
  const resGoal = (g.resHours || 30) * 3600e3;
  const now = Date.now();
  const rep = (r.reportName || '').toLowerCase().trim();
  let respAt = 0;
  for (const c of r.comments || []) {
    const au = (c.author || '').toLowerCase().trim();
    if (c.created && (rep ? (au && au !== rep) : !!au)) { respAt = c.created; break; }
  }
  r.respAtMs = respAt || 0;
  r.respMs = respAt ? whSpanMs(r.createdMs, respAt) : 0;
  r.elapsedMs = whSpanMs(r.createdMs, now);
  if (r.resolved) {
    /* zero working-span is a REAL measurement, not missing data: tasks
       created AND settled outside Mon–Fri 02:00–10:00 (same-evening /
       weekend work) span no calendar working time. Fall back to the
       wall-clock span so they land in in/out instead of the gray nodata
       bucket that used to swallow ~40% of all resolved work. */
    const resSpan = r.resolvedAt ? whSpanMs(r.createdMs, r.resolvedAt) : 0;
    r.resolvedMs = r.resMs = r.resolvedAt ? (resSpan || (r.resolvedAt - r.createdMs)) : 0;
    /* settled with NO non-reporter reply visible: the reply happened in the
       part of the thread the relay doesn't carry — Jira DID measure it
       (hydrated later via admSlaApplyNative); until then it's honest
       nodata, NOT 'out'. */
    r.respState = respAt ? (r.respMs <= respGoal ? 'in' : 'out') : 'nodata';
    r.resState = r.resMs ? (r.resMs <= resGoal ? 'in' : 'out') : 'nodata';
  } else {
    /* still open: the working clock keeps running — past goal ⇒ overdue, else pending */
    r.resolvedMs = 0; r.resMs = 0;
    r.respState = respAt ? (r.respMs <= respGoal ? 'in' : 'out') : (r.elapsedMs > respGoal ? 'overdue' : 'pending');
    r.resState = r.elapsedMs > resGoal ? 'overdue' : 'pending';
  }
  return r;
}
/* formats an SLA duration (WORKING hours): "1h 24m" up to 48wh, then days */
function admFmtSlaHours(ms) {
  if (!(ms > 0)) return '—';
  const h = ms / 3600e3;
  if (h >= 48) return Math.round(ms / 864e5) + 'd';
  const hi = Math.floor(h), mi = Math.round((h - hi) * 60);
  return mi && hi < 8 ? `${hi}h ${mi}m` : `${hi}h`;
}
/* ═══ 10. Date formats ═══ */
const LG_MONTHS_KA = ['იან', 'თებ', 'მარ', 'აპრ', 'მაი', 'ივნ', 'ივლ', 'აგვ', 'სექ', 'ოქტ', 'ნოე', 'დეკ'];
const LG_MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function lgParseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v); return isNaN(d.getTime()) ? null : d;
}
function fmtDateLong(v) {
  const d = lgParseDate(v); if (!d) return '';
  return adm.lang === 'ka'
    ? `${d.getDate()} ${LG_MONTHS_KA[d.getMonth()]} ${d.getFullYear()}`
    : `${d.getDate()} ${LG_MONTHS_EN[d.getMonth()]} ${d.getFullYear()}`;
}
function fmtDateTime(v) {
  const d = lgParseDate(v); if (!d) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return fmtDateLong(d) + ' ' + hm;
}
/* compact table date: Oct 19, 2026 (locale month names in ka) */
function fmtDate(v) {
  const d = lgParseDate(v); if (!d) return '';
  const mn = (adm.lang === 'ka') ? LG_MONTHS_KA[d.getMonth()] : LG_MONTHS_EN[d.getMonth()].slice(0, 3);
  return `${mn} ${d.getDate()}, ${d.getFullYear()}`;
}
function relTime(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

/* ═══ 11. Period logic ═══ */
function lgIsoStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function lgDayStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function lgDayEnd(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
function lgPeriodRange(kind, fromMs, toMs) {
  const now = new Date();
  if (kind === 'custom' && fromMs && toMs) {
    return { from: lgDayStart(new Date(fromMs)), to: lgDayEnd(new Date(toMs)) };
  }
  if (kind === 'today') return { from: lgDayStart(now), to: lgDayEnd(now) };
  if (kind === 'month') {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: lgDayEnd(now) };
  }
  if (kind === 'quarter') {
    const q = Math.floor(now.getMonth() / 3) * 3;
    return { from: new Date(now.getFullYear(), q, 1), to: lgDayEnd(now) };
  }
  if (kind === 'year') {
    return { from: new Date(now.getFullYear(), 0, 1), to: lgDayEnd(now) };
  }
  if (kind === 'all') return { from: new Date(2000, 0, 1), to: lgDayEnd(now) };
  // default 30d
  const from = new Date(now); from.setDate(from.getDate() - 29);
  return { from: lgDayStart(from), to: lgDayEnd(now) };
}
function admSavePeriod() {
  try { localStorage.setItem(LS_ADM_PERIOD, JSON.stringify(adm.period)); } catch (e) {}
}
function admRestorePeriod() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_ADM_PERIOD) || 'null');
    if (p && p.kind) adm.period = { kind: p.kind, fromMs: p.fromMs || null, toMs: p.toMs || null };
  } catch (e) {}
}
function admPeriodRange() { return lgPeriodRange(adm.period.kind, adm.period.fromMs, adm.period.toMs); }

/* ── per-chart period overrides ──
   Each of the 9 chart cards has its own select (default = the master period).
   A chart that was changed individually gets its own range; the rest follow
   the master period. Persists to localStorage so it survives reloads. */
function admChSavePeriods() {
  try { localStorage.setItem(LS_ADM_CHPERIOD, JSON.stringify(adm.chPeriod)); } catch (e) {}
}
function admChRestorePeriods() {
  try { const p = JSON.parse(localStorage.getItem(LS_ADM_CHPERIOD) || 'null'); if (p && typeof p === 'object') adm.chPeriod = p; } catch (e) {}
}
function admChRenderSelects() {
  document.querySelectorAll('select[data-ch-period]').forEach(sel => {
    const ch = sel.dataset.chPeriod;
    const cur = adm.chPeriod[ch] || 'master';
    if (!sel.dataset.built) {
      const opts = [['master', 'adm.ch.periodMaster'], ['30d', 'adm.p.30d'], ['month', 'adm.p.month'],
        ['quarter', 'adm.p.quarter'], ['year', 'adm.p.year'], ['all', 'adm.p.all']];
      sel.innerHTML = opts.map(([v, k]) => `<option value="${v}">${escapeHtml(t(k))}</option>`).join('');
      sel.dataset.built = '1';
      sel.addEventListener('change', () => {
        adm.chPeriod[ch] = sel.value;
        admChSavePeriods();
        redrawCharts();
      });
    }
    sel.value = cur;
  });
}
/* aggregate for a specific chart card: its own override range, else the master aggregate */
function admChAggregateFor(chId, masterAggr, masterRange) {
  const kind = adm.chPeriod[chId] || 'master';
  if (kind === 'master') return masterAggr;
  return admAggregate(adm.rows, lgPeriodRange(kind, null, null));
}

/* ═══ 12. Status classification ═══ */
const LG_ST_RE_DONE = /done|closed|resolved|complete|cancel|დასრულ|გადაწყ|cancel/i;
const LG_ST_RE_PROGRESS = /progress|in work|working|მიმდინარე|სამუშაო/i;
const LG_ST_RE_WAIT = /wait|pending|hold|blocked|ლოდინ|მოლოდინ/i;
function lgStatusClass(st) {
  const s = String(st || '');
  if (LG_ST_RE_DONE.test(s)) return 'lg-st-done';
  if (LG_ST_RE_PROGRESS.test(s)) return 'lg-st-progress';
  if (LG_ST_RE_WAIT.test(s)) return 'lg-st-wait';
  return 'lg-st-other';
}
function admIsResolved(f) {
  return !!(f.resolution && f.resolution.name) || lgStatusClass(f.status && f.status.name) === 'lg-st-done';
}

/* ═══ 13. Fetch desk (relay ?cmd=desk) ═══ */
async function admFetchDesk(force) {
  if (_admAbort) { try { _admAbort.abort(); } catch (e) {} _admAbort = null; }
  if (!force && _admCache && (Date.now() - _admCache.at) < ADM_LIVE_TTL) return _admCache.data;
  const domain = PUBLISH_DOMAIN;
  const ctrl = new AbortController();
  _admAbort = ctrl;
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 40000);
  try {
    const url = PUB_RELAY + '?cmd=desk&project=' + DESK_PROJECT + '&domain=' + encodeURIComponent(domain);
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('relay ' + r.status);
    const data = await r.json();
    if (!data || !data.ok) throw new Error('bad relay response');
    _admCache = { at: Date.now(), data };
    if (data.fieldIds) {
      try { localStorage.setItem(LS_ADM_FIELDIDS, JSON.stringify(data.fieldIds)); } catch (e) {}
      adm.fieldIds = { direction: data.fieldIds.direction || adm.fieldIds.direction, title: data.fieldIds.title || adm.fieldIds.title };
    }
    return data;
  } finally { clearTimeout(timer); _admAbort = null; }
}
/* ═══ 14. Normalize (mirror of lgNormalize) ═══ */
function lgAdfText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(lgAdfText).join(' ');
  if (typeof v === 'object') {
    if (v.text) return v.text;
    if (v.content) return lgAdfText(v.content);
    if (v.type === 'text' && v.text) return v.text;
    return '';
  }
  return String(v);
}
function admNormalize(data) {
  const dirId = adm.fieldIds.direction;
  const issues = (data && data.issues) || [];
  const rows = [];
  for (const it of issues) {
    const f = it.fields || {};
    const labels = Array.isArray(f.labels) ? f.labels : [];
    if (labels.some(l => String(l).toLowerCase() === DESK_EXCLUDE_LABEL)) continue;
    const statusName = (f.status && f.status.name) || '';
    const resolved = admIsResolved(f);
    const realRdMs = Date.parse(f.resolutiondate) || 0;
    /* detail-popup data — mirrors the desk's lgNormalize so the popup can
       show the full description, comment thread and the 📎 badge */
    const descRaw = lgAdfText(f.description).replace(/\r/g, '');
    const descLines = descRaw.split('\n').map((s) => s.trim()).filter(Boolean);
    const rawComments = Array.isArray(f.comment) ? f.comment : [];
    const comments = rawComments.map((c) => ({
      author: String(c?.author || ''),
      created: c?.created ? Date.parse(c.created) : 0,
      body: String(c?.body || '').replace(/\r/g, '').trim(),
      _idx: typeof c.idx === 'number' ? c.idx : null,
    })).filter((c) => c.body);
    const attFiles = (Array.isArray(f.attachment) ? f.attachment : [])
      .map((a) => ({ filename: String(a?.filename || ''), mimeType: String(a?.mimeType || '') }))
      .filter((a) => a.filename);
    /* ordered description media (media UUID + alt filename) — the detail
       popup paints one slot per 📷 marker in the text and slots the
       matching ?cmd=deskAttach attachment into each (mirrors the desk) */
    const descMedia = Array.isArray(f.descMedia)
      ? f.descMedia.map((m) => ({ id: String(m?.id || ''), alt: String(m?.alt || '') }))
      : [];
    rows.push({
      key: it.key || '',
      href: JIRA_BASE + (it.key || ''),
      summary: String(f.summary || '').trim(),
      status: statusName,
      statusCls: lgStatusClass(statusName),
      resolved,
      resName: (f.resolution && f.resolution.name) || '',
      reportName: (f.reporter && f.reporter.displayName) || '',
      assignName: (f.assignee && f.assignee.displayName) || '',
      labels,
      descFull: descLines.join('\n'),
      descOne: descLines[0] || '',
      comments,
      attFiles,
      descMedia,
      createdMs: Date.parse(f.created) || 0,
      updatedMs: Date.parse(f.updated) || 0,
      resolvedAt: resolved ? (realRdMs || Date.parse(f.updated) || Date.parse(f.created) || 0) : 0,
      rdReal: realRdMs > 0,
      direction: admShortDir(dirId ? lgAdfText(f[dirId]) : '')
    });
    const row = rows[rows.length - 1];
    admSlaRow(row);
    /* Jira's OWN SLA cycles ship in the bulk payload now — apply them AFTER
       the approximation so every chart/KPI/filter aggregates from the same
       verdicts the agent view shows (no more invented "no first reply" 33%).
       Drop _natResp/_natRes applied flags so hydration can still overwrite. */
    if (it.fields && (it.fields.sla || it.fields.slaRes)) {
      admSlaApplyNative(row, { resp: it.fields.sla || null, res: it.fields.slaRes || null });
      delete row._natResp; delete row._natRes;
      /* bulk native is PARTIAL: Jira's search/o-issue GET never carries the
         first-response cycles on this instance (only servicedeskapi does) —
         mark the row so admSlaQueueMissing still queues it for the full
         per-issue fetch. Cleared by admSlaPump once hydration lands. */
      row.slaBulk = true;
    }
  }
  return rows;
}
/* Direction values are long bilingual strings like
   "Photos and Claims (ფოტოები და პრეტენზიები) / Additional Photos — დამატებითი საწყობის სურათების გადაღება".
   For charts/tables keep only the readable English segment before " — "
   (e.g. "Photos and Claims / Additional Photos") and cap its length. */
function admShortDir(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  const dash = s.indexOf(' — ');
  if (dash > 0) s = s.slice(0, dash);
  // values look like "English (Georgian) / English - Georgian — Georgian description";
  // keep only the English part of each "/" segment and rejoin
  const hasGeo = (str) => { for (const ch of str) { if (ch >= 'ა' && ch <= 'ჰ') return true; } return false; };
  s = s.split('/')
    .map(seg => {
      let q = seg.replace(/\s*\([^)]*\)/g, '');
      const segs = q.split(/\s+-\s+/);
      const keep = segs.filter(sg => !hasGeo(sg));
      return (keep.length ? keep : segs.slice(0, 1)).join(' - ').trim();
    })
    .filter(Boolean).join(' / ');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s.length > 48 ? s.slice(0, 47).replace(/\s+\S*$/, '') + '…' : s;
}

/* ═══ 15. Aggregation (metrics) ═══ */
function ymdOf(ms) { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function ymOf(ms) { return ymdOf(ms).slice(0, 7); }
function admAggregate(rows, range) {
  const from = range.from.getTime(), to = range.to.getTime();
  const periodDays = Math.max(1, Math.round((to - from) / 864e5));
  const aggr = {
    total: 0, resolvedPeriod: 0, createdToday: 0, createdMonth: 0,
    open: 0, resolvedAll: 0,
    perDay: [], perMonth: [],
    perUser: new Map(), perDir: new Map(),
    perReporter: new Map(),
    donut: { open: 0, resolved: 0 },
    perStatus: new Map(),
    resDaysList: [],
    resRealN: 0, resApproxN: 0, periodDays,
    /* SLA compliance buckets + duration samples (see admSlaRow).
       resp* = first-response, res* = resolution. dur = in-period pctiles. */
    slaResp: { in: 0, out: 0, pending: 0, overdue: 0, nodata: 0 },
    slaRes: { in: 0, out: 0, pending: 0, overdue: 0, nodata: 0 },
    slaRespMsList: [], slaResMsList: [],
    slaPerDir: new Map()   /* dir → { respIn, respOut, resIn, resOut } */
  };
  /* bucket granularity for the created-vs-resolved trend:
     ≤120 days → daily · ≤560 days → weekly (Monday-anchored) · beyond → monthly */
  const useDay = periodDays <= 120;
  const useWeeks = !useDay && periodDays <= 560;
  const useMonths = !useDay && !useWeeks;
  const dayKey = (ms) => useDay ? ymdOf(ms)
    : useWeeks ? 'W' + ymdOf(ms - ((ms - 4 * 864e5) % (7 * 864e5)))   /* anchor Monday */
    : 'M' + ymOf(ms);
  const dayMap = new Map();
  if (useDay) {
    for (let i = periodDays - 1; i >= 0; i--) {
      const d = new Date(to - i * 864e5);
      dayMap.set(ymdOf(d.getTime()), { created: 0, resolved: 0 });
    }
  } else if (useWeeks) {
    /* seed week buckets from period start to end */
    let ws = from - ((from - 4 * 864e5) % (7 * 864e5));
    for (; ws <= to; ws += 7 * 864e5) dayMap.set('W' + ymdOf(ws), { created: 0, resolved: 0 });
  }
  /* for month-granularity ranges the trend chart reuses the (capped-24) monthly
     buckets; monMap below is seeded first and merged back into dayMap after */
  // monthly buckets: months spanned by the selected period, seeded BACKWARD from
  // the period end and capped at 24 so "all time" keeps the most recent months
  const monMap = new Map();
  {
    const endD = new Date(to);
    let y = endD.getFullYear(), m = endD.getMonth();
    const startRef = new Date(from);
    while (monMap.size < 24) {
      monMap.set(`${y}-${String(m + 1).padStart(2, '0')}`, { created: 0, resolved: 0 });
      if (y === startRef.getFullYear() && m === startRef.getMonth()) break;
      m--; if (m < 0) { m = 11; y--; }
    }
  }
  for (const r of rows) {
    if (r.createdMs >= todayStart0()) aggr.createdToday++;
    if (r.createdMs >= mStart0()) aggr.createdMonth++;
    if (r.resolved) { aggr.resolvedAll++; if (r.rdReal) aggr.resRealN++; else aggr.resApproxN++; }
    const inPeriod = r.createdMs >= from && r.createdMs <= to;
    /* resolved-in-period checks run BEFORE the created-in-period early
       continue, so tasks created earlier but resolved inside the period
       still count in "resolved · period", the user table and the median
       resolution-time sample (the caption counts resolutions, not only
       period-created tasks). */
    const resInPeriod = r.resolved && r.resolvedAt >= from && r.resolvedAt <= to;
    // resolution time (days) — MEDIAN over EVERY task resolved inside the
    // selected period, regardless of creation date. Jira only writes a real
    // resolutiondate on a small subset (probe: 2193/2217 resolved LOG issues
    // lack rd); for the rest fall back to `updated` (admNormalize already
    // resolves resolvedAt to realRd || updated || created), so the sample
    // covers ALL resolved-in-period tasks — with the previously rdReal-only
    // gate the KPI said "1.1d / median of 13" while 1630 tasks resolved.
    if (resInPeriod && r.resolvedAt > r.createdMs) {
      aggr.resDaysList.push((r.resolvedAt - r.createdMs) / 864e5);
    }
    if (!inPeriod) {
      /* still allow resolutions that happened inside the period for tasks
         created earlier — they count in "resolved · period" and perUser */
      if (resInPeriod) {
        aggr.resolvedPeriod++;
        const uo = r.assignName || r.reportName || '—';
        const rud = aggr.perUser.get(uo);
        if (rud) rud.resolved++;
      }
      continue;
    }
    aggr.total++;
    if (r.resolved) { aggr.donut.resolved++; } else { aggr.donut.open++; }
    if (resInPeriod) aggr.resolvedPeriod++;
    // status breakdown ( period-created work )
    const stn = r.status || '—';
    aggr.perStatus.set(stn, (aggr.perStatus.get(stn) || 0) + 1);
    // daily buckets (period-scoped)
    const ck = dayKey(r.createdMs);
    if (dayMap.has(ck)) dayMap.get(ck).created++;
    if (r.resolved && r.resolvedAt) {
      const rk = dayKey(r.resolvedAt);
      if (dayMap.has(rk)) dayMap.get(rk).resolved++;
    }
    // monthly buckets (period-scoped)
    const cm = ymOf(r.createdMs);
    if (monMap.has(cm)) monMap.get(cm).created++;
    if (r.resolved && r.resolvedAt) {
      const rm = ymOf(r.resolvedAt);
      if (monMap.has(rm)) monMap.get(rm).resolved++;
    }
    // users (period-created)
    const u = r.assignName || r.reportName || '—';
    if (!aggr.perUser.has(u)) aggr.perUser.set(u, { created: 0, resolved: 0, open: 0 });
    const ur = aggr.perUser.get(u);
    ur.created++;
    if (resInPeriod) ur.resolved++;
    if (!r.resolved) ur.open++;
    // directions (period-created)
    const dn = r.direction || '—';
    if (!aggr.perDir.has(dn)) aggr.perDir.set(dn, { total: 0, resolved: 0, open: 0 });
    const dr = aggr.perDir.get(dn);
    dr.total++;
    if (r.resolved) dr.resolved++; else dr.open++;
    // reporters (period-created)
    const rp = r.reportName || '—';
    aggr.perReporter.set(rp, (aggr.perReporter.get(rp) || 0) + 1);
    // ═══ SLA buckets (period-created work) ═══
    aggr.slaResp[r.respState] = (aggr.slaResp[r.respState] || 0) + 1;
    aggr.slaRes[r.resState] = (aggr.slaRes[r.resState] || 0) + 1;
    /* duration samples feed the "how well inside SLA" histogram — include
       ALL period-created tasks with a measured value, resolved or not */
    if (r.respMs > 0) aggr.slaRespMsList.push(r.respMs);
    if (r.resMs > 0) aggr.slaResMsList.push(r.resMs);
    if (!aggr.slaPerDir.has(dn)) aggr.slaPerDir.set(dn, { respIn: 0, respOut: 0, resIn: 0, resOut: 0, respOverdue: 0, resOverdue: 0 });
    const sd = aggr.slaPerDir.get(dn);
    if (r.respState === 'in') sd.respIn++; else if (r.respState === 'out' || r.respState === 'overdue') sd.respOut++;
    if (r.resState === 'in') sd.resIn++; else if (r.resState === 'out' || r.resState === 'overdue') sd.resOut++;
  }
  /* median first-response (robust against outliers) */
  aggr.slaRespN = aggr.slaRespMsList.length;
  if (aggr.slaRespN) {
    const rl = aggr.slaRespMsList.slice().sort((x, y) => x - y);
    const mid = Math.floor(rl.length / 2);
    aggr.medRespMs = rl.length % 2 ? rl[mid] : (rl[mid - 1] + rl[mid]) / 2;
  } else aggr.medRespMs = null;
  /* median resolution (hours precision for the SLA card) */
  aggr.slaResN = aggr.slaResMsList.length;
  if (aggr.slaResN) {
    const rl = aggr.slaResMsList.slice().sort((x, y) => x - y);
    const mid = Math.floor(rl.length / 2);
    aggr.medResMs = rl.length % 2 ? rl[mid] : (rl[mid - 1] + rl[mid]) / 2;
  } else aggr.medResMs = null;
  /* median resolution time (robust against outliers) */
  aggr.resDaysN = aggr.resDaysList.length;
  if (aggr.resDaysN) {
    const dl = aggr.resDaysList.slice().sort((x, y) => x - y);
    const mid = Math.floor(dl.length / 2);
    aggr.avgResDays = dl.length % 2 ? dl[mid] : (dl[mid - 1] + dl[mid]) / 2;
  } else aggr.avgResDays = null;
  if (useMonths) {
    /* trend buckets are the monthly buckets themselves: rebuild dayMap from monMap */
    dayMap.clear();
    for (const [k, v] of monMap) dayMap.set('M' + k, { created: v.created, resolved: v.resolved });
  }
  aggr.perDay = Array.from(dayMap, ([k, v]) => ({ day: k, ...v }));
  aggr.perMonth = Array.from(monMap, ([k, v]) => ({ ym: k, ...v })).sort((x, y) => x.ym.localeCompare(y.ym));
  aggr.useDay = useDay; aggr.useWeeks = useWeeks; aggr.useMonths = useMonths;
  return aggr;
}
function todayStart0() { return lgDayStart(new Date()).getTime(); }
function mStart0() { return new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime(); }
/* ═══ 16. Canvas chart drawing (no libs) ═══ */
function admColors() {
  const light = document.body.classList.contains('light');
  return {
    light,
    grid: light ? 'rgba(15,23,42,0.10)' : 'rgba(148,163,184,0.14)',
    text: light ? '#334155' : '#9fb0c3',
    blue: '#3b82f6', green: '#22c55e', cyan: '#22d3ee',
    amber: '#f59e0b', violet: '#8b5cf6', red: '#ef4444'
  };
}
function admChartSetup(cv, nBars) {
  const c = admColors();
  // re-measure synchronously after layout (canvas may have just been unhidden)
  let rect = cv.getBoundingClientRect();
  if (rect.width < 40) { rect = cv.parentElement.getBoundingClientRect(); }
  const w = Math.max(rect.width, 240), h = Math.max(rect.height || cv.getBoundingClientRect().height, 180);
  const dpr = window.devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h, c };
}
function admGrid(g, c, w, h, pad, maxV, ticks) {
  g.strokeStyle = c.grid; g.fillStyle = c.text;
  g.lineWidth = 1; g.font = '10px Inter, sans-serif'; g.textAlign = 'right';
  for (let i = 0; i <= ticks; i++) {
    const y = pad.t + (h - pad.t - pad.b) * (1 - i / ticks);
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(w - pad.r, y); g.stroke();
    g.fillText(String(Math.round(maxV * i / ticks)), pad.l - 6, y + 3);
  }
}
function admNoData(g, w, h, c) {
  g.fillStyle = c.text; g.globalAlpha = 0.6; g.textAlign = 'center';
  g.font = '12px Inter, sans-serif';
  g.fillText(t('adm.lb.nodata'), w / 2, h / 2);
  g.globalAlpha = 1;
}
/* x-axis label skipping by MEASURED width (the old fixed "every n-th label"
   rule ignored actual label size, so 30 daily MM/DD labels piled up on top
   of each other at the axis). step = smallest k such that k * labelW fits
   in the available slots; a previously-drawn label's x can veto a later
   one when the "always show last" rule would overlap it. */
function admLabelStep(g, labels, slotW) {
  let max = 0;
  for (const lb of labels) max = Math.max(max, g.measureText(lb).width);
  if (!max || !slotW) return 1;
  return Math.max(1, Math.ceil(max / slotW));
}
/* centered labels → half-width clearance from the previous drawn label */
function admLabelFits(g, lb, x, lastX) {
  if (lastX == null) return true;
  return (x - lastX) >= g.measureText(lb).width / 2 + 4;
}
function admChartBar(id, labels, series) {
  const cv = document.getElementById(id); if (!cv) return;
  const { g, w, h, c } = admChartSetup(cv);
  const pad = { l: 34, r: 10, t: 10, b: 26 };
  g.clearRect(0, 0, w, h);
  if (!labels.length || !series.some(s => s.data.some(v => v > 0))) { admNoData(g, w, h, c); return; }
  const maxV = Math.max(1, ...series.flatMap(s => s.data));
  admGrid(g, c, w, h, pad, maxV, 4);
  const n = labels.length, nS = series.length;
  const bw = (w - pad.l - pad.r) / n;
  series.forEach((s, si) => {
    s.data.forEach((v, i) => {
      if (!v) return;
      const bwid = Math.max(2, (bw * 0.62) / nS);
      const x = pad.l + i * bw + (bw - bwid * nS) / 2 + si * bwid;
      const hh = (h - pad.t - pad.b) * (v / maxV);
      g.fillStyle = s.color;
      g.beginPath();
      if (g.roundRect) g.roundRect(x, h - pad.b - hh, bwid - 1.5, hh, 3); else g.rect(x, h - pad.b - hh, bwid - 1.5, hh);
      g.fill();
    });
  });
  g.fillStyle = c.text; g.textAlign = 'center'; g.font = '10px Inter, sans-serif';
  labels.forEach((lb, i) => {
    const step = admLabelStep(g, labels, bw * 0.94);
    if (i % step !== 0 && i !== labels.length - 1) return;
    const x = pad.l + i * bw + bw / 2;
    if (!admLabelFits(g, lb, x, cv._lastLblX)) return;
    cv._lastLblX = x;
    g.fillText(lb, x, h - 8);
  });
  cv._lastLblX = null;
}
function admChartLine(id, labels, series) {
  const cv = document.getElementById(id); if (!cv) return;
  const { g, w, h, c } = admChartSetup(cv);
  const pad = { l: 34, r: 10, t: 10, b: 26 };
  g.clearRect(0, 0, w, h);
  if (!labels.length || !series.some(s => s.data.some(v => v > 0))) { admNoData(g, w, h, c); return; }
  const maxV = Math.max(1, ...series.flatMap(s => s.data));
  admGrid(g, c, w, h, pad, maxV, 4);
  const n = labels.length;
  const xOf = (i) => pad.l + (w - pad.l - pad.r) * (n <= 1 ? 0.5 : i / (n - 1));
  series.forEach(s => {
    g.strokeStyle = s.color; g.lineWidth = 2; g.beginPath();
    s.data.forEach((v, i) => {
      const y = h - pad.b - (h - pad.t - pad.b) * (v / maxV);
      if (i === 0) g.moveTo(xOf(i), y); else g.lineTo(xOf(i), y);
    });
    g.stroke();
    // fill under
    g.globalAlpha = 0.10; g.fillStyle = s.color; g.lineTo(xOf(n - 1), h - pad.b); g.lineTo(xOf(0), h - pad.b); g.closePath(); g.fill(); g.globalAlpha = 1;
  });
  g.fillStyle = c.text; g.textAlign = 'center'; g.font = '10px Inter, sans-serif';
  const slotW = (w - pad.l - pad.r) / Math.max(n, 1);
  labels.forEach((lb, i) => {
    const step = admLabelStep(g, labels, slotW * 0.94);
    if (i % step !== 0 && i !== labels.length - 1) return;
    const x = xOf(i);
    if (!admLabelFits(g, lb, x, cv._lastLblX)) return;
    cv._lastLblX = x;
    g.fillText(lb, x, h - 8);
  });
  cv._lastLblX = null;
}
function admChartDonut(id, segments) {
  const cv = document.getElementById(id); if (!cv) return;
  const { g, w, h, c } = admChartSetup(cv);
  g.clearRect(0, 0, w, h);
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (!total) return;
  const cx = w / 2, cy = (h - 22) / 2, R = Math.min(w, h - 30) / 2 - 12, r = R * 0.62;
  let ang = -Math.PI / 2;
  segments.forEach(s => {
    const a2 = ang + (s.value / total) * Math.PI * 2;
    g.beginPath(); g.arc(cx, cy, R, ang, a2); g.arc(cx, cy, r, a2, ang, true); g.closePath();
    g.fillStyle = s.color; g.fill();
    ang = a2;
  });
  g.fillStyle = c.text; g.textAlign = 'center';
  g.font = '700 20px Inter, sans-serif';
  g.fillText(String(total), cx, cy + 7);
  // legend
  g.font = '11px Inter, sans-serif';
  let lx = 12; const ly = h - 8;
  segments.forEach(s => {
    g.fillStyle = s.color; g.fillRect(lx, ly - 9, 9, 9);
    g.fillStyle = c.text; g.textAlign = 'left';
    g.fillText(s.label, lx + 13, ly - 1);
    lx += 22 + g.measureText(s.label).width + 14;
  });
}
function admChartHbar(id, items, color) {
  const cv = document.getElementById(id); if (!cv) return;
  const { g, w, h, c } = admChartSetup(cv);
  g.clearRect(0, 0, w, h);
  if (!items.length) { admNoData(g, w, h, c); return; }
  const maxV = Math.max(1, ...items.map(i => i.value));
  const rowH = Math.min(28, (h - 8) / Math.max(items.length, 1));
  const labelW = Math.min(120, w * 0.28);
  items.forEach((it, i) => {
    const y = 6 + i * rowH;
    g.font = '10px Inter, sans-serif'; g.textAlign = 'right'; g.fillStyle = c.text;
    let nm = it.label; if (nm.length > 18) nm = nm.slice(0, 17) + '…';
    g.fillText(nm, labelW - 4, y + rowH / 2 + 3);
    const bx = labelW + 4, bws = w - bx - 30;
    const bwid = Math.max(2, bws * (it.value / maxV));
    g.fillStyle = color;
    g.beginPath();
    if (g.roundRect) g.roundRect(bx, y + rowH * 0.2, bwid, rowH * 0.6, 4); else g.rect(bx, y + rowH * 0.2, bwid, rowH * 0.6);
    g.fill();
    g.fillStyle = c.text; g.textAlign = 'left';
    g.fillText(String(it.value), bx + bwid + 5, y + rowH / 2 + 3);
  });
}
/* duration-histogram with a dashed SLA goal marker.
   items: [{label, value}], goalIdx = bucket index where the goal lands
   (bars before it = inside SLA, after = out). Most effective for "how WELL
   we're inside SLA", not just pass/fail. */
function admChartSlaHist(id, items, goalIdx, inColor, outColor) {
  const cv = document.getElementById(id); if (!cv) return;
  const { g, w, h, c } = admChartSetup(cv);
  g.clearRect(0, 0, w, h);
  if (!items.length || !items.some(i => i.value > 0)) { admNoData(g, w, h, c); return; }
  const pad = { l: 34, r: 10, t: 10, b: 26 };
  const maxV = Math.max(1, ...items.map(i => i.value));
  admGrid(g, c, w, h, pad, maxV, 4);
  const n = items.length;
  const bw = (w - pad.l - pad.r) / n;
  items.forEach((it, i) => {
    if (!it.value) return;
    const hh = (h - pad.t - pad.b) * (it.value / maxV);
    g.fillStyle = i <= goalIdx ? inColor : outColor;
    g.beginPath();
    if (g.roundRect) g.roundRect(pad.l + i * bw + 1, h - pad.b - hh, bw - 2, hh, 3); else g.rect(pad.l + i * bw + 1, h - pad.b - hh, bw - 2, hh);
    g.fill();
  });
  /* dashed goal line at the bucket boundary that contains the goal */
  if (goalIdx >= 0 && goalIdx < n - 1) {
    const gx = pad.l + (goalIdx + 1) * bw;
    g.save();
    g.strokeStyle = c.text; g.setLineDash([4, 4]); g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(gx, pad.t); g.lineTo(gx, h - pad.b); g.stroke();
    g.restore();
    g.fillStyle = c.text; g.font = '10px Inter, sans-serif';
    g.textAlign = goalIdx > n / 2 ? 'right' : 'left';
    g.fillText('SLA', goalIdx > n / 2 ? gx - 4 : gx + 4, pad.t + 10);
  }
  g.fillStyle = c.text; g.textAlign = 'center'; g.font = '10px Inter, sans-serif';
  items.forEach((it, i) => {
    const step = admLabelStep(g, items.map(x => x.label), bw * 0.94);
    if (i % step !== 0 && i !== n - 1) return;
    const x = pad.l + i * bw + bw / 2;
    if (!admLabelFits(g, it.label, x, cv._lastLblX)) return;
    cv._lastLblX = x;
    g.fillText(it.label, x, h - 8);
  });
  cv._lastLblX = null;
}
function admChartStacked(id, items, colors) {
  const cv = document.getElementById(id); if (!cv) return;
  const { g, w, h, c } = admChartSetup(cv);
  g.clearRect(0, 0, w, h);
  if (!items.length) { admNoData(g, w, h, c); return; }
  /* reserve a 16px legend strip at the bottom (legend sits under the rows —
     it previously overlapped the last bar row because rows divided the
     whole canvas height) */
  const LEG_H = 16;
  const maxV = Math.max(1, ...items.map(i => i.parts.reduce((a, b) => a + b, 0)));
  const rowH = Math.min(30, (h - 8 - LEG_H) / Math.max(items.length, 1));
  const labelW = Math.min(120, w * 0.26);
  items.forEach((it, i) => {
    const y = 6 + i * rowH;
    g.font = '10px Inter, sans-serif'; g.textAlign = 'right'; g.fillStyle = c.text;
    let nm = it.label; if (nm.length > 18) nm = nm.slice(0, 17) + '…';
    g.fillText(nm, labelW - 4, y + rowH / 2 + 3);
    let x = labelW + 4;
    const bws = w - x - 34;
    const tot = it.parts.reduce((a, b) => a + b, 0);
    it.parts.forEach((v, pi) => {
      if (!v) return;
      const bwid = Math.max(2, bws * (v / maxV));
      g.fillStyle = colors[pi] || c.blue;
      g.fillRect(x, y + rowH * 0.22, bwid, rowH * 0.56);
      x += bwid;
    });
    g.fillStyle = c.text; g.textAlign = 'left';
    g.fillText(String(tot), x + 4, y + rowH / 2 + 3);
  });
  // legend under the rows
  const legendLabels = ['adm.ch.legResolved', 'adm.ch.legOpen'];
  g.font = '10px Inter, sans-serif';
  let lx = 8; const ly = h - 4;
  legendLabels.forEach((k, i) => {
    g.fillStyle = colors[i] || c.blue; g.fillRect(lx, ly - 8, 8, 8);
    g.fillStyle = c.text; g.textAlign = 'left';
    const lb = t(k);
    g.fillText(lb, lx + 12, ly - 1);
    lx += 24 + g.measureText(lb).width + 10;
  });
}
function redrawCharts() { if (adm.lastAggr) renderCharts(adm.lastAggr); }
window.addEventListener('resize', () => { clearTimeout(window._admRs); window._admRs = setTimeout(redrawCharts, 250); });

/* ── chart hover tooltips (like Jira Pulse) ──
   Each painter calls admTipBind(canvasId, hitTestFn). On mousemove it
   re-runs the hit-test and positions an absolutely-positioned <div> over
   the canvas' .adm-chart-card wrapper. hitTestFn(mouseX, mouseY) returns
   { title, rows: [{ color, label, value }] } or null to hide the tip. */
function admTipHost(id) {
  const cv = document.getElementById(id); if (!cv) return null;
  let tip = cv._tipEl;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'adm-tip';
    cv.parentElement.appendChild(tip);   /* wrapper = .adm-chart-card */
    cv._tipEl = tip;
    cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }
  return { cv, tip };
}
function admTipShow(tip, cv, hit) {
  if (!hit) { tip.style.display = 'none'; return; }
  tip.innerHTML =
    (hit.title ? `<div class="adm-tip-title">${escapeHtml(hit.title)}</div>` : '') +
    hit.rows.map(r => `<div class="adm-tip-row"><span class="adm-tip-dot" style="background:${r.color}"></span>` +
      `<span>${escapeHtml(r.label)}</span><b>${escapeHtml(String(r.value))}</b></div>`).join('');
  tip.style.display = 'block';
  /* position: above the cursor, keep inside the card */
  const wrap = tip.offsetParent || cv.parentElement;
  const x = Math.max(8, Math.min(cv._mx + 14, wrap.clientWidth - tip.offsetWidth - 8));
  const y = Math.max(8, cv._my - tip.offsetHeight - 12);
  tip.style.left = x + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}
function admTipBind(id, hitTest) {
  const h = admTipHost(id); if (!h) return;
  const { cv, tip } = h;
  cv._tipFn = hitTest;   /* latest painter's hit-test wins */
  if (!cv._tipBound) {
    cv._tipBound = '1';
    cv.addEventListener('mousemove', (ev) => {
      const r = cv.getBoundingClientRect();
      cv._mx = ev.clientX - r.left; cv._my = ev.clientY - r.top;
      if (cv._tipFn) admTipShow(tip, cv, cv._tipFn(cv._mx, cv._my));
    });
  }
}
/* drill-through for SLA charts: the hit-test function may return a
   `drill` key alongside the tooltip info — clicking the hovered bar /
   segment opens the task list below pre-filtered to exactly those rows. */
function admSlaClickBind(id) {
  const cv = document.getElementById(id); if (!cv) return;
  if (cv._slaClickBound) return;
  cv._slaClickBound = '1';
  cv.addEventListener('click', () => {
    if (!cv._tipFn) return;
    const hit = cv._tipFn(cv._mx, cv._my);
    if (hit && hit.drill) admOpenDrilldown(hit.drill);
  });
  cv.style.cursor = 'pointer';
}

/* ═══ 17. Render: KPI, charts, leaderboards, login activity ═══ */
function admKpiCard(icon, label, value, cls, sub, dlKey) {
  /* dlKey → the number itself is a button: clicking opens the task-list
     section pre-filtered to exactly the tasks behind this number */
  const val = (dlKey && value !== '–' && value != null)
    ? `<button type="button" class="kpi-dl-btn" data-dl="${dlKey}" title="${escapeHtml(t('adm.dl.tip'))}">${escapeHtml(String(value))}</button>`
    : escapeHtml(value == null ? '' : String(value));
  return `<div class="kpi glass ${cls || ''}"><div class="kpi-top"><span class="kpi-icon">${icon}</span>` +
    `<span class="kpi-label">${escapeHtml(label)}</span></div>` +
    `<div class="kpi-value">${val}</div>` +
    (sub ? `<div class="kpi-foot">${escapeHtml(sub)}</div>` : '') +
    `</div>`;
}
function admFmtResDays(d) {
  return d < 1 ? Math.round(d * 24) + 'h' : (Math.round(d * 10) / 10) + 'd';
}
function renderKpis(a) {
  const g = $('#admKpiGrid'); if (!g) return;
  if (!a) { g.innerHTML = ''; return; }
  const avgSub = a.avgResDays != null
    ? tReplace('adm.kpi.medianOn', { n: a.resDaysN })
    : t('adm.kpi.medianNone');
  const inProg = Array.from(a.perStatus.entries()).filter(([st]) => lgStatusClass(st) === 'lg-st-progress')
    .reduce((s, [, n]) => s + n, 0);
  const openPeriod = a.donut.open;
  /* SLA compliance % = measured (in + out of SLA) tasks that met the goal.
     Pending/overdue (clock still running) and nodata are excluded. */
  const slaPct = (b) => {
    const done = b.in + b.out;
    return done ? Math.round(100 * b.in / done) + '%' : '–';
  };
  const respSub = a.medRespMs != null
    ? tReplace('adm.sla.medRespSub', { n: a.slaRespN, t: admFmtSlaHours(a.medRespMs) })
    : t('adm.sla.nodataSub');
  const resSub = a.medResMs != null
    ? tReplace('adm.sla.medResSub', { n: a.slaResN, t: admFmtSlaHours(a.medResMs) })
    : t('adm.sla.nodataSub');
  g.innerHTML =
    admKpiCard('📅', t('adm.kpi.total'), a.total, 'accent-blue', t('adm.kpi.totalSub'), 'total') +
    admKpiCard('☀️', t('adm.kpi.today'), a.createdToday, 'accent-green', '', 'today') +
    admKpiCard('✅', t('adm.kpi.resolved'), a.resolvedPeriod, 'accent-cyan', '', 'resolved') +
    admKpiCard('📂', t('adm.kpi.open'), openPeriod, 'accent-amber', t('adm.kpi.openSub'), 'open') +
    admKpiCard('⏱', t('adm.kpi.avgRes'), a.avgResDays != null ? admFmtResDays(a.avgResDays) : '–', 'accent-violet', avgSub, 'avgres') +
    admKpiCard('🏁', t('adm.kpi.resAll'), a.resolvedAll, 'accent-green', '', 'resall') +
    admKpiCard('🚦', t('adm.kpi.inwork'), inProg, 'accent-blue', '', 'inprog') +
    admKpiCard('🗓', t('adm.kpi.month'), a.createdMonth, 'accent-cyan', '', 'month') +
    admKpiCard('⚡', t('adm.sla.respKpi'), slaPct(a.slaResp), 'accent-green', respSub, 'slaResp') +
    admKpiCard('🎯', t('adm.sla.resKpi'), slaPct(a.slaRes), 'accent-cyan', resSub, 'slaRes');
  /* bind KPI drill-down buttons */
  g.querySelectorAll('.kpi-dl-btn').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); admOpenDrilldown(b.dataset.dl); });
  });
}
function monthLabel(ym) {
  const mi = parseInt(String(ym).slice(5, 7), 10) - 1;
  const yr = String(ym).slice(0, 4);
  const mn = (adm.lang === 'ka') ? LG_MONTHS_KA[mi] : LG_MONTHS_EN[mi];
  return yr === String(new Date().getFullYear()) ? mn : `${mn} ${yr}`;
}
function dayLabel(ymd) { return ymd.slice(5).replace('-', '/'); }

/* ── 17b. KPI drill-down task list ──
   Clicking a KPI number opens the section below "Platform usage & logins"
   with exactly the tasks behind that number, rendered like the logistics
   desk task list (key link, summary, status chip, direction, assignee,
   reporter, created/resolved dates). ── */
/* filter per drill key — mirrors each KPI's definition EXACTLY (see
   admAggregate). The first release wrongly required a Jira resolutiondate
   (rdReal) for the resolved filters, which is why "Resolved (all time)"
   showed 2479 but listed only the 31 rdReal tasks — most resolved LOG
   tasks get Done status without Jira writing a resolutiondate. ── */
function admDrillRows(key) {
  const rows = adm.rows || [];
  const range = admPeriodRange();
  const from = range.from.getTime(), to = range.to.getTime();
  const day0 = todayStart0();
  const m0 = mStart0();
  const inPeriod = (ms) => ms >= from && ms <= to;
  /* KPI definition of "resolved": resolution field present OR a done-class
     status (identical to admAggregate's resolvedAll/resolvedPeriod counts) */
  const resInPeriod = (r) => r.resolved && inPeriod(r.resolvedAt);
  const createdInPeriod = (r) => inPeriod(r.createdMs);
  switch (key) {
    case 'total': return rows.filter(createdInPeriod);
    case 'today': return rows.filter((r) => r.createdMs >= day0);
    case 'month': return rows.filter((r) => r.createdMs >= m0);
    case 'resolved': return rows.filter(resInPeriod);
    case 'resall': return rows.filter((r) => r.resolved);
    case 'avgres': return rows.filter((r) => resInPeriod(r) && r.resolvedAt > r.createdMs && r.createdMs);
    case 'open': return rows.filter((r) => createdInPeriod(r) && !r.resolved);
    case 'inprog': return rows.filter((r) => createdInPeriod(r) && !r.resolved && lgStatusClass(r.status) === 'lg-st-progress');
    /* SLA drills — per-state, matching every click target on the SLA
       charts (status bars, histogram buckets, per-direction breaches) and
       the KPI cards. State first, then period-created (mirrors
       admAggregate's SLA buckets). */
    case 'slaResp': return rows.filter((r) => createdInPeriod(r) && (r.respState === 'in' || r.respState === 'out'));
    case 'slaRes': return rows.filter((r) => createdInPeriod(r) && (r.resState === 'in' || r.resState === 'out'));
    case 'slaRespIn': return rows.filter((r) => createdInPeriod(r) && r.respState === 'in');
    case 'slaResIn': return rows.filter((r) => createdInPeriod(r) && r.resState === 'in');
    case 'slaRespOut': return rows.filter((r) => createdInPeriod(r) && (r.respState === 'out' || r.respState === 'overdue'));
    case 'slaResOut': return rows.filter((r) => createdInPeriod(r) && (r.resState === 'out' || r.resState === 'overdue'));
    case 'slaRespPending': return rows.filter((r) => createdInPeriod(r) && r.respState === 'pending');
    case 'slaResPending': return rows.filter((r) => createdInPeriod(r) && r.resState === 'pending');
    case 'slaRespOverdue': return rows.filter((r) => createdInPeriod(r) && r.respState === 'overdue');
    case 'slaResOverdue': return rows.filter((r) => createdInPeriod(r) && r.resState === 'overdue');
    case 'slaRespNodata': return rows.filter((r) => createdInPeriod(r) && r.respState === 'nodata');
    case 'slaResNodata': return rows.filter((r) => createdInPeriod(r) && r.resState === 'nodata');
    default: {
      /* parametric SLA drills: histogram bucket "slaRespHist:N" /
         "slaResHist:N" and per-direction breaches "slaDirRespOut:<dir>" /
         "slaDirResOut:<dir>" */
      let m = key.match(/^(slaRespHist|slaResHist):(\d+)$/);
      if (m) {
        const edges = m[1] === 'slaRespHist' ? SLA_RESP_EDGES : SLA_RES_EDGES;
        const msKey = m[1] === 'slaRespHist' ? 'respMs' : 'resMs';
        const idx = Number(m[2]);
        const lo = idx === 0 ? 0 : edges[idx - 1];
        const hi = idx < edges.length ? edges[idx] : Infinity;
        return rows.filter((r) => createdInPeriod(r) && r[msKey] > lo && r[msKey] <= hi);
      }
      m = key.match(/^slaDir(Resp|Res)Out:(.+)$/);
      if (m) {
        const stKey = m[1] === 'Resp' ? 'respState' : 'resState';
        const dir = key.slice(key.indexOf(':') + 1);
        return rows.filter((r) => createdInPeriod(r) && (r.direction || '—') === dir
          && (r[stKey] === 'out' || r[stKey] === 'overdue'));
      }
      return [];
    }
  }
}
/* SLA compact badges for drill rows — "R: 1h 20m" green/red, "Res: 3h" */
const SLA_CLS = { in: 'lg-st-done', out: 'lg-st-breach', overdue: 'lg-st-breach', pending: 'lg-st-wait', nodata: 'lg-st-other' };
function admSlaBadgeCell(r) {
  const chip = (state, val, lbl) =>
    `<span class="lg-st-badge ${SLA_CLS[state] || 'lg-st-other'}" title="${escapeHtml(lbl)}">${escapeHtml(val)}</span>`;
  /* JSM-native cycles (r.slaNative, hydrated async per row) win when the
     aspect is COMPLETED — for unsettled aspects the live working clock is
     still the better display (JSM's ongoing elapsed can sit at a paused 0m). */
  const nat = r.slaNative || null;
  const natResp = nat?.resp && nat.resp.completed ? nat.resp : null;
  const natRes = nat?.res && nat.res.completed ? nat.res : null;
  const resp = natResp
    ? chip(natResp.breached ? 'out' : 'in', admFmtSlaHours(natResp.elapsedMs),
        t('adm.sla.respTitle') + ' · ' + admFmtSlaHours(natResp.elapsedMs))
    : r.respState === 'nodata' || !r.respAtMs
      ? chip('nodata', '–', t('adm.sla.nodataSub'))
      : chip(r.respState, admFmtSlaHours(r.respMs), t('adm.sla.respTitle') + ' · ' + admFmtSlaHours(r.respMs));
  const res = natRes
    ? chip(natRes.breached ? 'out' : 'in', admFmtSlaHours(natRes.elapsedMs),
        t('adm.sla.resTitle') + ' · ' + admFmtSlaHours(natRes.elapsedMs))
    : r.resState === 'pending' || r.resState === 'overdue'
      ? chip(r.resState, admFmtSlaHours(r.elapsedMs) + ' /', t('adm.sla.resRunning') + ' ' + admFmtSlaHours(r.elapsedMs))
      : r.resMs > 0 ? chip(r.resState, admFmtSlaHours(r.resMs), t('adm.sla.resTitle') + ' · ' + admFmtSlaHours(r.resMs))
      : chip('nodata', '–', t('adm.sla.nodataSub'));
  return `<td class="lg-sla-cell"><div class="lg-mini-row">${resp} ${res}</div></td>`;
}
function admOpenDrilldown(key) {
  if (adm.dl !== key) {
    /* a NEW drill click resets search/filters/sort/page so no stale state
       leaks between different drills; re-clicking the SAME drill keeps it */
    adm.dlQ = '';
    adm.dlFilters = { status: '', reporter: '', assignee: '', direction: '', sla: '' };
    adm.dlSort = { col: 'created', dir: 'desc' };
    adm.dlPage = 100;
  }
  adm.dl = key;
  admRenderDrilldown();
  const sec = $('#admDrillSection');
  if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function admCloseDrilldown() {
  adm.dl = null;
  hide($('#admDrillSection'));
}

/* ── drill-list table engine (search + filters + sort + 100-row pages) ──
   Mirrors the logistics desk's lgFiltered(): memoized (q + filters + sort)
   → rows pipeline; the page paints slice(0, dlPage) and the footer's
   "Show more" button grows dlPage by +100 while more rows exist. */

/* lowercase search haystack — pre-built once per row render cycle.
   Rows are plain objects recreated only by admNormalize() (each data load /
   language switch), so attaching `._hay` on-demand here is safe and eventual. */
function admDrillHay(r) {
  if (r._hay === undefined || r._hayLang !== adm.lang) {
    r._hay = (r.key + ' ' + (r.summary || '') + ' ' + (r.descFull || '') + ' ' +
      (r.status || '') + ' ' + (r.reportName || '') + ' ' + (r.assignName || '') + ' ' +
      (r.direction || '') + ' ' + (r.comments || []).map((c) => c.author + ' ' + c.body).join(' ')
    ).toLowerCase();
    r._hayLang = adm.lang;
  }
  return r._hay;
}

const ADM_DRILL_SLA_OPTS = [['', 'adm.dl.filterAll'], ['in', 'adm.sla.inSla'], ['late', 'adm.sla.outSla'],
  ['out', 'adm.sla.outSla'], ['pending', 'adm.sla.pending'], ['overdue', 'adm.sla.overdue'], ['nodata', 'adm.sla.nodata']];
const ADM_DRILL_SLA_RANK = { in: 0, pending: 1, nodata: 2, overdue: 3, out: 4 };

function admDrillDistinct(col) {
  const s = new Set();
  admDrillRows(adm.dl).forEach((r) => { if (r[col]) s.add(r[col]); });
  return [...s].sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
}

/* per-column filter bar: status / reporter / assignee selects + direction
   (natural <select>) + SLA fixed-state select — same look as the desk's bar. */
function admDrillBuildFilterBar() {
  const bar = $('#admDrillFilterBar'); if (!bar) return;
  const mk = (col, labelKey, opts) => {
    const o = opts || admDrillDistinct(col);
    return `<div class="lg-filter-item">` +
      `<span class="lg-filter-label">${escapeHtml(t(labelKey))}</span>` +
      `<select class="input tl-select" data-col="${col}" aria-label="${escapeHtml(t(labelKey))}">` +
      `<option value="">${escapeHtml(t('adm.dl.filterAll'))}</option>` +
      o.map((v) => {
        const lbl = col === 'sla' ? t(v) : v;
        return `<option value="${escapeHtml(col === 'sla' ? v : v)}"${adm.dlFilters[col] === v ? ' selected' : ''}>${escapeHtml(lbl)}</option>`;
      }).join('') + `</select></div>`;
  };
  const SLA_LBL = { in: 'adm.sla.inSla', late: 'adm.sla.outSla', pending: 'adm.sla.pending', overdue: 'adm.sla.overdue', nodata: 'adm.sla.nodata' };
  bar.innerHTML =
    mk('status', 'adm.dl.fStatus') +
    mk('reporter', 'adm.dl.fReporter') +
    mk('assignee', 'adm.dl.fAssignee') +
    mk('direction', 'adm.dl.fDirection') +
    mk('sla', 'adm.dl.fSla', ADM_DRILL_SLA_OPTS.map(([v]) => v).slice(1).map((v) => v === 'late' ? 'late' : v));
  bar.querySelectorAll('select[data-col]').forEach((sel) => {
    sel.addEventListener('change', () => {
      adm.dlFilters[sel.dataset.col] = sel.value;
      adm.dlPage = 100;                    /* new filter → back to page 1 */
      admRenderDrilldown();
    });
  });
}

function admDrillFiltered() {
  const rows = admDrillRows(adm.dl);
  const q = adm.dlQ.trim().toLowerCase();
  const f = adm.dlFilters;
  const out = rows.filter((r) => {
    if (f.status && r.status !== f.status) return false;
    if (f.reporter && r.reportName !== f.reporter) return false;
    if (f.assignee && r.assignName !== f.assignee) return false;
    if (f.direction && r.direction !== f.direction) return false;
    if (f.sla) {
      /* 'late' = measured breach OR still-open overdue (manager view);
         any other value matches either metric state directly */
      const hit = f.sla === 'late'
        ? (r.respState === 'out' || r.resState === 'out' || r.respState === 'overdue' || r.resState === 'overdue')
        : (r.respState === f.sla || r.resState === f.sla);
      if (!hit) return false;
    }
    if (q) return admDrillHay(r).includes(q);
    return true;
  });
  /* default sort when untouched: newest first (kept for period re-renders) */
  const sp = (adm.dlSort && adm.dlSort.col) ? adm.dlSort : { col: 'created', dir: 'desc' };
  const mul = sp.dir === 'asc' ? 1 : -1;
  const slaWorst = (r) => Math.max(ADM_DRILL_SLA_RANK[r.respState] || 0, ADM_DRILL_SLA_RANK[r.resState] || 0);
  const num = (r) => parseInt(String(r.key).split('-')[1], 10) || 0;
  out.sort((a, b) => {
    let res;
    const col = sp.col;
    if (col === 'created') res = (a.createdMs || 0) - (b.createdMs || 0);
    else if (col === 'resolved') res = (a.resolvedAt || 0) - (b.resolvedAt || 0);
    else if (col === 'key') res = num(a) - num(b);
    else if (col === 'sla') res = slaWorst(a) - slaWorst(b);
    else if (col === 'reporter') res = String(a.reportName || '').localeCompare(String(b.reportName || ''), undefined, { sensitivity: 'base' });
    else if (col === 'assignee') res = String(a.assignName || '').localeCompare(String(b.assignName || ''), undefined, { sensitivity: 'base' });
    else res = String(a[col] || '').localeCompare(String(b[col] || ''), undefined, { sensitivity: 'base' });
    return res * mul;
  });
  return out;
}

function admDrillMarkSortHeads() {
  const tbl = $('#admDrillTable'); if (!tbl) return;
  const sp = (adm.dlSort && adm.dlSort.col) ? adm.dlSort : { col: 'created', dir: 'desc' };
  tbl.querySelectorAll('th[data-col], .lg-th-split[data-col]').forEach((h) => {
    h.classList.toggle('lg-sorted', h.dataset.col === sp.col);
    if (h.dataset.col === sp.col) h.dataset.sort = sp.dir; else delete h.dataset.sort;
  });
}

function admRenderDrilldown() {
  const sec = $('#admDrillSection'); if (!sec) return;
  if (!adm.dl || !adm.verified) { hide(sec); return; }
  const all = admDrillRows(adm.dl);
  /* SLA drills have their own titles (not adm.kpi.*) */
  const dlTitleKey = adm.dl.startsWith('sla') ? ('adm.sla.dl.' + adm.dl) :
    ('adm.kpi.' + (adm.dl === 'resall' ? 'resAll' : adm.dl === 'avgres' ? 'avgRes' : adm.dl === 'inprog' ? 'inwork' : adm.dl));
  const title = t('adm.dl.title') + ' · ' + t(dlTitleKey);
  $('#admDrillTitle').textContent = title;
  $('#admDrillCount').textContent = tReplace('adm.count.n', { n: all.length });
  const tb = $('#admDrillTable tbody'); if (!tb) return;
  /* faint accent ring on the KPI card whose number is currently open */
  document.querySelectorAll('#admKpiGrid .kpi').forEach((k) => {
    const b = k.querySelector('.kpi-dl-btn');
    k.classList.toggle('dl-open', !!(b && b.dataset.dl === adm.dl));
  });
  tb.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center">${escapeHtml(t('adm.lb.nodata'))}</td></tr>`;
  /* filter bar reflects the (memoized) drill rows each render — distinct
     options come from the current drill */
  admDrillBuildFilterBar();
  admDrillMarkSortHeads();
  const searchInp = $('#admDrillSearch');
  if (searchInp && searchInp.value !== adm.dlQ) searchInp.value = adm.dlQ;
  if (!all.length) {
    $('#admDrillShown').textContent = '';
    $('#admDrillMore').classList.add('hidden');
    show(sec); return;
  }
  const rows = admDrillFiltered();
  const vis = rows.slice(0, adm.dlPage);
  const footShown = $('#admDrillShown');
  footShown.textContent = tReplace('adm.dl.shown', { a: 1, b: vis.length, n: rows.length });
  const moreBtn = $('#admDrillMore');
  if (rows.length > vis.length) {
    moreBtn.textContent = t('adm.dl.showMore') + ' +100';
    moreBtn.classList.remove('hidden');
  } else {
    moreBtn.classList.add('hidden');
  }
  tb.innerHTML = vis.map((r) => {
    /* title cell mirrors lgRowHtmlUncached exactly: clickable title +
       description preview + 📎 badge pinned top-right of the title line.
       Old plain <button class="lg-sum-link"> had no stylesheet rule and the
       browser default white button background was bleeding through. */
    const attN = (r.attFiles || []).length;
    const attBadge = attN
      ? `<a href="#" class="lg-open-card lg-att-badge" data-key="${escapeHtml(r.key)}" title="${escapeHtml(t('lg.row.hasFiles') + ' (' + attN + ')')}">📎${attN}</a>`
      : '';
    const descPreview = (r.descOne && r.descOne !== r.summary) ? r.descOne : '';
    const who = (name) => name
      ? escapeHtml(name)
      : `<span class="lg-unassigned">${escapeHtml(t('lg.unassigned'))}</span>`;
    const peopleHtml =
      `<div class="lg-mini-row" title="${escapeHtml(t('lg.th.reporter'))}"><span class="lg-mini-label">${escapeHtml(t('lg.th.reporter'))}</span>` +
      `<span class="lg-mini-value">${who(r.reportName)}</span></div>` +
      `<div class="lg-mini-row lg-row-asg" title="${escapeHtml(t('lg.th.assignee'))}"><span class="lg-mini-label assignee-chip">${escapeHtml(t('lg.th.assignee'))}</span>` +
      `<span class="lg-mini-value">${who(r.assignName)}</span></div>`;
    return `<tr>` +
    `<td class="lg-nowrap lg-key-cell"><a class="lg-key-link" href="${escapeHtml(r.href)}" target="_blank" rel="noopener">${escapeHtml(r.key)}</a></td>` +
    `<td class="lg-title-cell">
      <div class="lg-title-line">
        <div class="lg-task-title"><a href="#" class="lg-open-card lg-title-link" data-key="${escapeHtml(r.key)}">${escapeHtml(r.summary || '—')}</a></div>
        ${attBadge}
      </div>${descPreview ? `<div class="lg-desc">${escapeHtml(descPreview)}</div>` : ''}
    </td>` +
    `<td><span class="status-pill ${r.statusCls || 'lg-st-other'}">${escapeHtml(r.status || '—')}</span></td>` +
    `<td class="lg-people-cell">${peopleHtml}</td>` +
    `<td class="lg-direction-cell">${r.direction ? `<div class="lg-dir-text">${escapeHtml(r.direction)}</div>` : '<span class="muted">—</span>'}</td>` +
    `<td class="muted lg-created-cell">${fmtDate(r.createdMs)}${r.resolved && r.resolvedAt ? `<span class="lg-res-marker">→ ${fmtDate(r.resolvedAt)}</span>` : ''}</td>` +
    `${admSlaBadgeCell(r)}` +
    `</tr>`;
  }).join('');
  /* title click → in-app detail popup (same view as the logistics desk) */
  tb.querySelectorAll('.lg-open-card').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      admOpenCard(b.dataset.key);
    });
  });
  /* lazy native-SLA hydration for the rows actually shown */
  admSlaQueueMissing(vis.map((r) => r.key));
  show(sec);
}

/* ── 17c. Admin task detail popup ──
   Same markup/CSS as the desk's card (#lgCardOverlay) — full description,
   comment thread, attachments with image previews + lightbox. Attachment
   binaries/metadata come from the relay's ?cmd=deskAttach and ?url=
   proxy, exactly like the desk (no credentials needed — the relay is
   public for the published desk). ── */
const ADM_ATTACH_TTL = 10 * 60 * 1000;
const _admAttachCache = new Map();      /* key → { ts, attachments } */
const _admBlobCache = new Map();        /* attachId → objectURL */

function admAttachProxyUrl(contentUrl) { return PUB_RELAY + '?url=' + encodeURIComponent(contentUrl); }
function admIsImageMime(mime, filename) {
  if (/^image\//i.test(mime || '')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filename || '');
}
function admFmtBytes(n) {
  if (!n || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
async function admFetchAttachments(key) {
  const hit = _admAttachCache.get(key);
  if (hit && Date.now() - hit.ts < ADM_ATTACH_TTL) return hit.attachments;
  const url = PUB_RELAY + '?cmd=deskAttach&key=' + encodeURIComponent(key) +
    '&domain=' + encodeURIComponent(PUBLISH_DOMAIN);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* non-json */ }
  if (!res.ok) throw new Error((data && (data.error || data.detail)) || ('HTTP ' + res.status));
  const attachments = Array.isArray(data && data.attachments) ? data.attachments : [];
  _admAttachCache.set(key, { ts: Date.now(), attachments });
  return attachments;
}

/* ── JSM-native SLA hydration (per row) ────────────────────────────────
   SLA cycles live OUTSIDE the bulk desk payload (too heavy for ~4k
   issues), so — like attachments — each task's Jira-measured SLA clocks
   (Time to first response / Time to resolution) are fetched lazily via
   the relay's ?cmd=deskSla (with the admin auth header when connected)
   and cached in _admSlaCache. Rendering: once a row's SLA lands, ONLY
   that row's chips are re-painted in place (no full table re-render). */
const ADM_SLA_TTL = 10 * 60 * 1000;    /* per-session cache: 10 min */
const _admSlaCache = new Map();        /* key → { ts, sla } */
const _admSlaInFlight = new Map();     /* key → Promise (dedupe concurrent) */
const _admSlaTried = new Set();        /* keys that returned nothing → don't refetch */
let _admSlaQueue = [];                 /* pending keys for the deferred pump */
let _admSlaTimer = null;

/* fetch Jira's own SLA clocks for one task */
async function admFetchSla(key) {
  const hit = _admSlaCache.get(key);
  if (hit && Date.now() - hit.ts < ADM_SLA_TTL) return hit.sla;
  if (_admSlaInFlight.has(key)) return _admSlaInFlight.get(key);
  const p = (async () => {
    try {
      const url = PUB_RELAY + '?cmd=deskSla&key=' + encodeURIComponent(key) +
        '&domain=' + encodeURIComponent(PUBLISH_DOMAIN);
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { /* non-json */ }
      if (!res.ok) throw new Error((data && (data.error || data.detail)) || ('HTTP ' + res.status));
      const sla = data?.sla && typeof data.sla === 'object' ? data.sla : null;
      if (sla && (sla.resp || sla.res)) _admSlaCache.set(key, { ts: Date.now(), sla });
      else _admSlaTried.add(key);   /* Jira holds no cycles for this task */
      return sla;
    } finally {
      _admSlaInFlight.delete(key);
    }
  })();
  _admSlaInFlight.set(key, p);
  return p;
}

/* queue keys whose native SLA is still missing (drilldown + final table) */
function admSlaQueueMissing(keys) {
  for (const key of keys) {
    if (_admSlaCache.has(key) || _admSlaTried.has(key) || _admSlaInFlight.has(key)) continue;
    const r = admFindTask(key);
    if (!r || (r.slaNative && !r.slaBulk)) continue;
    _admSlaQueue.push(key);
  }
  if (_admSlaQueue.length && !_admSlaTimer) {
    _admSlaTimer = setTimeout(admSlaPump, 120);
  }
}

/* deferred pump: a few requests per tick so scrolling never stutter */
function admSlaPump() {
  _admSlaTimer = null;
  const batch = _admSlaQueue.splice(0, 4);
  if (!batch.length) return;
  for (const key of batch) {
    admFetchSla(key).then((sla) => {
      if (!sla) return;
      const r = admFindTask(key);
      if (!r) return;
      admSlaApplyNative(r, sla);
      r.slaBulk = false;         /* fully hydrated — skip next time */
      admRepaintRowSla(key);
      /* open popup shows exact settled times once the SLA lands */
      if (adm.cardKey === key) admRenderCard();
    }).catch(() => { /* optional garnish — approximation stays */ });
  }
  if (_admSlaQueue.length) _admSlaTimer = setTimeout(admSlaPump, 120);
}

/* surgical repaint of ONE row's SLA cell */
function admRepaintRowSla(key) {
  for (const tb of document.querySelectorAll('.lg-table tbody')) {
    const a = tb.querySelector(`.lg-open-card[data-key="${CSS.escape(key)}"]`);
    if (!a) continue;
    const row = a.closest('tr');
    if (!row) continue;
    const r = admFindTask(key);
    if (!r) continue;
    const cells = row.querySelectorAll('td');
    const slaTd = cells[cells.length - 1];   /* SLA is the last column */
    if (slaTd) slaTd.innerHTML = admSlaBadgeCell(r);
    break;
  }
}
async function admAttachBlob(att) {
  if (_admBlobCache.has(att.id)) return _admBlobCache.get(att.id);
  const res = await fetch(admAttachProxyUrl(att.contentUrl));
  if (!res.ok) throw new Error('preview HTTP ' + res.status);
  const blob = await res.blob();
  if (/json/i.test(blob.type || '')) throw new Error('proxy refused preview');
  const objUrl = URL.createObjectURL(blob);
  _admBlobCache.set(att.id, objUrl);
  return objUrl;
}
function admRevokeBlobCache() {
  for (const [, u] of _admBlobCache) { try { URL.revokeObjectURL(u); } catch (_) {} }
  _admBlobCache.clear();
}
function admAttachThumbHtml(att) {
  const isImg = admIsImageMime(att.mimeType, att.filename);
  if (isImg) {
    return `<a class="lg-att-item lg-att-img" data-att-id="${escapeHtml(att.id)}" href="#" title="${escapeHtml(att.filename)}">
      <img alt="${escapeHtml(att.filename)}" loading="lazy" />
      <span class="lg-att-name">${escapeHtml(att.filename)}</span>
    </a>`;
  }
  const icon = /\.(pdf)$/i.test(att.filename || '') ? '📄'
    : /\.(xlsx?|csv)$/i.test(att.filename || '') ? '📊'
    : /\.(docx?)$/i.test(att.filename || '') ? '📝' : '📎';
  return `<a class="lg-att-item lg-att-file" data-att-id="${escapeHtml(att.id)}" href="${admAttachProxyUrl(att.contentUrl)}" target="_blank" rel="noopener" title="${escapeHtml(att.filename)}">
    <span class="lg-att-icon">${icon}</span>
    <span class="lg-att-name">${escapeHtml(att.filename)}</span>
    ${att.size ? `<span class="lg-att-size">${admFmtBytes(att.size)}</span>` : ''}
  </a>`;
}
function admHydrateAttachImages(rootEl) {
  rootEl.querySelectorAll('.lg-att-img:not([data-hydrated="1"])').forEach((a) => {
    a.setAttribute('data-hydrated', '1');
    const attId = a.getAttribute('data-att-id');
    const meta = rootEl._admAttMeta && rootEl._admAttMeta.get(attId);
    if (!meta) return;
    a.querySelector('img') && (a.querySelector('img').alt = meta.filename);
    admAttachBlob(meta).then((objUrl) => {
      const img = a.querySelector('img');
      if (img) img.src = objUrl;
    }).catch(() => {
      a.classList.add('lg-att-broken');
      const n = a.querySelector('.lg-att-name');
      if (n) n.insertAdjacentHTML('beforebegin', '<span class="lg-att-icon">⚠️</span>');
    });
  });
}
function admFindTask(key) { return (adm.rows || []).find((r) => r.key === key) || null; }

function admOpenCard(key) {
  const task = admFindTask(key);
  if (!task) return;
  adm.cardKey = key;
  admRenderCard();
  show($('#admCardOverlay'));
  const cb = $('#admCardClose'); if (cb) cb.focus();
}
function admCloseCard() {
  adm.cardKey = null;
  hide($('#admCardOverlay'));
  admRevokeBlobCache();
  const lb = document.querySelector('.lg-lightbox');
  if (lb) lb.remove();
}
async function admDownloadAttachment(att) {
  const objUrl = await admAttachBlob(att);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = att.filename || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function admOpenLightbox(att, objUrl) {
  const lb = document.createElement('div');
  lb.className = 'lg-lightbox';
  lb.innerHTML = `
    <button class="lg-lightbox-close" type="button" aria-label="Close">✕</button>
    <button class="lg-lightbox-dl" type="button">⬇ ${escapeHtml(t('lg.card.download'))}</button>
    <img alt="${escapeHtml(att.filename)}" src="${objUrl}" />
    <div class="lg-lightbox-name">${escapeHtml(att.filename)}</div>`;
  const close = () => { lb.remove(); };
  lb.addEventListener('click', (e) => { if (e.target === lb || e.target.closest('.lg-lightbox-close')) close(); });
  lb.querySelector('.lg-lightbox-dl').addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '…';
    try { await admDownloadAttachment(att); }
    catch (_) { btn.textContent = '⚠ ' + t('lg.downloadFail'); setTimeout(() => { btn.disabled = false; btn.textContent = '⬇ ' + t('lg.card.download'); }, 2000); return; }
    btn.disabled = false; btn.textContent = '⬇ ' + t('lg.card.download');
  });
  document.addEventListener('keydown', function onKey(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
  document.body.appendChild(lb);
}
function admRenderCard() {
  const r = admFindTask(adm.cardKey);
  if (!r) return;
  const body = $('#admCardBody');
  const statusPill = `<span class="lg-status-chip ${r.statusCls || 'lg-st-other'}">${escapeHtml(r.status || '—')}</span>`;
  const personBlock = (roleKey, name) =>
    `<div class="lg-card-person"><span class="lg-person-role">${escapeHtml(t(roleKey))}</span>` +
    `<span class="lg-card-person-name${name ? '' : ' lg-unassigned'}">${name ? escapeHtml(name) : escapeHtml(t('lg.unassigned'))}</span></div>`;
  const metaItem = (label, value) =>
    `<div class="lg-card-meta-item"><span class="lg-person-role">${escapeHtml(label)}</span><span>${value}</span></div>`;
  const commentsHtml = r.comments && r.comments.length
    ? r.comments.map((c) =>
        `<div class="lg-card-comment">
          <div class="lg-card-comment-head">
            <span class="lg-comment-author">${escapeHtml(c.author || '—')}</span>
            <span class="lg-card-comment-date">${fmtDateTime(c.created)}</span>
          </div>
          <div class="lg-card-comment-body">${escapeHtml(c.body)}</div>
          <div class="lg-card-comment-attach" data-comment-idx="${c._idx != null ? c._idx : ''}"></div>
        </div>`).join('')
    : `<div class="muted">${escapeHtml(t('lg.card.noComments'))}</div>`;
  /* SLA meta line: exact settled times from Jira's own clocks when the
     payload has landed (row hydration queues it; popup open re-checks) */
  const nat = r.slaNative || null;
  const natChip = (a) => a
    ? `<span class="lg-st-badge ${a.breached ? 'lg-st-breach' : 'lg-st-done'}">${escapeHtml(admFmtSlaHours(a.elapsedMs))}</span>`
    : `<span class="lg-st-badge lg-st-other">–</span>`;
  const slaHtml =
    `<span class="lg-card-sla-wrap" title="${escapeHtml(t('adm.sla.respTitle') + ' / ' + t('adm.sla.resTitle'))}">` +
    natChip(nat?.resp?.completed ? nat.resp : null) +
    ' ' + natChip(nat?.res?.completed ? nat.res : null) +
    `</span>`;
  body.innerHTML = `
    <div class="lg-card-top">${statusPill}<span class="lg-card-key">${escapeHtml(r.key)}</span></div>
    <h3 class="lg-card-title">${escapeHtml(r.summary || '—')}</h3>
    <div class="lg-card-people">
      ${personBlock('lg.th.reporter', r.reportName)}
      ${personBlock('lg.th.assignee', r.assignName)}
    </div>
    <div class="lg-card-meta">
      ${metaItem(t('lg.th.created'), fmtDateTime(r.createdMs))}
      ${metaItem(t('lg.th.updated'), fmtDateTime(r.updatedMs))}
      ${r.direction ? metaItem(t('lg.th.direction'), escapeHtml(r.direction)) : ''}
      ${r.resolved && r.resolvedAt ? metaItem(t('lg.th.resolved'), fmtDateTime(r.resolvedAt)) : ''}
      ${metaItem(t('lg.th.sla'), slaHtml)}
    </div>
    <div class="lg-card-section">
      <span class="lg-person-role">${escapeHtml(t('lg.descLabel') || 'Description')}</span>
      <div class="lg-card-desc" id="admCardDesc">${admPaintDescHtml(r.descFull)}</div>
    </div>
    <div class="lg-card-section lg-card-attach-section" hidden>
      <span class="lg-person-role">${escapeHtml(t('lg.card.attachments') || 'Attachments')}</span>
      <div class="lg-card-attach-grid" id="admCardAttachGrid"></div>
    </div>
    <div class="lg-card-section">
      <span class="lg-person-role">${escapeHtml(t('lg.th.comments'))}</span>
      <div class="lg-card-comments">${commentsHtml}</div>
    </div>`;
  /* delegated interactions: image thumb → lightbox, Esc/outside → close */
  body.onclick = (e) => {
    const img = e.target.closest && e.target.closest('.lg-att-img');
    if (img && body._admAttMeta) {
      e.preventDefault();
      const att = body._admAttMeta.get(img.getAttribute('data-att-id'));
      admAttachBlob(att).then((u) => admOpenLightbox(att, u)).catch(() => {});
    }
  };
  admLoadCardAttachments(r.key);

  /* eager native-SLA fetch so the popup's SLA line lands immediately
     (queued row hydration may not have reached this key yet); repaints
     the popup when it arrives */
  if (!r.slaNative) {
    admFetchSla(r.key).then((sla) => {
      if (!sla || adm.cardKey !== r.key) return;
      admSlaApplyNative(r, sla);
      admRenderCard();
    }).catch(() => { /* SLA chips stay approximate */ });
  }
}
/* description text → esc'd text where every 📷 marker becomes an inline
   image slot the matching attachment later sits inside (mirrors the desk's
   lgPaintDescHtml). Empty descriptions keep the muted placeholder. */
function admPaintDescHtml(descFull) {
  if (!descFull) return `<span class="muted">${escapeHtml(t('lg.card.noDescription'))}</span>`;
  let mi = -1;
  return escapeHtml(descFull).replace(/📷/g, () => {
    mi += 1;
    return `<span class="jp-desc-media" data-desc-media="${mi}"></span>`;
  });
}

/* slot the attachment whose mediaId/alt matches each description marker
   into its slot — mediaId match first, filename fallback (this instance's
   image attachments often carry an EMPTY mediaId). Safe from both async
   arrival orders; slots already filled are skipped. */
function admPlaceDescAttachments(body, r, attachments) {
  const descEl = body.querySelector('#admCardDesc');
  if (!descEl || !r?.descMedia?.length) return;
  const slots = descEl.querySelectorAll('.jp-desc-media[data-desc-media]');
  if (!slots.length) return;
  const list = Array.isArray(attachments) && attachments.length
    ? attachments
    : (body._admAttMeta ? [...body._admAttMeta.values()] : []);
  const byMedia = new Map();
  const byFile = new Map();
  for (const a of list) {
    if (a.mediaId) byMedia.set(String(a.mediaId), a);
    const fn = String(a.filename || '').trim().toLowerCase();
    if (fn && !byFile.has(fn)) byFile.set(fn, a);
  }
  slots.forEach((slot) => {
    if (slot.getAttribute('data-done') === '1') return;
    const m = r.descMedia[Number(slot.getAttribute('data-desc-media'))] || null;
    if (!m) return;
    const att = byMedia.get(m.id) || byFile.get(String(m.alt || '').trim().toLowerCase()) || null;
    if (!att || !admIsImageMime(att.mimeType, att.filename)) return;
    slot.setAttribute('data-done', '1');
    slot.insertAdjacentHTML('beforeend', admAttachThumbHtml(att));
  });
  admHydrateAttachImages(body);
}
async function admLoadCardAttachments(key) {
  const body = $('#admCardBody');
  const keyAtStart = adm.cardKey;
  try {
    const attachments = await admFetchAttachments(key);
    if (adm.cardKey !== keyAtStart || $('#admCardOverlay').classList.contains('hidden')) return;
    if (!attachments.length) return;
    body._admAttMeta = new Map(attachments.map((a) => [String(a.id), a]));
    const inComments = attachments.filter((a) => a.commentIndex != null);
    for (const att of inComments) {
      const slot = body.querySelector(`.lg-card-comment-attach[data-comment-idx="${att.commentIndex}"]`);
      if (!slot) continue;
      slot.insertAdjacentHTML('beforeend', admAttachThumbHtml(att));
    }
    /* description-embedded images: slot matching attachments into the
       📷 markers painted into the description text */
    admPlaceDescAttachments(body, admFindTask(key), attachments);
    const rest = attachments.filter((a) => a.commentIndex == null);
    const sec = body.querySelector('.lg-card-attach-section');
    const grid = body.querySelector('#admCardAttachGrid');
    if (rest.length && sec && grid) {
      sec.hidden = false;
      grid.innerHTML = rest.map(admAttachThumbHtml).join('');
    }
    admHydrateAttachImages(body);
  } catch (_) {
    /* attachments are optional garnish — a failed fetch leaves the card clean */
  }
}
function renderCharts(a) {
  admChRenderSelects();
  if (!a) return;
  adm.lastAggr = a;
  /* per-chart paint: each card gets the aggregate for ITS period (master, or
     its own override computed on the fly). C[ch] = painter(admA, colors). */
  C.forEach((draw, ch) => draw(admChAggregateFor(ch, a), admColors()));
}

/* ── chart registry: chId → painter(admA) ── the per-chart period filter and
   tooltip wiring use this list. Rebuilt in one spot so at DOM level nothing
   else needs to know which aggregate goes with which chart. */
const _cv = (id) => document.getElementById(id);
/* nearest bar/point index from mouse x (mirror of painter geometry: pad l=34 r=10) */
function admHitIdxLineBar(cv, mx, n) {
  const w = cv.clientWidth || 300;
  const frac = (mx - 34) / (w - 34 - 10);
  if (frac < 0 || frac > 1) return -1;
  return n <= 1 ? 0 : Math.round(frac * (n - 1));
}

/* duration-histogram bucketing that ADAPTS to the goal: edges at 10% / 25% /
   50% / 100% / 200% / 400% of the goal → bars before the dashed line show
   how far under the SLA we usually are, bars after show how bad the misses
   are. Returns { labels, counts, edges, goalIdx }. */
function admSlaBuckets(list, goalMs, edges) {
  const counts = items0(edges.length + 1), labels = [];
  let goalIdx = edges.findIndex(e => e >= goalMs);
  if (goalIdx < 0) goalIdx = edges.length;
  for (let i = 0; i <= edges.length; i++) {
    const lo = i === 0 ? 0 : edges[i - 1], hi = i < edges.length ? edges[i] : Infinity;
    labels.push(i === edges.length ? '>' + admFmtSlaHours(edges[edges.length - 1]) : '≤' + admFmtSlaHours(edges[i]));
    counts[i] = list.filter(ms => ms > lo && ms <= hi).length;
  }
  return { labels, counts, goalIdx };
}
function items0(n) { return new Array(n).fill(0); }

const C = new Map([
  ['chDaily', (a, cc) => {
    /* per-bucket label: day "MM/DD", week-start "MM/DD" (strip W prefix),
       month "MonYYYY" when the trend is bucketed by month (very long ranges) */
    const trendLbl = a.useMonths
      ? (k) => monthLabel(k.replace(/^M/, '') + '-01')
      : (k) => dayLabel(k.replace(/^W/, ''));
    const labels = a.perDay.map(x => trendLbl(x.day));
    const sCreated = a.perDay.map(x => x.created);
    const sResolved = a.perDay.map(x => x.resolved);
    admChartLine('chDaily', labels, [
      { color: cc.blue, data: sCreated },
      { color: cc.green, data: sResolved }
    ]);
    admTipBind('chDaily', (mx) => {
      const n = labels.length; if (!n) return null;
      const i = admHitIdxLineBar(_cv('chDaily'), mx, n);
      if (i < 0 || i >= n) return null;
      return {
        title: labels[i],
        rows: [
          { color: cc.blue, label: t('adm.ch.legCreated'), value: sCreated[i] },
          { color: cc.green, label: t('adm.ch.legResolved'), value: sResolved[i] }
        ]
      };
    });
  }],
  /* monthly: months spanned by the chart's period, grouped bars */
  ['chMonthlyNew', (a, cc) => {
    const labels = a.perMonth.map(x => monthLabel(x.ym));
    const data = a.perMonth.map(x => x.created);
    admChartBar('chMonthlyNew', labels, [{ color: cc.cyan, data }]);
    admTipBind('chMonthlyNew', (mx) => {
      const n = labels.length; if (!n) return null;
      const i = admHitIdxLineBar(_cv('chMonthlyNew'), mx, n);
      if (i < 0 || i >= n) return null;
      return {
        title: labels[i],
        rows: [{ color: cc.cyan, label: t('adm.ch.legCreated'), value: data[i] }]
      };
    });
  }],
  ['chMonthlyDone', (a, cc) => {
    const labels = a.perMonth.map(x => monthLabel(x.ym));
    const data = a.perMonth.map(x => x.resolved);
    admChartBar('chMonthlyDone', labels, [{ color: cc.green, data }]);
    admTipBind('chMonthlyDone', (mx) => {
      const n = labels.length; if (!n) return null;
      const i = admHitIdxLineBar(_cv('chMonthlyDone'), mx, n);
      if (i < 0 || i >= n) return null;
      return {
        title: labels[i],
        rows: [{ color: cc.green, label: t('adm.ch.legResolved'), value: data[i] }]
      };
    });
  }],
  /* donut — period-scoped; tooltip = hovered segment label + value + share */
  ['chDonut', (a, cc) => {
    const segs = [
      { label: t('adm.lb.open'), value: a.donut.open, color: cc.amber },
      { label: t('adm.lb.resolved'), value: a.donut.resolved, color: cc.green }
    ];
    admChartDonut('chDonut', segs);
    admTipBind('chDonut', (mx, my) => {
      const total = segs.reduce((s, x) => s + x.value, 0);
      if (!total) return null;
      const cv = _cv('chDonut');
      const w = cv.clientWidth || 300, h = cv.clientHeight || 220;
      const cx = w / 2, cy = (h - 22) / 2, R = Math.min(w, h - 30) / 2 - 12, r = R * 0.62;
      const dx = mx - cx, dy = my - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < r - 2 || dist > R + 2) return null;
      let ang = Math.atan2(dy, dx); /* same clock base as painter (-PI/2 start) */
      if (ang < -Math.PI / 2) ang += Math.PI * 2;
      const frac = (ang + Math.PI / 2) / (Math.PI * 2);
      let acc = 0, hit = null;
      for (const s of segs) {
        acc += s.value / total;
        if (frac <= acc) { hit = s; break; }
      }
      if (!hit) hit = segs[segs.length - 1];
      return {
        title: hit.label,
        rows: [{ color: hit.color, label: hit.label, value: `${hit.value} (${Math.round(100 * hit.value / total)}%)` }]
      };
    });
  }],
  /* status breakdown (period-created work) */
  ['chStatus', (a, cc) => {
    const stItems = Array.from(a.perStatus.entries())
      .filter(([st]) => lgStatusClass(st) !== 'lg-st-done')
      .map(([st, n]) => ({ label: st, value: n }))
      .sort((x, y) => y.value - x.value);
    admChartHbar('chStatus', stItems, cc.cyan);
    admTipBind('chStatus', (mx, my) => admHitHbarRow(_cv('chStatus'), my, stItems, [], true));
  }],
  /* assignees: top 8 by open (period-created) */
  ['chAssignees', (a, cc) => {
    const users = Array.from(a.perUser.entries()).map(([n, v]) => ({ n, ...v }));
    const topOpen = users.filter(u => u.open > 0).sort((x, y) => y.open - x.open).slice(0, 8)
      .map(u => ({ label: u.n, value: u.open }));
    admChartHbar('chAssignees', topOpen, cc.amber);
    admTipBind('chAssignees', (mx, my) => admHitHbarRow(_cv('chAssignees'), my, topOpen, [], true));
  }],
  /* reporters: top 8 by created (period-scoped) */
  ['chReporters', (a, cc) => {
    const topRep = Array.from(a.perReporter.entries(), ([label, value]) => ({ label, value }))
      .sort((x, y) => y.value - x.value).slice(0, 8);
    admChartHbar('chReporters', topRep, cc.violet);
    admTipBind('chReporters', (mx, my) => admHitHbarRow(_cv('chReporters'), my, topRep, [], true));
  }],
  /* directions stacked (resolved + open) — period-scoped */
  ['chDirection', (a, cc) => {
    const dirs = Array.from(a.perDir.entries()).map(([n, v]) => ({ n, ...v }))
      .sort((x, y) => y.total - x.total).slice(0, 10);
    const rows = dirs.map(d => ({ label: d.n, parts: [d.resolved, d.open] }));
    admChartStacked('chDirection', rows, [cc.green, cc.amber]);
    admTipBind('chDirection', (mx, my) => admHitStackedRow(_cv('chDirection'), my, rows,
      [{ color: cc.green, label: t('adm.ch.legResolved') }, { color: cc.amber, label: t('adm.ch.legOpen') }]));
  }],
  ['chDirDone', (a, cc) => {
    const dirs = Array.from(a.perDir.entries()).map(([n, v]) => ({ n, ...v }))
      .sort((x, y) => y.total - x.total).slice(0, 10);
    const rows = dirs.map(d => ({ label: d.n, parts: [d.resolved, d.total - d.resolved] }));
    admChartStacked('chDirDone', rows, [cc.green, cc.cyan]);
    admTipBind('chDirDone', (mx, my) => admHitStackedRow(_cv('chDirDone'), my, rows,
      [{ color: cc.green, label: t('adm.ch.legResolved') }, { color: cc.cyan, label: t('adm.lb.open') }]));
  }],
  /* ── SLA charts ── per-state horizontal status bars (easier to read than
     the old donuts) + duration histograms with the dashed SLA goal line +
     per-direction breach stacked bars. Every SLA chart is CLICK-THROUGH:
     clicking a bar/segment opens the task list below with exactly those
     tasks (drill key in the hit-test → admDrillRows). States:
     in=green, out=red, overdue=amber, pending=cyan, nodata=gray. */
  ['chSlaResp', (a, cc) => {
    const segs = [
      { key: 'slaRespIn', label: t('adm.sla.inSla'), value: a.slaResp.in, color: cc.green },
      { key: 'slaRespOut', label: t('adm.sla.outSla'), value: a.slaResp.out, color: cc.red },
      { key: 'slaRespOverdue', label: t('adm.sla.overdue'), value: a.slaResp.overdue, color: cc.amber },
      { key: 'slaRespPending', label: t('adm.sla.pending'), value: a.slaResp.pending, color: cc.cyan },
      { key: 'slaRespNodata', label: t('adm.sla.nodata'), value: a.slaResp.nodata, color: 'rgba(148,163,184,0.35)' }
    ].filter(s => s.value > 0);
    admChartSlaStatus('chSlaResp', segs);
    admSlaClickBind('chSlaResp');
    admTipBind('chSlaResp', (mx, my) => admHitSlaStatus(_cv('chSlaResp'), mx, my, segs, a.slaResp));
  }],
  ['chSlaRes', (a, cc) => {
    const segs = [
      { key: 'slaResIn', label: t('adm.sla.inSla'), value: a.slaRes.in, color: cc.green },
      { key: 'slaResOut', label: t('adm.sla.outSla'), value: a.slaRes.out, color: cc.red },
      { key: 'slaResOverdue', label: t('adm.sla.overdue'), value: a.slaRes.overdue, color: cc.amber },
      { key: 'slaResPending', label: t('adm.sla.pending'), value: a.slaRes.pending, color: cc.cyan },
      { key: 'slaResNodata', label: t('adm.sla.nodataRes'), value: a.slaRes.nodata, color: 'rgba(148,163,184,0.35)' }
    ].filter(s => s.value > 0);
    admChartSlaStatus('chSlaRes', segs);
    admSlaClickBind('chSlaRes');
    admTipBind('chSlaRes', (mx, my) => admHitSlaStatus(_cv('chSlaRes'), mx, my, segs, a.slaRes));
  }],
  ['chSlaRespHist', (a, cc) => {
    const b = admSlaBuckets(a.slaRespMsList, (adm.slaGoals.respHours || 2) * 3600e3, SLA_RESP_EDGES);
    const items = b.labels.map((label, i) => ({ label, value: b.counts[i], drill: 'slaRespHist:' + i }));
    admChartSlaHist('chSlaRespHist', items, b.goalIdx, cc.green, cc.red);
    admSlaClickBind('chSlaRespHist');
    admTipBind('chSlaRespHist', (mx, my) => admHitSlaHistBar(_cv('chSlaRespHist'), mx, my, items, b.goalIdx));
  }],
  ['chSlaResHist', (a, cc) => {
    const b = admSlaBuckets(a.slaResMsList, (adm.slaGoals.resHours || 30) * 3600e3, SLA_RES_EDGES);
    const items = b.labels.map((label, i) => ({ label, value: b.counts[i], drill: 'slaResHist:' + i }));
    admChartSlaHist('chSlaResHist', items, b.goalIdx, cc.green, cc.red);
    admSlaClickBind('chSlaResHist');
    admTipBind('chSlaResHist', (mx, my) => admHitSlaHistBar(_cv('chSlaResHist'), mx, my, items, b.goalIdx));
  }],
  ['chSlaDir', (a, cc) => {
    const dirs = Array.from(a.slaPerDir.entries()).map(([n, v]) => ({ n, ...v }))
      .sort((x, y) => (y.respOut + y.resOut) - (x.respOut + x.resOut)).slice(0, 10)
      .filter(d => d.respOut || d.resOut);
    const rows = dirs.map(d => ({ label: d.n, parts: [d.respOut, d.resOut], dir: d.n }));
    admChartStacked('chSlaDir', rows, [cc.red, cc.amber]);
    admSlaClickBind('chSlaDir');
    admTipBind('chSlaDir', (mx, my) => admHitSlaDirRow(_cv('chSlaDir'), my, mx, rows,
      [{ color: cc.red, label: t('adm.sla.respBreaches'), drill: (d) => 'slaDirRespOut:' + d },
       { color: cc.amber, label: t('adm.sla.resBreaches'), drill: (d) => 'slaDirResOut:' + d }]));
  }]
]);
/* bucket edges (ms) for the two SLA histograms — resp goal 2wh, res goal 30wh.
   Values are WORKING-ms, so the buckets read as working-hour ranges. */
const SLA_RESP_EDGES = [0.25 * 3600e3, 0.5 * 3600e3, 3600e3, 2 * 3600e3, 4 * 3600e3, 8 * 3600e3];
const SLA_RES_EDGES = [4 * 3600e3, 12 * 3600e3, 24 * 3600e3, 30 * 3600e3, 60 * 3600e3, 120 * 3600e3];
/* ── SLA status bar (replaces the donut) ── one horizontal stacked bar per
   chart with each state as a separate labeled row next to it: the label,
   the count and the share are directly readable, no pie-angle guessing. */
function admChartSlaStatus(id, segs) {
  const cv = document.getElementById(id); if (!cv) return;
  const { g, w, h, c } = admChartSetup(cv);
  g.clearRect(0, 0, w, h);
  const total = segs.reduce((a, s) => a + s.value, 0);
  if (!total) { admNoData(g, w, h, c); return; }
  /* The big bar answers the SAME question as the KPI card: of the MEASURED
     tasks (met + breached), what share met the goal? So it normalizes the
     in/out segments among themselves — excluding pending/overdue/nodata —
     and its headline % matches the KPI exactly. Pending/overdue/nodata stay
     fully visible as legend rows with counts and share-of-total. */
  const measured = segs.filter(s => s.key.endsWith('In') || s.key.endsWith('Out'));
  const mTotal = measured.reduce((a, s) => a + s.value, 0);
  const rows = segs.length;
  const rowH = Math.min(30, (h - 8) / rows);
  const barH = 22;
  /* the big total share bar on top */
  if (mTotal) {
    let x = 12;
    const bw = w - 24;
    measured.forEach(s => {
      const bws = bw * (s.value / mTotal);
      g.fillStyle = s.color;
      if (g.roundRect) { g.beginPath(); g.roundRect(x, 8, bws, barH, 4); g.fill(); }
      else g.fillRect(x, 8, Math.max(2, bws), barH);
      x += bws;
    });
    /* share % drawn inside segments wide enough */
    g.font = '700 11px Inter, sans-serif'; g.textAlign = 'center';
    x = 12;
    measured.forEach(s => {
      const bws = bw * (s.value / mTotal);
      if (bws >= 34) {
        g.fillStyle = '#fff';
        g.fillText(Math.round(100 * s.value / mTotal) + '%', x + bws / 2, 8 + barH / 2 + 4);
      }
      x += bws;
    });
  } else {
    admNoData(g, w, h, c); return;
  }
  /* legend rows: swatch + label + count */
  segs.forEach((s, i) => {
    const y = 8 + barH + 8 + i * rowH;
    g.textAlign = 'left'; g.font = '11px Inter, sans-serif';
    g.fillStyle = s.color; g.fillRect(14, y + rowH / 2 - 5, 10, 10);
    g.fillStyle = c.text; g.fillText(s.label, 30, y + rowH / 2 + 4);
    g.textAlign = 'right';
    g.fillText(String(s.value), w - 44, y + rowH / 2 + 4);
    g.fillStyle = c.text; g.font = '10px Inter, sans-serif';
    g.fillText(Math.round(100 * s.value / total) + '%', w - 10, y + rowH / 2 + 4);
    g.font = '11px Inter, sans-serif';
  });
}
/* status-bar hit-test — row over legend rows, or the share bar on top.
   Bar segments (measured in/out) report their measured-denominator %, so
   the tooltip agrees with the KPI card and the drawn headline %. */
function admHitSlaStatus(cv, mx, my, segs, _buckets) {
  const total = segs.reduce((s, x) => s + x.value, 0);
  if (!total) return null;
  const measured = segs.filter(s => s.key.endsWith('In') || s.key.endsWith('Out'));
  const mTotal = measured.reduce((a, s) => a + s.value, 0);
  const pctOf = (s) => (s.key.endsWith('In') || s.key.endsWith('Out')) && mTotal
    ? Math.round(100 * s.value / mTotal)
    : Math.round(100 * s.value / total);
  const w = cv.clientWidth || 300, h = cv.clientHeight || 220;
  const barH = 22;
  /* share bar on top: hit by x fraction (geometry mirrors the measured-only bar) */
  if (my >= 8 && my <= 8 + barH && mTotal) {
    const bw = w - 24;
    let acc = 12;
    for (const s of measured) {
      const bws = bw * (s.value / mTotal);
      if (mx >= acc && mx <= acc + bws) return { title: s.label, rows: [{ color: s.color, label: s.label, value: `${s.value} (${pctOf(s)}%)` }], drill: s.key };
      acc += bws;
    }
    return null;
  }
  /* legend rows below */
  const rows = segs.length;
  const rowH = Math.min(30, (h - 8) / rows);
  const i = Math.floor((my - (8 + barH + 8)) / rowH);
  if (i < 0 || i >= rows) return null;
  const s = segs[i];
  return { title: s.label, rows: [{ color: s.color, label: s.label, value: `${s.value} (${pctOf(s)}%)` }], drill: s.key };
}
/* SLA histogram hit-test — bar geometry mirrors admChartSlaHist (pad l=34 r=10);
   the item's drill key (bucket index) comes back for click-through */
function admHitSlaHistBar(cv, mx, my, items, goalIdx) {
  const w = cv.clientWidth || 300;
  const frac = (mx - 34) / (w - 34 - 10);
  const n = items.length;
  if (frac < 0 || frac > 1 || !n) return null;
  const i = Math.min(n - 1, Math.floor(frac * n));
  const inside = i <= goalIdx ? t('adm.sla.inSla') : t('adm.sla.outSla');
  return { title: items[i].label, rows: [{ color: '', label: inside, value: items[i].value }], drill: items[i].drill };
}
/* SLA per-direction breach hit-test — like admHitStackedRow but also maps
   the hovered PART (resp vs res breach) + the row's direction to a drill key */
function admHitSlaDirRow(cv, my, mx, rows, series) {
  if (!rows.length) return null;
  const h = cv.clientHeight || 200;
  const rowH = Math.min(30, (h - 8) / rows.length);
  const i = Math.floor((my - 6) / rowH);
  if (i < 0 || i >= rows.length) return null;
  const it = rows[i];
  /* which stacked segment was clicked? mirror geometry: bars start at
     labelW = min(120, w*0.26) + 4, scaled per painter */
  const w = cv.clientWidth || 300;
  const labelW = Math.min(120, w * 0.26);
  const barW = w - labelW - 4 - 34;
  const tot = it.parts.reduce((s, v) => s + v, 0);
  const maxV = tot; /* approx: painter scales per-row relative to chart max,
     the part boundary fraction within the total is what we need */
  let x = labelW + 4, drill = null;
  for (let pi = 0; pi < it.parts.length; pi++) {
    const frac = it.parts[pi] / maxV;
    const bwid = Math.max(2, barW * frac);
    if (mx >= x && mx <= x + bwid && it.parts[pi]) { drill = series[pi].drill(it.dir); break; }
    x += bwid;
  }
  return {
    title: it.label,
    rows: series.map((s, pi) => ({ color: s.color, label: s.label, value: it.parts[pi] || 0 })),
    drill
  };
}
/* hbar hit-test: row = label + value */
function admHitHbarRow(cv, my, items, _unused, _fullLbl) {
  if (!items.length) return null;
  const h = cv.clientHeight || 200;
  const rowH = Math.min(28, (h - 8) / Math.max(items.length, 1));
  const i = Math.floor((my - 6) / rowH);
  if (i < 0 || i >= items.length) return null;
  return { title: items[i].label, rows: [{ color: '', label: items[i].label, value: items[i].value }] };
}
/* stacked hit-test: row = label + each part + total */
function admHitStackedRow(cv, my, rows, series) {
  if (!rows.length) return null;
  const h = cv.clientHeight || 200;
  const rowH = Math.min(30, (h - 8) / Math.max(rows.length, 1));
  const i = Math.floor((my - 6) / rowH);
  if (i < 0 || i >= rows.length) return null;
  const it = rows[i];
  const tot = it.parts.reduce((s, v) => s + v, 0);
  return {
    title: it.label,
    rows: series.map((s, pi) => ({ color: s.color, label: s.label, value: it.parts[pi] || 0 }))
      .concat(tot ? [{ color: 'transparent', label: t('adm.lb.total'), value: tot }] : [])
  };
}

/* ═══ 18. Leaderboards (searchable + sortable) ═══ */
function admBindSearch(inputId, tableId, key) {
  const inp = $(inputId);
  if (!inp || inp.dataset.bound) return;
  inp.dataset.bound = '1';
  inp.addEventListener('input', () => { adm.lbSearch[key] = inp.value; admRenderLeaderboard(key); });
}
function admBindSort(tableId, key) {
  const tbl = $(tableId);
  if (!tbl || tbl.dataset.sortBound) return;
  tbl.dataset.sortBound = '1';
  tbl.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      const cur = adm.lbSort[key];
      adm.lbSort[key] = { col, dir: cur.col === col ? (cur.dir === 'asc' ? 'desc' : 'asc') : 'desc' };
      admRenderLeaderboard(key);
    });
  });
}
function admSortRows(rows, key) {
  const { col, dir } = adm.lbSort[key];
  const sgn = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((x, y) => {
    const a = x[col], b = y[col];
    if (typeof a === 'string' || typeof b === 'string') return sgn * String(a || '').localeCompare(String(b || ''));
    return sgn * ((a || 0) - (b || 0));
  });
}
function admMarkSortHeads(tableId, key) {
  const tbl = $(tableId); if (!tbl) return;
  const { col, dir } = adm.lbSort[key];
  tbl.querySelectorAll('th[data-col]').forEach(th => {
    th.classList.toggle('lg-sorted', th.dataset.col === col);
    if (th.dataset.col === col) th.dataset.sort = dir; else delete th.dataset.sort;
  });
}
function admRenderLeaderboard(key) {
  const a = adm.lastAggr;
  if (key === 'user') {
    const ut = $('#admUserTable'); if (!ut) return;
    admMarkSortHeads('#admUserTable', 'user');
    if (!a) { ut.querySelector('tbody').innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center">${escapeHtml(t('adm.lb.nodata'))}</td></tr>`; return; }
    let users = Array.from(a.perUser.entries()).map(([n, v]) => ({ n, ...v }))
      .filter(u => u.created || u.resolved || u.open);
    const q = String(adm.lbSearch.user || '').toLowerCase();
    if (q) users = users.filter(u => u.n.toLowerCase().includes(q));
    users = admSortRows(users, 'user').slice(0, 25);
    if (!users.length) {
      ut.querySelector('tbody').innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center">${escapeHtml(t('adm.lb.nodata'))}</td></tr>`;
    } else {
      ut.querySelector('tbody').innerHTML = users.map(u =>
        `<tr><td>${escapeHtml(u.n)}</td><td>${u.created}</td><td>${u.resolved}</td><td>${u.open}</td></tr>`).join('');
    }
  } else if (key === 'dir') {
    const dt = $('#admDirTable'); if (!dt) return;
    admMarkSortHeads('#admDirTable', 'dir');
    if (!a) { dt.querySelector('tbody').innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center">${escapeHtml(t('adm.lb.nodata'))}</td></tr>`; return; }
    let dirs = Array.from(a.perDir.entries()).map(([n, v]) => ({ n, ...v }));
    const q = String(adm.lbSearch.dir || '').toLowerCase();
    if (q) dirs = dirs.filter(d => d.n.toLowerCase().includes(q));
    dirs = admSortRows(dirs, 'dir');
    if (!dirs.length) {
      dt.querySelector('tbody').innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center">${escapeHtml(t('adm.lb.nodata'))}</td></tr>`;
    } else {
      dt.querySelector('tbody').innerHTML = dirs.map(d =>
        `<tr><td>${escapeHtml(d.n)}</td><td>${d.total}</td><td>${d.resolved}</td><td>${d.open}</td></tr>`).join('');
    }
  } else {
    const tbl = $('#admLoginTable'); if (!tbl) return;
    admMarkSortHeads('#admLoginTable', 'login');
    const st = adm.lastStats;
    if (!st) return;
    /* per-user surface chips: desk / admin / both (from the per-surface buckets) */
    const dU = new Set(((st.desk || {}).users || []).map(u => String(u.email || '').toLowerCase()));
    const aU = new Set(((st.admin || {}).users || []).map(u => String(u.email || '').toLowerCase()));
    let users = (st.users || []).slice();
    users.forEach(u => {
      const e = String(u.email || '').toLowerCase();
      const inD = dU.has(e), inA = aU.has(e);
      u.surface = inD && inA ? 'both' : inD ? 'desk' : inA ? 'admin' : '';
    });
    const q = String(adm.lbSearch.login || '').toLowerCase();
    if (q) users = users.filter(u =>
      String(u.email || '').toLowerCase().includes(q) || String(u.surface || '').includes(q));
    users = admSortRows(users, 'login');
    const tb = tbl.querySelector('tbody');
    if (!users.length) {
      tb.innerHTML = `<tr><td colspan="5" class="muted" style="text-align:center">${escapeHtml(t('adm.lb.nodata'))}</td></tr>`;
      return;
    }
    const sLbl = { desk: t('adm.act.desk'), admin: t('adm.act.admin'), both: t('adm.act.both'), '': '–' };
    tb.innerHTML = users.map(u => {
      const on = (Date.now() - (u.lastTs || 0)) < 15 * 60 * 1000;
      const sf = String(u.surface || '');
      const badge = sf === 'desk' ? 'lg-st-done' : sf === 'admin' ? 'lg-st-admin' : 'lg-st-other';
      return `<tr><td>${escapeHtml(u.email || '')}</td>` +
        `<td>${sf ? `<span class="lg-st-badge ${badge}">${escapeHtml(sLbl[sf])}</span>` : '–'}</td>` +
        `<td>${u.lastTs ? relTime(u.lastTs) + ' ago' : '–'}</td>` +
        `<td>${u.count != null ? u.count : '–'}</td>` +
        `<td><span class="lg-st-badge ${on ? 'lg-st-done' : 'lg-st-other'}">${escapeHtml(on ? t('adm.act.online') : t('adm.act.offline'))}</span></td></tr>`;
    }).join('');
  }
}
function renderLeaderboards(a) {
  if (a) adm.lastAggr = a;
  ['user', 'dir', 'login'].forEach(admRenderLeaderboard);
}
function admBindLeaderboard() {
  admBindSearch('#admUserSearch', '#admUserTable', 'user');
  admBindSearch('#admDirSearch', '#admDirTable', 'dir');
  admBindSearch('#admLoginSearch', '#admLoginTable', 'login');
  admBindSort('#admUserTable', 'user');
  admBindSort('#admDirTable', 'dir');
  admBindSort('#admLoginTable', 'login');
}

/* ═══ 19. Login activity ═══
   Tiles = logistics-desk traffic (what we care about); Admin and Overall
   (union of desk + admin) shown as secondary breakdowns below. */
function renderLoginActivity(st) {
  if (!st) return;
  adm.lastStats = st;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
  const paint = (stats, prefix) => {
    set(`#${prefix}Now`, stats.activeNow != null ? stats.activeNow : 0);
    set(`#${prefix}Today`, stats.today != null ? stats.today : 0);
    set(`#${prefix}Week`, stats.week != null ? stats.week : 0);
    set(`#${prefix}Total`, stats.total != null ? stats.total : 0);
    set(`#${prefix}Sessions`, stats.sessions != null ? stats.sessions : 0);
  };
  paint(st.desk || {}, 'admDesk');
  paint(st.admin || {}, 'admAdm');
  /* union top-level (desk ∪ admin) */
  paint({ activeNow: st.activeNow, today: st.today, week: st.week, total: st.total ?? ((st.users && st.users.length) || 0), sessions: st.sessions }, 'admUni');
  admRenderLeaderboard('login');
}
/* ═══ 20. Period select / count / fetched-at ═══ */
function admRenderPeriodSelect() {
  const sel = $('#admPeriod'); if (!sel) return;
  const opts = [
    ['30d', 'adm.p.30d'], ['month', 'adm.p.month'], ['quarter', 'adm.p.quarter'],
    ['year', 'adm.p.year'], ['all', 'adm.p.all'], ['custom', 'adm.p.custom']
  ];
  sel.innerHTML = opts.map(([v, k]) => `<option value="${v}">${escapeHtml(t(k))}</option>`).join('');
  sel.value = adm.period.kind;
}
function admRenderCustomWrap() {
  const w = $('#admCustomWrap'); if (!w) return;
  if (adm.period.kind === 'custom') {
    show(w);
    const f = $('#admFrom'), tt = $('#admTo');
    if (f && adm.period.fromMs) f.value = new Date(adm.period.fromMs).toISOString().slice(0, 10);
    if (tt && adm.period.toMs) tt.value = new Date(adm.period.toMs).toISOString().slice(0, 10);
  } else hide(w);
}
function admOnPeriodChange() {
  const sel = $('#admPeriod'); if (!sel) return;
  adm.period.kind = sel.value;
  if (sel.value !== 'custom') { adm.period.fromMs = null; adm.period.toMs = null; }
  admSavePeriod(); admRenderCustomWrap(); admCloseDrilldown(); renderAll();
}
function admOnCustomDates() {
  const f = $('#admFrom'), tt = $('#admTo');
  if (!f || !tt || !f.value || !tt.value) return;
  adm.period.fromMs = Date.parse(f.value + 'T00:00:00');
  adm.period.toMs = Date.parse(tt.value + 'T23:59:59');
  if (adm.period.fromMs > adm.period.toMs) { const tmp = adm.period.fromMs; adm.period.fromMs = adm.period.toMs; adm.period.toMs = tmp; }
  admSavePeriod(); renderAll();
}
function admSetCount(n) {
  const el = $('#admCount'); if (!el) return;
  el.textContent = (n == null) ? t('adm.count.loading') : tReplace('adm.count.n', { n });
}
function admSetFetched(ms) {
  const el = $('#admFetchedAt'); if (!el) return;
  el.textContent = ms ? tReplace('adm.fetched', { t: fmtDateTime(ms) }) : '';
}
function renderAll() {
  const range = admPeriodRange();
  const a = adm.verified && adm.rows.length ? admAggregate(adm.rows, range) : null;
  admSetCount(a ? a.total : (adm.loading ? null : 0));
  renderKpis(a); renderCharts(a); renderLeaderboards(a);
  admRenderDrilldown();   /* keep an open drill-down in sync with its period */
  admSetFetched(adm.fetchedAt);
}
function admError(msg) {
  const el = $('#admError'); if (!el) return;
  if (!msg) { hide(el); return; }
  el.textContent = msg; show(el);
}

/* ── SLA goal settings card (persisted on the relay via ?cmd=sla:set) ── */
function admRenderSlaCard() {
  const wrap = $('#admSlaCard'); if (!wrap) return;
  const g = adm.slaGoals || SLA_DEFAULT_GOALS;
  $('#admSlaResp').value = g.respHours;
  $('#admSlaRes').value = g.resHours;
}
async function admOnSlaSave() {
  if (adm.slaSaving) return;
  const rh = Number($('#admSlaResp').value), sh = Number($('#admSlaRes').value);
  if (!isFinite(rh) || rh <= 0 || !isFinite(sh) || sh <= 0) { toast(t('adm.sla.invalid')); return; }
  adm.slaSaving = true;
  const btn = $('#admSlaSaveBtn'); if (btn) btn.disabled = true;
  try {
    await admSaveSlaGoals(rh, sh);
    toast(tReplace('adm.sla.saved', { rh, sh }));
    renderAll();   /* re-bucket every SLA chart against the new goals */
  } catch (e) {
    toast(t('adm.sla.saveFail') + ' ' + (e.message || ''));
  } finally {
    adm.slaSaving = false;
    if (btn) btn.disabled = false;
  }
}

/* ═══ 21. Orchestration: load / refresh ═══ */
async function admLoadData() {
  if (adm.loading) return;
  adm.loading = true;
  show($('#admLoading')); admError('');
  admSetCount(null);
  try {
    /* goals first (fast blob read) so admNormalize computes SLA with the right values */
    await fetchAdmSlaGoals();
    admRenderSlaCard();
    const data = await admFetchDesk(false);
    adm.rows = admNormalize(data);
    adm.jqlTotal = data.jqlTotal || adm.rows.length;
    adm.fetchedAt = Date.now();
    hide($('#admLoading'));
    renderAll();
    fetchAdmStats().then(st => renderLoginActivity(st));
    lgSendAdmPing(adm.email);
    /* keep the activity tiles fresh (active-now / last-seen age) */
    clearInterval(adm.statsTimer);
    adm.statsTimer = setInterval(async () => {
      if (adm.loading) return;
      const st = await fetchAdmStats();
      if (st) renderLoginActivity(st);
    }, 60 * 1000);
  } catch (e) {
    hide($('#admLoading'));
    admError((e && e.message) || 'load failed');
    admSetCount(0);
  } finally { adm.loading = false; }
}
async function admRefresh() {
  if (adm.loading) return;
  const btn = $('#admRefreshBtn');
  if (btn) btn.classList.add('lg-spinning');
  await admLoadData();
  if (btn) btn.classList.remove('lg-spinning');
}

/* ═══ 22. Boot ═══ */
(function boot() {
  try {
    const saved = localStorage.getItem(LS_LANG);
    adm.lang = (saved === 'ka' || saved === 'en') ? saved : (navigator.language || 'en').slice(0, 2) === 'ka' ? 'ka' : 'en';
  } catch (e) {}
  applyThemeClass(); setLangButtons(); applyI18n();

  document.querySelectorAll('.theme-btn').forEach(b =>
    b.addEventListener('click', () => setTheme(b.dataset.theme)));
  document.querySelectorAll('.lang-btn').forEach(b =>
    b.addEventListener('click', () => setLang(b.dataset.lang)));

  const brand = $('#admBrandBtn');
  if (brand) brand.addEventListener('click', () => { location.href = '../'; });

  const rb = $('#admRefreshBtn'); if (rb) rb.addEventListener('click', admRefresh);
  const ps = $('#admPeriod'); if (ps) ps.addEventListener('change', admOnPeriodChange);
  const slaSave = $('#admSlaSaveBtn'); if (slaSave) slaSave.addEventListener('click', admOnSlaSave);
  const dlClose = $('#admDrillClose');
  if (dlClose) dlClose.addEventListener('click', admCloseDrilldown);
  /* drill-list search box (free-text, mirrors #lgSearch) */
  const dlSearch = $('#admDrillSearch');
  if (dlSearch) dlSearch.addEventListener('input', () => {
    adm.dlQ = dlSearch.value;
    adm.dlPage = 100;                      /* new search → back to page 1 */
    admRenderDrilldown();
  });
  /* "Show more": grow the visible page by +100 while more rows exist */
  const dlMore = $('#admDrillMore');
  if (dlMore) dlMore.addEventListener('click', () => { adm.dlPage += 100; admRenderDrilldown(); });
  /* click-to-sort headers (delegated once — thead never re-renders) */
  const dlTable = $('#admDrillTable');
  if (dlTable) dlTable.querySelectorAll('th[data-col], .lg-th-split[data-col]').forEach((h) => {
    h.addEventListener('click', () => {
      const col = h.dataset.col;
      const cur = (adm.dlSort && adm.dlSort.col) ? adm.dlSort : { col: 'created', dir: 'desc' };
      adm.dlSort = { col, dir: cur.col === col ? (cur.dir === 'asc' ? 'desc' : 'asc') : 'desc' };
      admRenderDrilldown();
    });
  });
  /* task detail popup wiring: close button, outside click, Esc */
  const cc = $('#admCardClose');
  if (cc) cc.addEventListener('click', admCloseCard);
  const cov = $('#admCardOverlay');
  if (cov) cov.addEventListener('click', (e) => { if (e.target === cov) admCloseCard(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && adm.cardKey) admCloseCard();
  });
  admBindLeaderboard();
  const f = $('#admFrom'), tt = $('#admTo');
  if (f) f.addEventListener('change', admOnCustomDates);
  if (tt) tt.addEventListener('change', admOnCustomDates);

  const sb = $('#admSendBtn'); if (sb) sb.addEventListener('click', admSendCode);
  const vb = $('#admVerifyBtn'); if (vb) vb.addEventListener('click', admVerifyCode);
  const ei = $('#admEmail'), ci = $('#admCode');
  if (ei) ei.addEventListener('keydown', ev => { if (ev.key === 'Enter') admSendCode(); });
  if (ci) ci.addEventListener('keydown', ev => { if (ev.key === 'Enter') admVerifyCode(); });

  const chip = $('#admUserChip');
  if (chip) chip.addEventListener('click', toggleAdmSignOut);
  const so = $('#admSignOutBtn');
  if (so) so.addEventListener('click', (ev) => { ev.stopPropagation(); admSignOut(); });
  document.addEventListener('click', (ev) => {
    const chip2 = $('#admUserChip');
    if (chip2 && !chip2.contains(ev.target)) closeAdmSignOut();
  });

  if (admRestoreSession()) {
    admEnterVerified('');
  } else {
    renderAdmGate();
    initAdmGoogleButton();
  }
})();
