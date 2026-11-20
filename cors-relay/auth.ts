/**
 * JiraPulse relay — session backend (18 Nov 2026 security review, Phase 2).
 *
 * Server-side identity for the org gate, replacing the client-only flows:
 *   - Google: the browser forwards its Google ID token here; it is verified
 *     SERVER-SIDE against Google's public JWKS (RS256 signature, iss, aud,
 *     exp, email_verified, org domain) before any session is minted. The
 *     old client-side `decodeJwt` trust is gone for authorization purposes.
 *   - Email codes: the relay generates a RANDOM one-time code (never a
 *     deterministic hash the page bundle could compute), stores only its
 *     SHA-256 hash with a 10-minute expiry and an attempt cap, and emails it
 *     server-side through FormSubmit. The code never passes through the
 *     browser that requested it.
 *   - Sessions: opaque 256-bit tokens stored as SHA-256 hashes in blob
 *     storage. Data endpoints accept them via the `x-jp-session` header.
 *
 * Enforcement is flag-gated (`?cmd=auth:enforce`, admin token; blob-backed).
 * Flag OFF (default): legacy clients (no session logic) keep working — the
 * GitHub Pages deployment stays functional until the operator flips the
 * switch. Flag ON: every anonymous stored-cred data read requires a valid
 * session (fail closed).
 */
import { blob } from "https://esm.town/v/std/blob";
import { CORS_HEADERS, ORG_EMAIL_DOMAIN, sha256Hex } from "./shared.ts";

/* Public identifiers (not secrets): already shipped in the page bundles. */
export const GOOGLE_CLIENT_ID = '671098966570-21bp1aeud5o2glbjsliif3foi6n71gmh.apps.googleusercontent.com';
/* Relay-side admin list — the admin ROLE is decided here, never in the
   browser (Phase 2.1: "admin role backend-only"). Same two people the desk
   admin panels whitelisted. */
export const ADMIN_EMAILS = [
  'anania.devsurashvili@caucasusauto.com',
  'ani@caucasusauto.com',
];

/* blob keys */
const SESSIONS_KEY = 'jirapulse_sessions_v1';
const EMAIL_CODES_KEY = 'jirapulse_email_codes_v1';
const ENFORCE_KEY = 'jirapulse_enforce_sessions_v1';

/* session + code policy */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;        /* 7 days, sliding */
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   /* hard cap from iat */
const SESSION_EXTEND_GAP_MS = 60 * 60 * 1000;          /* extend at most hourly */
const SESSION_MAX_RECORDS = 10_000;                    /* prune beyond this */
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;              /* code valid 10 min */
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const EMAIL_CODE_COOLDOWN_MS = 45 * 1000;              /* between sends */
const EMAIL_CODE_MAX_PENDING = 500;                    /* prune beyond this */

type SessionRec = {
  email: string; admin: boolean; provider: 'google' | 'email';
  iat: number; lastSeen: number; exp: number;
};
type SessionsMap = Record<string, SessionRec>;   /* key: sha256(token) */
type EmailCodeRec = { hash: string; exp: number; attempts: number; sentAt: number };
type EmailCodesMap = Record<string, EmailCodeRec>;

/* ── enforcement flag (legacy-compat switch) ─────────────────────────── */
let _enforceCache: { on: boolean; freshUntil: number } = { on: false, freshUntil: 0 };

export async function sessionsEnforced(): Promise<boolean> {
  const now = Date.now();
  if (now < _enforceCache.freshUntil) return _enforceCache.on;
  let on = false;
  try {
    const f = (await blob.getJSON(ENFORCE_KEY)) as any;
    on = f?.on === true;
  } catch { on = false; }
  _enforceCache = { on, freshUntil: now + 60_000 };
  return on;
}

export async function setEnforceFlag(on: boolean): Promise<void> {
  await blob.setJSON(ENFORCE_KEY, { on: !!on, ts: Date.now() });
  _enforceCache = { on: !!on, freshUntil: 0 };
}

/* ── base64url helpers ───────────────────────────────────────────────── */
function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function randomToken(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
function randomCode(): string {
  /* 6 digits, uniform over 100000..999999 (no leading-zero ambiguity) */
  const n = 100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000);
  return String(n);
}

/* ── Google ID token verification (server-side, JWKS RS256) ─────────── */
type GoogleClaims = { email: string; sub: string; name?: string };
let _jwksCache: { keys: any[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchJwks(): Promise<any[]> {
  if (_jwksCache && Date.now() - _jwksCache.fetchedAt < JWKS_TTL_MS) return _jwksCache.keys;
  const resp = await fetch('https://www.googleapis.com/oauth2/v3/certs', {
    method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error('JWKS fetch failed (HTTP ' + resp.status + ')');
  const jwks = await resp.json();
  if (!Array.isArray(jwks?.keys) || !jwks.keys.length) throw new Error('empty JWKS');
  _jwksCache = { keys: jwks.keys, fetchedAt: Date.now() };
  return _jwksCache.keys;
}

export function orgEmailOk(email: string): boolean {
  const e = String(email || '').toLowerCase().trim();
  return e.endsWith('@' + ORG_EMAIL_DOMAIN) && e.split('@')[1] === ORG_EMAIL_DOMAIN;
}

/* Verify a Google ID token end-to-end on the server. Returns the verified
   identity or throws with a short reason (never echo token contents). */
export async function verifyGoogleIdToken(credential: string): Promise<GoogleClaims> {
  const parts = String(credential || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  let header: any, claims: any;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    throw new Error('malformed token');
  }
  if (!header || header.alg !== 'RS256' || !header.kid) throw new Error('unsupported token');
  const keys = await fetchJwks();
  const jwk = keys.find((k) => k && k.kid === header.kid)
    /* unknown kid (Google rotated) → refresh the cache once */
    || await (async () => {
      _jwksCache = null;
      const fresh = await fetchJwks();
      return fresh.find((k) => k && k.kid === header.kid) || null;
    })();
  if (!jwk) throw new Error('unknown key id');
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    b64urlDecode(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]),
  );
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== GOOGLE_CLIENT_ID) throw new Error('wrong audience');
  if (!claims.exp || now > Number(claims.exp) + 60) throw new Error('token expired');
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(String(claims.iss || ''))) {
    throw new Error('wrong issuer');
  }
  const email = String(claims.email || '').toLowerCase().trim();
  if (!email || claims.email_verified === false) throw new Error('email not verified');
  if (!orgEmailOk(email)) throw new Error('outside the org domain');
  /* Workspace tokens carry hd; when present it must be the org domain */
  if (claims.hd != null && String(claims.hd).toLowerCase() !== ORG_EMAIL_DOMAIN) {
    throw new Error('outside the org domain');
  }
  return { email, sub: String(claims.sub || ''), name: claims.name ? String(claims.name) : undefined };
}

/* ── session mint / lookup ───────────────────────────────────────────── */
function pruneSessions(map: SessionsMap): void {
  const now = Date.now();
  for (const k of Object.keys(map)) {
    if (!map[k] || Number(map[k].exp) <= now) delete map[k];
  }
  const keys = Object.keys(map);
  if (keys.length > SESSION_MAX_RECORDS) {
    keys.sort((a, b) => Number(map[a].lastSeen) - Number(map[b].lastSeen));
    for (const k of keys.slice(0, keys.length - SESSION_MAX_RECORDS)) delete map[k];
  }
}

export async function mintSession(email: string, provider: 'google' | 'email'): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  const rec: SessionRec = {
    email: String(email).toLowerCase().trim(),
    admin: ADMIN_EMAILS.includes(String(email).toLowerCase().trim()),
    provider,
    iat: now,
    lastSeen: now,
    exp: now + SESSION_TTL_MS,
  };
  const hash = await sha256Hex(token);
  const map = ((await blob.getJSON(SESSIONS_KEY)) || {}) as SessionsMap;
  map[hash] = rec;
  pruneSessions(map);
  await blob.setJSON(SESSIONS_KEY, map);
  return token;
}

/* Resolve the `x-jp-session` header to a live session record. Sliding
   expiry: sessions used at least hourly stay alive up to the hard cap;
   otherwise they expire 7 days after mint. Returns null when absent/
   unknown/expired. The token itself is never stored — only its hash. */
export async function authSession(request: Request): Promise<SessionRec | null> {
  const token = (request.headers.get('x-jp-session') || '').trim();
  if (!token || token.length > 512 || !/^[A-Za-z0-9_\-]{43,128}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  let map: SessionsMap;
  try { map = ((await blob.getJSON(SESSIONS_KEY)) || {}) as SessionsMap; } catch { return null; }
  const rec = map[hash];
  if (!rec) return null;
  const now = Date.now();
  if (Number(rec.exp) <= now) { delete map[hash]; await blob.setJSON(SESSIONS_KEY, map).catch(() => {}); return null; }
  if (now - Number(rec.lastSeen) > SESSION_EXTEND_GAP_MS) {
    rec.lastSeen = now;
    rec.exp = Math.min(Number(rec.iat) + SESSION_MAX_AGE_MS, now + SESSION_TTL_MS);
    map[hash] = rec;
    pruneSessions(map);
    await blob.setJSON(SESSIONS_KEY, map).catch(() => { /* best-effort */ });
  }
  return rec;
}

export async function dropSession(request: Request): Promise<boolean> {
  const token = (request.headers.get('x-jp-session') || '').trim();
  if (!token) return false;
  const hash = await sha256Hex(token);
  try {
    const map = ((await blob.getJSON(SESSIONS_KEY)) || {}) as SessionsMap;
    if (map[hash]) { delete map[hash]; await blob.setJSON(SESSIONS_KEY, map); return true; }
  } catch { /* ignore */ }
  return false;
}

/* ── the anonymous data-endpoint gate ──────────────────────────────────
   Call this at the top of every handler that would otherwise serve the
   stored read-only credentials to a request WITHOUT its own Authorization
   header. Returns either a live session record, null (legacy mode: proceed
   without a session), or a 401 Response the caller must return directly
   (enforcement ON and no valid session — fail closed). */
export async function anonSessionGate(request: Request): Promise<SessionRec | Response> {
  const sess = await authSession(request);
  if (sess) return sess;
  if (await sessionsEnforced()) {
    return new Response(JSON.stringify({ error: 'org sign-in required (no valid session)' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
  return null;   /* legacy mode: anonymous stored-cred reads still allowed */
}

/* ── email one-time codes (random, server-side delivery) ─────────────── */
function pruneEmailCodes(map: EmailCodesMap): void {
  const now = Date.now();
  for (const k of Object.keys(map)) {
    if (!map[k] || Number(map[k].exp) <= now) delete map[k];
  }
  const keys = Object.keys(map);
  if (keys.length > EMAIL_CODE_MAX_PENDING) {
    keys.sort((a, b) => Number(map[a].sentAt) - Number(map[b].sentAt));
    for (const k of keys.slice(0, keys.length - EMAIL_CODE_MAX_PENDING)) delete map[k];
  }
}

async function emailViaFormSubmit(email: string, code: string, subject: string): Promise<void> {
  const body =
    'Hello,\n\n' +
    'Your one-time access code for JiraPulse is:\n\n' +
    code + '\n\n' +
    'It expires in 10 minutes. Enter it on the JiraPulse page you opened.\n\n' +
    'If you did not request this, ignore this email.';
  /* NOTE: no AbortSignal on this fetch. Verified on Val Town (20 Nov): a
     fetch that carries AbortSignal.timeout never completes against
     formsubmit.co, while the identical request without a signal succeeds
     in ~1s. The Promise.race below provides the timeout instead. */
  const send = fetch('https://formsubmit.co/ajax/' + encodeURIComponent(email), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      /* FormSubmit's bot check treats a request with no Origin/Referer as
         "a local HTML file" and rejects/hangs it — present a browser-like
         site origin so server-side delivery is accepted. */
      'Origin': 'https://ananiadevsurashvili-byte.github.io',
      'Referer': 'https://ananiadevsurashvili-byte.github.io/jira-pulse/',
    },
    body: JSON.stringify({
      email,
      _subject: subject,
      message: body,
      _template: 'table',
      _captcha: 'false',
    }),
  });
  /* timeout guard without AbortSignal (see NOTE above). 45s: Val Town kills
     the val at 60s, and FormSubmit latency from datacenter egress can spike
     to ~40s under per-recipient throttling — typical sends take 1-3s. */
  const resp: Response = await new Promise<Response>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('email delivery timed out (upstream slow — try again in a minute)')), 45_000);
    send.then(
      (r) => { clearTimeout(t); resolve(r); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
  const data = await resp.json().catch(() => ({}));
  /* FormSubmit returns `success` as a STRING ("true"/"false"), not a
     boolean — accept both spellings or real rejections look like success. */
  const okFlag = !!data && (data.success === true || String(data.success).toLowerCase() === 'true');
  if (!resp.ok || !okFlag) {
    const reason = String((data && (data.message || data.error)) || ('HTTP ' + resp.status));
    const err = new Error(reason);
    (err as any).activating = /activat/i.test(reason);
    throw err;
  }
}

/* Generate a random code, store only its hash, and email it server-side.
   Throws an Error with `.activating` set when FormSubmit needs activation. */
export async function startEmailCode(email: string, subject: string): Promise<void> {
  const key = String(email).toLowerCase().trim();
  const map = ((await blob.getJSON(EMAIL_CODES_KEY)) || {}) as EmailCodesMap;
  const prev = map[key];
  const now = Date.now();
  if (prev && now - Number(prev.sentAt) < EMAIL_CODE_COOLDOWN_MS) {
    throw new Error('code already sent — wait a minute and check your inbox');
  }
  const code = randomCode();
  const rec: EmailCodeRec = {
    hash: await sha256Hex(key + '|' + code),
    exp: now + EMAIL_CODE_TTL_MS,
    attempts: 0,
    sentAt: now,
  };
  map[key] = rec;
  pruneEmailCodes(map);
  await blob.setJSON(EMAIL_CODES_KEY, map);
  await emailViaFormSubmit(key, code, subject);
}

/* Verify a submitted code against the stored hash. Failures increment the
   attempt counter (persisted); exceeding the cap burns the code. */
export async function verifyEmailCode(email: string, code: string): Promise<boolean> {
  const key = String(email).toLowerCase().trim();
  const map = ((await blob.getJSON(EMAIL_CODES_KEY)) || {}) as EmailCodesMap;
  const rec = map[key];
  const now = Date.now();
  if (!rec || Number(rec.exp) <= now) return false;
  if (Number(rec.attempts) >= EMAIL_CODE_MAX_ATTEMPTS) return false;
  const hash = await sha256Hex(key + '|' + String(code || '').trim());
  if (hash !== rec.hash) {
    rec.attempts = Number(rec.attempts) + 1;
    map[key] = rec;
    await blob.setJSON(EMAIL_CODES_KEY, map);
    return false;
  }
  delete map[key];
  await blob.setJSON(EMAIL_CODES_KEY, map).catch(() => { /* best-effort */ });
  return true;
}

/* ── public payload shape for the client ─────────────────────────────── */
export type SessionPublic = { email: string; admin: boolean; provider: string; exp: number };

export function sessionPublic(rec: SessionRec): SessionPublic {
  return { email: rec.email, admin: !!rec.admin, provider: rec.provider, exp: Number(rec.exp) };
}

export function isAdminEmail(email: string): boolean {
  return ADMIN_EMAILS.includes(String(email || '').toLowerCase().trim());
}
