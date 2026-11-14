# ⚡ JiraPulse

A slick, modern **client-side analytics dashboard for Jira Cloud boards**.
Enter your Jira site, email and API token — JiraPulse syncs your boards and turns their data into beautiful, real-time delivery insights.

🔗 **Live app:** https://ananiadevsurashvili-byte.github.io/jira-pulse/

## ✨ Features

- 🔐 **Connect with a Jira API token** — credentials are stored only in your browser's local storage. Requests to Jira go over HTTPS through JiraPulse's own relay (see Privacy below) — never through third-party proxies.
- 📋 **Automatic board sync** — lists every scrum / kanban / team-managed board you have access to.
- 📊 **Delivery metrics per board**
  - Issues analyzed (full board scope, up to 600 recent issues with full change history)
  - Tasks **created in the last 30 days** (+ daily trend chart)
  - Tasks **resolved in the last 30 days** and weekly throughput (last 12 weeks)
  - Overall completion rate (Done vs total)
  - **Average cycle time** (created → resolved)
  - Current work-in-progress count
  - **Average time tasks spend in each status** (computed from the issue changelog!)
  - "Longest sitting in current status" table with direct links to issues
- 🎨 Dark glassmorphism UI, animated gradient orbs, Chart.js visualizations.

## 🚀 Usage

1. Open the live app.
2. Grab an API token at https://id.atlassian.com/manage-profile/security/api-tokens
3. Enter `yoursite.atlassian.net` + account email + token → **Connect**.
4. Pick any synced board → dashboard loads instantly. Use **Refresh** to re-sync.

> 💡 If your browser blocks direct calls to Jira (CORS), open **Settings → Route requests via CORS proxy**.

## 🛠 Tech

Pure HTML/CSS/JS single-page app (no build step) + [Chart.js](https://www.chartjs.org/) via CDN.
Uses Jira Cloud REST APIs: `agile/1.0/board`, `agile/1.0/board/{id}/issue?expand=changelog`.

Deployed as a static site on **GitHub Pages**, with the organization deployment served from the GitLab repo onto company infrastructure:

| Environment | URL | Source |
|---|---|---|
| GitHub Pages (current public home) | `https://ananiadevsurashvili-byte.github.io/jira-pulse/` | `main` on GitHub |
| Organization test | `https://jirapulse-test.caucasusauto.com/` | `test` branch on GitLab (nginx image via the DevOps pipeline) |
| Organization production | `https://jirapulse.caucasusauto.com/` | `main` on GitLab (same pipeline) |

All three serve the same static files and call the same relay; the relay's CORS allowlist covers every origin listed above.

## 🚚 Logistics Desk

A companion mini-app at [/logistics/](https://ananiadevsurashvili-byte.github.io/jira-pulse/logistics/) — the same org login (Google + email code, @caucasusauto.com only) showing a live, filterable task list of the **LOG Service-Desk project** (tasks labeled *Internal* are excluded).

## 💸 Fines Desk

A clone of the logistics desk for a second department at `/fines/` (admin dashboard at `/fines/admin/`). It reads one Service-Desk project:

- the project key defaults to `FIN` and can be overridden without a redeploy by opening `/fines/?project=<KEY>` (persisted in that browser),
- the relay only serves anonymous desk reads for projects on its desk allowlist — the built-in set is `LOG`, and the admin extends it at runtime with
  `POST /?cmd=desk:allow` `{"project":"KEY"}` (admin token required; `?cmd=desk:disallow` removes it again).

## 🔒 Privacy

Your Jira credentials are stored only in your browser's local storage (clear them anytime via **Settings → Clear local data**). Browser-side calls to Jira pass through **JiraPulse's own relay** (a Val Town endpoint we control) because Jira's API sends no CORS headers to static sites — no third-party proxy services are used.

The relay is a small backend, and it does store some data:
- the **publish configuration** (which boards are published and their chart layout) and the **SLA goals**,
- a set of **read-only Jira credentials** the admin stored once so anonymous viewers of published boards can see live data,
- short-lived **response caches** for published boards and the desk pages (10–15 minutes) and a derived allowlist of published projects,
- **desk login-activity counters** (email, timestamps, user agent; readable only with the admin token).

Board analytics data is fetched live from Jira at view time and never archived. All admin write operations require a shared admin token that is never shipped in the app bundle (rotate it any time via the relay's `?cmd=admin:rotate`).
