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
const ADM_LIVE_TTL = 30 * 1000;

const adm = {
  email: '', verified: false, codeSent: false,
  rows: [], jqlTotal: 0, fetchedAt: 0, countIn: 0,
  fieldIds: { direction: null, title: null },
  period: { kind: '30d', fromMs: null, toMs: null },
  lastAggr: null, lastStats: null, statsTimer: null,
  lbSearch: { user: '', dir: '', login: '' },
  /* per-chart period overrides: chId → 'master' | '30d' | 'month' | … ('master' = follow the master period) */
  chPeriod: {},
  lbSort: { user: { col: 'resolved', dir: 'desc' }, dir: { col: 'total', dir: 'desc' }, login: { col: 'lastTs', dir: 'desc' } },
  charts: {}, loading: false, lang: 'en'
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
    'auth.googleFailed': 'Google sign-in failed · only @{d} accounts can access the admin'
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
      createdMs: Date.parse(f.created) || 0,
      updatedMs: Date.parse(f.updated) || 0,
      resolvedAt: resolved ? (realRdMs || Date.parse(f.updated) || Date.parse(f.created) || 0) : 0,
      rdReal: realRdMs > 0,
      direction: admShortDir(dirId ? lgAdfText(f[dirId]) : '')
    });
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
    resDaysSum: 0, resDaysN: 0,
    resRealN: 0, resApproxN: 0, periodDays
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
    if (!inPeriod) {
      /* still allow resolutions that happened inside the period for tasks
         created earlier — they count in "resolved · period" */
      if (r.resolved && r.resolvedAt >= from && r.resolvedAt <= to) aggr.resolvedPeriod++;
      continue;
    }
    aggr.total++;
    if (r.resolved) aggr.donut.resolved++; else aggr.donut.open++;
    if (r.resolved && r.resolvedAt >= from && r.resolvedAt <= to) aggr.resolvedPeriod++;
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
    // avg resolution time (days) — only rows with a Jira-issued resolutiondate;
    // no updated-fallback here: `updated` drifts on edits/comments and is not
    // the resolve moment (probe: 2193/2217 resolved LOG issues lack rd)
    if (r.resolved && r.rdReal && r.createdMs && r.resolvedAt > r.createdMs) {
      aggr.resDaysSum += (r.resolvedAt - r.createdMs) / 864e5;
      aggr.resDaysN++;
    }
    // users (period-created)
    const u = r.assignName || r.reportName || '—';
    if (!aggr.perUser.has(u)) aggr.perUser.set(u, { created: 0, resolved: 0, open: 0 });
    const ur = aggr.perUser.get(u);
    ur.created++;
    if (r.resolved && r.resolvedAt >= from && r.resolvedAt <= to) ur.resolved++;
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
  }
  aggr.avgResDays = aggr.resDaysN ? (aggr.resDaysSum / aggr.resDaysN) : null;
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
    if (labels.length > 16 && i % Math.ceil(labels.length / 16) !== 0) return;
    g.fillText(lb, pad.l + i * bw + bw / 2, h - 8);
  });
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
  labels.forEach((lb, i) => {
    if (labels.length > 10 && i % Math.ceil(labels.length / 10) !== 0 && i !== labels.length - 1) return;
    g.fillText(lb, xOf(i), h - 8);
  });
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
function admChartStacked(id, items, colors) {
  const cv = document.getElementById(id); if (!cv) return;
  const { g, w, h, c } = admChartSetup(cv);
  g.clearRect(0, 0, w, h);
  if (!items.length) { admNoData(g, w, h, c); return; }
  const maxV = Math.max(1, ...items.map(i => i.parts.reduce((a, b) => a + b, 0)));
  const rowH = Math.min(30, (h - 8) / Math.max(items.length, 1));
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

/* ═══ 17. Render: KPI, charts, leaderboards, login activity ═══ */
function admKpiCard(icon, label, value, cls, sub) {
  return `<div class="kpi glass ${cls || ''}"><div class="kpi-top"><span class="kpi-icon">${icon}</span>` +
    `<span class="kpi-label">${escapeHtml(label)}</span></div>` +
    `<div class="kpi-value">${escapeHtml(String(value))}</div>` +
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
    ? tReplace('adm.kpi.basedOn', { n: a.resDaysN })
    : t('adm.lb.nodata');
  const inProg = Array.from(a.perStatus.entries()).filter(([st]) => lgStatusClass(st) === 'lg-st-progress')
    .reduce((s, [, n]) => s + n, 0);
  const openPeriod = a.donut.open;
  g.innerHTML =
    admKpiCard('📅', t('adm.kpi.total'), a.total, 'accent-blue', t('adm.kpi.totalSub')) +
    admKpiCard('☀️', t('adm.kpi.today'), a.createdToday, 'accent-green', '') +
    admKpiCard('✅', t('adm.kpi.resolved'), a.resolvedPeriod, 'accent-cyan', '') +
    admKpiCard('📂', t('adm.kpi.open'), openPeriod, 'accent-amber', t('adm.kpi.openSub')) +
    admKpiCard('⏱', t('adm.kpi.avgRes'), a.avgResDays != null ? admFmtResDays(a.avgResDays) : '–', 'accent-violet', avgSub) +
    admKpiCard('🏁', t('adm.kpi.resAll'), a.resolvedAll, 'accent-green', '') +
    admKpiCard('🚦', t('adm.kpi.inwork'), inProg, 'accent-blue', '') +
    admKpiCard('🗓', t('adm.kpi.month'), a.createdMonth, 'accent-cyan', '');
}
function monthLabel(ym) {
  const mi = parseInt(String(ym).slice(5, 7), 10) - 1;
  const yr = String(ym).slice(0, 4);
  const mn = (adm.lang === 'ka') ? LG_MONTHS_KA[mi] : LG_MONTHS_EN[mi];
  return yr === String(new Date().getFullYear()) ? mn : `${mn} ${yr}`;
}
function dayLabel(ymd) { return ymd.slice(5).replace('-', '/'); }
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
  }]
]);
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
  admSavePeriod(); admRenderCustomWrap(); renderAll();
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
  admSetFetched(adm.fetchedAt);
}
function admError(msg) {
  const el = $('#admError'); if (!el) return;
  if (!msg) { hide(el); return; }
  el.textContent = msg; show(el);
}

/* ═══ 21. Orchestration: load / refresh ═══ */
async function admLoadData() {
  if (adm.loading) return;
  adm.loading = true;
  show($('#admLoading')); admError('');
  admSetCount(null);
  try {
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
