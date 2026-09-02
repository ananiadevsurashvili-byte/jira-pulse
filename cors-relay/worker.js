/**
 * JiraPulse — personal CORS relay for Jira Cloud (Cloudflare Worker, free tier)
 * ============================================================================
 * Why this exists: browsers cannot call the Jira Cloud REST API directly from a
 * GitHub Pages site (Jira does not send CORS headers), so requests must pass
 * through a relay. Free public relays are rate-limited or require API keys.
 * This tiny worker is YOUR OWN relay — free up to 100,000 requests/day.
 *
 * ── How to deploy (≈5 minutes) ──────────────────────────────────────────────
 * 1. Sign up / log in at https://dash.cloudflare.com  (free)
 * 2. Workers & Pages → Create → Create Worker → name it (e.g. "jira-relay")
 * 3. Click "Deploy", then "Edit code"
 * 4. Delete the sample code, paste THIS file, click "Deploy"
 * 5. Copy your worker URL: https://jira-relay.<your-subdomain>.workers.dev
 * 6. In JiraPulse → ⚙ Settings → "Custom relay URL" paste:
 *        https://jira-relay.<your-subdomain>.workers.dev/?url={url}
 *    …and Save. Done — all Jira traffic now goes through your private relay.
 *
 * Security: only https://*.atlassian.net targets are allowed. Any Authorization
 * header the app sends is forwarded verbatim to Jira. Nothing is logged/stored.
 */

const ALLOWED_HOST = /\.atlassian\.net$/i;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request) {
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
    let targetUrl;
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

    // ── Forward the request verbatim (incl. Authorization) to Jira ────────
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('origin');
    headers.delete('referer');
    headers.delete('cookie');

    const upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body: (request.method === 'GET' || request.method === 'HEAD')
        ? undefined
        : await request.arrayBuffer(),
      redirect: 'follow',
    });

    // ── Relay Jira's response back, with CORS headers added ───────────────
    const out = new Headers(upstream.headers);
    out.set('Access-Control-Allow-Origin', '*');
    out.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    out.delete('content-security-policy');
    out.delete('x-frame-options');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
