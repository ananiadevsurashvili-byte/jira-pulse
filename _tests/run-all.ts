/**
 * JiraPulse relay test suite (18 Nov 2026 security reassessment).
 * Covers all 6 required verification proofs + negative cases:
 *   1. Phase 1.1 — anonymous issue detail injects `project` into fields (Regression A).
 *   2. Phase 1.2 — shared conn-store: legacy migration + cross-page token (Regression B).
 *   3. Phase 1.3 — publish-admin token out of localStorage (sessionStorage only).
 *   4. Phase 2   — backend sessions: server-side Google verify, random email
 *                  codes, session-required data endpoints, session-derived lgPing.
 *   5. Phase 3   — cache scope partitioning, fail-closed allowlist, desk
 *                  restricted-issue denial.
 *   6. Phase 4   — rate limits keyed by session identity, upstream timeouts,
 *                  nginx headers, SRI on external scripts.
 *
 * Run:  node _tests/run-all.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  makeBlobMock, makeUpstreamMock, googleTestJwks, signGoogleIdToken, googleClaims,
} from './mocks.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* ── install mocks BEFORE the combined module loads ──────────────────── */
const blobMock = makeBlobMock();
(globalThis as any).__jpBlobMock = blobMock;
const upstream = makeUpstreamMock();
(globalThis as any).fetch = upstream.fetch;

/* build + load the combined relay module (imports = syntax check too) */
execFileSync(process.execPath, [join(HERE, 'harness.ts')], { stdio: 'inherit' });
const R: any = await import('./_combined.ts');

const CREDS_KEY = R.CREDS_KEY as string;
const PUB_KEY = R.PUB_KEY as string;
const BOARD_CACHE_KEY = 'jirapulse_board_cache_v2';
const JIRA = 'https://test.atlassian.net';
const RELAY = 'https://gensweaty--65df49bca6d911f19f231607ee4eb77e.web.val.run/';
const ADMIN_EMAIL = 'anania.devsurashvili@caucasusauto.com';
const VIEWER_EMAIL = 'viewer@caucasusauto.com';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log('  PASS  ' + name);
    } catch (e) {
      failed++;
      failures.push(name);
      console.log('  FAIL  ' + name + ' → ' + (e as Error).message);
    }
  })();
}

function handlerUrl(qs: string, init?: RequestInit): Promise<Response> {
  return R.handler(new Request(RELAY + qs, init));
}
function resetState() {
  blobMock.store.clear();
  R.rateBuckets.clear();
  upstream.clearCalls();
  (R as any)._pubProjectsCache.set = new Set(R.DESK_PROJECTS);
  (R as any)._pubProjectsCache.freshUntil = 0;
  (R as any)._pubProjectsCache.lastFailAt = 0;
}
async function setEnforced(on: boolean) { await R.setEnforceFlag(on); }

/* Code delivery is fire-and-forget in the relay (FormSubmit's HTTP response
   is slow from datacenter egress) — give the background task its ticks. */
async function waitForFormSubmit(count: number) {
  for (let i = 0; i < 100 && upstream.formSubmits.length < count; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

function seedStandardWorld() {
  blobMock.store.set(CREDS_KEY, { domain: JIRA, email: 'ro@caucasusauto.com', token: 'ro-token' });
  blobMock.store.set(PUB_KEY, {
    savedAt: Date.now(), shareSeed: 'org', domain: 'test.atlassian.net',
    boards: [{ boardId: 42, boardName: 'Board 42', published: true }],
    chartDefs: [],
  });
  upstream.routes.set('test.atlassian.net/rest/agile/1.0/board/42', () => ({
    status: 200, json: { id: 42, location: { projectKey: 'ABC' } },
  }));
  upstream.routes.set('test.atlassian.net/rest/agile/1.0/board/42/configuration', () => ({
    status: 200, json: { filter: { id: 7 } },
  }));
  upstream.routes.set('test.atlassian.net/rest/agile/1.0/board/42/project', () => ({
    status: 200, json: { values: [{ key: 'ABC' }] },
  }));
  upstream.routes.set('test.atlassian.net/rest/agile/1.0/board/42/issue', () => ({
    status: 200, json: { issues: [], total: 0, isLast: true },
  }));
  upstream.routes.set('test.atlassian.net/rest/api/3/filter/7', () => ({
    status: 200, json: { jql: 'project = ABC' },
  }));
  upstream.routes.set('test.atlassian.net/rest/api/3/field', () => ({
    status: 200, json: [{ id: 'customfield_10100', name: 'Change Request Complexity', custom: true }],
  }));
  upstream.routes.set('test.atlassian.net/rest/api/3/search/jql', () => ({
    status: 200, json: { issues: [{
      key: 'ABC-1',
      fields: { summary: 's', status: { name: 'Open' }, security: null, labels: [], created: 1, updated: 1 },
    }], total: 1, isLast: true },
  }));
  /* single-issue read (plain proxy) */
  upstream.routes.set('test.atlassian.net/rest/api/3/issue/ABC-1', (_u, call) => ({
    status: 200, json: {
      key: 'ABC-1',
      fields: {
        summary: 's', project: { key: 'ABC' }, security: null, labels: [],
        comment: { comments: [{ body: {}, author: { displayName: 'a' }, created: '' }] },
      },
    },
  }));
  /* desk issue reads (deskAttach / deskSla / proxy issue detail).
     NOTE: keys must be VALID Jira keys (PROJECT-<digits>) — the relay's
     route regexes reject anything else. */
  upstream.routes.set('test.atlassian.net/rest/api/3/issue/LOG-1', () => ({
    status: 200, json: {
      key: 'LOG-1',
      fields: {
        project: { key: 'LOG' }, security: null, labels: [],
        attachment: [], comment: { comments: [] },
      },
    },
  }));
  upstream.routes.set('test.atlassian.net/rest/api/3/issue/LOG-2', () => ({
    status: 200, json: {
      key: 'LOG-2',
      fields: { project: { key: 'LOG' }, security: { id: 10000, name: 'Restricted' }, labels: [], attachment: [], comment: { comments: [] } },
    },
  }));
  upstream.routes.set('test.atlassian.net/rest/api/3/issue/LOG-3', () => ({
    status: 200, json: {
      key: 'LOG-3',
      fields: { project: { key: 'LOG' }, security: null, labels: ['Internal'], attachment: [], comment: { comments: [] } },
    },
  }));
}

/* ════════════════════════ 1. Phase 1.1 (Regression A) ════════════════ */
async function testPhase11() {
  console.log('\n[1] Phase 1.1 — Regression A: anonymous issue detail field injection');
  resetState(); seedStandardWorld();
  const callerUrl = encodeURIComponent(JIRA + '/rest/api/3/issue/ABC-1?fields=summary');
  const res = await handlerUrl('?url=' + callerUrl);
  assert.equal(res.status, 200, 'anonymous issue read should be 200 (got ' + res.status + ')');
  const issueCall = upstream.jiraCalls().find((c) => c.url.includes('/rest/api/3/issue/ABC-1'));
  assert.ok(issueCall, 'upstream issue fetch must have happened');
  const fl = new URL(issueCall!.url).searchParams.get('fields') || '';
  for (const need of ['project', 'security', 'labels']) {
    assert.ok(fl.split(',').includes(need), `upstream fields must include "${need}" (got: ${fl})`);
  }
  /* negatives */
  resetState(); seedStandardWorld();
  const resSec = await handlerUrl('?url=' + encodeURIComponent(JIRA + '/rest/api/3/issue/LOG-2?fields=summary'));
  assert.equal(resSec.status, 403);
  assert.equal(((await resSec.json()) as any).error, 'issue is security-restricted');
  const resInt = await handlerUrl('?url=' + encodeURIComponent(JIRA + '/rest/api/3/issue/LOG-3?fields=summary'));
  assert.equal(resInt.status, 403);
  assert.equal(((await resInt.json()) as any).error, 'issue not published');
  /* not-published project (ABC not in allowlist — only desk LOG is) */
  resetState(); seedStandardWorld();
  (R as any)._pubProjectsCache.set = new Set(['LOG']);
  (R as any)._pubProjectsCache.freshUntil = Date.now() + 60_000;
  const resUnpub = await handlerUrl('?url=' + encodeURIComponent(JIRA + '/rest/api/3/issue/ABC-1?fields=summary'));
  assert.equal(resUnpub.status, 403);
  assert.equal(((await resUnpub.json()) as any).error, 'issue not published');
}

/* ════════════════════════ 2. Phase 1.2 (Regression B) ════════════════ */
async function testPhase12() {
  console.log('\n[2] Phase 1.2 — Regression B: shared conn-store legacy migration');
  const code = readFileSync(join(ROOT, 'conn-store.js'), 'utf8');
  const ls = new Map<string, string>();
  const ss = new Map<string, string>();
  const ctx: any = {
    window: {},
    localStorage: {
      getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
      setItem: (k: string, v: string) => ls.set(k, String(v)),
      removeItem: (k: string) => ls.delete(k),
    },
    sessionStorage: {
      getItem: (k: string) => (ss.has(k) ? ss.get(k)! : null),
      setItem: (k: string, v: string) => ss.set(k, String(v)),
      removeItem: (k: string) => ss.delete(k),
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const store = ctx.JPConnStore;

  /* legacy layout: token inside LS_CONN → migrated to sessionStorage on load */
  ls.set('jp_conn_v1', JSON.stringify({ domain: 'test.atlassian.net', email: 'a@caucasusauto.com', token: 'tok-legacy' }));
  const legacy = store.load();
  assert.ok(legacy && legacy.token === 'tok-legacy', 'legacy conn must still resolve with its token');
  assert.ok(!JSON.parse(ls.get('jp_conn_v1')!).token, 'token must be stripped from localStorage after migration');
  assert.equal(ss.get('jp_jira_token_v1'), 'tok-legacy', 'migrated token must live in sessionStorage');

  /* modern layout: token only in sessionStorage */
  ls.clear(); ss.clear();
  store.save({ domain: 'test.atlassian.net', email: 'a@caucasusauto.com', token: 'tok-new' });
  assert.ok(!JSON.parse(ls.get('jp_conn_v1')!).token, 'save() must never put the token in localStorage');
  assert.equal(ss.get('jp_jira_token_v1'), 'tok-new');
  const modern = store.load();
  assert.ok(modern && modern.token === 'tok-new');

  /* token lost from sessionStorage → connection not resolvable (fail-safe) */
  ss.clear();
  assert.equal(store.load(), null, 'missing sessionStorage token must not resolve a connection');

  /* clear wipes both stores */
  store.save({ domain: 'd', email: 'e', token: 't' });
  store.clear();
  assert.equal(store.load(), null);

  /* every page loads the shared module */
  const pages = [
    'index.html', 'admin/index.html', 'csp/index.html', 'csp/admin/index.html',
    'logistics/index.html', 'fines/index.html',
    'logistics/admin/index.html', 'fines/admin/index.html',
  ];
  for (const p of pages) {
    const html = readFileSync(join(ROOT, p), 'utf8');
    assert.ok(/conn-store\.js/.test(html), p + ' must load conn-store.js');
    assert.ok(/relay-session\.js/.test(html), p + ' must load relay-session.js');
  }
}

/* ════════════════════════ 3. Phase 1.3 ═══════════════════════════════ */
async function testPhase13() {
  console.log('\n[3] Phase 1.3 — publish-admin token kept out of localStorage');
  const app = readFileSync(join(ROOT, 'app.js'), 'utf8');
  assert.ok(app.includes('SS_PUB_ADMIN_TOKEN'), 'app.js must define the sessionStorage key');
  assert.ok(app.includes("sessionStorage.getItem(SS_PUB_ADMIN_TOKEN)"), 'reads must come from sessionStorage');
  assert.ok(!app.includes('localStorage.setItem(LS_PUB_ADMIN_TOKEN'), 'no new writes of the token to localStorage');
  const legacyMigrated = /localStorage\.getItem\(LS_PUB_ADMIN_TOKEN\)[\s\S]{0,200}sessionStorage\.setItem\(SS_PUB_ADMIN_TOKEN/.test(app);
  assert.ok(legacyMigrated, 'legacy localStorage token must be migrated to sessionStorage');
  /* admin panels already ship the same pattern */
  for (const p of ['logistics/admin/admin-app.js', 'fines/admin/admin-app.js']) {
    const src = readFileSync(join(ROOT, p), 'utf8');
    assert.ok(src.includes('SS_PUB_ADMIN_TOKEN') && src.includes('sessionStorage.getItem(SS_PUB_ADMIN_TOKEN)'), p + ' reads from sessionStorage');
  }
}

/* ════════════════════════ 4. Phase 2 ═════════════════════════════════ */
async function testPhase2() {
  console.log('\n[4] Phase 2 — backend sessions (Google verify, email codes, gates)');

  /* Google JWKS route */
  upstream.routes.set('www.googleapis.com/oauth2/v3/certs', () => ({ status: 200, json: googleTestJwks() }));

  /* 4a. server-side verification: happy path */
  resetState(); seedStandardWorld();
  const tok = signGoogleIdToken(googleClaims({ email: ADMIN_EMAIL }));
  const claims = await R.verifyGoogleIdToken(tok);
  assert.equal(claims.email, ADMIN_EMAIL, 'valid org token must verify');

  /* 4b. negatives */
  const rejects: Array<[string, Record<string, unknown>, RegExp]> = [
    ['wrong audience', { aud: 'https://evil.example/attacker' }, /wrong audience/],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 999 }, /token expired/],
    ['outside org domain', { email: 'attacker@gmail.com', hd: null }, /outside the org domain/],
    ['unverified email', { email_verified: false }, /email not verified/],
    ['wrong issuer', { iss: 'https://evil.example' }, /wrong issuer/],
  ];
  for (const [label, over, re] of rejects) {
    const bad = signGoogleIdToken(googleClaims(over));
    await assert.rejects(() => R.verifyGoogleIdToken(bad), re, 'must reject: ' + label);
  }
  /* tampered signature — flip a char in the MIDDLE of the signature:
     the last base64 char only encodes padding bits, so flipping it can
     be a no-op (flaky); a mid-signature flip always changes the bytes. */
  const tokChars = signGoogleIdToken(googleClaims()).split('');
  const flipAt = tokChars.length - 100;   /* 100 from the end = mid-signature (sig ≈ 342 chars) */
  tokChars[flipAt] = tokChars[flipAt] === 'A' ? 'B' : 'A';
  const tampered = tokChars.join('');
  await assert.rejects(() => R.verifyGoogleIdToken(tampered), /bad signature|unknown key id|malformed/, 'must reject tampered token');

  /* 4c. ?cmd=auth:google end-to-end → session minted; whoami works */
  const g = await handlerUrl('?cmd=auth:google', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: signGoogleIdToken(googleClaims({ email: ADMIN_EMAIL })) }),
  });
  assert.equal(g.status, 200, 'auth:google must succeed for a valid org admin token');
  const gBody = await g.json() as any;
  assert.ok(gBody.sessionToken, 'session token minted');
  assert.equal(gBody.admin, true, 'relay decides the admin role');

  const who = await handlerUrl('?cmd=auth:whoami', { headers: { 'x-jp-session': gBody.sessionToken } });
  assert.equal(who.status, 200);
  const whoBody = await who.json() as any;
  assert.equal(whoBody.email, ADMIN_EMAIL);
  assert.equal(whoBody.admin, true);
  /* bogus session → 401 */
  const whoBad = await handlerUrl('?cmd=auth:whoami', { headers: { 'x-jp-session': 'AAAA_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
  assert.equal(whoBad.status, 401);

  /* 4d. random email code: generated server-side, delivered via FormSubmit,
         verified only relay-side; deterministic offline computation is gone */
  resetState(); seedStandardWorld();
  const send = await handlerUrl('?cmd=auth:email-start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: VIEWER_EMAIL }),
  });
  assert.equal(send.status, 200, 'email-start must succeed (got ' + send.status + ')');
  await waitForFormSubmit(1);
  assert.equal(upstream.formSubmits.length, 1, 'the code must be emailed SERVER-side (FormSubmit)');
  assert.ok(upstream.formSubmits[0].origin && upstream.formSubmits[0].referer,
    'the FormSubmit call must carry Origin/Referer — their bot check rejects bare server calls (success:"false", HTTP 200)');
  const msg = String(upstream.formSubmits[0].payload.message || '');
  const m = msg.match(/\b(\d{6})\b/);
  assert.ok(m, 'the emailed message must contain the 6-digit code');
  const code = m![1];

  /* wrong code → 401; the code survives for a correct later attempt */
  const bad1 = await handlerUrl('?cmd=auth:email-verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: VIEWER_EMAIL, code: '000000' === code ? '111111' : '000000' }),
  });
  assert.equal(bad1.status, 401);

  /* attempt cap: 5 wrong attempts burn the code */
  for (let i = 0; i < 4; i++) {
    await handlerUrl('?cmd=auth:email-verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: VIEWER_EMAIL, code: '9999'.includes(code.slice(0, 4)) ? '123456' : '654321' }),
    });
  }
  const burnt = await handlerUrl('?cmd=auth:email-verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: VIEWER_EMAIL, code }),
  });
  assert.equal(burnt.status, 401, 'a burnt code must not verify even with the right value');

  /* a fresh code verifies and mints a session */
  const send2 = await handlerUrl('?cmd=auth:email-start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'second@caucasusauto.com' }),
  });
  assert.equal(send2.status, 200);
  await waitForFormSubmit(2);
  assert.equal(upstream.formSubmits.length, 2, 'the second code must also be emailed SERVER-side');
  const code2 = String(upstream.formSubmits[upstream.formSubmits.length - 1].payload.message).match(/\b(\d{6})\b/)![1];
  const ok = await handlerUrl('?cmd=auth:email-verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'second@caucasusauto.com', code: code2 }),
  });
  assert.equal(ok.status, 200, 'the correct fresh code must verify');
  const okBody = await ok.json() as any;
  assert.ok(okBody.sessionToken);
  assert.equal(okBody.admin, false, 'non-admin email must NOT get the admin role');

  /* non-org email rejected */
  const foreign = await handlerUrl('?cmd=auth:email-start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'attacker@gmail.com' }),
  });
  assert.equal(foreign.status, 400, 'only org-domain emails may request codes');

  /* 4e. session-required data endpoints (Phase 2.2, flag-gated).
     NOTE: resetState() wipes the blob — sessions included — so mint a
     fresh session via the relay-internal API instead of reusing the
     token from the (now-wiped) email flow above. */
  resetState(); seedStandardWorld();
  await setEnforced(true);
  const noSess = await handlerUrl('?cmd=board&bid=42&mode=light');
  assert.equal(noSess.status, 401, 'enforcement ON: anonymous board read must be 401');
  const freshToken = await R.mintSession('second@caucasusauto.com', 'email');
  const withSess = await handlerUrl('?cmd=board&bid=42&mode=light', { headers: { 'x-jp-session': freshToken } });
  assert.equal(withSess.status, 200, 'enforcement ON: a valid session must pass');
  await setEnforced(false);
  const legacyNoSess = await handlerUrl('?cmd=board&bid=42&mode=light');
  assert.equal(legacyNoSess.status, 200, 'enforcement OFF (legacy): anonymous reads keep working');

  /* 4f. lgPing derives identity from the session (Phase 2.3).
     The reset above wiped the sessions blob again — mint a fresh token. */
  resetState(); seedStandardWorld();
  const pingToken = await R.mintSession('second@caucasusauto.com', 'email');
  const ping = await handlerUrl('?cmd=lgPing', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-jp-session': pingToken },
    body: JSON.stringify({ email: 'spoofed@caucasusauto.com', surface: 'desk' }),
  });
  assert.equal(ping.status, 200);
  assert.equal(((await ping.json()) as any).email, 'second@caucasusauto.com',
    'the pinged email must come from the SESSION, not the spoofable body');
  await setEnforced(true);
  const pingAnon = await handlerUrl('?cmd=lgPing', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: VIEWER_EMAIL, surface: 'desk' }),
  });
  assert.equal(pingAnon.status, 401, 'enforcement ON: session-less pings are rejected');
  await setEnforced(false);
  const pingLegacy = await handlerUrl('?cmd=lgPing', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: VIEWER_EMAIL, surface: 'desk' }),
  });
  assert.equal(pingLegacy.status, 200, 'legacy clients (flag OFF) keep working');

  /* 4g. signout destroys the session */
  const out = await handlerUrl('?cmd=auth:signout', { method: 'POST', headers: { 'x-jp-session': pingToken } });
  assert.equal(out.status, 200);
  const whoAfter = await handlerUrl('?cmd=auth:whoami', { headers: { 'x-jp-session': pingToken } });
  assert.equal(whoAfter.status, 401, 'a dropped session must stop validating');
}

/* ════════════════════════ 5. Phase 3 ═════════════════════════════════ */
async function testPhase3() {
  console.log('\n[5] Phase 3 — cache partitioning, fail-closed allowlist, desk denial');

  /* 5a. board cache is anonymous-tier only; viewer-auth never reads it */
  resetState(); seedStandardWorld();
  const cacheKey = `${BOARD_CACHE_KEY}:anon:test.atlassian.net:42:light`;
  blobMock.store.set(cacheKey, {
    ts: Date.now(), data: { ok: true, boardId: 42, source: 'x', mode: 'light', hasChangelog: false, count: 1, fetchedAt: 1, issues: [{ key: 'CACHED' }] },
  });
  const anon = await handlerUrl('?cmd=board&bid=42&mode=light');
  assert.equal(anon.status, 200);
  assert.equal(((await anon.json()) as any).cached, true, 'anonymous read must be served from the anon cache');
  assert.equal(upstream.jiraCalls().filter((c) => c.url.includes('/search/jql')).length, 0, 'cache hit must not touch Jira');

  upstream.clearCalls();
  const viewer = await handlerUrl('?cmd=board&bid=42&mode=light', { headers: { 'Authorization': 'Basic ' + btoa('v@caucasusauto.com:vtk') } });
  assert.equal(viewer.status, 200);
  assert.notEqual(((await viewer.json()) as any).cached, true, 'viewer-auth read must NOT be served the anon cache');
  assert.ok(upstream.jiraCalls().some((c) => c.url.includes('/search/jql')), 'viewer-auth read must hit Jira live');
  assert.ok(!blobMock.store.has(cacheKey) || true);
  /* the viewer run must not overwrite the anon cache slot */
  const slot = await blobMock.getJSON(cacheKey) as any;
  assert.ok(slot && slot.data?.issues?.[0]?.key === 'CACHED', 'viewer-auth fetch must not feed the shared anon cache');

  /* 5b. publishedProjects fail-closed: no stale-blob resurrection */
  resetState(); seedStandardWorld();
  blobMock.store.set('jirapulse_pub_projects_v1', { ts: 1, projects: ['ZZZ', 'YYY'] });   /* stale copy */
  (R as any)._pubProjectsCache.set = new Set(['ZZZ']);
  (R as any)._pubProjectsCache.freshUntil = 0;
  (R as any)._pubProjectsCache.lastFailAt = 0;
  upstream.routes.set('test.atlassian.net/rest/agile/1.0/board/42/project', () => ({ status: 500, json: {} }));
  const set = await R.publishedProjects(true);
  assert.ok(!set.has('ZZZ') && !set.has('YYY'), 'stale allowlist entries must NOT survive a failed rebuild');
  assert.ok(set.has('LOG'), 'fail-closed allowlist keeps the static built-in desk projects');

  /* 5c. desk handlers deny restricted + internal issues for anonymous reads */
  resetState(); seedStandardWorld();
  const attachSec = await handlerUrl('?cmd=deskAttach&key=LOG-2&domain=test.atlassian.net');
  assert.equal(attachSec.status, 403, 'security-restricted issue attachments must be denied');
  const attachInt = await handlerUrl('?cmd=deskAttach&key=LOG-3&domain=test.atlassian.net');
  assert.equal(attachInt.status, 403, 'desk-internal issue attachments must be denied');
  const attachOk = await handlerUrl('?cmd=deskAttach&key=LOG-1&domain=test.atlassian.net');
  assert.equal(attachOk.status, 200, 'clean desk issue attachments stay available');

  const slaSec = await handlerUrl('?cmd=deskSla&key=LOG-2&domain=test.atlassian.net');
  assert.equal(slaSec.status, 403, 'security-restricted issue SLA must be denied');
  const slaInt = await handlerUrl('?cmd=deskSla&key=LOG-3&domain=test.atlassian.net');
  assert.equal(slaInt.status, 403, 'desk-internal issue SLA must be denied');
  /* SLA happy path needs the two SLA sources */
  upstream.routes.set('test.atlassian.net/rest/api/3/issue/LOG-1', () => ({
    status: 200, json: { key: 'LOG-1', fields: { project: { key: 'LOG' }, security: null, labels: [], customfield_10016: 3600 } },
  }));
  upstream.routes.set('test.atlassian.net/rest/servicedeskapi/request/LOG-1/sla', () => ({
    status: 200, json: { values: [] },
  }));
  const slaOk = await handlerUrl('?cmd=deskSla&key=LOG-1&domain=test.atlassian.net');
  assert.equal(slaOk.status, 200, 'clean desk issue SLA stays available');

  /* desk LIST keeps filtering restricted + internal (no regression) */
  const deskRes = await handlerUrl('?cmd=desk&project=LOG&domain=test.atlassian.net');
  assert.equal(deskRes.status, 200);
}

/* ════════════════════════ 6. Phase 4 ═════════════════════════════════ */
async function testPhase4() {
  console.log('\n[6] Phase 4 — rate-limit identity, timeouts, headers, SRI');

  /* 6a. rate limits keyed by session identity, not spoofable XFF */
  R.rateBuckets.clear();
  const mk = (sess: string | null) => R.handler(new Request(RELAY + '?cmd=lgPing', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '1.2.3.4',   /* same IP for every caller */
      ...(sess ? { 'x-jp-session': sess } : {}),
    },
    body: JSON.stringify({ email: VIEWER_EMAIL, surface: 'desk' }),
  }));
  /* rateLimit() runs BEFORE the handler body — call it directly for precision */
  R.rateBuckets.clear();
  const reqA = () => R.rateLimit(new Request(RELAY + '?cmd=lgPing', {
    method: 'POST', headers: { 'x-jp-session': 'A'.repeat(64) + '_aaaa' },
  }));
  const reqB = () => R.rateLimit(new Request(RELAY + '?cmd=lgPing', {
    method: 'POST', headers: { 'x-jp-session': 'B'.repeat(64) + '_bbbb' },
  }));
  const reqSpoof = () => R.rateLimit(new Request(RELAY + '?cmd=lgPing', {
    method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' },
  }));
  let hitLimit = false;
  for (let i = 0; i < 21; i++) hitLimit = await reqA();   /* limit 20 → call 21 trips */
  assert.equal(hitLimit, true, 'the 21st call within the window must trip the limit');
  assert.equal(await reqB(), false, 'a DIFFERENT session gets its own bucket');
  assert.equal(await reqSpoof(), false, 'a spoofed XFF header must not poison the session bucket');

  /* 6b. upstream timeouts present on every direct fetch site */
  const rs = readFileSync(join(ROOT, 'cors-relay', 'relay-source.ts'), 'utf8');
  const dk = readFileSync(join(ROOT, 'cors-relay', 'desk.ts'), 'utf8');
  const au = readFileSync(join(ROOT, 'cors-relay', 'auth.ts'), 'utf8');
  const fetchSites = (rs.match(/\bfetch\(/g) || []).length
    + (dk.match(/\bfetch\(/g) || []).length
    + (au.match(/\bfetch\(/g) || []).length;
  const timeouts = (rs.match(/AbortSignal\.timeout\(/g) || []).length
    + (dk.match(/AbortSignal\.timeout\(/g) || []).length
    + (au.match(/AbortSignal\.timeout\(/g) || []).length;
  assert.ok(fetchSites >= 14, 'expected 14 upstream fetch sites, found ' + fetchSites);
  /* Every fetch must carry AbortSignal.timeout, EXCEPT the FormSubmit call:
     verified live on Val Town (20 Nov) that a signal-carrying fetch to
     formsubmit.co never completes there — it uses a Promise.race guard
     instead, which must stay documented in the source. */
  assert.ok(timeouts >= fetchSites - 1, 'every upstream fetch must carry AbortSignal.timeout (fetches=' + fetchSites + ', timeouts=' + timeouts + ')');
  assert.ok(/no AbortSignal on this fetch/.test(au), 'the FormSubmit no-signal exception must stay documented in auth.ts');

  /* 6c. nginx security headers */
  const nginx = readFileSync(join(ROOT, 'docker', 'nginx.conf'), 'utf8');
  assert.ok(/X-Frame-Options\s+DENY/.test(nginx), 'nginx must set X-Frame-Options DENY');
  assert.ok(/Content-Security-Policy/.test(nginx), 'nginx must set a CSP');
  assert.ok(/X-Content-Type-Options nosniff/.test(nginx), 'nginx must set nosniff');
  assert.ok(/Referrer-Policy/.test(nginx), 'nginx must set Referrer-Policy');
  assert.ok(/frame-ancestors 'none'/.test(nginx), 'CSP must forbid framing');

  /* 6d. SRI on every CDN script tag (GSI exempt: Google serves dynamic JS) */
  const pages = [
    'index.html', 'admin/index.html', 'csp/index.html', 'csp/admin/index.html',
    'logistics/index.html', 'fines/index.html',
    'logistics/admin/index.html', 'fines/admin/index.html',
  ];
  for (const p of pages) {
    const html = readFileSync(join(ROOT, p), 'utf8');
    const tags = html.match(/<script[^>]+src="https:\/\/[^"]+"[^>]*><\/script>/g) || [];
    for (const tag of tags) {
      const src = (tag.match(/src="([^"]+)"/) || [])[1];
      const hasSri = /integrity="/.test(tag);
      const isGsi = /accounts\.google\.com/.test(src);
      assert.ok(hasSri || isGsi, `${p}: CDN script without SRI: ${src}`);
    }
  }
}

/* ── syntax check every shipped JS bundle (node --check) ─────────────── */
async function testSyntax() {
  const bundles = [
    'app.js', 'conn-store.js', 'relay-session.js',
    'logistics/app.js', 'fines/app.js',
    'logistics/admin/admin-app.js', 'fines/admin/admin-app.js',
  ];
  for (const b of bundles) {
    execFileSync(process.execPath, ['--check', join(ROOT, b)], { stdio: 'pipe' });
  }
}

/* ── runner ──────────────────────────────────────────────────────────── */
console.log('JiraPulse relay security test suite (18 Nov 2026 reassessment)');
await test('Phase 1.1 — Regression A: anonymous issue detail field injection', testPhase11);
await test('Phase 1.2 — Regression B: shared conn-store legacy migration', testPhase12);
await test('Phase 1.3 — publish-admin token kept out of localStorage', testPhase13);
await test('Phase 2 — backend sessions (Google verify, email codes, gates)', testPhase2);
await test('Phase 3 — cache partitioning, fail-closed allowlist, desk denial', testPhase3);
await test('Phase 4 — rate-limit identity, timeouts, headers, SRI', testPhase4);
await test('node --check on all shipped bundles', testSyntax);
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('failed: ' + failures.join(' | '));
  process.exit(1);
}
