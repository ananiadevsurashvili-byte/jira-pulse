# JiraPulse personal CORS relay (Cloudflare Worker)

Jira Cloud does not send CORS headers, so a browser app on GitHub Pages cannot
call the Jira REST API directly. JiraPulse falls back to free public relays,
but those are rate-limited or now require API keys. **Your own relay is free
(100,000 requests/day) and takes ~5 minutes to set up — once.**

## Deploy (5 minutes)

1. Create/log in to a free account at <https://dash.cloudflare.com>
2. Left menu → **Workers & Pages** → **Create** → **Create Worker**
3. Name it e.g. `jira-relay` → **Deploy** → **Edit code**
4. Delete the sample code, paste the contents of [`worker.js`](./worker.js), **Deploy**
5. Copy the URL shown, e.g. `https://jira-relay.your-name.workers.dev`
6. Open JiraPulse → **⚙ Settings** → **Custom relay URL** and paste:

   ```
   https://jira-relay.your-name.workers.dev/?url={url}
   ```

   (keep the literal `{url}` placeholder) → **Save**

All Jira requests now go through your private relay. Done.

## What it does

- Forwards any request (incl. `Authorization`) verbatim to `https://*.atlassian.net`
  — **only** Atlassian hosts are allowed.
- Adds permissive CORS headers to the response so the browser accepts it.
- Stores nothing, logs nothing, no API key needed.

## Why not rely on public relays?

| Relay | Status (2026) |
|---|---|
| corsproxy.io (keyless) | dead — now requires a paid API key |
| api.cors.lol | works but rate-limited: 20 req / 5 min / IP |
| corsproxy.io (with key) | fine — paste your key in Settings |
| **your own worker** | **unlimited for personal use, zero cost** |
