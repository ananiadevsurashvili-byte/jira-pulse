/**
 * JiraPulse relay — desk family: ?cmd=desk, ?cmd=deskAttach, ?cmd=deskSla.
 * Split out of main.tsx (relay-source.ts) to stay under Val Town's
 * 80,000-character per-file limit. Shared blob keys + json() come from
 * ./shared.ts.
 */
import { blob } from "https://esm.town/v/std/blob";
import {
  CREDS_KEY,
  DESK_CACHE_KEY,
  DESK_CACHE_TTL,
  DESK_EXCLUDE_LABEL,
  DESK_FIELDS_BASE,
  DESK_PROJECTS,
  json,
} from "./shared.ts";
/* ADF (Atlassian Document Format) body → plain text, one line per block.
   media/mediaInline/mediaSingle nodes emit the SAME " 📷 " marker the
   in-app renderer (jpAdfText) emits, so the desk-payload path can paint
   image placeholders exactly like the per-issue detail path does. */
function adfToText(doc: any): string {
  if (doc == null) return "";
  if (typeof doc === "string") return doc;
  if (Array.isArray(doc)) return doc.map(adfToText).filter(Boolean).join("\n");
  if (typeof doc !== "object") return "";
  if (doc.type === "media" || doc.type === "mediaInline") return " 📷 ";
  let text = "";
  if (Array.isArray(doc.content)) text = adfToText(doc.content);
  else if (doc.text != null) text = String(doc.text);
  const blocks = ["paragraph", "heading", "bulletList", "orderedList", "codeBlock", "blockquote", "mediaSingle"];
  if (blocks.includes(doc.type)) return text ? text + "\n" : "";
  return text;
}

/* ordered media entries of an ADF body (media UUID + alt filename) —
   the desk payload attaches these lists so the client can slot the
   matching attachment (resolved later via ?cmd=deskAttach) into every
   📷 marker it paints. Same shape the per-issue detail path builds. */
function adfMediaNodes(doc: any): { id: string; alt: string }[] {
  const list: { id: string; alt: string }[] = [];
  const walk = (n: any): void => {
    if (n == null) return;
    if (Array.isArray(n)) { for (const c of n) walk(c); return; }
    if (typeof n !== "object") return;
    if (n.type === "media" || n.type === "mediaInline") {
      /* the bare media node carries the real UUID+alt; wrappers like
         mediaSingle do NOT — descend into them instead of recording
         an empty entry (desc images all resolved as id:"" before) */
      list.push({
        id: n?.attrs?.id != null ? String(n.attrs.id) : "",
        alt: n?.attrs?.alt != null ? String(n.attrs.alt) : "",
      });
      return;
    }
    if (Array.isArray(n.content)) walk(n.content);
    if (n.body && typeof n.body === "object") walk(n.body);
  };
  walk(doc);
  return list;
}
/* ─────────────── live Service Desk fetch for the Logistics page ───────────────
   Sibling of handleBoardCmd for Service Desk projects that have no agile board.
   ?cmd=desk&project=<KEY>&domain=<host>&directionField=<id>&titleField=<id>
   Returns ALL project issues EXCLUDING label "Internal" (Jira's NOT IN on the
   multi-value labels field has "any value" edge semantics, so we re-filter the
   results server-side too — the viewer page filters a third time client-side).
   Credentials: viewer's own Authorization header wins; else the admin's stored
   read-only Jira credentials (same rules as ?cmd=board). */
/* compact SLA aspect from a BULK search custom field (desk payload).
   Response picks the earliest completed cycle (first agent reply, JSM can
   accumulate), falling back to the ongoing one; resolution picks the last
   completed cycle (actual settlement), falling back to ongoing. Only the
   numbers the client needs are kept — wire-size friendly at ~4k issues. */
function bulkSlaAspect(cf: any, isResp: boolean) {
  if (!cf || typeof cf !== 'object') return null;
  const completed: any[] = Array.isArray(cf.completedCycles) ? cf.completedCycles : [];
  const ongoing: any = cf.ongoingCycle || null;
  let pick: any = null;
  if (isResp) {
    for (const c of completed) {
      const s = Number(c?.stopTime?.epochMillis) || 0;
      if (!pick || s < pick.s) pick = { c, s, done: true };
    }
    if (!pick && ongoing) pick = { c: ongoing, s: 0, done: false };
  } else {
    if (completed.length) pick = { c: completed[completed.length - 1], s: 0, done: true };
    else if (ongoing) pick = { c: ongoing, s: 0, done: false };
  }
  if (!pick) return null;
  const c = pick.c;
  return {
    elapsedMs: Number(c?.elapsedTime?.millis) || 0,
    goalMs: Number(c?.goalDuration?.millis) || 0,
    breached: c?.breached === true || String(c?.breached) === 'true',
    completed: pick.done,
    startMs: Number(c?.startTime?.epochMillis) || 0,
    stopMs: Number(c?.stopTime?.epochMillis) || 0,
  };
}

export async function handleDeskCmd(u: URL, request: Request): Promise<Response> {
  const project = (u.searchParams.get('project') || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,9}$/.test(project)) {
    return json({ error: 'invalid project' }, 400);
  }
  const domainParam = (u.searchParams.get('domain') || '').trim();
  const forceFresh = u.searchParams.get('fresh') === '1';
  /* captured before the creds block reassigns authHeader (see handleBoardCmd:
     viewer-cred fetches must not feed the shared cache) */
  const hadViewerAuth = !!request.headers.get('authorization');

  /* ── period filter (server-side, carried into the JQL itself) ──
     from/to are absolute ISO-8601 datetimes with an explicit UTC offset
     (yyyy-MM-dd'T'HH:mm:ss.SSS±ZZZZ) computed by the client. Absolute +
     self-describing timezone means the window is exact no matter where
     the client, this relay or Jira's server sit. Expanded server-side
     the "last 30 days" view downloads a few hundred issues instead of
     the whole ~4k project — that's the fast default. */
  const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/;
  const fromQ = (u.searchParams.get('from') || '').trim();
  const toQ = (u.searchParams.get('to') || '').trim();
  if ((fromQ && !TS_RE.test(fromQ)) || (toQ && !TS_RE.test(toQ))) {
    return json({ error: 'invalid from/to (expected ISO-8601 with UTC offset)' }, 400);
  }
  /* anonymous reads may only touch published desk projects (see DESK_PROJECTS);
     viewers bringing their own Authorization header are unrestricted */
  if (!request.headers.get('authorization') && !DESK_PROJECTS.has(project)) {
    return json({ error: 'project not published' }, 403);
  }
  /* each project+window gets its own short-TTL cache slot: the cache key
     MUST include the project — without it a LOG sync overwrote the single
     slot and every other project's viewer read the wrong project's issues
     (boards rendered with an empty description/comments/reporter overlay) */
  const deskKey = DESK_CACHE_KEY + ':' + project +
    ((fromQ || toQ) ? ':' + fromQ + '..' + toQ : '');

  /* short-lived response cache: another viewer (or a revisit within the
     TTL) gets the last synced payload immediately instead of paying the
     ~40-page Jira sync again */
  if (!forceFresh) {
    try {
      const cached = await blob.getJSON(deskKey) as any;
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
  let slaRespFieldId = (u.searchParams.get('slaRespField') || '').trim();
  let slaResFieldId = (u.searchParams.get('slaResField') || '').trim();
  let directionFieldName = '';
  let titleFieldName = '';
  let titleCandidates: { id: string; name: string }[] = [];
  try {
    const fResp = await get('/rest/api/3/field');
    if (fResp.ok) {
      const catalog: any[] = await fResp.json();
      if (!slaRespFieldId) {
        const fr = catalog.find((f) => f && f.custom && /^time to first response$/i.test(f.name || ''));
        if (fr?.id) slaRespFieldId = String(fr.id);
      }
      if (!slaResFieldId) {
        const rs = catalog.find((f) => f && f.custom && /^time to resolution$/i.test(f.name || ''));
        if (rs?.id) slaResFieldId = String(rs.id);
      }
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

  const SEARCH_FIELDS = [DESK_FIELDS_BASE, directionFieldId, titleFieldId, slaRespFieldId, slaResFieldId]
    .filter(Boolean).join(',') + (hadViewerAuth ? '' : ',security');

  /* paged search — same shape as handleBoardCmd.searchJql (no changelog here).
     MAX_TOTAL 8000 with two full re-fetch passes: effectively syncs ALL LOG
     tasks (currently ~4k, headroom to grow). jqlTotal + truncated report
     how many issues Jira actually matched, so truncation is visible.
     (Phase R: raised from 4000 because the real count had reached the cap
     and the user needs the TRUE total in All-time mode.) */
  const MAX_TOTAL = 8000;
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

  /* period window narrows the JQL itself — Jira only returns (and we only
     download) the issues inside the requested range.
     NOTE: this Jira instance's `created` comparisons only match with plain
     date strings ("2026-09-10") — a full ISO stamp with ".000+0400" silently
     matches NOTHING even though the query returns 200. So we normalize the
     incoming ISO stamps to date-only bounds: from = inclusive day, to =
     exclusive next-day (`created < "yyyy-mm-dd"` covers the whole end day). */
  const periodParts: string[] = [];
  if (fromQ) periodParts.push(`created >= "${fromQ.slice(0, 10)}"`);
  if (toQ) {
    /* bump the end date by one day so the entire "to" day is included */
    const dEnd = new Date(toQ.slice(0, 10) + 'T00:00:00Z');
    dEnd.setUTCDate(dEnd.getUTCDate() + 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    const nextDay = `${dEnd.getUTCFullYear()}-${pad(dEnd.getUTCMonth() + 1)}-${pad(dEnd.getUTCDate())}`;
    periodParts.push(`created < "${nextDay}"`);
  }
  const periodJql = periodParts.length ? ' AND ' + periodParts.join(' AND ') : '';

  const jql = `project in ("${project}") AND (labels is EMPTY OR labels NOT IN ("${DESK_EXCLUDE_LABEL}"))${periodJql} ORDER BY created DESC`;
  let issues = await searchJql(jql);
  if (!issues) return json({ error: 'could not load project issues from Jira' }, 502);

  /* server-side re-filter: JQL NOT IN on multi-value fields can still match
     issues that carry the excluded label among others */
  issues = issues.filter((i) => !((i.fields?.labels || []) as string[])
    .some((l: unknown) => String(l).toLowerCase() === DESK_EXCLUDE_LABEL.toLowerCase()));

  /* anonymous viewers must not see security-restricted issues (same rule as
     handleBoardCmd; logged-in viewers keep their own Jira scope) */
  if (!hadViewerAuth) {
    issues = issues.filter((i) => i?.fields?.security == null);
  }

  /* slim comments: keep only the LAST 10 public ones per issue, flattened
     to plain text — keeps the payload small (description ADF is already
     dropped by the API when "comment" is requested as a list of bodies).
     Internal notes (Jira "internal" flag / JSM jsdPublic=false) are dropped
     server-side: this payload goes to the public page, so those must never
     leave the relay. 10 instead of 3: the task-list comments column reads
     ONLY this payload, so an earlier comment that carries inline images
     (e.g. a 6th comment holding screenshots) must still be shipped. */
  const DESK_COMMENTS_MAX = 10;
  for (const iss of issues) {
    const comments = iss.fields?.comment?.comments;
    if (Array.isArray(comments) && comments.length) {
      /* idx = the comment's position in Jira's FULL comment list —
         deskAttach reports comment attachments against the full list, so
         the client needs this anchor to place images inside the right
         comment even though only the last N are transmitted. */
      const visible = (comments as any[])
        .map((c: any, i: number) => ({ c, i }))
        .filter(({ c }) => !(c?.internal === true || c?.jsdPublic === false));
      iss.fields.comment = visible.slice(-DESK_COMMENTS_MAX).map(({ c, i }) => ({
        idx: i,
        author: String(c?.author?.displayName || ''),
        created: String(c?.created || ''),
        body: adfToText(c?.body),
        /* media nodes pasted INTO this comment (UUID + alt filename) —
           the client maps them against ?cmd=deskAttach results to slot
           inline images under THIS comment (same as the detail path) */
        media: adfMediaNodes(c?.body),
      }));
      if (!iss.fields.comment.length) delete iss.fields.comment;
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
        resolution: f.resolution ? { name: String(f.resolution.name || '') } : null,
        resolutiondate: f.resolutiondate ? String(f.resolutiondate) : null,
        created: String(f.created || ''),
        updated: String(f.updated || ''),
        assignee: f.assignee ? { displayName: String(f.assignee.displayName || '') } : null,
        reporter: f.reporter ? { displayName: String(f.reporter.displayName || '') } : null,
        labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
        comment: Array.isArray(f.comment) ? f.comment : [],
        /* just file counts + tiny mime info — enough for a 📎 badge on the
           table row; binaries are never fetched here */
        attachment: Array.isArray(f.attachment)
          ? f.attachment.map((a: any) => ({
              filename: String(a?.filename || ''),
              mimeType: String(a?.mimeType || ''),
            }))
          : [],
        /* Jira's OWN SLA clocks (same data the agent view shows) — one
           compact settled-cycle per aspect so every chart/KPI/list chip can
           aggregate from Jira's verdict instead of a client approximation.
           Completed cycles often report elapsedTime "0m" (NEW_SLA_FORMAT),
           but start/stop hold the real settlement window — the client
           recomputes from those when needed. */
        sla: bulkSlaAspect(f[slaRespFieldId], true) || undefined,
        slaRes: bulkSlaAspect(f[slaResFieldId], false) || undefined,
      },
    };
    if (directionFieldId) {
      out.fields[directionFieldId] = dirTxt;   /* plain text — lgNormCustom passes strings through */
    }
    if (f.description != null) {
      out.fields.description = adfToText(f.description);  /* plain text; client renders both */
    }
    /* ordered description media (media UUID + alt filename) — the client
       paints one placeholder slot per 📷 marker in the description text
       and slots the matching ?cmd=deskAttach attachment into each */
    out.fields.descMedia = adfMediaNodes(f.description);
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
    period: { from: fromQ || null, to: toQ || null },
    fieldIds: { direction: directionFieldId || null, title: titleFieldId || null },
    fieldNames: { direction: directionFieldName, title: titleFieldName },
    slaFieldIds: { resp: slaRespFieldId || null, res: slaResFieldId || null },
    titleCandidates,
    issues: slimIssues,
  };

  /* publish the finished payload to the short-TTL blob cache (best-effort).
     Only stored-cred fetches may feed the SHARED cache — a viewer-cred sync
     reflects that one viewer's Jira scope. */
  if (!hadViewerAuth) {
    try {
      await blob.setJSON(deskKey, { ts: Date.now(), data: result });
    } catch { /* non-fatal */ }
  }

  return json(result);
}

/* ─────────── attachments for ONE issue (?cmd=deskAttach) ────────────────
   `?cmd=desk` intentionally leaves attachments OUT of the bulk payload —
   adding metadata for ~4k issues would balloon the sync and slow the
   download. Instead, when the logistics task card opens, the client asks
   for exactly ONE issue here. Everything it might show is resolved in a
   single Jira call:

   - GET /rest/api/3/issue/{key}?fields=attachment,comment
     → task-level attachments (fields.attachment[])
     → FULL ADF comment bodies, walked for `media` nodes. Pasted-in
       comments carry media UUIDs (attrs.id), which are mapped to real
       attachment ids via fields.attachment[].mediaId (Jira links them) —
       so images shown INLINE in a comment are surfaced as that comment's
       attachments, not just listed at the issue level.

   Response (json):
     { ok, cmd:'deskAttach', key, attachments: [ { id, filename, mimeType,
       size, created, author, contentUrl, commentIndex | null } ],
     commentCount }

   Binary file bodies are NOT proxied from here — the client previews via
   the plain CORS proxy (`?url=<contentUrl>`) it already knows how to use. */
export async function handleDeskAttachCmd(u: URL, request: Request): Promise<Response> {
  const key = (u.searchParams.get('key') || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
    return json({ error: 'invalid key' }, 400);
  }
  const domainParam = (u.searchParams.get('domain') || '').trim();

  /* credentials: identical rules to handleDeskCmd (viewer-first, then storing creds) */
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
    /* anonymous reads stay inside the published desk projects (DESK_PROJECTS) */
    if (!DESK_PROJECTS.has(key.split('-')[0])) {
      return json({ error: 'issue not in a published desk project' }, 403);
    }
    authHeader = 'Basic ' + btoa(stored.email + ':' + stored.token);
    domain = stored.domain;
  }
  /* normalize scheme: app may send scheme-less "x.atlassian.net" */
  if (domain && !/^https:\/\//i.test(domain)) domain = 'https://' + domain;
  if (!domain || !/^https:\/\/[a-z0-9.-]+\.atlassian\.net$/i.test(domain)) {
    return json({ error: 'no usable Jira domain' }, 400);
  }
  const base = domain.replace(/\/+$/, '');

  const resp = await fetch(base + '/rest/api/3/issue/' + encodeURIComponent(key) +
    '?fields=attachment,comment', {
    method: 'GET',
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json',
      'User-Agent': 'JiraPulse-Relay/1.0',
    },
    redirect: 'follow',
  });
  if (!resp.ok) {
    return json({ error: `Jira fetch failed (HTTP ${resp.status})` }, resp.status === 404 ? 404 : 502);
  }
  const issue = await resp.json();
  const f = issue?.fields || {};

  /* media UUID → attachment id map. For attachments Jira stores
     fields.attachment[].mediaId which IS the ADF media attrs.id. */
  const mediaToAttach = new Map<string, any>();
  const attachList: any[] = Array.isArray(f.attachment) ? f.attachment : [];
  for (const a of attachList) {
    if (a && a.mediaId && a.id) mediaToAttach.set(String(a.mediaId), a);
  }

  /* walk FULL ADF comment bodies for media nodes: a media node's attrs.id
     is a media UUID — map it via mediaToAttach (Jira sets mediaId on the
     matching attachment). Anything referenced but missing from the map
     (e.g. cross-issue media) is skipped. attrs.alt (when present) is the
     FILENAME of the embedded media — this matters because on this Jira
     instance image attachments often come back with an EMPTY mediaId, so
     the UUID map alone matches nothing and inline comment images would
     never slot into their comment. We keep both signals. */
  const mediaInComments: { id: string; alt: string; commentIndex: number }[] = [];
  const walkAdf = (node: any, ci: number) => {
    if (node == null) return;
    if (Array.isArray(node)) { for (const n of node) walkAdf(n, ci); return; }
    if (typeof node !== 'object') return;
    if (node.type === 'media' || node.type === 'mediaInline' || node.type === 'mediaSingle') {
      const mid = node?.attrs?.id != null ? String(node.attrs.id) : '';
      /* ADF alt for media nodes is the original filename, e.g.
         "image-20260727-094602.png" */
      const alt = node?.attrs?.alt != null ? String(node.attrs.alt) : '';
      if (mid || alt) mediaInComments.push({ id: mid, alt, commentIndex: ci });
    }
    /* ADF containers descend via .content (document bodies nest under .body) */
    if (Array.isArray(node.content)) walkAdf(node.content, ci);
    if (node.body && typeof node.body === 'object') walkAdf(node.body, ci);
  };
  /* EVERY top-level comment is walked with its OWN index — the old single
     walk over the whole `comments` array kept ci=0 for every comment, so
     every inline image mapped to comment 0 and images inside later
     comments never slotted into their own comment bubble.
     ANONYMOUS callers: media referenced from restricted comments (JSM
     internal / visibility-limited) is skipped — those comments never reach
     the public page, so their images must not surface either. The
     attachment itself stays listed (Jira attaches it to the issue, not the
     comment), it just cannot be pinned into a hidden comment. */
  const anon = !request.headers.get('authorization');
  const commentList: any[] = Array.isArray(f.comment?.comments) ? f.comment.comments : [];
  commentList.forEach((c: any, ci: number) => {
    if (anon && (c?.visibility != null || c?.internal === true || c?.jsdPublic === false)) return;
    walkAdf(c?.body, ci);
  });

  const commentAttachByIndex = new Map<number, Set<string>>();  /* mediaId → indices */
  for (const { id, commentIndex } of mediaInComments) {
    if (!commentAttachByIndex.has(commentIndex)) commentAttachByIndex.set(commentIndex, new Set());
    commentAttachByIndex.get(commentIndex)!.add(id);
  }
  /* filename(lowercased) → comment index — for empty-mediaId attachments */
  const commentFileByIndex = new Map<number, Set<string>>();
  for (const { alt, commentIndex } of mediaInComments) {
    const fn = (alt || '').trim().toLowerCase();
    if (!fn) continue;
    if (!commentFileByIndex.has(commentIndex)) commentFileByIndex.set(commentIndex, new Set());
    commentFileByIndex.get(commentIndex)!.add(fn);
  }

  const attachments = attachList
    .filter((a) => a && a.id)
    .map((a) => {
      const content = String(a.content || '');
      /* Jira returns an api.?? subdomain — normalize it to this domain so
         the client can pass it through the CORS proxy cleanly */
      const contentUrl = content.startsWith('https://')
        ? content
        : new URL(`/rest/api/3/attachment/content/${a.id}`, base).toString();
      /* which comment (if any) embeds this attachment's media inline.
         Primary: mediaId UUID match. Fallback: attachment filename vs the
         ADF media attrs.alt (filename) — needed because on this instance
         image attachments routinely return an EMPTY mediaId. */
      let commentIndex: number | null = null;
      const mid = a.mediaId ? String(a.mediaId) : '';
      if (mid) {
        for (const [ci, set] of commentAttachByIndex) {
          if (set.has(mid)) { commentIndex = ci; break; }
        }
      }
      if (commentIndex === null) {
        const fn = String(a.filename || '').trim().toLowerCase();
        if (fn) {
          for (const [ci, set] of commentFileByIndex) {
            if (set.has(fn)) { commentIndex = ci; break; }
          }
        }
      }
      return {
        id: String(a.id),
        filename: String(a.filename || ''),
        mimeType: String(a.mimeType || ''),
        size: Number(a.size || 0),
        created: String(a.created || ''),
        author: String(a.author?.displayName || ''),
        mediaId: mid,
        contentUrl,
        commentIndex,
      };
    });

  const commentCount = Array.isArray(f.comment?.comments) ? f.comment.comments.length : 0;
  return json({
    ok: true,
    cmd: 'deskAttach',
    key,
    commentCount,
    attachments,
  });
}

/* ───────────── JSM-native SLA for ONE issue (?cmd=deskSla) ────────────────
   The logistics task lists previously APPROXIMATED first-response and
   resolution SLAs in client-side working-hours math. That is wrong whenever
   JSM itself has measured cycles (it pauses on status changes, knows the
   actual goals, carries the REAL breach verdict, and reports the exact
   settlement times). This endpoint returns Jira's OWN SLA clock for one
   request so the client can show exactly what the agent view shows.

   Data sources (first that works wins):
   1. GET /rest/api/3/issue/{key}?fields=customfield_10041
      → {"Time to resolution": { completedCycles, ongoingCycle, ... }}
      (SLA custom fields appear on /issue when the API token has JSM perms)
   2. GET /rest/servicedeskapi/request/{key}/sla  (SDE API fallback)

   Response:
     { ok, cmd:'deskSla', key, sla: {
         resp: { elapsedMs, goalMs, breached, completed, startMs, stopMs, breachMs } | null,
         res:  { ...same } | null,
         source: 'issue-field' | 'sde-api' | 'none',
     } }
   elapsedMs is WALL-CLOCK JSM-time (already respects JSM's calendar + pause
   rules); the client treats goalMs/breached verbatim. */
type DeskSlaCycle = {
  elapsedMs: number; goalMs: number; breached: boolean;
  completed: boolean; startMs: number; stopMs: number; breachMs: number;
};
type DeskSlaAspect = { elapsedMs: number; goalMs: number; breached: boolean; completed: boolean; startMs: number; stopMs: number; breachMs: number } | null;

function deskSlaCycle(c: any, completed: boolean): DeskSlaCycle {
  return {
    elapsedMs: Number(c?.elapsedTime?.millis) || 0,
    goalMs: Number(c?.goalDuration?.millis) || 0,
    breached: c?.breached === true || String(c?.breached) === 'true',
    completed,
    startMs: Number(c?.startTime?.epochMillis) || 0,
    stopMs: Number(c?.stopTime?.epochMillis) || 0,
    breachMs: Number(c?.breachTime?.epochMillis) || 0,
  };
}

function deskSlaGoalOverride(a: DeskSlaAspect, fallbackHours: number): DeskSlaAspect {
  if (!a || a.goalMs > 0) return a;
  const goalMs = Math.round(fallbackHours * 3600e3);
  return a ? { ...a, goalMs } : a;
}

/* JSM can ACCUMULATE cycles (goal missed → clock restarts). For FIRST
   RESPONSE the settled measurement is the earliest completed cycle (the
   first agent reply); for RESOLUTION it is the last completed cycle (the
   actual settlement). Ongoing cycles: response prefers the earliest (the
   clock JSM started for the FIRST reply), resolution the current one. */
function deskSlaRespCycle(cf: any): DeskSlaAspect | null {
  const completed: any[] = Array.isArray(cf?.completedCycles) ? cf.completedCycles : [];
  const ongoing: any = cf?.ongoingCycle || null;
  let pick: any = null;
  for (const c of completed) {
    if (!pick || deskSlaCycle(c, true).stopMs < pick.stopMs) pick = deskSlaCycle(c, true);
  }
  if (!pick && ongoing) pick = deskSlaCycle(ongoing, false);
  return pick;
}
function deskSlaResCycle(cf: any): DeskSlaAspect | null {
  const completed: any[] = Array.isArray(cf?.completedCycles) ? cf.completedCycles : [];
  const ongoing: any = cf?.ongoingCycle || null;
  if (completed.length) return deskSlaCycle(completed[completed.length - 1], true);
  if (ongoing) return deskSlaCycle(ongoing, false);
  return null;
}

function deskSlaFromField(cf: any, isResp: boolean): DeskSlaAspect | null {
  if (!cf || typeof cf !== 'object') return null;
  return isResp ? deskSlaRespCycle(cf) : deskSlaResCycle(cf);
}

/* the /issue payload names each SLA custom field; JSM ships "Time to first
   response" and "Time to resolution" under names like customfield_10041 —
   match by the issue's names/base fields to pick them apart. */
function deskSlaAspectsFromIssue(issue: any): { resp: DeskSlaAspect; res: DeskSlaAspect } | null {
  const f = issue?.fields || {};
  const names = issue?.names || {};
  let resp: DeskSlaAspect = null;
  let res: DeskSlaAspect = null;
  for (const k of Object.keys(f)) {
    if (!/^customfield_\d+$/.test(k)) continue;
    const nm = String(names[k] || '');
    const cf = f[k];
    if (!cf || typeof cf !== 'object') continue;
    if (/first response/i.test(nm)) {
      const a = deskSlaFromField(cf, true);
      if (a) resp = deskSlaGoalOverride(a, 2);
    } else if (/resolution/i.test(nm)) {
      const a = deskSlaFromField(cf, false);
      if (a) res = deskSlaGoalOverride(a, 30);
    }
  }
  return (resp || res) ? { resp, res } : null;
}

function deskSlaFromSde(values: any): { resp: DeskSlaAspect; res: DeskSlaAspect } | null {
  if (!Array.isArray(values) || !values.length) return null;
  let resp: DeskSlaAspect = null;
  let res: DeskSlaAspect = null;
  for (const s of values) {
    const active = deskSlaFromField(s, /first response/i.test(String(s?.name || '')));
    if (!active) continue;
    if (/first response/i.test(String(s?.name || ''))) resp = deskSlaGoalOverride(active, 2);
    else if (/resolution/i.test(String(s?.name || ''))) res = deskSlaGoalOverride(active, 30);
  }
  return (resp || res) ? { resp, res } : null;
}

export async function handleDeskSlaCmd(u: URL, request: Request): Promise<Response> {
  const key = (u.searchParams.get('key') || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
    return json({ error: 'invalid key' }, 400);
  }
  const domainParam = (u.searchParams.get('domain') || '').trim();

  /* credentials: identical rules to handleDeskAttachCmd */
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
    /* anonymous reads stay inside the published desk projects (DESK_PROJECTS) */
    if (!DESK_PROJECTS.has(key.split('-')[0])) {
      return json({ error: 'issue not in a published desk project' }, 403);
    }
    authHeader = 'Basic ' + btoa(stored.email + ':' + stored.token);
    domain = stored.domain;
  }
  if (domain && !/^https:\/\//i.test(domain)) domain = 'https://' + domain;
  if (!domain || !/^https:\/\/[a-z0-9.-]+\.atlassian\.net$/i.test(domain)) {
    return json({ error: 'no usable Jira domain' }, 400);
  }
  const base = domain.replace(/\/+$/, '');
  const jh: Record<string, string> = {
    'Authorization': authHeader,
    'Accept': 'application/json',
    'User-Agent': 'JiraPulse-Relay/1.0',
  };

  /* MERGE both sources instead of "first that works wins": on this Jira
     instance the /search + /issue GET NEVER carry "Time to first response"
     (the field comes back empty for all 5,496 LOG requests) — the settled
     response cycles only surface through the servicedeskapi endpoint. So
     take resolution from the issue field and response from the SDE API,
     whichever each source can supply. */
  let best: { resp: DeskSlaAspect; res: DeskSlaAspect } | null = null;
  let source = 'none';

  /* 1st: /issue with names expansion → get ALL SLA custom fields. */
  try {
    const r1 = await fetch(base + '/rest/api/3/issue/' + encodeURIComponent(key) +
      '?fields=*nocommon&expand=names', { method: 'GET', headers: jh, redirect: 'follow' });
    if (r1.ok) {
      const issue = await r1.json();
      const aspects = deskSlaAspectsFromIssue(issue);
      if (aspects && (aspects.resp || aspects.res)) {
        best = { resp: aspects.resp, res: aspects.res };
        source = 'issue-field';
      }
    }
  } catch { /* fall through to SDE API */ }

  /* 2nd: service desk API (only for JSM project requests) */
  try {
    const r2 = await fetch(base + '/rest/servicedeskapi/request/' + encodeURIComponent(key) + '/sla', {
      method: 'GET', headers: jh, redirect: 'follow',
    });
    if (r2.ok) {
      const j = await r2.json();
      const aspects = deskSlaFromSde(j?.values);
      if (aspects && (aspects.resp || aspects.res)) {
        best = best
          ? { resp: best.resp || aspects.resp, res: best.res || aspects.res }
          : { resp: aspects.resp, res: aspects.res };
        source = source === 'issue-field' ? 'issue-field+sde-api' : 'sde-api';
      }
    }
  } catch { /* fall through to the none response */ }

  if (best && (best.resp || best.res)) {
    return json({ ok: true, cmd: 'deskSla', key, sla: { ...best, source } });
  }

  return json({ ok: true, cmd: 'deskSla', key, sla: { resp: null, res: null, source: 'none' } });
}
