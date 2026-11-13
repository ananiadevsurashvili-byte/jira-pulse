/**
 * JiraPulse — shared online CORS relay for Jira Cloud (Val Town free tier).
 * ============================================================================
 * TWO roles in one val:
 *
 * 1) CORS PROXY (unchanged behavior): browsers cannot call the Jira Cloud REST
 *    API directly from a GitHub Pages site (Jira sends no CORS headers), so
 *    requests must pass through a relay. Forwards the Authorization header
 *    verbatim so every visitor uses their own Jira credentials.
 *
 * 2) PUBLISH BACKEND: stores the *publish configuration* (which boards are
 *    published + the chart layout) in Val Town blob storage so that viewers on
 *    ANY device see the boards immediately after signing in — no localStorage
 *    per-browser store, no admin republish needed for data freshness.
 *    The DATA itself is never stored: viewers always get live Jira numbers
 *    fetched through this relay at view time (optionally with the admin's
 *    stored read-only credentials when the viewer has none of their own).
 *
 * Commands (JSON responses):
 *   ?cmd=ping                                   → { ok }
 *   ?cmd=config:get                             → full publish config or { config:null }
 *   ?cmd=publish:set   (POST body: config)      → overwrites the whole config [admin only]
 *   ?cmd=publish:clear                          → removes the config          [admin only]
 *   ?cmd=board&bid=<id>&mode=<light|full>       → live issues for one board   [public]
 *   ?cmd=desk&project=<KEY>&domain=<host>       → live Service Desk issues for one
 *                                                 project, excluding label "Internal"
 *                                                 (Logistics viewer page)      [public]
 *
 * Admin auth for writes: the request must carry the publish-admin token.
 * The token is a shared secret minted when the admin publishes; it is sent as
 * "x-jp-admin" header (POST) and checked against the token stored WITH the
 * config (rotate-on-publish keeps it in sync between app + relay).
 *
 * Deployed endpoint:
 *   https://gensweaty--65df49bca6d911f19f231607ee4eb77e.web.val.run/
 * Val page:
 *   https://www.val.town/x/gensweaty/jira-relay/code/
 */
import { blob } from "https://esm.town/v/std/blob";
import { CORS_HEADERS, CREDS_KEY, DESK_PROJECTS, json } from "./shared.ts";
import { handleDeskAttachCmd, handleDeskCmd, handleDeskSlaCmd } from "./desk.ts";

const ALLOWED_HOST = /(^|\.)atlassian\.net$/i;

/* blob keys (Val Town blobs are account-scoped, so prefix for safety) */
const PUB_KEY = "jirapulse_publish_v1";
const ADMIN_KEY = "jirapulse_publish_admin_v1";
/* SLA goals shared by the logistics admin dashboard + public desk task list.
   Admin sets them once (?cmd=sla:set, x-jp-admin guarded); both surfaces read
   ?cmd=sla:get so the computed in/out-of-SLA numbers always match. No blobs →
   these defaults (the goals the user set in JSM: 2h response · 30h resolution). */
const SLA_KEY = "jirapulse_sla_goals_v1";
const DEFAULT_SLA_GOALS = { respHours: 2, resHours: 30 };


/* board response blob-cache for ?cmd=board: one board payload costs a full
   Jira chain (board context + filter + paginated search with changelog),
   and the pub master-boards replay it for EVERY published board on every
   load. Caching the finished payload makes master-all / revisits near-
   instant; ?fresh=1 bypasses and re-syncs (viewer-controlled freshness). */
const BOARD_CACHE_KEY = "jirapulse_board_cache_v1";
/* 10 min keeps hourly-style dashboards honest while collapsing the burst
   of N+1 synchronous requests a master-all load produces into one chain
   per board per window. */
const BOARD_CACHE_TTL = 10 * 60 * 1000;

/* "Change Request Complexity" custom-field id: Jira instance-bound but
   effectively static, so the expensive /rest/api/3/field catalog scan
   runs at most once per day instead of on every ?cmd=board hit. */
const COMPLEXITY_FIELD_KEY = "jirapulse_complexity_field_v1";
const COMPLEXITY_FIELD_TTL = 24 * 60 * 60 * 1000;

/* Admin auth: the shared secret lives ONLY in blob storage (ADMIN_KEY) — it is
   never hardcoded in this source and never shipped to browsers. When the blob
   holds no token the relay FAILS CLOSED: every admin-gated command returns 401
   until an operator seeds a token (first-time seeding is done in the Val Town
   editor; rotation happens via ?cmd=admin:rotate with the current token). */


/* constant-time admin-token comparison: both sides are hashed and the digests
   compared byte-by-byte, so response timing never leaks how many leading
   characters of a guessed token were correct. */
async function tokenMatches(given: string, stored: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(given || ''))),
    crypto.subtle.digest('SHA-256', enc.encode(String(stored || ''))),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

/* Admin check: the stored token is the ONLY source of truth. A missing or
   empty stored token fails closed (never compares against an empty string,
   which would let a header-less request match). */
async function adminAuthed(request: Request): Promise<boolean> {
  let stored = "";
  try { stored = String((await blob.getJSON(ADMIN_KEY)) || ""); } catch { stored = ""; }
  if (!stored) return false;
  const token = request.headers.get('x-jp-admin') || '';
  return await tokenMatches(token, stored);
}

/* ── CORS: approved frontend origins only ─────────────────────────────
   Browsers on any other origin get no Access-Control-Allow-Origin header,
   so their response is blocked. Non-browser clients are not affected by
   CORS at all — it is a browser policy, NOT authentication; every
   sensitive command enforces its own auth regardless. Add the
   organization's own domain(s) here when the app moves onto company
   hosting (GitLab Pages / Kubernetes ingress). */
const APPROVED_ORIGIN_RE = new RegExp(
  '^https://(ananiadevsurashvili-byte\\.github\\.io|anania\\.devsurashvili\\.gitlab\\.io)$' +
  '|^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$', 'i');

function applyCors(request: Request, resp: Response): Response {
  const origin = request.headers.get('origin') || '';
  const h = new Headers(resp.headers);
  h.delete('access-control-allow-origin');
  if (origin && APPROVED_ORIGIN_RE.test(origin)) {
    h.set('Access-Control-Allow-Origin', origin);
    h.append('Vary', 'Origin');
  }
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

/* ── per-client rate limiting (plain in-memory buckets) ───────────────
   Best-effort: counters live per val isolate and reset on restart, so
   this blunts floods and runaway loops rather than being a hard global
   quota. Read scopes get generous budgets so normal page loads (a
   master-all refresh fans out one request per board) never trip them. */
const RATE_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  proxy: { limit: 240, windowMs: 60_000 },
  board: { limit: 120, windowMs: 60_000 },
  desk: { limit: 60, windowMs: 60_000 },
  deskAttach: { limit: 240, windowMs: 60_000 },
  deskSla: { limit: 240, windowMs: 60_000 },
  lgPing: { limit: 20, windowMs: 60_000 },
  lgStats: { limit: 60, windowMs: 60_000 },
  write: { limit: 20, windowMs: 60_000 },
  read: { limit: 120, windowMs: 60_000 },
};
const WRITE_CMDS = new Set(['publish:set', 'publish:clear', 'creds:set', 'sla:set', 'admin:rotate']);
const rateBuckets = new Map<string, { n: number; resetAt: number }>();

function rateLimit(request: Request): boolean {
  const u = new URL(request.url);
  const cmd = u.searchParams.get('cmd') || '';
  const scope = cmd
    ? (WRITE_CMDS.has(cmd) ? 'write'
      : cmd === 'board' ? 'board'
      : cmd === 'desk' ? 'desk'
      : cmd === 'deskAttach' ? 'deskAttach'
      : cmd === 'deskSla' ? 'deskSla'
      : cmd === 'lgPing' ? 'lgPing'
      : cmd === 'lgStats' ? 'lgStats'
      : 'read')
    : 'proxy';
  const cfg = RATE_LIMITS[scope];
  if (!cfg) return false;
  const ip = (request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown').split(',')[0].trim();
  const now = Date.now();
  if (rateBuckets.size > 10_000) {
    for (const [k, b] of rateBuckets) if (b.resetAt <= now) rateBuckets.delete(k);
    if (rateBuckets.size > 10_000) rateBuckets.clear();
  }
  const key = ip + '|' + scope;
  const b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) {
    rateBuckets.set(key, { n: 1, resetAt: now + cfg.windowMs });
    return false;
  }
  b.n += 1;
  return b.n > cfg.limit;
}

/* ────────────────────────── entrypoint ────────────────────────── */
async function handler(request: Request): Promise<Response> {
  const resp = await route(request);
  return applyCors(request, resp);
}

async function route(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (rateLimit(request)) return json({ error: 'too many requests' }, 429);
  const u = new URL(request.url);

  /* ── publish backend commands ── */
  const cmd = u.searchParams.get('cmd');
  if (cmd) {
    try {
      if (cmd === 'ping') return json({ ok: true, ts: Date.now() });

      if (cmd === 'config:get') {
        const cfg = await blob.getJSON(PUB_KEY);
        return json({ config: cfg ?? null });
      }

      if (cmd === 'publish:set') {
        if (!(await adminAuthed(request))) return json({ error: 'admin auth required' }, 401);
        let body: unknown;
        try { body = await request.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
        if (!body || typeof body !== 'object') return json({ error: 'config must be an object' }, 400);
        await blob.setJSON(PUB_KEY, body);
        /* anonymous proxy reads scope themselves against the published
           boards — rebuild the derived project allowlist in the background */
        publishedProjects(true).catch(() => { /* best-effort */ });
        return json({ ok: true, savedAt: Date.now() });
      }

      if (cmd === 'publish:clear') {
        if (!(await adminAuthed(request))) return json({ error: 'admin auth required' }, 401);
        await blob.setJSON(PUB_KEY, null);
        /* nothing is published anymore → anonymous reads shrink to the desk
           projects immediately (both the in-memory copy and the stale-fallback blob) */
        _pubProjectsCache = { set: new Set(DESK_PROJECTS), freshUntil: Date.now() + PUB_PROJECTS_TTL, lastFailAt: 0 };
        blob.setJSON(PUB_PROJECTS_KEY, { ts: Date.now(), projects: [...DESK_PROJECTS] }).catch(() => { /* best-effort */ });
        return json({ ok: true });
      }

      if (cmd === 'creds:set') {
        if (!(await adminAuthed(request))) return json({ error: 'admin auth required' }, 401);
        const body = await request.json().catch(() => null);
        if (!body?.domain || !body?.email || !body?.token) return json({ error: 'domain, email and token required' }, 400);
        await blob.setJSON(CREDS_KEY, {
          domain: String(body.domain),
          email: String(body.email),
          token: String(body.token),
          savedAt: Date.now(),
        });
        return json({ ok: true });
      }

      /* live board data for published viewers:
         ?cmd=board&bid=<boardId>&mode=light|full&domain=<host>
         Authorization header: the VIEWER's own Jira creds when they have them
         (preferred — zero stored credentials); if absent, falls back to the
         admin's stored read-only Jira credentials (set once via creds:set). */
      if (cmd === 'board') {
        return await handleBoardCmd(u, request);
      }

      if (cmd === 'desk') {
        return await handleDeskCmd(u, request);
      }

      /* attachments for ONE issue (logistics task card popup) */
      if (cmd === 'deskAttach') {
        return await handleDeskAttachCmd(u, request);
      }

      /* JSM-native SLA clocks for ONE issue (logistics task lists).
         Reads the same service-desk SLA data Jira shows in the agent view
         (Time to first response / Time to resolution cycles) — the client
         renders GREEN/RED from Jira's own verdict instead of re-computing
         an approximation. */
      if (cmd === 'deskSla') {
        return await handleDeskSlaCmd(u, request);
      }

      /* lightweight login-activity tracking (logistics admin dashboard):
         POST ?cmd=lgPing  body {email}  → upsert one visitor record
         GET  ?cmd=lgStats            → sorted activity + active/today counts */
      if (cmd === 'lgPing') {
        return await handleLgPing(request);
      }
      if (cmd === 'lgStats') {
        return await handleLgStats(request);
      }

      /* ── SLA goals (logistics desk) ──
         GET  ?cmd=sla:get          → { goals: { respHours, resHours } }
         POST ?cmd=sla:set          body { respHours, resHours } (hours, admin token) */
      if (cmd === 'sla:get') {
        const goals = await blob.getJSON(SLA_KEY);
        return json({ ok: true, goals: goals ?? DEFAULT_SLA_GOALS });
      }
      if (cmd === 'sla:set') {
        if (!(await adminAuthed(request))) return json({ error: 'admin auth required' }, 401);
        const body = await request.json().catch(() => null);
        const rh = Number(body?.respHours), sh = Number(body?.resHours);
        if (!isFinite(rh) || rh <= 0 || rh > 24 * 30 || !isFinite(sh) || sh <= 0 || sh > 24 * 180) {
          return json({ error: 'respHours/resHours must be positive hours' }, 400);
        }
        const goals = { respHours: rh, resHours: sh, savedAt: Date.now() };
        await blob.setJSON(SLA_KEY, goals);
        return json({ ok: true, goals });
      }

      /* rotate the publish-admin token: requires the CURRENT valid token in
         x-jp-admin plus { newToken } in the JSON body. Use it whenever the
         shared secret may have leaked (it is never shipped in the app bundle). */
      if (cmd === 'admin:rotate') {
        if (!(await adminAuthed(request))) return json({ error: 'admin auth required' }, 401);
        const body = await request.json().catch(() => null);
        const next = String(body?.newToken || '');
        if (!/^[A-Za-z0-9_\-]{24,96}$/.test(next)) {
          return json({ error: 'newToken must be 24-96 chars of [A-Za-z0-9_-]' }, 400);
        }
        await blob.setJSON(ADMIN_KEY, next);
        return json({ ok: true, rotatedAt: Date.now() });
      }

      return json({ error: 'unknown cmd: ' + cmd }, 400);
    } catch (e) {
      return json({ error: 'command failed', detail: String(e) }, 500);
    }
  }

  /* ── plain CORS proxy (unchanged) ── */
  return await handleProxy(request, u);
}

/* ─────────────────── live board fetch for viewers ─────────────────── */
/* Uses the SAME multi-strategy approach as the app: board context (filter
   JQL + project keys) → project-wide JQL search with changelog (full data)
   → board issue endpoint fallback. Runs server-side so viewers pay only one
   round-trip and get a normalised { issues, hasChangelog } payload back. */
async function handleBoardCmd(u: URL, request: Request): Promise<Response> {
  const bid = parseInt(u.searchParams.get('bid') || '', 10);
  if (!bid || bid < 1) return json({ error: 'invalid bid' }, 400);
  const mode = u.searchParams.get('mode') === 'full' ? 'full' : 'light';
  const domainParam = (u.searchParams.get('domain') || '').trim();
  /* captured before the creds block reassigns authHeader — viewers bringing
     their own Authorization get live fetches that must NOT pollute the
     shared blob cache (it is served to every other caller) */
  const hadViewerAuth = !!request.headers.get('authorization');

  /* credentials: viewer's own Authorization header wins; else admin's stored creds */
  let authHeader = request.headers.get('authorization') || '';
  let domain = '';
  const stored = await blob.getJSON(CREDS_KEY);
  if (authHeader) {
    if (domainParam && /(^|\.)atlassian\.net$/i.test(domainParam)) {
      domain = domainParam;
    } else {
      domain = stored?.domain || '';
    }
  }
  if (!authHeader) {
    if (!stored?.domain || !stored?.email || !stored?.token) {
      return json({ error: 'no credentials available (viewer not connected and no stored creds)' }, 401);
    }
    /* published-board allowlist: an ANONYMOUS read may only touch boards the
       admin actually published — the stored read-only creds must never become
       a loophole for enumerating every board in the Jira site. Viewers who
       bring their own Authorization header are unaffected (their creds, their
       own Jira scope). */
    let allowed: Set<number>;
    try {
      const cfg = (await blob.getJSON(PUB_KEY)) as any;
      allowed = new Set<number>(((cfg && Array.isArray(cfg.boards)) ? cfg.boards : [])
        .filter((b: any) => b && b.published !== false)
        .map((b: any) => parseInt(b.boardId, 10))
        .filter((n: number) => Number.isFinite(n) && n > 0));
    } catch {
      allowed = new Set<number>();   /* config unreadable → fail closed */
    }
    if (!allowed.has(bid)) return json({ error: 'board not published' }, 403);
    authHeader = 'Basic ' + btoa(stored.email + ':' + stored.token);
    domain = stored.domain;
  }
  /* normalize scheme: app may send scheme-less "x.atlassian.net" */
  if (domain && !/^https:\/\//i.test(domain)) domain = 'https://' + domain;
  if (!domain || !/^https:\/\/[a-z0-9.-]+\.atlassian\.net$/i.test(domain)) {
    return json({ error: 'no usable Jira domain' }, 401);
  }
  const base = domain.replace(/\/+$/, '');

  /* headers for every Jira call we make below */
  const jh: Record<string, string> = {
    'Authorization': authHeader,
    'Accept': 'application/json',
    'User-Agent': 'JiraPulse-Relay/1.0',
  };
  const get = async (path: string): Promise<Response> => {
    return await fetch(base + path, { method: 'GET', headers: jh, redirect: 'follow' });
  };

  /* ── 0. payload blob-cache: instant replay within the TTL window ── */
  const forceFresh = u.searchParams.get('fresh') === '1';
  const boardKey = `${BOARD_CACHE_KEY}:${domain.replace(/^https:\/\//i, '').toLowerCase()}:${bid}:${mode}`;
  if (!forceFresh) {
    try {
      const cached = await blob.getJSON(boardKey) as any;
      if (cached && cached.data && cached.ts && Date.now() - cached.ts < BOARD_CACHE_TTL) {
        return json({ ...cached.data, cached: true, cacheAge: Date.now() - cached.ts });
      }
    } catch { /* missing/corrupt cache → full sync below */ }
  }

  /* ── 1. board context: type/location/config-filter/projects (all
        resolved in one round-trip wave — the filter JQL fetch used to run
        serially after the config response and stretched every uncached
        load) ── */
  const [boardResp, cfgResp, projectsResp, filterJql] = await Promise.all([
    get(`/rest/agile/1.0/board/${bid}`).catch(() => null),
    get(`/rest/agile/1.0/board/${bid}/configuration`).catch(() => null),
    get(`/rest/agile/1.0/board/${bid}/project`).catch(() => null),
    /* filter JQL: needs cfgResp settled first, so resolved inside the same
       wave instead of a separate serial wait afterwards */
    (async () => {
      let fid: string | null = null;
      try { fid = (await cfgResp?.json())?.filter?.id || null; } catch { /* ignore */ }
      if (!fid) return '';
      try {
        const fResp = await get(`/rest/api/3/filter/${fid}`);
        if (fResp.ok) return (await fResp.json())?.jql || '';
      } catch { /* ignore */ }
      return '';
    })(),
  ]);
  let projectKeys: string[] = [];
  try {
    const pj = await projectsResp?.json();
    const vals = pj?.values || pj || [];
    if (Array.isArray(vals)) projectKeys = vals.map((p: any) => p.key).filter(Boolean);
  } catch { /* ignore */ }
  if (!projectKeys.length) {
    try {
      const loc = (await boardResp?.json())?.location;
      if (loc?.projectKey) projectKeys = [loc.projectKey];
    } catch { /* ignore */ }
  }

  /* ── 2. search: project-wide JQL first (full fields incl. resolutiondate),
        then filter JQL, then the board issue endpoint ── */
  const FIELDS = 'summary,status,resolutiondate,created,updated,issuetype,assignee,priority,labels';
  /* cap raised 600 → 5000: long time ranges must return the REAL issue pool */
  const MAX_TOTAL = 5000;
  const withChangelog = mode === 'full';

  /* discover the "Change Request Complexity" custom field id from the field catalog
     (ids differ per Jira instance and unknown ids are silently dropped from `fields`)
     so the complexity distribution charts work for public viewers too.
     The catalog scan costs a full /rest/api/3/field round trip, so the result
     is blob-cached for a day and only re-discovered live when missing/expired. */
  let complexityFieldId = '';
  let complexityFromCache = false;
  try {
    const cfCached = await blob.getJSON(COMPLEXITY_FIELD_KEY) as any;
    if (cfCached && cfCached.id && cfCached.ts && Date.now() - cfCached.ts < COMPLEXITY_FIELD_TTL) {
      complexityFieldId = String(cfCached.id);
      complexityFromCache = true;
    }
  } catch { /* missing/corrupt cache → live discovery below */ }
  if (!complexityFromCache) {
    try {
      const fResp = await get('/rest/api/3/field');
      if (fResp.ok) {
        const catalog: any[] = await fResp.json();
        const wanted = catalog.find((f) => f && f.custom && /change request complexity/i.test(f.name || ''))
          || catalog.find((f) => f && f.custom && /complexity/i.test(f.name || ''));
        if (wanted?.id) {
          complexityFieldId = String(wanted.id);
          blob.setJSON(COMPLEXITY_FIELD_KEY, { ts: Date.now(), id: complexityFieldId }).catch(() => { /* best-effort */ });
        }
      }
    } catch { /* best-effort — charts just show "no data" without it */ }
  }
  /* anonymous payloads additionally carry the security field so restricted
     issues can be dropped below (logged-in viewers keep their own scope) */
  const SEARCH_FIELDS = (complexityFieldId ? `${FIELDS},${complexityFieldId}` : FIELDS) +
    (hadViewerAuth ? '' : ',security');

  async function searchJql(jql: string): Promise<any[] | null> {
    const out: any[] = [];
    let pageSize = withChangelog ? 25 : 50;
    for (let pass = 0; pass < 6; pass++) {
      out.length = 0;
      let nextPageToken: string | null = null;
      let ok = true;
      while (out.length < MAX_TOTAL) {
        const qp = new URLSearchParams();
        qp.set('jql', jql);
        qp.set('fields', SEARCH_FIELDS);
        qp.set('maxResults', String(pageSize));
        if (withChangelog) qp.set('expand', 'changelog');
        if (nextPageToken) qp.set('nextPageToken', nextPageToken);
        let resp: Response;
        try {
          resp = await get(`/rest/api/3/search/jql?${qp.toString()}`);
        } catch (e) {
          return null;
        }
        if (resp.status === 413 && pageSize > 1) { ok = false; }        // shrink & restart
        else if (resp.status === 410 || resp.status === 400) return null; // endpoint disabled / bad JQL
        else if (!resp.ok) return null;
        else {
          let page: any;
          try { page = await resp.json(); } catch { return null; }
          if (Array.isArray(page.issues)) out.push(...page.issues);
          if (page.isLast === true || !page.nextPageToken) break;
          nextPageToken = page.nextPageToken;
        }
        if (!ok) break;
      }
      if (ok) return out.slice(0, MAX_TOTAL);
      pageSize = Math.max(1, Math.floor(pageSize / 2));
    }
    return null;
  }

  async function fetchBoardIssues(cap = MAX_TOTAL): Promise<any[] | null> {
    const out: any[] = [];
    let startAt = 0;
    while (out.length < cap) {
      const resp = await get(`/rest/agile/1.0/board/${bid}/issue?startAt=${startAt}&maxResults=50&fields=${encodeURIComponent(SEARCH_FIELDS)}`).catch(() => null);
      if (!resp || !resp.ok) return out.length ? out : null;
      let page: any;
      try { page = await resp.json(); } catch { return out.length ? out : null; }
      const vals = Array.isArray(page.issues) ? page.issues : [];
      out.push(...vals);
      const total = typeof page.total === 'number' ? page.total : null;
      if (!vals.length || page.isLast === true) break;
      if (total !== null && startAt + vals.length >= total) break;
      startAt += vals.length;
    }
    return out.slice(0, cap);
  }

  let issues: any[] | null = null;
  let source = '';
  if (projectKeys.length) {
    issues = await searchJql(`project in (${projectKeys.map((k) => `"${k}"`).join(', ')}) ORDER BY created DESC`);
    if (issues) source = 'projects-search';
  }
  if (!issues && filterJql) {
    issues = await searchJql(filterJql);
    if (issues) source = 'filter-search';
  }
  if (!issues) {
    issues = await fetchBoardIssues();
    if (issues) source = 'board-endpoint';
  }
  if (!issues) return json({ error: 'could not load board issues from Jira' }, 502);

  /* anonymous viewers must not see security-restricted issues even on a
     published board (the stored read-only integration identity can see
     them — the anonymous human must not) */
  if (!hadViewerAuth) {
    issues = issues.filter((i) => i?.fields?.security == null);
  }

  const hasChangelog = issues.some((i) => i?.changelog?.histories?.length);

  const payload = {
    ok: true,
    boardId: bid,
    source,
    mode,
    hasChangelog,
    count: issues.length,
    fetchedAt: Date.now(),
    issues,
  };
  /* store the finished payload (best-effort — a failed write just means the
     next request pays the full chain again). Only stored-cred fetches may
     feed the SHARED cache: a viewer-cred fetch reflects that one viewer's
     Jira scope and would leak it to every other caller. */
  if (!hadViewerAuth) {
    try { await blob.setJSON(boardKey, { ts: Date.now(), data: payload }); } catch { /* ignore */ }
  }
  return json(payload);
}


/* ───────────────── login-activity tracking (admin dashboard) ──────────
   One blob record per viewer email per surface: desk | admin.
   Fired from the logistics desk + logistics/admin pages on load / on sign-in.
   `jirapulse_lg_logins_v1` = legacy combined record (kept for existing data);
   `jirapulse_lg_logins_v2` = { desk: {email: rec}, admin: {email: rec} } */
const LG_LOGINS_KEY = "jirapulse_lg_logins_v1";
const LG_LOGINS_V2_KEY = "jirapulse_lg_logins_v2";
const LG_ACTIVE_MS = 15 * 60 * 1000;        /* "active now" window */
const LG_PING_COOLDOWN_MS = 60 * 1000;      /* min gap between accepted upserts per email */

type LgLoginRec = { email: string; firstTs: number; lastTs: number; count: number; lastUa: string };

async function lgUpsertLogin(surface: "desk" | "admin", email: string, now: number, ua: string): Promise<LgLoginRec> {
  const map2 = (await blob.getJSON(LG_LOGINS_V2_KEY)) || { desk: {}, admin: {} };
  if (!map2.desk) map2.desk = {};
  if (!map2.admin) map2.admin = {};
  const bucket = surface === "admin" ? map2.admin : map2.desk;
  /* legacy seed: migrate an existing v1 record into desk (the desk page is
     where most traffic came from while v1 was the only sink) */
  if (!bucket[email]) {
    const legacy = (await blob.getJSON(LG_LOGINS_KEY)) || {};
    const lr = legacy[email];
    if (lr) bucket[email] = { email, firstTs: Number(lr.firstTs) || now, lastTs: Number(lr.lastTs) || 0, count: Number(lr.count) || 0, lastUa: String(lr.lastUa || "") };
  }
  const rec: LgLoginRec = bucket[email] || { email, firstTs: now, lastTs: 0, count: 0, lastUa: "" };
  /* write-cooldown: repeat pings inside the window are pure no-ops. The
     client fires these fire-and-forget and ignores the response, and the
     30 min session gap dwarfs the cooldown, so real users see no change —
     this only caps blob-write spam from scripted floods. */
  if (now - Number(rec.lastTs || 0) < LG_PING_COOLDOWN_MS) return rec;
  const isNewSession = now - Number(rec.lastTs || 0) > 30 * 60 * 1000;  /* 30min gap = new "session" */
  bucket[email] = {
    email,
    firstTs: Number(rec.firstTs) || now,
    lastTs: now,
    count: (Number(rec.count) || 0) + (isNewSession ? 1 : 0),
    lastUa: ua,
  };
  await blob.setJSON(LG_LOGINS_V2_KEY, map2);
  /* keep v1 in sync as a running union so downgrades / older admin builds still see something */
  const v1 = (await blob.getJSON(LG_LOGINS_KEY)) || {};
  v1[email] = { email, firstTs: bucket[email].firstTs, lastTs: now, count: Math.max(Number(v1[email]?.count) || 0, bucket[email].count), lastUa: ua };
  await blob.setJSON(LG_LOGINS_KEY, v1);
  return bucket[email];
}

async function handleLgPing(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  const email = String(body?.email || '').toLowerCase().trim();
  /* length cap keeps abuse payloads (mega-strings) out of the login blob */
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'email required' }, 400);
  }
  const now = Date.now();
  const surface = body?.surface === 'admin' ? 'admin' : 'desk';
  const rec = await lgUpsertLogin(surface, email, now, String((request.headers.get('user-agent') || '').slice(0, 120)));
  return json({ ok: true, email, lastTs: rec.lastTs, count: rec.count });
}

async function lgStatsFor(bucket: Record<string, any> | undefined): Promise<any> {
  const users = Object.values(bucket || {})
    .map((r: any) => ({
      email: String(r.email || ''),
      firstTs: Number(r.firstTs) || 0,
      lastTs: Number(r.lastTs) || 0,
      count: Number(r.count) || 0,
      lastUa: String(r.lastUa || ''),
    }))
    .sort((a: any, b: any) => b.lastTs - a.lastTs);
  const now = Date.now();
  const dayStart = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const weekStart = now - 7 * 24 * 60 * 60 * 1000;
  const sessions = users.reduce((s: number, r: any) => s + (Number(r.count) || 0), 0);
  return {
    activeNow: users.filter((r: any) => now - r.lastTs <= LG_ACTIVE_MS).length,
    today: users.filter((r: any) => r.lastTs >= dayStart).length,
    week: users.filter((r: any) => r.lastTs >= weekStart).length,
    total: users.length,
    sessions,
    users,
  };
}

async function handleLgStats(request: Request): Promise<Response> {
  /* Login-activity stats expose visitor emails and user agents → the
     response is restricted to the relay admin (x-jp-admin token). */
  if (!(await adminAuthed(request))) return json({ error: 'admin auth required' }, 401);
  /* v2 = per-surface { desk, admin }; fall back to v1 (legacy union) when empty */
  const v2 = (await blob.getJSON(LG_LOGINS_V2_KEY)) || null;
  const now = Date.now();
  if (v2 && ((v2.desk && Object.keys(v2.desk).length) || (v2.admin && Object.keys(v2.admin).length))) {
    return json({
      ok: true,
      cmd: 'lgStats',
      now,
      desk: await lgStatsFor(v2.desk),
      admin: await lgStatsFor(v2.admin),
      /* top-level: union across both surfaces (back-compat for older admin page) */
      ...await lgStatsFor({ ...(v2.desk || {}), ...(v2.admin || {}) }),
    });
  }
  const map = (await blob.getJSON(LG_LOGINS_KEY)) || {};
  const stats = await lgStatsFor(map);
  return json({ ok: true, cmd: 'lgStats', now, desk: stats, ...stats });
}

/* ───────────── derived allowlist of PUBLISHED projects ─────────────────
   Anonymous ?url= reads must never touch data outside what the admin has
   actually published. The allowlist = every published agile board's project
   keys ∪ the desk projects (DESK_PROJECTS). It is resolved with the stored
   read-only creds, blob-cached (24 h TTL), and rebuilt in the background
   after every publish:set / publish:clear. Fail-closed behaviour: when the
   allowlist cannot be rebuilt, the last cached copy is used; with no cache
   at all only the desk projects are allowed. */
const PUB_PROJECTS_KEY = "jirapulse_pub_projects_v1";
const PUB_PROJECTS_TTL = 24 * 60 * 60 * 1000;
let _pubProjectsCache: { set: Set<string>; freshUntil: number; lastFailAt: number } = {
  set: new Set<string>(DESK_PROJECTS), freshUntil: 0, lastFailAt: 0,
};

async function publishedProjects(force = false): Promise<Set<string>> {
  const now = Date.now();
  if (!force && now < _pubProjectsCache.freshUntil) return _pubProjectsCache.set;
  /* after a failed rebuild, back off for a minute so a Jira outage cannot
     turn every anonymous read into a burst of Jira calls */
  if (!force && now - _pubProjectsCache.lastFailAt < 60_000) return _pubProjectsCache.set;
  const out = new Set<string>(DESK_PROJECTS);
  let fresh: string[] | null = null;
  try {
    const cfg = (await blob.getJSON(PUB_KEY)) as any;
    const bids = ((cfg && Array.isArray(cfg.boards)) ? cfg.boards : [])
      .filter((b: any) => b && b.published !== false)
      .map((b: any) => parseInt(b.boardId, 10))
      .filter((n: number) => Number.isFinite(n) && n > 0);
    const stored = await blob.getJSON(CREDS_KEY);
    if (stored?.domain && stored?.email && stored?.token && bids.length) {
      const base = String(stored.domain).replace(/^https?:\/\//, '').replace(/\/+$/, '');
      const jh: Record<string, string> = {
        'Authorization': 'Basic ' + btoa(stored.email + ':' + stored.token),
        'Accept': 'application/json',
        'User-Agent': 'JiraPulse-Relay/1.0',
      };
      /* per board: project list first, then the board itself (single-project
         boards carry location.projectKey) — a board that fails BOTH marks the
         whole rebuild incomplete so the previous copy stays authoritative */
      const resolved = await Promise.all(bids.map(async (bid: number): Promise<string[] | null> => {
        try {
          const pr = await fetch(`https://${base}/rest/agile/1.0/board/${bid}/project`, { headers: jh, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
          if (pr.ok) {
            const pj = await pr.json();
            const vals = pj?.values || (Array.isArray(pj) ? pj : []);
            const keys = (Array.isArray(vals) ? vals : []).map((p: any) => String(p?.key || '')).filter(Boolean);
            if (keys.length) return keys;
          }
          const br = await fetch(`https://${base}/rest/agile/1.0/board/${bid}`, { headers: jh, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
          if (br.ok) {
            const loc = (await br.json())?.location;
            return loc?.projectKey ? [String(loc.projectKey)] : [];
          }
        } catch { /* single-board failure → rebuild marked incomplete */ }
        return null;
      }));
      if (resolved.every((r) => r !== null)) {
        for (const ks of resolved as string[][]) for (const k of ks) out.add(k);
        fresh = [...out];
      }
    }
  } catch { /* rebuild failed — fall back to the stale copy below */ }
  if (fresh) {
    _pubProjectsCache = { set: new Set<string>(fresh), freshUntil: now + PUB_PROJECTS_TTL, lastFailAt: 0 };
    blob.setJSON(PUB_PROJECTS_KEY, { ts: now, projects: fresh }).catch(() => { /* best-effort */ });
    return _pubProjectsCache.set;
  }
  _pubProjectsCache.lastFailAt = now;
  /* stale copy beats nothing: keeps already-published reads alive across a
     short Jira hiccup instead of failing closed on every popup */
  try {
    const cached = await blob.getJSON(PUB_PROJECTS_KEY) as any;
    if (cached && Array.isArray(cached.projects) && cached.projects.length) {
      _pubProjectsCache.set = new Set<string>(cached.projects.map(String));
    }
  } catch { /* ignore */ }
  return _pubProjectsCache.set;
}

/* ────────────────────────── plain CORS proxy ────────────────────────── */
async function handleProxy(request: Request, u: URL): Promise<Response> {
  const target = u.searchParams.get('url');
  if (!target) {
    return json({ error: 'Missing ?url= parameter or ?cmd= command' }, 400);
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    // tolerate the raw (unencoded) form used by some relay templates
    try { targetUrl = new URL(u.search.slice(5)); }
    catch { return json({ error: 'Invalid ?url= parameter' }, 400); }
  }
  if (targetUrl.protocol !== 'https:' || !ALLOWED_HOST.test(targetUrl.hostname)) {
    return json({ error: 'Only https://*.atlassian.net URLs are allowed' }, 403);
  }

  // Forward only the auth-relevant headers verbatim to Jira
  const headers = new Headers();
  for (const h of ['authorization', 'content-type', 'accept', 'user-agent']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }

  /* ── anonymous reads are scoped to PUBLISHED data ──────────────────────
     Without a viewer Authorization header the stored read-only creds are
     used ONLY for two narrow, published-scope GETs (single-issue detail for
     the card popup, and attachment content for its previews — both proven
     against the derived published-project allowlist first). Every other
     anonymous request goes to Jira without credentials, so Jira itself
     refuses it with 401. Viewers with their own Authorization header are
     unaffected (their creds, their own Jira scope). */
  if (!headers.get('authorization') && request.method === 'GET') {
    let m: RegExpMatchArray | null;
    if ((m = targetUrl.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9_]*-\d+)$/))) {
      return await anonIssueGet(targetUrl, m[1]);
    }
    if ((m = targetUrl.pathname.match(/^\/rest\/api\/3\/attachment\/content\/(\d+)$/))) {
      const jpKey = (u.searchParams.get('jpKey') || '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(jpKey)) {
        return json({ error: 'attachment reads require jpKey (the parent issue key)' }, 400);
      }
      return await anonAttachmentGet(targetUrl, jpKey, m[1]);
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body: (request.method === 'GET' || request.method === 'HEAD')
        ? undefined
        : await request.arrayBuffer(),
      redirect: 'follow',
      signal: AbortSignal.timeout(45_000),
    });
  } catch (e) {
    return json({ error: 'Upstream fetch failed', detail: String(e) }, 502);
  }

  // Relay Jira's response back, with CORS headers added by applyCors()
  const out = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (['content-encoding', 'content-length', 'transfer-encoding',
      'content-security-policy', 'x-frame-options'].includes(lk)) continue;
    out.set(k, v);
  }
  out.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/* Stored read-only credentials, already matched against the target host.
   Shared by both anonymous read paths; 401 when they are absent/mismatched. */
async function storedCredsForHost(host: string): Promise<{ auth: string; base: string } | null> {
  try {
    const stored = await blob.getJSON(CREDS_KEY);
    const storedHost = stored?.domain ? String(stored.domain).replace(/^https?:\/\//, '').replace(/\/+$/, '') : '';
    if (storedHost && stored?.email && stored?.token &&
        storedHost.toLowerCase() === host.toLowerCase()) {
      return { auth: 'Basic ' + btoa(stored.email + ':' + stored.token), base: 'https://' + storedHost };
    }
  } catch { /* fall through */ }
  return null;
}

/* anonymous single-issue GET (?url=…/rest/api/3/issue/{key}?fields=…):
   served with the stored read-only creds ONLY when the issue lives in a
   published project, carries no security level, and its restricted
   comments (visibility-limited / JSM internal) are stripped. Position
   placeholders keep the comment array aligned with ?cmd=deskAttach, whose
   commentIndex values refer to Jira's FULL comment list. */
async function anonIssueGet(targetUrl: URL, key: string): Promise<Response> {
  const [creds, allowed] = await Promise.all([storedCredsForHost(targetUrl.hostname), publishedProjects()]);
  if (!creds) return json({ error: 'no credentials available (viewer not connected and no stored creds)' }, 401);
  /* the caller's field list may omit "security" — force it in so the
     security-restriction check below actually sees the value */
  const up = new URL(targetUrl.toString());
  const fl = (up.searchParams.get('fields') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!fl.includes('security')) fl.push('security');
  up.searchParams.set('fields', fl.join(','));
  let resp: Response;
  try {
    resp = await fetch(up.toString(), {
      method: 'GET',
      headers: { 'authorization': creds.auth, 'accept': 'application/json', 'user-agent': 'JiraPulse-Relay/1.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return json({ error: 'Upstream fetch failed', detail: String(e) }, 502);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return new Response(text || JSON.stringify({ error: `Jira responded with HTTP ${resp.status}` }), {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('content-type') || 'application/json' },
    });
  }
  const text = await resp.text();
  let data: any;
  try { data = JSON.parse(text); } catch { return json({ error: 'unexpected upstream payload' }, 502); }
  const proj = String(data?.fields?.project?.key || '');
  if (!proj || !allowed.has(proj)) return json({ error: 'issue not published' }, 403);
  if (data?.fields?.security != null) return json({ error: 'issue is security-restricted' }, 403);
  const cs = data?.fields?.comment?.comments;
  if (Array.isArray(cs)) {
    /* redact IN PLACE (empty stub) so array positions — and therefore
       attachment commentIndex alignment — stay identical for the client */
    data.fields.comment.comments = cs.map((c: any) =>
      (c?.visibility != null || c?.internal === true || c?.jsdPublic === false)
        ? { id: c?.id, redacted: true, author: {}, body: { type: 'doc', version: 1, content: [] } }
        : c);
  }
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/* anonymous attachment-content GET (?url=…/rest/api/3/attachment/content/{id}
   &jpKey=<parent issue>): the parent issue must live in a published project,
   carry no security level, and actually reference this attachment id — only
   then is the binary streamed with the stored read-only creds. */
async function anonAttachmentGet(targetUrl: URL, jpKey: string, attId: string): Promise<Response> {
  const [creds, allowed] = await Promise.all([storedCredsForHost(targetUrl.hostname), publishedProjects()]);
  if (!creds) return json({ error: 'no credentials available (viewer not connected and no stored creds)' }, 401);
  const jh = { 'authorization': creds.auth, 'accept': 'application/json', 'user-agent': 'JiraPulse-Relay/1.0' };
  let resp: Response;
  try {
    resp = await fetch(`${creds.base}/rest/api/3/issue/${encodeURIComponent(jpKey)}?fields=project,security,attachment`, {
      method: 'GET', headers: jh, redirect: 'follow', signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return json({ error: 'Upstream fetch failed', detail: String(e) }, 502);
  }
  if (!resp.ok) {
    return json({ error: `parent issue lookup failed (HTTP ${resp.status})` }, resp.status === 404 ? 404 : 502);
  }
  let issue: any;
  try { issue = await resp.json(); } catch { return json({ error: 'unexpected upstream payload' }, 502); }
  const proj = String(issue?.fields?.project?.key || '');
  if (!proj || !allowed.has(proj)) return json({ error: 'issue not published' }, 403);
  if (issue?.fields?.security != null) return json({ error: 'issue is security-restricted' }, 403);
  const list: any[] = Array.isArray(issue?.fields?.attachment) ? issue.fields.attachment : [];
  if (!list.some((a: any) => String(a?.id || '') === attId)) {
    return json({ error: 'attachment does not belong to this issue' }, 403);
  }
  let upstream: Response;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: 'GET', headers: jh, redirect: 'follow', signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return json({ error: 'Upstream fetch failed', detail: String(e) }, 502);
  }
  const out = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (['content-encoding', 'content-length', 'transfer-encoding',
      'content-security-policy', 'x-frame-options'].includes(lk)) continue;
    out.set(k, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// Val Town HTTP val entrypoint: the platform invokes the default export
// per-request — do NOT call Deno.serve here.
export default handler;
