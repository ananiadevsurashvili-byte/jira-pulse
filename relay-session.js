/**
 * JiraPulse — shared relay session client (every page).
 *
 * The relay now owns org authentication (18 Nov 2026 review, Phase 2):
 *   - Google sign-in: the browser forwards the Google ID token to the relay
 *     (?cmd=auth:google), which verifies it SERVER-SIDE against Google's
 *     JWKS before minting a session.
 *   - Email codes: the relay generates a RANDOM one-time code and emails it
 *     server-side; the browser only submits the code back
 *     (?cmd=auth:email-start / ?cmd=auth:email-verify). The old
 *     deterministic code the page bundle could compute for any address is
 *     gone.
 *   - Sessions: opaque tokens (x-jp-session header). Stored in
 *     sessionStorage — cleared automatically when the browser tab/session
 *     ends, same hardening as the Jira token and the publish-admin token.
 *   - The ADMIN ROLE comes from the relay (whoami.admin), never from a
 *     client-side email list.
 *
 * All page bundles call this module instead of implementing the flows
 * themselves.
 */
(function () {
  'use strict';
  var SS_SESSION = 'jp_session_v1';

  function get() {
    try {
      var raw = sessionStorage.getItem(SS_SESSION);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.token || !s.email) return null;
      return s;
    } catch (_) { return null; }
  }

  function save(rec) {
    try {
      sessionStorage.setItem(SS_SESSION, JSON.stringify({
        token: String(rec.sessionToken || ''),
        email: String(rec.email || '').toLowerCase(),
        admin: rec.admin === true,
        ts: Date.now(),
      }));
    } catch (_) { /* non-fatal */ }
  }

  function clear() {
    try { sessionStorage.removeItem(SS_SESSION); } catch (_) { /* noop */ }
  }

  /* headers for any relay call an authenticated viewer makes */
  function headers(extra) {
    var s = get();
    var h = Object.assign({}, extra || {});
    if (s && s.token) h['x-jp-session'] = s.token;
    return h;
  }

  function signedIn() {
    var s = get();
    return !!(s && s.token && s.email);
  }

  function isAdmin() {
    var s = get();
    return !!(s && s.admin === true);
  }

  function request(relayUrl, cmd, opts) {
    opts = opts || {};
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs || 25000);
    return fetch(relayUrl + '?cmd=' + encodeURIComponent(cmd), {
      method: opts.method || 'GET',
      headers: Object.assign({ 'Accept': 'application/json' }, headers(opts.auth !== false ? {} : {}), opts.extraHeaders || {}),
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    }).finally(function () { clearTimeout(timer); });
  }

  /* POST the Google ID token; the relay verifies it and mints the session */
  async function signInGoogle(relayUrl, credential) {
    var res = await request(relayUrl, 'auth:google', {
      method: 'POST', body: { credential: credential },
    });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok || !data || !data.sessionToken) {
      throw new Error((data && data.error) || ('Google sign-in failed (HTTP ' + res.status + ')'));
    }
    save(data);
    return data;
  }

  /* The relay generates + emails a random code (server-side FormSubmit) */
  async function sendEmailCode(relayUrl, email) {
    var res = await request(relayUrl, 'auth:email-start', {
      method: 'POST', body: { email: email },
    });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok || !data || data.ok !== true) {
      var err = new Error((data && data.error) || ('could not send the code (HTTP ' + res.status + ')'));
      err.activating = !!(data && data.activating);
      throw err;
    }
    return data;
  }

  /* Submit the code; on success a session is minted + stored */
  async function verifyEmailCode(relayUrl, email, code) {
    var res = await request(relayUrl, 'auth:email-verify', {
      method: 'POST', body: { email: email, code: code },
    });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok || !data || !data.sessionToken) {
      throw new Error((data && data.error) || ('code check failed (HTTP ' + res.status + ')'));
    }
    save(data);
    return data;
  }

  /* Validate the stored session on boot (server decides whether it lives) */
  async function whoami(relayUrl) {
    var s = get();
    if (!s) return null;
    try {
      var res = await request(relayUrl, 'auth:whoami', {});
      var data = await res.json().catch(function () { return null; });
      if (!res.ok || !data || data.ok !== true) { clear(); return null; }
      /* keep the stored copy fresh (admin flag may change relay-side) */
      s.email = data.email || s.email;
      s.admin = data.admin === true;
      save({ sessionToken: s.token, email: s.email, admin: s.admin });
      return s;
    } catch (_) { return null; }   /* relay hiccup: keep the session, fail open for UI only */
  }

  /* Destroy the session relay-side + locally */
  async function signOut(relayUrl) {
    var s = get();
    clear();
    if (s && relayUrl) {
      try { await request(relayUrl, 'auth:signout', { method: 'POST' }); } catch (_) { /* best-effort */ }
    }
  }

  window.JPSession = {
    get: get, save: save, clear: clear, headers: headers,
    signedIn: signedIn, isAdmin: isAdmin,
    signInGoogle: signInGoogle, sendEmailCode: sendEmailCode, verifyEmailCode: verifyEmailCode,
    whoami: whoami, signOut: signOut,
  };
})();
