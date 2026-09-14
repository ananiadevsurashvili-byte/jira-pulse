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

const ALLOWED_HOST = /(^|\.)atlassian\.net$/i;

/* blob keys (Val Town blobs are account-scoped, so prefix for safety) */
const PUB_KEY = "jirapulse_publish_v1";
const ADMIN_KEY = "jirapulse_publish_admin_v1";
const CREDS_KEY = "jirapulse_creds_v1";

/* admin token: static shared secret minted at first deploy. It only guards
   WHICH config is written; the Jira data itself stays behind Jira auth. */
const DEFAULT_ADMIN_TOKEN = "jp_k9R2vTq7Lm4wXy8Zp3nB6dF1sH5jC";

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, x-jp-admin',
  'Access-Control-Max-Age': '86400',
};

/* ────────────────────────── entrypoint ────────────────────────── */
async function handler(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
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
        const stored = (await blob.getJSON(ADMIN_KEY)) || DEFAULT_ADMIN_TOKEN;
        const token = request.headers.get('x-jp-admin') || '';
        if (!token || token !== stored) return json({ error: 'admin auth required' }, 401);
        let body: unknown;
        try { body = await request.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
        if (!body || typeof body !== 'object') return json({ error: 'config must be an object' }, 400);
        await blob.setJSON(ADMIN_KEY, stored);          // make sure the key exists
        await blob.setJSON(PUB_KEY, body);
        return json({ ok: true, savedAt: Date.now() });
      }

      if (cmd === 'publish:clear') {
        const stored = (await blob.getJSON(ADMIN_KEY)) || DEFAULT_ADMIN_TOKEN;
        const token = request.headers.get('x-jp-admin') || '';
        if (!token || token !== stored) return json({ error: 'admin auth required' }, 401);
        await blob.setJSON(PUB_KEY, null);
        return json({ ok: true });
      }

      if (cmd === 'creds:set') {
        const stored = (await blob.getJSON(ADMIN_KEY)) || DEFAULT_ADMIN_TOKEN;
        const token = request.headers.get('x-jp-admin') || '';
        if (!token || token !== stored) return json({ error: 'admin auth required' }, 401);
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
    authHeader = 'Basic ' + btoa(stored.email + ':' + stored.token);
    domain = stored.domain;
  }
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

  /* ── 1. board context: type/location/config-filter/projects ── */
  const [boardResp, cfgResp, projectsResp] = await Promise.all([
    get(`/rest/agile/1.0/board/${bid}`).catch(() => null),
    get(`/rest/agile/1.0/board/${bid}/configuration`).catch(() => null),
    get(`/rest/agile/1.0/board/${bid}/project`).catch(() => null),
  ]);
  let filterId: string | null = null;
  try { filterId = (await cfgResp?.json())?.filter?.id || null; } catch { /* ignore */ }
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
  let filterJql = '';
  if (filterId) {
    try {
      const fResp = await get(`/rest/api/3/filter/${filterId}`);
      if (fResp.ok) filterJql = (await fResp.json())?.jql || '';
    } catch { /* ignore */ }
  }

  /* ── 2. search: project-wide JQL first (full fields incl. resolutiondate),
        then filter JQL, then the board issue endpoint ── */
  const FIELDS = 'summary,status,resolutiondate,created,issuetype,assignee,priority,labels';
  const MAX_TOTAL = 600;
  const withChangelog = mode === 'full';

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
        qp.set('fields', FIELDS);
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
      const resp = await get(`/rest/agile/1.0/board/${bid}/issue?startAt=${startAt}&maxResults=50&fields=${encodeURIComponent(FIELDS)}`).catch(() => null);
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

  const hasChangelog = issues.some((i) => i?.changelog?.histories?.length);

  return json({
    ok: true,
    boardId: bid,
    source,
    mode,
    hasChangelog,
    count: issues.length,
    fetchedAt: Date.now(),
    issues,
  });
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

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body: (request.method === 'GET' || request.method === 'HEAD')
        ? undefined
        : await request.arrayBuffer(),
      redirect: 'follow',
    });
  } catch (e) {
    return json({ error: 'Upstream fetch failed', detail: String(e) }, 502);
  }

  // Relay Jira's response back, with CORS headers added
  const out = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (['content-encoding', 'content-length', 'transfer-encoding',
      'content-security-policy', 'x-frame-options'].includes(lk)) continue;
    out.set(k, v);
  }
  out.set('Access-Control-Allow-Origin', '*');
  out.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// Val Town HTTP val entrypoint: the platform invokes the default export
// per-request — do NOT call Deno.serve here.
export default handler;

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
