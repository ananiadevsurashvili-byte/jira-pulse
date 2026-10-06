# Plan: JiraPulse `/logistics` — Service Desk Task List (org-only)

## Summary

Add a new standalone page inside the existing repo — `logistics/index.html` + `logistics/app.js` + `logistics/styles.css` — served at:

**https://ananiadevsurashvili-byte.github.io/jira-pulse/logistics/**

It gives the exact same login experience as jira-pulse (Google sign-in + email one-time code), restricted to `@caucasusauto.com` only, and after login shows a task list of ALL issues from the Jira Service Desk project **LOG** (`https://caucasusauto.atlassian.net/jira/servicedesk/projects/LOG/`) **excluding** any issue labeled `Internal`. Columns: key (hyperlink), summary, status, assignee, created, updated, Logistics direction (custom field), Title (custom field), labels, linked issues. Global search + per-column filters + sortable columns — same UX patterns as the main app.

**Zero modifications to existing jira-pulse files** (app.js, index.html, styles.css, admin/). The only shared-code change is **additive** in the deployed relay (Val Town): a new public `?cmd=desk&project=LOG` command. GitHub Pages serves the new folder automatically after one git push.

## Current State Analysis

- **Login system** (app.js 1552–2001): `PUBLISH_DOMAIN='caucasusauto.com'`, `publishEmailOk()` already enforces org-only emails; Google GSI with `hd` restriction + `handleGoogleCredential()`; FormSubmit email one-time code (`pubSendCode`/`pubVerifyCode`, seed `'org'` for the org-wide publish); 30-day localStorage session `jp_pub_session_v1`. This is exactly the gate the user wants — reusable verbatim.
- **Relay** (`cors-relay/relay-source.ts`, deployed at `https://gensweaty--65df49bca6d911f19f231607ee4eb77e.web.val.run/`): `?cmd=board` shows the proven pattern — viewer `Authorization` header wins, else admin's stored read-only creds (`CREDS_KEY` blob), paged `GET /rest/api/3/search/jql` with `nextPageToken`, 413 page-size shrink loop, custom-field discovery via `/rest/api/3/field`. `handleBoardCmd` requires a numeric board id — cannot be reused as-is for a Service Desk project; a sibling `desk` command is needed.
- **Critical constraint discovered**: the existing `app.js` self-boots on `DOMContentLoaded` and wires `#connectForm`, `#boardSelect` etc. **without null guards** — the new page CANNOT simply `<script src="../app.js">`. It must ship its own standalone `logistics/app.js` with the auth/session/theme/i18n helpers **copied** (this is reuse-by-copy, not duplication of logic — there is no shared module in this no-build-step repo).
- **Reusable CSS**: `styles.css` already contains `.glass`, `.card`, `.data-table`, `.status-pill`, `.tl-select`, `.tl-search`, `.tl-filterbar`, `.data-badge`, `.pub-user-chip`, `.lang-switch`, `.theme-switch`, `.orb`, and the `body.light` theme. The new page links `../styles.css` (read-only reuse) and adds a tiny `logistics/styles.css` only for new bits (sort carets, chips, sticky header).
- **Theme/lang persistence**: shared keys `jp_theme_v1` / `jp_lang_v1` — reading/writing the same keys keeps theme + language in sync across both pages automatically.
- **JQL caveat**: `labels NOT IN ("Internal")` has "any value" edge semantics in Jira for multi-value fields — an issue labeled `[Internal, X]` can still match. Mitigated with **triple defense**: JQL exclusion + relay-side re-filter + client-side re-filter.

## Proposed Changes

### 1. `cors-relay/relay-source.ts` — add public `desk` command (ADDITIVE ONLY)

`ping`, `config:*`, `publish:*`, `creds:*`, `board`, and the `?url=` proxy stay byte-identical.

- **Dispatch** (after the `board` branch): `if (cmd === 'desk') return await handleDeskCmd(u, request);`
- **New constants**: `DESK_EXCLUDE_LABEL = 'Internal'`; `DESK_FIELDS_BASE = 'summary,status,created,updated,assignee,issuetype,labels,issuelinks'`.
- **`handleDeskCmd(u, request)`**:
  1. `project` query param, uppercase, validate `/^[A-Z][A-Z0-9_]{0,9}$/` → else 400.
  2. **Creds block copied verbatim from `handleBoardCmd`** (viewer Authorization wins → else `CREDS_KEY` stored creds → 401 if neither; `domain` param or `stored.domain`).
  3. **Custom-field discovery** via `GET /rest/api/3/field` (same best-effort pattern as the complexity-field code): `directionFieldId` = custom field named `Logistics direction` (fallback: any custom `/logistics/i`); `titleFieldId` = custom field named exactly `Title` (fallback: any custom `/title/i`). Overridable via `&directionField=` / `&titleField=` params.
  4. **`searchJql()`** copied from `handleBoardCmd` (no changelog, page size 50, `MAX_TOTAL=600`, 413 shrink loop) with `SEARCH_FIELDS = [DESK_FIELDS_BASE, directionFieldId, titleFieldId].filter(Boolean).join(',')`.
  5. JQL: `project in ("LOG") AND (labels is EMPTY OR labels NOT IN ("Internal")) ORDER BY created DESC`
  6. **Relay-side label re-filter**: drop any issue whose `fields.labels` includes `internal` (case-insensitive).
  7. Response: `{ ok, cmd:'desk', project, count, fetchedAt, fieldIds:{direction,title}, issues }`.
- Update the file-header command list to document `?cmd=desk&project=LOG`.

### 2. `cors-relay/deploy_relay_v2.js` — extend smoke tests

Add before the summary: `?cmd=desk&project=LOG!` → expect 400; `?cmd=desk&project=LOG` → expect 200 or 401 (depends on stored creds). Deploy with `VALTOWN_TOKEN` + `JP_ADMIN_TOKEN` env vars — existing smoke suite (`ping`, wrong-token 401, publish:set/get/clear, board-without-creds, evil-proxy 403) already guards regressions.

### 3. `logistics/index.html` (NEW)

- Same fonts + GSI script (`accounts.google.com/gsi/client`, async); `<title>JiraPulse · Logistics</title>`; `<link rel="stylesheet" href="../styles.css?v=8241341">` + `<link rel="stylesheet" href="styles.css">`; same favicon style. **All URLs relative** (critical for GitHub Pages subpath).
- Body: 3 `.orb` divs; `.topbar.pub-topbar` header — brand (links `../`), center title `lgHeadTitle`, right: `.lang-switch` (EN/ქა), `.theme-switch` (dark/light), `#lgUserChip` (`pub-user-chip` shape with `#lgSignOutBtn`).
- Gate card `#lgAuthBox.glass`: `#lgGoogleBtn` container, "or email" divider, `#lgEmail` input, `#lgSendBtn`, hidden `#lgCodeWrap` (`#lgCode` + `#lgVerifyBtn`), `#lgStatus` line. All text via `data-i18n`.
- Content `#lgContent.hidden`: meta row (`#lgCount` data-badge, `#lgFetchedAt`, Refresh `#lgRefreshBtn`), error banner `#lgError`, table card `.card.glass` with `#lgFilterBar.tl-filterbar`, global `#lgSearch.tl-search`, and `.table-scroll > table.data-table` — thead 10 sortable `th[data-col]`: key, summary, status, assignee, created, updated, direction, title, labels, links; tbody `#lgTbody`.
- Footer; `<script src="app.js"></script>` (relative).

### 4. `logistics/app.js` (NEW, standalone)

**Constants**: `PUB_RELAY` (same Val Town URL), `PUBLISH_DOMAIN='caucasusauto.com'`, `GOOGLE_CLIENT_ID` (verbatim), `LS_PUB_SESSION='jp_pub_session_v1'` (shared → sign-in on either page carries over), `PUB_SESSION_TTL` 30d, `LS_THEME='jp_theme_v1'`, `LS_LANG='jp_lang_v1'`, `LS_CONN='jp_conn_v1'`, `JIRA_DOMAIN='caucasusauto.atlassian.net'`, `DESK_PROJECT='LOG'`, `LOG_SEED='org'` (same code derivation as org publish), `MAX_ROWS=400` display cap.

**Copied verbatim from app.js** (reuse-by-copy): `escapeHtml`, `publishCode`, `publishEmailOk`, `decodeJwt`, `googleReady`, session save/restore/clear trio, `fmtDateLong`, theme boot/apply/set, i18n `t()`/`tReplace()`/`applyI18n()` with local `I18N = {en, ka}`.

**Auth flow** (logic identical, ids renamed `pub*` → `lg*`): `handleGoogleCredential` (rejects non-org emails with `pub.restricted`), `initGoogleButton` (poll pattern, `hd: PUBLISH_DOMAIN`), `lgSendCode` (FormSubmit, subject "Your JiraPulse Logistics access code"), `lgVerifyCode`, `lgEnterVerified`, `lgSignOut` (incl. `disableAutoSelect`), `lgUpdateUserChip`.

**Data layer**:
- `loadConn()` — reads viewer's own Jira conn from `jp_conn_v1` (optional; adds `Authorization: Basic` header when present).
- `lgFetchDesk()` — `GET PUB_RELAY + '?cmd=desk&project=LOG&domain=' + JIRA_DOMAIN`, 40s AbortController, 30s in-memory cache; 401 → clear guidance message.
- `lgNormalize(issue, fieldIds)` → `{ key, href:'https://caucasusauto.atlassian.net/browse/KEY', summary, status, assignee, created, updated, direction, title, labels[], links[] }`. Custom-field value shapes normalized (`v.value ?? v.name ?? v`). `links` from `fields.issuelinks` (outward/inward key + type label). Client-side re-filter: drop `labels` containing `internal`.

**Table engine**:
- `lgBuildFilterBar()` — selects (status, assignee incl. Unassigned, direction, labels) + text inputs (summary, title, links) using `.tl-select`/`.tl-search`.
- `lgApplyFiltersSort()` — global search across key+summary+status+assignee+direction+title+labels+links; per-column exact (selects) / includes (inputs); sort per column (dates via `Date.parse`, strings via `localeCompare`); default sort created desc.
- `lgRenderRows()` — capped at `MAX_ROWS` with "showing X of Y"; key cell = hyperlink (new-tab arrow); `.status-pill` status; label chips; linked-issue chips hyperlinked to `browse/LINKKEY`; empty state row; debounced inputs (250 ms); `th` click toggles sort with ▲/▼ indicator.

### 5. `logistics/styles.css` (NEW, small)

Sort caret classes on `th[data-col]`, `.lg-chip` (label pill), `.lg-link-chip`, `.lg-dir-pill`, sticky `thead` inside `.table-scroll`, filter-bar widths, `body.light` variants for all new elements.

### 6. `README.md` (OPTIONAL, one line — the only allowed touch to existing files)

`/logistics/` — org-only page listing Service Desk LOG tasks (excludes `Internal`), same relay, `cmd=desk`.

## i18n

Login block reuses verbatim-copied `pub.*` keys (EN+KA). New `lg.*` keys (EN + KA): `lg.headTitle`, `lg.subtitle`, `lg.refresh`, `lg.refreshing`, `lg.count` ({n} tasks), `lg.showing`, `lg.searchPh`, `lg.filterAll`, `lg.th.key/summary/status/assignee/created/updated/direction/title/labels/links`, `lg.sortTitle`, `lg.filterTitle`, `lg.empty`, `lg.unassigned`, `lg.openJira`, `lg.updatedAt`, `lg.errorLoad`, `lg.errorNoCreds`, `lg.directionMissing`.

## Assumptions & Decisions

1. **Same repo, new folder** (user confirmed) → link ends with `/jira-pulse/logistics/`; one git push deploys it; existing pages untouched.
2. **Standalone `logistics/app.js`** — the existing app.js cannot be included as-is (self-booting, no null guards); auth helpers are copied. This is the only way to satisfy "don't change the first project" in a no-build repo.
3. **Shared session/theme/lang keys** → signing in on one page signs you in on the other; theme/language sync both ways. Intended feature, matches "exactly same log in system".
4. **New relay `?cmd=desk`** rather than reusing `?cmd=board` — Service Desk LOG has no agile board id; `desk` reuses the proven creds + searchJql blocks and is purely additive (zero regression risk to existing commands).
5. **Triple `Internal` exclusion** (JQL + relay + client) due to Jira's multi-value `NOT IN` edge semantics.
6. **Custom field ids discovered at runtime** via `/rest/api/3/field` with URL-param override — resilient to field-id differences.
7. **600-issue cap** — same documented cap as `cmd=board`; the count chip communicates it.
8. **Viewer creds fallback chain**: viewer's own Jira conn (from main app localStorage) → admin's stored relay creds → clear 401 guidance message.

## Verification

1. **Syntax**: `node --check logistics/app.js` (deploy script validated by running it; relay TS validated by Val Town on deploy).
2. **Relay smoke after deploy**: `ping` 200; `desk&project=LOG!` → 400; `desk&project=LOG` with viewer Basic auth → 200, `fieldIds` non-null, **no issue has label `internal`**; without auth → 200 (stored creds) or 401 with clear message; regressions: `board` 200 with viewer auth, evil proxy 403, wrong admin token 401 (deploy script covers).
3. **Constraint check**: `git status` shows changes ONLY in `cors-relay/`, `logistics/` (new), optionally `README.md` — never `app.js`, `index.html`, `styles.css`, `admin/`.
4. **Live checks**: main app unchanged and working; `/jira-pulse/logistics/` — gate renders, Google button initializes, org email code arrives + verifies, non-org email/Gmail rejected, table shows all 10 columns, key links open `browse/KEY` in Jira, search + per-column filters + every column sort work, `Internal`-labeled issues absent, Refresh works.
5. **Cross-page**: theme/lang set on `/logistics/` reflects on the main app and vice versa; session valid on both pages; sign-out clears both.
