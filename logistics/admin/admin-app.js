'use strict';
/* JiraPulse · Logistics admin dashboard (standalone - no module imports)
   Auth: admin-whitelist (Google GSI or email code) → relay ?cmd=desk + lgPing/lgStats
   Metrics: KPIs, canvas charts, per-user & per-direction leaderboards, login activity. */

/* ═══ 1. Constants & state ═══ */
const PUB_RELAY = 'https://gensweaty--65df49bca6d911f19f231607ee4eb77e.web.val.run/';
const PUBLISH_DOMAIN = 'caucasusauto.com';
const GOOGLE_CLIENT_ID = '1041661921234-kccuvhfbkgej4fl9a9im0p87nh0if8p3.apps.googleusercontent.com';
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
const LS_ADM_FIELDIDS = 'jp_lg_fieldids_v1';
const ADM_LIVE_TTL = 30 * 1000;

const adm = {
  email: '', verified: false, codeSent: false,
  rows: [], jqlTotal: 0, fetchedAt: 0, countIn: 0,
  fieldIds: { direction: null, title: null },
  period: { kind: '30d', fromMs: null, toMs: null },
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
    'adm.kpi.resolved': 'Resolved · period', 'adm.kpi.open': 'Open (all time)', 'adm.kpi.resAll': 'Resolved (all time)',
    'adm.kpi.active': 'Active now', 'adm.kpi.logins': 'Logins today',
    'adm.ch.daily': 'New vs resolved · last 30 days', 'adm.ch.monthlyNew': 'New tasks per month · 12 months',
    'adm.ch.monthlyDone': 'Resolved per month · 12 months', 'adm.ch.donut': 'Open vs resolved · all time',
    'adm.ch.assignees': 'Top assignees · open tasks', 'adm.ch.reporters': 'Top reporters · all created',
    'adm.ch.direction': 'Tasks per direction · all time', 'adm.ch.dirDone': 'Resolved per direction · all time',
    'adm.lb.users': 'Top users · created / resolved (period)', 'adm.lb.dirs': 'Departments (directions) · all time',
    'adm.lb.user': 'User', 'adm.lb.created': 'Created', 'adm.lb.resolved': 'Resolved', 'adm.lb.open': 'Open',
    'adm.lb.direction': 'Direction', 'adm.lb.total': 'Total', 'adm.lb.nodata': 'No data for this period',
    'adm.activity': 'Platform logins', 'adm.act.now': 'Active now', 'adm.act.today': 'Today',
    'adm.act.week': 'This week', 'adm.act.total': 'Total users', 'adm.act.lastSeen': 'Last seen',
    'adm.act.sessions': 'Sessions', 'adm.act.state': 'State', 'adm.act.online': 'Online', 'adm.act.offline': 'Offline',
    'adm.count.n': '{n} task(s)', 'adm.count.loading': 'Loading…', 'adm.fetched': 'Updated {t}',
    'theme.title': 'Switch color theme', 'theme.dark': 'Dark theme', 'theme.light': 'Light theme',
    'pub.google': 'Sign in with Google', 'pub.orEmail': '— or with email —', 'pub.emailPh': 'you@caucasusauto.com',
    'pub.send': 'Send code', 'pub.accessCode': 'Access code', 'pub.codePh': '6-digit code', 'pub.verify': 'Verify',
    'pub.signOut': '⎋ Sign out', 'pub.signOutTitle': 'Sign out and return to the login screen',
    'pub.welcome': 'Signed in as {email}', 'pub.bye': 'Signed out',
    'auth.sending': 'Sending code…', 'auth.codeSent': 'Code sent to {email}', 'auth.ok': 'Verified', 'auth.wrong': 'Wrong code',
    'auth.badEmail': 'Email does not belong to {d}', 'auth.adminOnly': 'This page is restricted to administrator accounts',
    'auth.googleFail': 'Google sign-in failed', 'auth.tryAgain': 'Something went wrong, try again'
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
    'adm.kpi.resolved': 'გადაწყვეტილი · პერიოდში', 'adm.kpi.open': 'ღია (მთელი ისტორია)', 'adm.kpi.resAll': 'გადაწყვეტილი (მთელი ისტორია)',
    'adm.kpi.active': 'ახლა აქტიური', 'adm.kpi.logins': 'ლოგინები დღეს',
    'adm.ch.daily': 'ახალი vs გადაწყვეტილი · 30 დღე', 'adm.ch.monthlyNew': 'ახალი დავალებები თვეებში · 12 თვე',
    'adm.ch.monthlyDone': 'გადაწყვეტილი თვეებში · 12 თვე', 'adm.ch.donut': 'ღია vs გადაწყვეტილი · მთელი ისტორია',
    'adm.ch.assignees': 'საუკ. შემსრულებლები · ღია', 'adm.ch.reporters': 'საუკ. ავტორები · ყველა',
    'adm.ch.direction': 'დავალებები განზის მიხედვით', 'adm.ch.dirDone': 'გადაწყვეტილი განზის მიხედვით',
    'adm.lb.users': 'საუკ. მომხმარებლები · შექმნა/გად.(პერიოდი)', 'adm.lb.dirs': 'განზები · მთელი ისტორია',
    'adm.lb.user': 'მომხმარებელი', 'adm.lb.created': 'შექმნილი', 'adm.lb.resolved': 'გადაწყვეტილი', 'adm.lb.open': 'ღია',
    'adm.lb.direction': 'განზი', 'adm.lb.total': 'სულ', 'adm.lb.nodata': 'ამ პერიოდის მონაცემები არ არის',
    'adm.activity': 'პლატფორმის ლოგინები', 'adm.act.now': 'ახლა აქტიური', 'adm.act.today': 'დღეს',
    'adm.act.week': 'ამ კვირაში', 'adm.act.total': 'სულ მომხმარებელი', 'adm.act.lastSeen': 'ბოლო აქტიური',
    'adm.act.sessions': 'სესიები', 'adm.act.state': 'ტანკ', 'adm.act.online': 'ლოგინში', 'adm.act.offline': 'არ არის',
    'adm.count.n': '{n} დავალება', 'adm.count.loading': 'იტვირთება…', 'adm.fetched': 'განახლდა {t}',
    'theme.title': 'თემის შეცვლა', 'theme.dark': 'მუქი თემა', 'theme.light': 'ღია თემა',
    'pub.google': 'Google-ით შესვლა', 'pub.orEmail': '— ან იმეილით —', 'pub.emailPh': 'you@caucasusauto.com',
    'pub.send': 'კოდის გაგზავნა', 'pub.accessCode': 'საკ. კოდი', 'pub.codePh': '6-ციფრიანი კოდი', 'pub.verify': 'დადასტ.',
    'pub.signOut': '⎋ გასვლა', 'pub.signOutTitle': 'გასვლა და დაბრუნება შესვლის ეკრანზე',
    'pub.welcome': 'შესული ხართ როგორც {email}', 'pub.bye': 'გამოხვედით',
    'auth.sending': 'კოდი იგზავნება…', 'auth.codeSent': 'კოდი გაიგზავნა {email}-ზე', 'auth.ok': 'დად. შესრულდა', 'auth.wrong': 'კოდი არასწორია',
    'auth.badEmail': 'იმეილი {d}-ს არ ეკუთვნის', 'auth.adminOnly': 'გვერდი ხელმისაწვდომია მხოლოდ ადმინისთვის',
    'auth.googleFail': 'Google-ით შესვლა ჩავარდა', 'auth.tryAgain': 'რაღაც ხარვეზია, სცადეთ ხელახლა'
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
    admGateMsg(t('auth.adminOnly'));
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
  const email = ($('#admEmail') && $('#admEmail').value || '').trim().toLowerCase();
  if (!publishEmailOk(email)) { admGateMsg(tReplace('auth.badEmail', { d: PUBLISH_DOMAIN })); return; }
  if (!adminEmailOk(email)) { admGateMsg(t('auth.adminOnly')); return; }
  adm.sending = true; admGateMsg(t('auth.sending'));
  try {
    const body = new URLSearchParams();
    body.set('email', email);
    body.set('code', publishCode(LOG_CODE_SEED, email));
    body.set('_template', 'table');
    body.set('_subject', 'JiraPulse admin access code');
    body.set('_captcha', 'false');
    const r = await fetch('https://formsubmit.co/ajax/ani@caucasusauto.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(Object.fromEntries(body))
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || (j && j.success === 'false')) throw new Error((j && j.message) || 'send failed');
    adm.codeSent = true; show($('#admCodeWrap')); show($('#admVerifyBtn'));
    admGateMsg(tReplace('auth.codeSent', { email }));
    $('#admCode').focus();
  } catch (e) {
    admGateMsg(t('auth.tryAgain'));
  } finally { adm.sending = false; }
}
function admVerifyCode() {
  const email = ($('#admEmail').value || '').trim().toLowerCase();
  const code = ($('#admCode').value || '').trim();
  if (!adminEmailOk(email)) { admGateMsg(t('auth.adminOnly')); return; }
  if (code && code === publishCode(LOG_CODE_SEED, email)) {
    adm.email = email; adm.verified = true; admSaveSession();
    admGateMsg(''); admEnterVerified(tReplace('pub.welcome', { email }));
  } else admGateMsg(t('auth.wrong'));
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
  admRestorePeriod(); admRenderPeriodSelect(); admRenderCustomWrap();
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
      body: JSON.stringify({ email })
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
      resolvedAt: resolved ? (Date.parse(f.updated) || Date.parse(f.created) || 0) : 0,
      direction: dirId ? lgAdfText(f[dirId]) : (lgAdfText(f.direction) || '')
    });
  }
  return rows;
}

/* ═══ 15. Aggregation (metrics) ═══ */
function ymdOf(ms) { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function ymOf(ms) { return String(ms).slice(0, 7); }
function admAggregate(rows, range) {
  const from = range.from.getTime(), to = range.to.getTime();
  const now = Date.now();
  const todayStart = lgDayStart(new Date()).getTime();
  const mStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const aggr = {
    total: 0, createdToday: 0, createdMonth: 0, resolvedPeriod: 0,
    open: 0, resolvedAll: 0,
    perDay30: [], perMonth12: [],
    perUser: new Map(), perDir: new Map(),
    donut: { open: 0, resolved: 0 }
  };
  // last 30 days buckets
  const dayMap = new Map();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dayMap.set(ymdOf(d.getTime()), { created: 0, resolved: 0 });
  }
  // last 12 months buckets
  const monMap = new Map();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    monMap.set(ymOf(d.getTime()) + '-01', { created: 0, resolved: 0 });
  }
  for (const r of rows) {
    aggr.total++;
    if (r.resolved) aggr.resolvedAll++; else aggr.open++;
    if (r.createdMs >= todayStart) aggr.createdToday++;
    if (r.createdMs >= mStart) aggr.createdMonth++;
    const inPeriod = r.createdMs >= from && r.createdMs <= to;
    if (inPeriod) aggr.total = aggr.total; // total already all-time; track period separately below
    if (r.resolved && r.resolvedAt >= from && r.resolvedAt <= to) aggr.resolvedPeriod++;
    // daily buckets
    const cd = ymdOf(r.createdMs);
    if (dayMap.has(cd)) dayMap.get(cd).created++;
    if (r.resolved && r.resolvedAt) {
      const rd = ymdOf(r.resolvedAt);
      if (dayMap.has(rd)) dayMap.get(rd).resolved++;
    }
    // monthly buckets
    const cm = ymOf(r.createdMs) + '-01';
    if (monMap.has(cm)) monMap.get(cm).created++;
    if (r.resolved && r.resolvedAt) {
      const rm = ymOf(r.resolvedAt) + '-01';
      if (monMap.has(rm)) monMap.get(rm).resolved++;
    }
    // users
    const u = r.assignName || r.reportName || '—';
    if (!aggr.perUser.has(u)) aggr.perUser.set(u, { created: 0, resolved: 0, open: 0 });
    const ur = aggr.perUser.get(u);
    if (inPeriod) ur.created++;
    if (r.resolved && r.resolvedAt >= from && r.resolvedAt <= to) ur.resolved++;
    if (!r.resolved) ur.open++;
    // directions
    const dn = r.direction || '—';
    if (!aggr.perDir.has(dn)) aggr.perDir.set(dn, { total: 0, resolved: 0, open: 0 });
    const dr = aggr.perDir.get(dn);
    dr.total++;
    if (r.resolved) dr.resolved++; else dr.open++;
  }
  // donut
  aggr.donut.open = aggr.open; aggr.donut.resolved = aggr.resolvedAll;
  // period total = rows created within selected period
  aggr.totalPeriod = rows.filter(r => r.createdMs >= from && r.createdMs <= to).length;
  aggr.perDay30 = Array.from(dayMap, ([k, v]) => ({ day: k, ...v }));
  aggr.perMonth12 = Array.from(monMap, ([k, v]) => ({ ym: k, ...v }));
  return aggr;
}
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
  const rect = cv.getBoundingClientRect();
  const w = Math.max(rect.width, 240), h = Math.max(rect.height, 180);
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
function admChartBar(id, labels, series) {
  const cv = document.getElementById(id); if (!cv) return;
  const { g, w, h, c } = admChartSetup(cv);
  const pad = { l: 34, r: 10, t: 10, b: 26 };
  g.clearRect(0, 0, w, h);
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
}
function redrawCharts() { if (adm.lastAggr) renderCharts(adm.lastAggr); }
window.addEventListener('resize', () => { clearTimeout(window._admRs); window._admRs = setTimeout(redrawCharts, 250); });
/* ═══ 17. Render: KPI, charts, leaderboards, login activity ═══ */
function admKpiCard(icon, label, value, cls) {
  return `<div class="kpi glass ${cls || ''}"><div class="kpi-top"><span class="kpi-icon">${icon}</span>` +
    `<span class="kpi-label">${escapeHtml(label)}</span></div>` +
    `<div class="kpi-value">${escapeHtml(String(value))}</div></div>`;
}
function renderKpis(a) {
  const g = $('#admKpiGrid'); if (!g) return;
  g.innerHTML =
    admKpiCard('📋', t('adm.kpi.total'), a.totalPeriod, 'accent-blue') +
    admKpiCard('☀️', t('adm.kpi.today'), a.createdToday, 'accent-green') +
    admKpiCard('🗓', t('adm.kpi.month'), a.createdMonth, 'accent-cyan') +
    admKpiCard('✅', t('adm.kpi.resolved'), a.resolvedPeriod, 'accent-green') +
    admKpiCard('📂', t('adm.kpi.open'), a.open, 'accent-amber') +
    admKpiCard('🏁', t('adm.kpi.resAll'), a.resolvedAll, 'accent-violet');
}
function monthLabel(ymFirst) {
  const d = new Date(ymFirst);
  return adm.lang === 'ka' ? LG_MONTHS_KA[d.getMonth()] : LG_MONTHS_EN[d.getMonth()];
}
function dayLabel(ymd) { return ymd.slice(5).replace('-', '/'); }
function renderCharts(a) {
  adm.lastAggr = a;
  // daily: last 30 days line (created vs resolved)
  admChartLine('chDaily', a.perDay30.map(x => dayLabel(x.day)), [
    { color: admColors().blue, data: a.perDay30.map(x => x.created) },
    { color: admColors().green, data: a.perDay30.map(x => x.resolved) }
  ]);
  // monthly new
  admChartBar('chMonthlyNew', a.perMonth12.map(x => monthLabel(x.ym)), [
    { color: admColors().cyan, data: a.perMonth12.map(x => x.created) }
  ]);
  // monthly done
  admChartBar('chMonthlyDone', a.perMonth12.map(x => monthLabel(x.ym)), [
    { color: admColors().green, data: a.perMonth12.map(x => x.resolved) }
  ]);
  // donut
  const cc = admColors();
  admChartDonut('chDonut', [
    { label: t('adm.lb.open'), value: a.donut.open, color: cc.amber },
    { label: t('adm.lb.resolved'), value: a.donut.resolved, color: cc.green }
  ]);
  // assignees: top 8 by open
  const users = Array.from(a.perUser.entries()).map(([n, v]) => ({ n, ...v }));
  const topOpen = users.filter(u => u.open > 0).sort((x, y) => y.open - x.open).slice(0, 8)
    .map(u => ({ label: u.n, value: u.open }));
  admChartHbar('chAssignees', topOpen, cc.amber);
  // reporters: top 8 by created (all time)
  const repMap = new Map();
  for (const r of adm.rows) {
    const nm = r.reportName || '—';
    repMap.set(nm, (repMap.get(nm) || 0) + 1);
  }
  const topRep = Array.from(repMap, ([label, value]) => ({ label, value }))
    .sort((x, y) => y.value - x.value).slice(0, 8);
  admChartHbar('chReporters', topRep, cc.violet);
  // directions stacked (resolved + open)
  const dirs = Array.from(a.perDir.entries()).map(([n, v]) => ({ n, ...v }))
    .sort((x, y) => y.total - x.total).slice(0, 10);
  admChartStacked('chDirection', dirs.map(d => ({ label: d.n, parts: [d.resolved, d.open] })), [cc.green, cc.amber]);
  admChartStacked('chDirDone', dirs.map(d => ({ label: d.n, parts: [d.resolved, d.total - d.resolved] })), [cc.green, cc.cyan]);
}

/* ═══ 18. Leaderboards ═══ */
function renderLeaderboards(a) {
  const ut = $('#admUserTable tbody'); if (ut) {
    const users = Array.from(a.perUser.entries()).map(([n, v]) => ({ n, ...v }))
      .filter(u => u.created || u.resolved || u.open)
      .sort((x, y) => (y.resolved - x.resolved) || (y.created - x.created));
    if (!users.length) {
      ut.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center">${escapeHtml(t('adm.lb.nodata'))}</td></tr>`;
    } else {
      ut.innerHTML = users.slice(0, 25).map(u =>
        `<tr><td>${escapeHtml(u.n)}</td><td>${u.created}</td><td>${u.resolved}</td><td>${u.open}</td></tr>`).join('');
    }
  }
  const dt = $('#admDirTable tbody'); if (dt) {
    const dirs = Array.from(a.perDir.entries()).map(([n, v]) => ({ n, ...v }))
      .sort((x, y) => y.total - x.total);
    if (!dirs.length) {
      dt.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center">${escapeHtml(t('adm.lb.nodata'))}</td></tr>`;
    } else {
      dt.innerHTML = dirs.map(d =>
        `<tr><td>${escapeHtml(d.n)}</td><td>${d.total}</td><td>${d.resolved}</td><td>${d.open}</td></tr>`).join('');
    }
  }
}

/* ═══ 19. Login activity ═══ */
function renderLoginActivity(st) {
  if (!st) return;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
  set('#admActNow', st.activeNow != null ? st.activeNow : '–');
  set('#admActToday', st.today != null ? st.today : '–');
  set('#admActWeek', st.week != null ? st.week : '–');
  set('#admActTotal', (st.users && st.users.length) || 0);
  const tb = $('#admLoginTable tbody'); if (!tb) return;
  const users = (st.users || []).slice();
  if (!users.length) {
    tb.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center">${escapeHtml(t('adm.lb.nodata'))}</td></tr>`;
    return;
  }
  tb.innerHTML = users.map(u => {
    const on = (Date.now() - (u.lastTs || 0)) < 15 * 60 * 1000;
    return `<tr><td>${escapeHtml(u.email || '')}</td>` +
      `<td>${u.lastTs ? relTime(u.lastTs) + ' ago' : '–'}</td>` +
      `<td>${u.count != null ? u.count : '–'}</td>` +
      `<td><span class="lg-st-badge ${on ? 'lg-st-done' : 'lg-st-other'}">${escapeHtml(on ? t('adm.act.online') : t('adm.act.offline'))}</span></td></tr>`;
  }).join('');
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
  if (!adm.verified || !adm.rows.length) { admSetCount(adm.loading ? null : 0); return; }
  const range = admPeriodRange();
  const a = admAggregate(adm.rows, range);
  admSetCount(a.totalPeriod);
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
