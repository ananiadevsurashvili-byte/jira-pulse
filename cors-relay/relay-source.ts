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

const ALLOWED_HOST = /(^|\.)atlassian\.net$/i;

/* blob keys (Val Town blobs are account-scoped, so prefix for safety) */
const PUB_KEY = "jirapulse_publish_v1";
const ADMIN_KEY = "jirapulse_publish_admin_v1";
const CREDS_KEY = "jirapulse_creds_v1";

/* ── Logistics viewer page (?cmd=desk) ── */
const DESK_EXCLUDE_LABEL = "Internal";
const DESK_FIELDS_BASE = "summary,description,status,created,updated,assignee,reporter,labels,comment";

/* desk response blob-cache: one full LOG sync costs ~40 sequential Jira
   pages; caching the finished result (even very briefly) makes page
   revisits and multi-viewer bursts near-instant. Freshness remains
   viewer-controlled: ?fresh=1 bypasses and re-syncs. */
const DESK_CACHE_KEY = "jirapulse_desk_cache_v1";
const DESK_CACHE_TTL = 60 * 1000;

/* ADF (Atlassian Document Format) body → plain text, one line per block */
function adfToText(doc: any): string {
  if (doc == null) return "";
  if (typeof doc === "string") return doc;
  if (Array.isArray(doc)) return doc.map(adfToText).filter(Boolean).join("\n");
  if (typeof doc !== "object") return "";
  let text = "";
  if (Array.isArray(doc.content)) text = adfToText(doc.content);
  else if (doc.text != null) text = String(doc.text);
  const blocks = ["paragraph", "heading", "bulletList", "orderedList", "codeBlock", "blockquote"];
  if (blocks.includes(doc.type)) return text ? text + "\n" : "";
  return text;
}

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

      if (cmd === 'desk') {
        return await handleDeskCmd(u, request);
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
  const FIELDS = 'summary,status,resolutiondate,created,updated,issuetype,assignee,priority,labels';
  const MAX_TOTAL = 600;
  const withChangelog = mode === 'full';

  /* discover the "Change Request Complexity" custom field id from the field catalog
     (ids differ per Jira instance and unknown ids are silently dropped from `fields`)
     so the complexity distribution charts work for public viewers too */
  let complexityFieldId = '';
  try {
    const fResp = await get('/rest/api/3/field');
    if (fResp.ok) {
      const catalog: any[] = await fResp.json();
      const wanted = catalog.find((f) => f && f.custom && /change request complexity/i.test(f.name || ''))
        || catalog.find((f) => f && f.custom && /complexity/i.test(f.name || ''));
      if (wanted?.id) complexityFieldId = String(wanted.id);
    }
  } catch { /* best-effort — charts just show "no data" without it */ }
  const SEARCH_FIELDS = complexityFieldId ? `${FIELDS},${complexityFieldId}` : FIELDS;

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

/* ─────────────── live Service Desk fetch for the Logistics page ───────────────
   Sibling of handleBoardCmd for Service Desk projects that have no agile board.
   ?cmd=desk&project=<KEY>&domain=<host>&directionField=<id>&titleField=<id>
   Returns ALL project issues EXCLUDING label "Internal" (Jira's NOT IN on the
   multi-value labels field has "any value" edge semantics, so we re-filter the
   results server-side too — the viewer page filters a third time client-side).
   Credentials: viewer's own Authorization header wins; else the admin's stored
   read-only Jira credentials (same rules as ?cmd=board). */
async function handleDeskCmd(u: URL, request: Request): Promise<Response> {
  const project = (u.searchParams.get('project') || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,9}$/.test(project)) {
    return json({ error: 'invalid project' }, 400);
  }
  const domainParam = (u.searchParams.get('domain') || '').trim();
  const forceFresh = u.searchParams.get('fresh') === '1';

  /* short-lived response cache: another viewer (or a revisit within the
     TTL) gets the last synced payload immediately instead of paying the
     ~40-page Jira sync again */
  if (!forceFresh) {
    try {
      const cached = await blob.getJSON(DESK_CACHE_KEY) as any;
      if (cached && cached.data && cached.ts && Date.now() - cached.ts < DESK_CACHE_TTL) {
        return json({ ...cached.data, cached: true, cacheAge: Date.now() - cached.ts });
      }
    } catch { /* cache miss — fall through to the live sync */ }
  }

  /* credentials: identical rules to handleBoardCmd */
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
  /* normalize scheme: app may send scheme-less "x.atlassian.net" */
  if (domain && !/^https:\/\//i.test(domain)) domain = 'https://' + domain;
  if (!domain || !/^https:\/\/[a-z0-9.-]+\.atlassian\.net$/i.test(domain)) {
    return json({ error: 'no usable Jira domain' }, 401);
  }
  const base = domain.replace(/\/+$/, '');

  const jh: Record<string, string> = {
    'Authorization': authHeader,
    'Accept': 'application/json',
    'User-Agent': 'JiraPulse-Relay/1.0',
  };
  const get = async (path: string): Promise<Response> => {
    return await fetch(base + path, { method: 'GET', headers: jh, redirect: 'follow' });
  };

  /* ── custom field discovery: "Logistics direction" + "Title" ──
     (ids differ per instance; overridable via query params) */
  let directionFieldId = (u.searchParams.get('directionField') || '').trim();
  let titleFieldId = (u.searchParams.get('titleField') || '').trim();
  let directionFieldName = '';
  let titleFieldName = '';
  let titleCandidates: { id: string; name: string }[] = [];
  try {
    const fResp = await get('/rest/api/3/field');
    if (fResp.ok) {
      const catalog: any[] = await fResp.json();
      if (!directionFieldId) {
        const dir = catalog.find((f) => f && f.custom && /^logistics direction$/i.test(f.name || ''))
          || catalog.find((f) => f && f.custom && /logistics/i.test(f.name || ''));
        if (dir?.id) { directionFieldId = String(dir.id); directionFieldName = String(dir.name || ''); }
      }
      if (!titleFieldId) {
        /* strict auto-match only (exact names); anything else that merely
           CONTAINS "title" is reported as a candidate list instead, so a
           wrong look-alike field (e.g. "Problem Title Reminder Red") can
           never hijack the column */
        const ttl = catalog.find((f) => f && f.custom && /^title$/i.test(f.name || ''))
          || catalog.find((f) => f && f.custom && /^request title$/i.test(f.name || ''));
        if (ttl?.id) { titleFieldId = String(ttl.id); titleFieldName = String(ttl.name || ''); }
        titleCandidates = catalog
          .filter((f) => f && f.custom && /title/i.test(f.name || ''))
          .slice(0, 12)
          .map((f) => ({ id: String(f.id), name: String(f.name) }));
      }
    }
  } catch { /* best-effort — columns just come back empty without it */ }

  const SEARCH_FIELDS = [DESK_FIELDS_BASE, directionFieldId, titleFieldId]
    .filter(Boolean).join(',');

  /* paged search — same shape as handleBoardCmd.searchJql (no changelog here).
     MAX_TOTAL 4000 with two full re-fetch passes: effectively syncs ALL LOG
     tasks (currently ~2.4k, headroom to grow). jqlTotal + truncated report
     how many issues Jira actually matched, so truncation is visible. */
  const MAX_TOTAL = 4000;
  let jqlTotal = 0;
  let jqlTruncated = false;
  async function searchJql(jql: string): Promise<any[] | null> {
    const out: any[] = [];
    /* start optimistic: /search/jql takes maxResults up to ~1000 — that cuts
       a full LOG sync from ~40 sequential pages to ~4, which is most of the
       first-load wait. On 413 the shrink-and-retry below stays safe. */
    let pageSize = 1000;
    for (let pass = 0; pass < 4; pass++) {
      /* pass 1: read the first page just to learn `total` (and honor 413) */
      out.length = 0;   /* a shrink-retry pass must restart clean */
      const qp0 = new URLSearchParams();
      qp0.set('jql', jql);
      qp0.set('fields', SEARCH_FIELDS);
      qp0.set('maxResults', String(pageSize));
      let firstPage: any;
      try {
        const resp = await get(`/rest/api/3/search/jql?${qp0.toString()}`);
        if (resp.status === 413 && pageSize > 1) { pageSize = Math.max(1, Math.floor(pageSize / 2)); continue; }
        if (resp.status === 410 || resp.status === 400) return null;
        if (!resp.ok) return null;
        firstPage = await resp.json();
      } catch { return null; }
      if (typeof firstPage.total === 'number') jqlTotal = firstPage.total;
      if (Array.isArray(firstPage.issues)) out.push(...firstPage.issues);
      let nextPageToken: string | null = firstPage.nextPageToken || null;
      while (nextPageToken && out.length < MAX_TOTAL) {
        const qp = new URLSearchParams();
        qp.set('jql', jql);
        qp.set('fields', SEARCH_FIELDS);
        qp.set('maxResults', String(pageSize));
        qp.set('nextPageToken', nextPageToken);
        let resp: Response;
        try { resp = await get(`/rest/api/3/search/jql?${qp.toString()}`); } catch { return null; }
        if (resp.status === 413 && pageSize > 1) { pageSize = Math.max(1, Math.floor(pageSize / 2)); continue; }
        if (resp.status === 410 || resp.status === 400) return null;
        if (!resp.ok) return null;
        let page: any;
        try { page = await resp.json(); } catch { return null; }
        if (typeof page.total === 'number') jqlTotal = page.total;
        if (Array.isArray(page.issues)) out.push(...page.issues);
        if (page.isLast === true || !page.nextPageToken) break;
        nextPageToken = page.nextPageToken;
      }
      jqlTruncated = out.length < (jqlTotal || out.length) || out.length >= MAX_TOTAL;
      return out.slice(0, MAX_TOTAL);
    }
    return null;
  }

  const jql = `project in ("${project}") AND (labels is EMPTY OR labels NOT IN ("${DESK_EXCLUDE_LABEL}")) ORDER BY created DESC`;
  let issues = await searchJql(jql);
  if (!issues) return json({ error: 'could not load project issues from Jira' }, 502);

  /* server-side re-filter: JQL NOT IN on multi-value fields can still match
     issues that carry the excluded label among others */
  issues = issues.filter((i) => !((i.fields?.labels || []) as string[])
    .some((l: unknown) => String(l).toLowerCase() === DESK_EXCLUDE_LABEL.toLowerCase()));

  /* slim comments: keep only the LAST 3 per issue, flattened to plain text —
     keeps the payload small (description ADF is already dropped by the API
     when "comment" is requested as a list of bodies). */
  for (const iss of issues) {
    const comments = iss.fields?.comment?.comments;
    if (Array.isArray(comments) && comments.length) {
      iss.fields.comment = comments.slice(-3).map((c: any) => ({
        author: String(c?.author?.displayName || ''),
        created: String(c?.created || ''),
        body: adfToText(c?.body),
      }));
    } else {
      delete iss.fields.comment;
    }
  }

  /* ── slim the wire format (big download win) ──
     The viewer only reads: key, summary, status.name, created, updated,
     assignee.displayName, reporter.displayName, labels, the direction
     custom field, description (plain text) and comment. Everything else
     per issue (expand, self, id, avatar URLs inside users, the direction
     object's self/id links, per-comment created string, ADF document)
     was dead weight — ADF alone is hundreds of bytes per issue when the
     client's own renderer already handles plain text fine. */
  const slimIssues = issues.map((iss: any) => {
    const f = iss.fields || {};
    const directionVal = directionFieldId ? f[directionFieldId] : undefined;
    const dirTxt = directionVal && typeof directionVal === 'object'
      ? [directionVal.value, directionVal.child?.value].filter(Boolean).join(' / ')
      : (directionVal == null ? '' : String(directionVal));
    const out: any = {
      key: String(iss.key || ''),
      fields: {
        summary: String(f.summary || ''),
        status: { name: String(f.status?.name || '') },
        created: String(f.created || ''),
        updated: String(f.updated || ''),
        assignee: f.assignee ? { displayName: String(f.assignee.displayName || '') } : null,
        reporter: f.reporter ? { displayName: String(f.reporter.displayName || '') } : null,
        labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
        comment: Array.isArray(f.comment) ? f.comment : [],
      },
    };
    if (directionFieldId) {
      out.fields[directionFieldId] = dirTxt;   /* plain text — lgNormCustom passes strings through */
    }
    if (f.description != null) {
      out.fields.description = adfToText(f.description);  /* plain text; client renders both */
    }
    return out;
  });
  issues = null as any;   /* let the raw ADF copy be GC-able before stringifying */

  const result: any = {
    ok: true,
    cmd: 'desk',
    project,
    count: slimIssues.length,
    jqlTotal: jqlTotal || slimIssues.length,
    truncated: jqlTruncated || jqlTotal > slimIssues.length,
    fetchedAt: Date.now(),
    fieldIds: { direction: directionFieldId || null, title: titleFieldId || null },
    fieldNames: { direction: directionFieldName, title: titleFieldName },
    titleCandidates,
    issues: slimIssues,
  };

  /* publish the finished payload to the short-TTL blob cache (best-effort) */
  try {
    await blob.setJSON(DESK_CACHE_KEY, { ts: Date.now(), data: result });
  } catch { /* non-fatal */ }

  return json(result);
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
