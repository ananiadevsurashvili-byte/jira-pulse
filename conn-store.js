/**
 * JiraPulse — shared Jira connection storage (every page: pub, /admin/, /csp/,
 * /csp/admin/, /logistics/, /logistics/admin/, /fines/, /fines/admin/).
 *
 * Regression B (18 Nov 2026 security review): the pages used to read the
 * Jira API token straight out of `jp_conn_v1` in localStorage. After review
 * finding 6 moved the token into sessionStorage (`jp_jira_token_v1`) in the
 * root app, every other page still expected it inside the localStorage blob
 * and silently dropped the connection (cross-page sign-in mismatch).
 *
 * This module is the single source of truth:
 *   - localStorage  `jp_conn_v1`     → domain, email, non-sensitive prefs
 *   - sessionStorage `jp_jira_token_v1` → the API token (cleared when the
 *     browser tab/session ends; never readable across sessions)
 * Legacy layouts (token inside jp_conn_v1) are migrated on first load.
 */
(function () {
  'use strict';
  var LS_CONN = 'jp_conn_v1';
  var SS_TOKEN = 'jp_jira_token_v1';

  function load() {
    try {
      var raw = localStorage.getItem(LS_CONN);
      if (!raw) return null;
      var c = JSON.parse(raw);
      if (!c) return null;
      /* one-time migration from the pre-hardening layout that stored the
         token inside LS_CONN */
      if (c.token) {
        try { sessionStorage.setItem(SS_TOKEN, String(c.token)); } catch (_) { /* noop */ }
        delete c.token;
        try { localStorage.setItem(LS_CONN, JSON.stringify(c)); } catch (_) { /* noop */ }
      }
      var token = '';
      try { token = sessionStorage.getItem(SS_TOKEN) || ''; } catch (_) { /* noop */ }
      if (!c.domain || !c.email || !token) return null;
      var out = Object.assign({}, c, { token: token });
      return out;
    } catch (_) { return null; }
  }

  function save(conn) {
    try {
      var c = Object.assign({}, conn || {});
      var token = c.token;
      delete c.token;
      localStorage.setItem(LS_CONN, JSON.stringify(c));
      if (token) sessionStorage.setItem(SS_TOKEN, String(token));
      else sessionStorage.removeItem(SS_TOKEN);
    } catch (_) { /* storage unavailable — non-fatal */ }
  }

  function clear() {
    try { localStorage.removeItem(LS_CONN); } catch (_) { /* noop */ }
    try { sessionStorage.removeItem(SS_TOKEN); } catch (_) { /* noop */ }
  }

  window.JPConnStore = { load: load, save: save, clear: clear };
})();
