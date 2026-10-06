/* ═══════════════════════════════════════════════════════════════════════
   JiraPulse · Logistics Desk (logistics/app.js)

   A standalone mini-app that lives at /logistics/ alongside the main
   JiraPulse dashboard. It reuses the SAME auth system, theme, language,
   connection and session storage as the main app (same localStorage keys),
   but shows a filtered task list for ONE Service-Desk project (LOG):

     • gate: Google sign-in (org-domain restricted) + email one-time code
     • data: relay ?cmd=desk — all LOG issues EXCEPT label "Internal"
     • table: key↗ / title (summary) with description under it / status /
       assignee / registered / updated / logistics direction
     • global search + per-column filters + click-to-sort headers

   IMPORTANT: this file is intentionally standalone (reuse-by-copy). The
   main app.js self-boots its own DOM wiring with no null-guards, so it can
   NOT be shared via <script src>. Keep the copied helpers in sync manually.
   ═══════════════════════════════════════════════════════════════════════ */

'use strict';

/* ── tiny DOM helpers (copied from app.js) ─────────────────────────── */
const $ = (s) => document.querySelector(s);
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ── constants (same values as the main app) ───────────────────────── */
const PUB_RELAY = 'https://gensweaty--65df49bca6d911f19f231607ee4eb77e.web.val.run/';
const PUBLISH_DOMAIN = 'caucasusauto.com';   /* allowed email domain */
const GOOGLE_CLIENT_ID = '671098966570-21bp1aeud5o2glbjsliif3foi6n71gmh.apps.googleusercontent.com';

const JIRA_DOMAIN = 'caucasusauto.atlassian.net';   /* link base for issue keys */
const DESK_PROJECT = 'LOG';                          /* the Service-Desk project key */
const DESK_EXCLUDE_LABEL = 'internal';               /* case-insensitive exclusion */
const LOG_CODE_SEED = 'org';                         /* same code seed as the org publish */

/* shared localStorage keys — values sync automatically with the main app */
const LS_THEME = 'jp_theme_v1';
const LS_LANG = 'jp_lang_v1';
const LS_CONN = 'jp_conn_v1';
const LS_PUB_SESSION = 'jp_pub_session_v1';
const PUB_SESSION_TTL = 30 * 24 * 60 * 60 * 1000;   /* 30 days */

/* table tuning */
const LG_LIVE_TTL = 30 * 1000;    /* in-memory data cache */
const LG_MAX_ROWS = 1000;         /* rendered-row cap (filters still apply to all) */

/* ── state ─────────────────────────────────────────────────────────── */
let lgState = {
  email: '',
  verified: false,
  codeSent: false,
  rows: [],            /* normalized task rows */
  fieldIds: { direction: null, title: null },
  truncated: false,
  q: '',               /* global search text */
  filters: { status: '', reporter: '', assignee: '', direction: '' },
  sort: { col: 'created', dir: 'desc' },
  loading: false,
  cardKey: null,       /* task currently open in the detail card */
};
let _lgCache = null;   /* { data, ts } */
let toastTimer = null;

function toast(msg, type = 'info') {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast' + (type === 'ok' ? ' toast-ok' : type === 'err' ? ' toast-err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(t), 4200);
}

/* ── i18n · English + Georgian ─────────────────────────────────────── */
let LANG = 'en';
try { LANG = localStorage.getItem(LS_LANG) === 'ka' ? 'ka' : 'en'; } catch (_) {}

const I18N = {
  en: {
    /* shared keys used by the static markup (kept identical to the main app) */
    'settings.email': 'Email',
    'pub.google': 'Sign in with Google',
    'pub.orEmail': '— or with email —',
    'pub.send': 'Send code',
    'pub.accessCode': 'Access code',
    'pub.codePh': '6-digit code',
    'pub.verify': 'Verify',
    'pub.emailPh': 'you@caucasusauto.com',
    'pub.restricted': 'Access is restricted to @{d} accounts.',
    'pub.googleLoading': 'Google sign-in is still loading… try again in a few seconds.',
    'pub.googleFailed': 'Google sign-in could not start. Use your @{d} email instead.',
    'pub.signOut': '⎋ Sign out',
    'pub.signOutTitle': 'Sign out and return to the login screen',
    'pub.signedOut': 'Signed out — see you soon!',
    'pub.resendCode': 'Resend code',
    'pub.sending': 'Sending your code to {email}…',
    'pub.sentTo': 'Code sent to {email}. Check your inbox, then enter it below.',
    'pub.sendFailed': 'Could not email the code ({m}). Use Sign in with Google instead.',
    'pub.wrongCode': 'Wrong code. Please try again.',
    'pub.invalidEmail': 'Please enter a valid @{d} email.',
    'pub.activateFirst': 'First time for this email — FormSubmit has emailed an activation link to {email}. Click it, then press "Resend code".',
    'pub.deliverFailed': 'Could not deliver the code right now ({m}). Use Sign in with Google instead.',
    'theme.title': 'Switch color theme',
    'theme.dark': 'Dark theme',
    'theme.light': 'Light theme',
    'auth.sending': 'Sending…',
    /* logistics-specific keys */
    'lg.headTitle': 'Logistics desk',
    'lg.orgBadge': 'Logistics',
    'lg.toMain': 'Go to JiraPulse dashboards',
    'lg.title': 'Logistics desk',
    'lg.subtitle': 'Live LOG service-desk tasks · restricted to @caucasusauto.com',
    'lg.listTitle': 'LOG tasks',
    'lg.listSub': 'All service-desk requests · items labeled "Internal" are hidden',
    'lg.refresh': 'Refresh',
    'lg.refreshing': 'Refreshing…',
    'lg.updatedAt': 'Updated {t}',
    'lg.count': '{n} tasks',
    'lg.showing': 'Showing {n} of {total} — refine filters to see more',
    'lg.searchPh': 'Search tasks…',
    'lg.filterAll': 'All',
    'lg.th.key': 'Key',
    'lg.th.title': 'Title',
    'lg.th.status': 'Status',
    'lg.th.reporter': 'Reporter',
    'lg.th.assignee': 'Assignee',
    'lg.th.created': 'Registered',
    'lg.th.updated': 'Updated',
    'lg.th.direction': 'Logistics direction',
    'lg.th.comments': 'Comments',
    'lg.sortTitle': 'Click to sort',
    'lg.filterStatus': 'Filter by status',
    'lg.filterReporter': 'Filter by reporter',
    'lg.filterAssignee': 'Filter by assignee',
    'lg.filterDirection': 'Filter by direction',
    'lg.commentsCount': '{n} comments',
    'lg.truncated': 'Jira returned more tasks than can be synced — showing the newest.',
    'lg.loading': 'Loading tasks…',
    'lg.empty': 'No tasks match the current filters.',
    'lg.unassigned': 'Unassigned',
    'lg.card.noDescription': 'No description',
    'lg.card.noComments': 'No comments yet',
    'lg.card.close': 'Close',
    'lg.descLabel': 'Description',
    'lg.scrollLeft': 'Scroll left',
    'lg.scrollRight': 'Scroll right',
    'lg.errorLoad': 'Could not load LOG tasks ({m}).',
    'lg.errorNoCreds': 'No Jira credentials available for the relay. The admin must connect once from the main JiraPulse app (which stores relay creds), then reload this page.',
    'lg.footer': 'JiraPulse · Logistics desk — live Jira data, org-only access',
  },
  ka: {
    'settings.email': 'ელფოსტა',
    'pub.google': 'Google-ით შესვლა',
    'pub.orEmail': '— ან ელფოსტით —',
    'pub.send': 'კოდის გაგზავნა',
    'pub.accessCode': 'წვდომის კოდი',
    'pub.codePh': '6-ციფრიანი კოდი',
    'pub.verify': 'დადასტურება',
    'pub.emailPh': 'you@caucasusauto.com',
    'pub.restricted': 'წვდომა შეზღუდულია @{d} ანგარიშებზე.',
    'pub.googleLoading': 'Google-ით შესვლა ჯერ იტვირთება… სცადეთ რამდენიმე წამში.',
    'pub.googleFailed': 'Google-ით შესვლა ვერ დაიწყო. გამოიყენეთ თქვენი @{d} ფოსტა.',
    'pub.signOut': '⎋ გასვლა',
    'pub.signOutTitle': 'გასვლა და დაბრუნება შესვლის ეკრანზე',
    'pub.signedOut': 'გასულხართ სისტემიდან — ნახვამდის!',
    'pub.resendCode': 'კოდის ხელახლა გაგზავნა',
    'pub.sending': 'კოდი იგზავნება {email} მისამართზე…',
    'pub.sentTo': 'კოდი გაიგზავნა {email} მისამართზე. შეამოწმეთ შემომავალი და შეიყვანეთ ქვემოთ.',
    'pub.sendFailed': 'კოდის გაგზავნა ვერ მოხერხდა ({m}). გამოიყენეთ Google-ით შესვლა.',
    'pub.wrongCode': 'კოდი არასწორია. სცადეთ ხელახლა.',
    'pub.invalidEmail': 'გთხოვთ, შეიყვანეთ სწორი @{d} ფოსტა.',
    'pub.activateFirst': 'ეს ფოსტა პირველად გამოიყენება — FormSubmit-მა {email} მისამართზე გააქტივაციის ბმული გაგზავნა. დააჭირეთ მას და შემდეგ აირჩიეთ „კოდის ხელახლა გაგზავნა".',
    'pub.deliverFailed': 'კოდი ამჟამად ვერ მიეწოდა ({m}). გამოიყენეთ Google-ით შესვლა.',
    'theme.title': 'ფერის თემის გადამრთველი',
    'theme.dark': 'მუქი თემა',
    'theme.light': 'ღია თემა',
    'auth.sending': 'იგზავნება…',
    'lg.headTitle': 'ლოჯისტიკის დესკი',
    'lg.orgBadge': 'ლოჯისტიკა',
    'lg.toMain': 'JiraPulse დეშბორდებზე გადასვლა',
    'lg.title': 'ლოჯისტიკის დესკი',
    'lg.subtitle': 'ლოჯისტიკის სერვის-დესკის ამოცანები · მხოლოდ @caucasusauto.com-ისთვის',
    'lg.listTitle': 'LOG ამოცანები',
    'lg.listSub': 'სერვის-დესკის ყველა მოთხოვნა · „Internal" ლეიბლიანი ამოცანები დამალულია',
    'lg.refresh': 'განახლება',
    'lg.refreshing': 'განახლება…',
    'lg.updatedAt': 'განახლდა {t}',
    'lg.count': '{n} ამოცანა',
    'lg.showing': 'ნაჩვენებია {n} / {total} — შეავიწროვეთ ფილტრები დანარჩენის სანახავად',
    'lg.searchPh': 'ამოცანების ძებნა…',
    'lg.filterAll': 'ყველა',
    'lg.th.key': 'კოდი',
    'lg.th.title': 'დასახელება',
    'lg.th.status': 'სტატუსი',
    'lg.th.reporter': 'მომხსენებელი',
    'lg.th.assignee': 'აღმასრულებელი',
    'lg.th.created': 'რეგისტრაციის თარიღი',
    'lg.th.updated': 'ბოლო განახლება',
    'lg.th.direction': 'მიმართულება',
    'lg.th.comments': 'კომენტარები',
    'lg.sortTitle': 'დასალაგებლად დააჭირეთ',
    'lg.filterStatus': 'სტატუსით ფილტრი',
    'lg.filterReporter': 'მომხსენებლით ფილტრი',
    'lg.filterAssignee': 'აღმასრულებლით ფილტრი',
    'lg.filterDirection': 'მიმართულებით ფილტრი',
    'lg.commentsCount': '{n} კომენტარი',
    'lg.truncated': 'Jira-მა ამოცანების იმაზე მეტი დააბრუნა, რამდენის სინქრონიზაციაც შესაძლებელია — ნაჩვენებია უახლესი.',
    'lg.loading': 'ამოცანები იტვირთება…',
    'lg.empty': 'ფილტრებს ვერცერთი ამოცანა არ ემთხვევა.',
    'lg.unassigned': 'გაუნაწილებელი',
    'lg.card.noDescription': 'აღწერა არ არის',
    'lg.card.noComments': 'კომენტარები ჯერ არ არის',
    'lg.card.close': 'დახურვა',
    'lg.descLabel': 'აღწერა',
    'lg.scrollLeft': 'ჩამოსქროლე მარცხნივ',
    'lg.scrollRight': 'ჩამოსქროლე მარჯვნივ',
    'lg.errorLoad': 'LOG ამოცანების ჩატვირთვა ვერ მოხერხდა ({m}).',
    'lg.errorNoCreds': 'რელეისთვის Jira-ს ავტორიზაცია მიუწვდომელია. ადმინმა ერთხელ უნდა დაუკავშირდეს ძირითად JiraPulse აპლიკაციას (ინახავს relay-ის ავტორიზაციას) და შემდეგ გადატვირთოს ეს გვერდი.',
    'lg.footer': 'JiraPulse · ლოჯისტიკის დესკი — პირდაპირი Jira მონაცემები, მხოლოდ ორგანიზაციისთვის',
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

function tReplace(key, subs, fallback) {
  let s = t(key, fallback);
  for (const [k, v] of Object.entries(subs || {})) s = s.split('{' + k + '}').join(String(v));
  return s;
}

function applyI18n(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n')); });
  scope.querySelectorAll('[data-i18n-text]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n-text')); });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
}

function setLangButtons() {
  document.querySelectorAll('.lang-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === LANG);
  });
}

function setLang(lang) {
  LANG = (lang === 'ka') ? 'ka' : 'en';
  try { localStorage.setItem(LS_LANG, LANG); } catch (_) {}
  document.documentElement.setAttribute('lang', LANG === 'ka' ? 'ka' : 'en');
  applyI18n();
  setLangButtons();
  /* re-render dynamic surfaces so runtime strings follow the language */
  try {
    if (lgState.verified && lgState.rows.length) { lgBuildFilterBar(); lgRenderRows(); }
    if (lgState.cardKey) { lgRenderCard(); }   /* open card follows the language too */
  } catch { /* noop */ }
}

/* ── theme switcher (copied pattern from app.js) ───────────────────── */
let THEME = 'dark';
try { THEME = localStorage.getItem(LS_THEME) === 'light' ? 'light' : 'dark'; } catch (_) {}

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
}

/* ── org access (copied from app.js) ───────────────────────────────── */
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

function decodeJwt(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64);
    return JSON.parse(json);
  } catch { return null; }
}

function googleReady() {
  return typeof window.google !== 'undefined' && window.google.accounts && window.google.accounts.id;
}

/* ── viewer session (same key/shape as the main app) ─────────────────
   Signed in on one page → signed in on the other; 30-day TTL. */
function lgSaveSession(extra = {}) {
  try {
    if (!lgState.verified || !lgState.email) return;
    localStorage.setItem(LS_PUB_SESSION, JSON.stringify({
      email: lgState.email,
      ts: Date.now(),
      ...extra,
    }));
  } catch { /* storage unavailable — non-fatal */ }
}

function lgRestoreSession() {
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

function lgClearSession() {
  try { localStorage.removeItem(LS_PUB_SESSION); } catch { /* noop */ }
}

/* ── stored Jira connection (shared with the main app) ─────────────── */
function loadConn() {
  try {
    const raw = localStorage.getItem(LS_CONN);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c.domain || !c.email || !c.token) return null;
    return c;
  } catch (_) { return null; }
}

/* ── date formatting (copied + a datetime variant) ───────────────────
   Dates follow the active UI language (en / ka) so Georgian users see
   Georgian month names everywhere — table cells and the task card.
   Georgian month names are rendered manually because some Chromium
   builds ship without ka-GE ICU data (Intl silently falls back to en). */
const LG_MONTHS_KA = ['იან', 'თებ', 'მარ', 'აპრ', 'მაი', 'ივნ', 'ივლ', 'აგვ', 'სექ', 'ოქტ', 'ნოე', 'დეკ'];

function lgKaDate(d) {
  return `${d.getDate()} ${LG_MONTHS_KA[d.getMonth()]} ${d.getFullYear()}`;
}

function lgKaTime(d) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function lgParseDate(v) {
  if (!v) return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

function fmtDateLong(v) {
  const d = lgParseDate(v);
  if (!d) return '—';
  return LANG === 'ka' ? lgKaDate(d) : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(v) {
  const d = lgParseDate(v);
  if (!d) return '—';
  if (LANG === 'ka') return `${lgKaDate(d)} ${lgKaTime(d)}`;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/* ── status → semantic color bucket ──────────────────────────────────
   One bucket per workflow family; CSS gives each a colored pill. */
function lgStatusClass(status) {
  const s = String(status || '').toLowerCase();
  if (/^(done|closed|resolved|complete|completed|cancelled|canceled)/.test(s)) return 'lg-st-done';
  if (/^(in progress|in review|review|testing|qa|in development|reopened)/.test(s)) return 'lg-st-progress';
  if (/^(waiting|pending|blocked|hold|on hold|escalated|open|to do|backlog|new)/.test(s)) return 'lg-st-wait';
  return 'lg-st-other';
}

/* ── login gate rendering ──────────────────────────────────────────── */
function renderLgGate() {
  lgState.verified = false;
  lgState.email = '';
  lgState.codeSent = false;
  $('#lgEmail').value = '';
  $('#lgEmail').disabled = false;
  $('#lgEmail').placeholder = 'you@' + PUBLISH_DOMAIN;
  $('#lgCodeWrap').classList.add('hidden');
  $('#lgCode').value = '';
  $('#lgCode').disabled = false;
  $('#lgSendBtn').textContent = t('pub.send');
  $('#lgSendBtn').disabled = false;
  $('#lgVerifyBtn').textContent = t('pub.verify');
  $('#lgVerifyBtn').classList.add('hidden');
  $('#lgStatus').textContent = '';
  $('#lgStatus').className = 'muted';
  $('#lgContent').classList.add('hidden');
  $('#lgAuthBox').classList.remove('hidden');
  updateLgUserChip();
  /* re-render Google's official button — GSI wipes it when the gate was hidden */
  initGoogleButton();
}

/* verified path: hide the gate, show the task list, load data */
function lgEnterVerified() {
  hide($('#lgGate'));
  $('#lgAuthBox').classList.add('hidden');
  show($('#lgContent'));
  updateLgUserChip();
  lgLoad(false);
}

/* ── Google sign-in (copied pattern from app.js) ───────────────────── */
function handleGoogleCredential(resp) {
  const payload = decodeJwt(resp.credential);
  const email = (payload?.email || '').toLowerCase().trim();
  if (!publishEmailOk(email)) {
    $('#lgStatus').textContent = tReplace('pub.restricted', { d: PUBLISH_DOMAIN });
    $('#lgStatus').className = 'error';
    return;
  }
  lgState.email = email;
  lgState.verified = true;
  lgSaveSession();
  /* no "verified · loading" message — the task list appearing IS the feedback */
  lgEnterVerified();
}

/* render Google's official sign-in button over our placeholder. The GSI
   script loads with `async`, so poll until ready (same as the main app). */
function initGoogleButton() {
  const container = $('#lgGoogleBtn');
  if (!container || !GOOGLE_CLIENT_ID) return;

  let polls = 0;
  const timer = setInterval(() => {
    polls++;
    if (!googleReady()) {
      if (polls === 1) {
        container.addEventListener('click', () => {
          $('#lgStatus').textContent = t('pub.googleLoading');
          $('#lgStatus').className = 'warn';
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
      container.innerHTML = '';
      window.google.accounts.id.renderButton(container, {
        theme: 'outline',
        size: 'large',
        width: 280,
        text: 'continue_with',
        logo_alignment: 'center',
      });
    } catch (e) {
      $('#lgStatus').textContent = tReplace('pub.googleFailed', { d: PUBLISH_DOMAIN });
      $('#lgStatus').className = 'error';
    }
  }, 200);
}

/* ── email one-time code (copied pattern from app.js) ────────────────
   Same code derivation (seed 'org' + email) as the main org publish, so a
   user's Logistics code equals their JiraPulse code. FormSubmit emails it. */
async function lgSendCode() {
  const email = $('#lgEmail').value.trim();
  if (!publishEmailOk(email)) {
    $('#lgStatus').textContent = tReplace('pub.invalidEmail', { d: PUBLISH_DOMAIN });
    $('#lgStatus').className = 'error';
    return;
  }
  lgState.email = email;
  const code = publishCode(LOG_CODE_SEED, email);
  lgState.codeSent = true;

  const btn = $('#lgSendBtn');
  btn.disabled = true;
  btn.textContent = t('auth.sending');
  $('#lgStatus').textContent = tReplace('pub.sending', { email });
  $('#lgStatus').className = 'muted';

  const recipient = email;
  const subject = 'Your JiraPulse Logistics access code';
  const body =
    'Hello,\n\n' +
    'Your one-time access code for JiraPulse Logistics (LOG service desk) is:\n\n' +
    code + '\n\n' +
    'Enter it on the Logistics page to view the task list.\n\n' +
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
    if (data && data.success === false) {
      const reason = data.message || 'the email service needs confirmation';
      const activating = /activat/i.test(reason);
      $('#lgStatus').textContent = activating
        ? tReplace('pub.activateFirst', { email })
        : tReplace('pub.deliverFailed', { m: reason });
      $('#lgStatus').className = activating ? 'warn' : 'error';
      $('#lgCodeWrap').classList.remove('hidden');
      $('#lgVerifyBtn').classList.remove('hidden');
      $('#lgSendBtn').textContent = t('pub.resendCode');
      return;
    }
    $('#lgStatus').textContent = tReplace('pub.sentTo', { email });
    $('#lgStatus').className = 'ok';
    $('#lgCodeWrap').classList.remove('hidden');
    $('#lgVerifyBtn').classList.remove('hidden');
    $('#lgSendBtn').textContent = t('pub.resendCode');
  } catch (e) {
    $('#lgStatus').textContent = tReplace('pub.sendFailed', { m: e.message });
    $('#lgStatus').className = 'error';
  } finally {
    btn.disabled = false;
    if (!btn.textContent.startsWith('Resend') && !btn.textContent.startsWith('კოდის ხელახლა')) btn.textContent = t('pub.send');
  }
}

function lgVerifyCode() {
  const entered = $('#lgCode').value.trim();
  const expected = publishCode(LOG_CODE_SEED, lgState.email);
  if (entered === expected) {
    lgState.verified = true;
    lgSaveSession();
    /* success = the task list appearing; the status line stays for errors */
    lgEnterVerified();
  } else {
    $('#lgStatus').textContent = t('pub.wrongCode');
    $('#lgStatus').className = 'error';
  }
}

/* ── topbar identity chip + sign-out (copied pattern from app.js) ──── */
function updateLgUserChip() {
  const chip = $('#lgUserChip');
  if (!chip) return;
  const email = lgState.email || '';
  if (!lgState.verified || !email) {
    chip.classList.add('hidden');
    return;
  }
  const name = String(email).split('@')[0] || '?';
  const avatar = $('#lgUserAvatar');
  avatar.textContent = name.charAt(0).toUpperCase();
  $('#lgUserName').textContent = email;
  chip.title = email;
  chip.classList.remove('hidden');
}

function toggleLgSignOut(ev) {
  if (ev) ev.stopPropagation();
  const chip = $('#lgUserChip');
  const menu = $('#lgSignOutBtn');
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

function closeLgSignOut() {
  const chip = $('#lgUserChip');
  const menu = $('#lgSignOutBtn');
  if (menu) menu.classList.add('hidden');
  if (chip) chip.classList.remove('signout-open');
}

function lgSignOut() {
  closeLgSignOut();
  lgState.verified = false;
  lgState.email = '';
  lgState.codeSent = false;
  lgState.rows = [];
  lgState.q = '';
  lgState.filters = { status: '', assignee: '', direction: '' };
  lgState.sort = { col: 'created', dir: 'desc' };
  _lgCache = null;
  lgClearSession();   /* forget the persisted viewer session */
  /* let Google forget the chosen account so the next sign-in shows the chooser */
  if (googleReady()) {
    try { window.google.accounts.id.disableAutoSelect(); } catch { /* noop */ }
  }
  renderLgGate();
  show($('#lgGate'));
  toast(t('pub.signedOut'), 'ok');
}

/* ── data layer: relay ?cmd=desk ─────────────────────────────────────
   Viewer with their own Jira connection forwards Basic auth (their creds,
   zero stored secrets); otherwise the relay falls back to the admin's
   stored creds. All LOG issues except label "Internal" come back. */
async function lgFetchDesk(force = false) {
  if (!force && _lgCache && Date.now() - _lgCache.ts < LG_LIVE_TTL) return _lgCache.data;
  const conn = loadConn();
  const domain = conn?.domain ? String(conn.domain).replace(/^https?:\/\//, '') : JIRA_DOMAIN;
  const url = PUB_RELAY + '?cmd=desk&project=' + encodeURIComponent(DESK_PROJECT) +
    '&domain=' + encodeURIComponent(domain);
  const headers = { 'Accept': 'application/json' };
  if (conn) headers['Authorization'] = 'Basic ' + btoa(conn.email + ':' + conn.token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch (_) { /* non-json */ }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.detail)) || `Desk fetch failed (HTTP ${res.status})`);
      err.status = res.status;
      throw err;
    }
    _lgCache = { data, ts: Date.now() };
    return data;   /* { ok, cmd:'desk', project, count, fetchedAt, fieldIds, issues } */
  } finally {
    clearTimeout(timer);
  }
}

/* normalize a Jira custom-field value to a display string
   (handles plain values, Jira objects, arrays and cascading selects —
   cascading shows "Parent / Child" like Jira's own display) */
function lgNormCustom(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && !Array.isArray(v)) {
    if (v.value != null || v.child != null) {
      const parent = v.value != null ? String(v.value) : '';
      const child = v.child ? lgNormCustom(v.child) : '';
      return child ? (parent + ' / ' + child) : parent;
    }
    return String(v.value ?? v.name ?? v.displayName ?? '');
  }
  if (Array.isArray(v)) return v.map(lgNormCustom).filter(Boolean).join(', ');
  return '';
}

/* Jira ADF (Atlassian Document Format) → plain text, one line per block */
function lgAdfText(doc) {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc;
  if (Array.isArray(doc)) return doc.map(lgAdfText).filter(Boolean).join('\n');
  if (typeof doc !== 'object') return '';
  let text = '';
  if (Array.isArray(doc.content)) text = lgAdfText(doc.content);
  else if (doc.text != null) text = String(doc.text);
  /* paragraph-level nodes get a newline after them for readability */
  if (doc.type === 'paragraph' || doc.type === 'heading' || doc.type === 'bulletList' ||
      doc.type === 'orderedList' || doc.type === 'codeBlock' || doc.type === 'blockquote') {
    return text ? text + '\n' : '';
  }
  return text;
}

/* first line(s) of the description for the compact table cell */
function lgDescPreview(raw) {
  const full = lgAdfText(raw).replace(/\r/g, '');
  if (!full.trim()) return { one: '', full: '' };
  const lines = full.split('\n').map((s) => s.trim()).filter(Boolean);
  return { one: lines[0] || '', full: lines.join('\n') };
}

/* relay issues → flat display rows (with defense-in-depth Internal filter) */
function lgNormalize(data) {
  const dirId = data.fieldIds?.direction || null;
  const rows = [];
  for (const iss of (data.issues || [])) {
    const f = iss.fields || {};
    const labels = (f.labels || []).map(String);
    if (labels.some((l) => l.toLowerCase() === DESK_EXCLUDE_LABEL)) continue;

    const direction = dirId ? lgNormCustom(f[dirId]) : '';
    const desc = lgDescPreview(f.description);

    /* comments come pre-slimmed from the relay: last 3, plain-text bodies */
    const rawComments = Array.isArray(f.comment) ? f.comment : [];
    const comments = rawComments.map((c) => ({
      author: String(c?.author || ''),
      created: c?.created ? Date.parse(c.created) : 0,
      body: String(c?.body || '').replace(/\r/g, '').trim(),
    })).filter((c) => c.body);

    const num = parseInt(String(iss.key).split('-')[1], 10) || 0;
    rows.push({
      key: iss.key,
      num,
      href: 'https://' + JIRA_DOMAIN + '/browse/' + encodeURIComponent(iss.key),
      summary: f.summary || '',
      descOne: desc.one,
      descFull: desc.full,
      status: f.status?.name || '',
      reporter: f.reporter?.displayName || '',
      assignee: f.assignee?.displayName || '',
      created: f.created ? Date.parse(f.created) : 0,
      updated: f.updated ? Date.parse(f.updated) : 0,
      direction,
      comments,
    });
  }
  return rows;
}

/* ── table engine: filters + sort + render ─────────────────────────── */
function lgDistinct(col) {
  const s = new Set();
  lgState.rows.forEach((r) => { if (r[col]) s.add(r[col]); });
  return [...s].sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
}

/* per-column dropdowns: status / reporter / assignee / direction */
function lgBuildFilterBar() {
  const bar = $('#lgFilterBar');
  if (!bar) return;
  const mk = (id, col, labelKey) => {
    const opts = lgDistinct(col).map((v) =>
      `<option value="${escapeHtml(v)}"${lgState.filters[col] === v ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
    return `<select id="${id}" class="input tl-select" data-col="${col}" title="${escapeHtml(t(labelKey))}">` +
      `<option value="">${escapeHtml(t('lg.filterAll'))}</option>${opts}</select>`;
  };
  bar.innerHTML =
    mk('lgFStatus', 'status', 'lg.filterStatus') +
    mk('lgFReporter', 'reporter', 'lg.filterReporter') +
    mk('lgFAssignee', 'assignee', 'lg.filterAssignee') +
    mk('lgFDir', 'direction', 'lg.filterDirection');
  bar.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', () => {
      lgState.filters[sel.dataset.col] = sel.value;
      lgRenderRows();
    });
  });
}

/* global search + per-column filters + sort → filtered row array */
function lgFiltered() {
  const q = lgState.q.trim().toLowerCase();
  const rows = lgState.rows.filter((r) => {
    if (lgState.filters.status && r.status !== lgState.filters.status) return false;
    if (lgState.filters.reporter && r.reporter !== lgState.filters.reporter) return false;
    if (lgState.filters.assignee && r.assignee !== lgState.filters.assignee) return false;
    if (lgState.filters.direction && r.direction !== lgState.filters.direction) return false;
    if (!q) return true;
    const hay = [
      r.key, r.summary, r.descFull, r.status, r.reporter, r.assignee, r.direction,
      r.comments.map((c) => c.author + ' ' + c.body).join(' '),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
  const { col, dir } = lgState.sort;
  const mul = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    let r;
    if (col === 'created' || col === 'updated') r = (a[col] || 0) - (b[col] || 0);
    else if (col === 'key') r = a.num - b.num;   /* LOG-123 → 123 */
    else if (col === 'comments') r = a.comments.length - b.comments.length;
    else r = String(a[col] || '').localeCompare(String(b[col] || ''), undefined, { sensitivity: 'base' });
    return r * mul;
  });
  return rows;
}

function lgRowHtml(r) {
  /* key + title open the in-app task card instead of navigating to Jira */
  const keyLink = `<a href="#" class="lg-open-card" data-key="${escapeHtml(r.key)}" title="${escapeHtml(r.summary)}">` +
    `${escapeHtml(r.key)}<span class="ilist-ext" aria-hidden="true">⤢</span></a>`;
  const direction = r.direction
    ? `<div class="lg-dir-text">${escapeHtml(r.direction)}</div>`
    : '<span class="muted">—</span>';
  /* Title cell: task title (summary) with the description line under it */
  const descHtml = r.descOne
    ? `<div class="lg-desc" ${r.descFull !== r.descOne ? `title="${escapeHtml(r.descFull)}"` : ''}>${escapeHtml(r.descOne)}</div>`
    : '';
  /* people columns: plain names — reporter and assignee each in their own cell */
  const reporterHtml = r.reporter
    ? escapeHtml(r.reporter)
    : `<span class="lg-unassigned">${escapeHtml(t('lg.unassigned'))}</span>`;
  const assigneeHtml = r.assignee
    ? escapeHtml(r.assignee)
    : `<span class="lg-unassigned">${escapeHtml(t('lg.unassigned'))}</span>`;
  /* comments: synced from Jira — stacked preview, full text on hover */
  const commentsHtml = r.comments.length
    ? `<div class="lg-comments" title="${escapeHtml(r.comments.map((c) => (c.author ? c.author + ': ' : '') + c.body).join('\n———\n'))}">` +
      r.comments.map((c) =>
        `<div class="lg-comment"><span class="lg-comment-author">${escapeHtml(c.author || '—')}</span>` +
        `<span class="lg-comment-body">${escapeHtml(c.body.length > 90 ? c.body.slice(0, 90) + '…' : c.body)}</span></div>`
      ).join('') +
      `</div>`
    : '<span class="muted">—</span>';
  return `<tr>
    <td class="lg-nowrap lg-key-cell">${keyLink}</td>
    <td class="lg-title-cell">
      <div class="lg-task-title"><a href="#" class="lg-open-card lg-title-link" data-key="${escapeHtml(r.key)}">${escapeHtml(r.summary || '—')}</a></div>${descHtml}
    </td>
    <td><span class="status-pill ${lgStatusClass(r.status)}">${escapeHtml(r.status || '—')}</span></td>
    <td class="lg-reporter-cell">${reporterHtml}</td>
    <td class="lg-assignee-cell">${assigneeHtml}</td>
    <td class="muted lg-nowrap lg-date-cell">${fmtDateLong(r.created)}</td>
    <td class="muted lg-nowrap lg-date-cell">${fmtDateLong(r.updated)}</td>
    <td class="lg-direction-cell">${direction}</td>
    <td class="lg-comments-cell">${commentsHtml}</td>
  </tr>`;
}

function lgRenderRows() {
  const all = lgFiltered();
  const rows = all.slice(0, LG_MAX_ROWS);
  $('#lgTbody').innerHTML = rows.length
    ? rows.map(lgRowHtml).join('')
    : `<tr><td colspan="9" class="muted" style="text-align:center;padding:22px">${escapeHtml(t('lg.empty'))}</td></tr>`;
  $('#lgCount').textContent = tReplace('lg.count', { n: all.length });
  $('#lgShowing').textContent = all.length > rows.length
    ? tReplace('lg.showing', { n: rows.length, total: all.length })
    : '';
  /* sort carets on the active column */
  document.querySelectorAll('#lgContent thead th[data-col]').forEach((th) => {
    const active = th.dataset.col === lgState.sort.col;
    th.classList.toggle('lg-sorted', active);
    th.setAttribute('data-sort', active ? lgState.sort.dir : '');
  });
  /* keep the open card in sync with fresh data (e.g. after Refresh) */
  if (lgState.cardKey) {
    const still = all.some((r) => r.key === lgState.cardKey) || lgState.rows.some((r) => r.key === lgState.cardKey);
    if (still) lgRenderCard(); else lgCloseCard();
  }
}

/* ── task card: Jira-style full detail popup, rendered in-app ────────────
   Opens from the task key or title click. Never navigates to Jira — all
   data comes from the synced rows (relay), so it also works offline. */
function lgFindTask(key) {
  return lgState.rows.find((r) => r.key === key) || null;
}

function lgOpenCard(key) {
  const task = lgFindTask(key);
  if (!task) return;
  lgState.cardKey = key;
  lgRenderCard();
  show($('#lgCardOverlay'));
  $('#lgCardClose').focus();
}

function lgCloseCard() {
  lgState.cardKey = null;
  hide($('#lgCardOverlay'));
}

function lgRenderCard() {
  const r = lgFindTask(lgState.cardKey);
  if (!r) return;

  const statusPill = `<span class="status-pill ${lgStatusClass(r.status)}">${escapeHtml(r.status || '—')}</span>`;

  const personBlock = (roleKey, name, unassigned) => {
    const val = name
      ? escapeHtml(name)
      : `<span class="lg-unassigned">${escapeHtml(t('lg.unassigned'))}</span>`;
    return `<div class="lg-card-person">
      <span class="lg-person-role" data-i18n="${roleKey}">${escapeHtml(t(roleKey))}</span>
      <span class="lg-card-person-name${name ? '' : ' lg-unassigned'}">${val}</span>
    </div>`;
  };

  const metaItem = (labelKey, value) =>
    `<div class="lg-card-meta-item">
      <span class="lg-person-role" data-i18n="${labelKey}">${escapeHtml(t(labelKey))}</span>
      <span>${value}</span>
    </div>`;

  const commentsHtml = r.comments.length
    ? r.comments.map((c) =>
        `<div class="lg-card-comment">
          <div class="lg-card-comment-head">
            <span class="lg-comment-author">${escapeHtml(c.author || '—')}</span>
            <span class="lg-card-comment-date">${fmtDateTime(c.created)}</span>
          </div>
          <div class="lg-card-comment-body">${escapeHtml(c.body)}</div>
        </div>`
      ).join('')
    : `<div class="muted">${escapeHtml(t('lg.card.noComments'))}</div>`;

  $('#lgCardBody').innerHTML = `
    <div class="lg-card-top">
      ${statusPill}
      <span class="lg-card-key">${escapeHtml(r.key)}</span>
    </div>
    <h3 class="lg-card-title">${escapeHtml(r.summary || '—')}</h3>
    <div class="lg-card-people">
      ${personBlock('lg.th.reporter', r.reporter, false)}
      ${personBlock('lg.th.assignee', r.assignee, true)}
    </div>
    <div class="lg-card-meta">
      ${metaItem('lg.th.created', fmtDateTime(r.created))}
      ${metaItem('lg.th.updated', fmtDateTime(r.updated))}
      ${r.direction ? metaItem('lg.th.direction', escapeHtml(r.direction)) : ''}
    </div>
    <div class="lg-card-section">
      <span class="lg-person-role" data-i18n="lg.descLabel">${escapeHtml(t('lg.descLabel') || 'Description')}</span>
      <div class="lg-card-desc">${r.descFull
        ? escapeHtml(r.descFull)
        : `<span class="muted">${escapeHtml(t('lg.card.noDescription'))}</span>`}</div>
    </div>
    <div class="lg-card-section">
      <span class="lg-person-role" data-i18n="lg.th.comments">${escapeHtml(t('lg.th.comments'))}</span>
      <div class="lg-card-comments">${commentsHtml}</div>
    </div>`;
}

/* ── load pipeline ─────────────────────────────────────────────────── */
async function lgLoad(force) {
  if (lgState.loading) return;
  lgState.loading = true;
  hide($('#lgError'));
  const btn = $('#lgRefreshBtn');
  const label = btn.querySelector('span');
  if (label) label.textContent = t('lg.refreshing');
  btn.disabled = true;
  try {
    const data = await lgFetchDesk(force);
    lgState.rows = lgNormalize(data);
    lgState.fieldIds = data.fieldIds || { direction: null };
    lgState.truncated = !!data.truncated;
    $('#lgFetchedAt').textContent = tReplace('lg.updatedAt', { t: fmtDateTime(data.fetchedAt) }) +
      (lgState.truncated ? ' · ⚠ ' + t('lg.truncated') : '');
    lgBuildFilterBar();
    lgRenderRows();
  } catch (e) {
    $('#lgError').textContent = e?.status === 401
      ? t('lg.errorNoCreds')
      : tReplace('lg.errorLoad', { m: e?.message || 'error' });
    show($('#lgError'));
  } finally {
    lgState.loading = false;
    if (label) label.textContent = t('lg.refresh');
    btn.disabled = false;
  }
}

/* ── boot ──────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  applyThemeClass();
  setLangButtons();
  applyI18n();

  /* topbar switches (same persistence as the main app) */
  document.querySelectorAll('.theme-btn').forEach((b) => {
    b.addEventListener('click', () => setTheme(b.dataset.theme));
  });
  document.querySelectorAll('.lang-btn').forEach((b) => {
    b.addEventListener('click', () => setLang(b.dataset.lang));
  });

  /* auth wiring */
  $('#lgSendBtn').addEventListener('click', lgSendCode);
  $('#lgVerifyBtn').addEventListener('click', lgVerifyCode);
  $('#lgEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') lgSendCode(); });
  $('#lgCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') lgVerifyCode(); });

  /* content wiring */
  $('#lgRefreshBtn').addEventListener('click', () => lgLoad(true));
  $('#lgBrandBtn').addEventListener('click', () => { location.href = '../'; });
  $('#lgBrandBtn').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') location.href = '../'; });

  /* global search (debounced like the main task list) */
  let deb;
  $('#lgSearch').addEventListener('input', (e) => {
    clearTimeout(deb);
    deb = setTimeout(() => { lgState.q = e.target.value; lgRenderRows(); }, 250);
  });

  /* click-to-sort headers */
  document.querySelectorAll('#lgContent thead th[data-col]').forEach((th) => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (lgState.sort.col === col) {
        lgState.sort.dir = lgState.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        lgState.sort = { col, dir: (col === 'created' || col === 'updated' || col === 'key') ? 'desc' : 'asc' };
      }
      lgRenderRows();
    });
  });

  /* task card: open from key/title clicks (delegated), close on button,
     overlay click or Escape — never navigates to Jira */
  $('#lgTbody').addEventListener('click', (e) => {
    const link = e.target.closest('.lg-open-card');
    if (!link) return;
    e.preventDefault();
    lgOpenCard(link.dataset.key);
  });
  $('#lgCardClose').addEventListener('click', lgCloseCard);
  $('#lgCardOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) lgCloseCard(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && lgState.cardKey) lgCloseCard(); });

  /* horizontal scroll controls: buttons nudge the table, edge buttons and
     scrollbar visibility follow the scroll position */
  const scroller = $('#lgTableScroll');
  const updateScrollBtns = () => {
    const max = scroller.scrollWidth - scroller.clientWidth;
    $('#lgScrollLeft').classList.toggle('lg-scroll-hidden', scroller.scrollLeft <= 4);
    $('#lgScrollRight').classList.toggle('lg-scroll-hidden', scroller.scrollLeft >= max - 4);
  };
  $('#lgScrollLeft').addEventListener('click', () => {
    scroller.scrollBy({ left: -Math.round(scroller.clientWidth * 0.7), behavior: 'smooth' });
  });
  $('#lgScrollRight').addEventListener('click', () => {
    scroller.scrollBy({ left: Math.round(scroller.clientWidth * 0.7), behavior: 'smooth' });
  });
  scroller.addEventListener('scroll', updateScrollBtns, { passive: true });
  window.addEventListener('resize', updateScrollBtns, { passive: true });
  setInterval(updateScrollBtns, 1200);   /* rows re-render changes scrollWidth */
  updateScrollBtns();

  /* identity chip + sign-out */
  $('#lgUserChip').addEventListener('click', toggleLgSignOut);
  $('#lgSignOutBtn').addEventListener('click', (e) => { e.stopPropagation(); lgSignOut(); });
  document.addEventListener('click', closeLgSignOut);

  /* session restore skips the login gate (shared with the main app) */
  const s = lgRestoreSession();
  if (s) {
    lgState.email = s.email;
    lgState.verified = true;
    lgEnterVerified();
  } else {
    renderLgGate();
  }
});
