# JiraPulse relay

Jira Cloud does not send CORS headers, so a browser app on GitHub Pages cannot
call the Jira REST API directly. JiraPulse ships with its **own hosted relay**
already built in — nothing to install, nothing to configure.

## Hosted relay (default, zero setup)

The app's first-choice relay runs on [Val Town](https://www.val.town)'s free
tier (100,000 requests/day):

```
https://gensweaty--65df49bca6d911f19f231607ee4eb77e.web.val.run/?url={url}
```

- Forwards any request (incl. `Authorization`) verbatim to
  `https://*.atlassian.net` — **only** Atlassian hosts are allowed.
- Adds permissive CORS headers to the response so the browser accepts it.
- Stores nothing, logs nothing, no API key needed.
- Source: [`relay-source.ts`](./relay-source.ts) (deployed as a public
  [HTTP val](https://www.val.town/x/gensweaty/jira-relay)).

## Re-deploy / edit the hosted relay

The val account is `gensweaty` (Google sign-in). To update the code:
open <https://www.val.town/x/gensweaty/jira-relay/code/main.tsx>, edit, save —
or redeploy via the Val Town REST API:

```powershell
$token = "<val-town-api-token>"   # Settings → API tokens
$body  = Get-Content relay-source.ts -Raw
Invoke-RestMethod -Method Put `
  -Uri "https://api.val.town/v2/vals/9891c927-1c5d-4b37-8396-a0cac13233d8/files?path=main.tsx" `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body (@{ content = $body; type = "http" } | ConvertTo-Json)
```

## Optional: your own private relay

Anyone can also run a private copy:

- **Val Town** — create a free HTTP val at <https://www.val.town>, paste
  `relay-source.ts`, and put `https://<handle>--<id>.web.val.run/?url={url}`
  into JiraPulse → **⚙ Settings → Custom relay URL**.
- **Cloudflare Workers** — deploy [`worker.js`](./worker.js) (same logic,
  Workers runtime) and use `https://jira-relay.<your-subdomain>.workers.dev/?url={url}`.

## Why not rely on public relays?

| Relay | Status (2026) |
|---|---|
| corsproxy.io (keyless) | dead — now requires a paid API key |
| api.cors.lol | works but rate-limited: 20 req / 5 min / IP |
| corsproxy.io (with key) | fine — paste your key in Settings |
| **JiraPulse hosted relay** | **default — 100k req/day, free** |
