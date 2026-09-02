/**
 * JiraPulse — shared online CORS relay for Jira Cloud (Val Town free tier).
 * ============================================================================
 * Browsers cannot call the Jira Cloud REST API directly from a GitHub Pages
 * site (Jira sends no CORS headers), so requests must pass through a relay.
 * Free public relays are rate-limited, so JiraPulse ships its own.
 *
 * This HTTP val forwards requests to *.atlassian.net ONLY, passing the
 * Authorization header through so every visitor uses their own Jira
 * credentials. Nothing is stored or logged. Free tier: 100,000 runs/day.
 *
 * Deployed endpoint:
 *   https://gensweaty--65df49bca6d911f19f231607ee4eb77e.web.val.run/?url=<encodeURIComponent(jiraUrl)>
 * Val page:
 *   https://www.val.town/x/gensweaty/jira-relay/code/
 */
const ALLOWED_HOST = /(^|\.)atlassian\.net$/i;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
};

async function handler(request: Request): Promise<Response> {
  // ── CORS preflight ─────────────────────────────────────────────────────
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── Resolve the target URL from ?url= (encoded) or ?url= raw ──────────
  const u = new URL(request.url);
  const target = u.searchParams.get('url');
  if (!target) {
    return json({ error: 'Missing ?url= parameter' }, 400);
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

  // ── Forward only the auth-relevant headers verbatim to Jira ───────────
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

  // ── Relay Jira's response back, with CORS headers added ───────────────
  const out = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    // drop hop-by-hop / decoding / embedding headers: the body has been
    // transparently decompressed, and CSP/XFO are irrelevant for fetch()
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
