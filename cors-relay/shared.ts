/**
 * JiraPulse relay — shared constants & helpers (imported by main.tsx + desk.ts).
 * Split out of the original single-file source to stay under Val Town's
 * 80,000-character per-file limit.
 */

/* blob keys (Val Town blobs are account-scoped, so prefix for safety).
   CREDS_KEY: the stored read-only Jira credentials (set via ?cmd=creds:set). */
export const CREDS_KEY = "jirapulse_creds_v1";

/* The organization's email domain — the org gate allows only addresses in
   this domain (mirror of the page bundles' PUBLISH_DOMAIN). */
export const ORG_EMAIL_DOMAIN = "caucasusauto.com";

/* ── Logistics viewer page (?cmd=desk) ── */
export const DESK_EXCLUDE_LABEL = "Internal";
export const DESK_FIELDS_BASE = "summary,description,status,resolution,resolutiondate,created,updated,assignee,reporter,labels,attachment,comment";

/* desk response blob-cache: one full LOG sync costs ~40 sequential Jira
   pages; caching the finished result (even very briefly) makes page
   revisits and multi-viewer bursts near-instant. Freshness remains
   viewer-controlled: ?fresh=1 bypasses and re-syncs. */
export const DESK_CACHE_KEY = "jirapulse_desk_cache_v4";
/* Anonymous (viewer-without-creds) desk-family reads are restricted to these
   project keys — the stored read-only creds must not become a loophole for
   enumerating other Jira/JSM projects. The logistics desk and its admin both
   hardcode DESK_PROJECT = 'LOG'; add a key here if a second desk goes live. */
/* built-in desk allowlist (base set); the admin can extend it at runtime
   via ?cmd=desk:allow (blob-backed extra list, see DESK_EXTRA_KEY) */
export const DESK_PROJECTS = new Set(["LOG"]);
/* blob key holding the admin-added desk projects (merged with DESK_PROJECTS) */
export const DESK_EXTRA_KEY = "jirapulse_desk_projects_extra_v1";
/* 60s made every incognito visit pay the full multi-minute desk sync
   (viewer almost always arrived after the slot expired) → boards looked
   permanently empty. 15 min keeps the payload fresh enough for status
   changes while making real back-to-back visits INSTANT. */
export const DESK_CACHE_TTL = 15 * 60 * 1000;

/* Per-response CORS headers WITHOUT Access-Control-Allow-Origin: the origin
   echo is added per-request by applyCors() in main (approved origins only). */
export const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, x-jp-admin, x-jp-session',
  'Access-Control-Max-Age': '86400',
};

export function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/* SHA-256 hex digest helper — session tokens, email codes and rate-limit
   keys are stored/compared as hashes, never in plaintext. */
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s || '')));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ── issue-level authorization gate for ANONYMOUS reads ────────────────
   Single source of truth for every server-side anonymous read path: the
   plain-proxy single-issue GET, its attachment variant, and the desk
   family (?cmd=deskAttach / ?cmd=deskSla). The issue must
     1) live in the allowlist (published projects / desk projects),
   2) carry NO security level, and
   3) not carry the desk-internal exclusion label.
   Returns the denial message (→ 403) or null when allowed.
   (18 Nov review Phase 3.3: the desk handlers previously skipped checks
   2 and 3 entirely, leaking restricted-issue attachments and SLAs.) */
export function anonIssueAllowed(fields: any, allowed: Set<string>): string | null {
  const proj = String(fields?.project?.key || '');
  if (!proj || !allowed.has(proj)) return 'issue not published';
  if (fields?.security != null) return 'issue is security-restricted';
  const labels: string[] = Array.isArray(fields?.labels)
    ? fields.labels.map((l: any) => String(l || '').toLowerCase()) : [];
  if (labels.includes(String(DESK_EXCLUDE_LABEL || 'Internal').toLowerCase())) return 'issue not published';
  return null;
}
