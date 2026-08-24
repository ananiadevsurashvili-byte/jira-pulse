# ⚡ JiraPulse

A slick, modern **client-side analytics dashboard for Jira Cloud boards**.
Enter your Jira site, email and API token — JiraPulse syncs your boards and turns their data into beautiful, real-time delivery insights.

🔗 **Live app:** https://ananiadevsurashvili-byte.github.io/jira-pulse/

## ✨ Features

- 🔐 **Connect with a Jira API token** — credentials are stored *only* in your browser's local storage and sent directly to your Jira site over HTTPS.
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

Deployed as a static site on **GitHub Pages**.

## 🔒 Privacy

Everything runs in your browser. There is no backend — nothing is logged or stored anywhere except your own browser's local storage. Clear it anytime via **Settings → Clear local data**.
