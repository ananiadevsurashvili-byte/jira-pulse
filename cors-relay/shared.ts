/**
 * JiraPulse relay — shared constants & helpers (imported by main.tsx + desk.ts).
 * Split out of the original single-file source to stay under Val Town's
 * 80,000-character per-file limit.
 */

/* blob keys (Val Town blobs are account-scoped, so prefix for safety).
   CREDS_KEY: the stored read-only Jira credentials (set via ?cmd=creds:set). */
export const CREDS_KEY = "jirapulse_creds_v1";

/* ── Logistics viewer page (?cmd=desk) ── */
export const DESK_EXCLUDE_LABEL = "Internal";
export const DESK_FIELDS_BASE = "summary,description,status,resolution,resolutiondate,created,updated,assignee,reporter,labels,attachment,comment";

/* desk response blob-cache: one full LOG sync costs ~40 sequential Jira
   pages; caching the finished result (even very briefly) makes page
   revisits and multi-viewer bursts near-instant. Freshness remains
   viewer-controlled: ?fresh=1 bypasses and re-syncs. */
export const DESK_CACHE_KEY = "jirapulse_desk_cache_v3";
/* Anonymous (viewer-without-creds) desk-family reads are restricted to these
   project keys — the stored read-only creds must not become a loophole for
   enumerating other Jira/JSM projects. The logistics desk and its admin both
   hardcode DESK_PROJECT = 'LOG'; add a key here if a second desk goes live. */
export const DESK_PROJECTS = new Set(["LOG"]);
/* 60s made every incognito visit pay the full multi-minute desk sync
   (viewer almost always arrived after the slot expired) → boards looked
   permanently empty. 15 min keeps the payload fresh enough for status
   changes while making real back-to-back visits INSTANT. */
export const DESK_CACHE_TTL = 15 * 60 * 1000;

/* Per-response CORS headers WITHOUT Access-Control-Allow-Origin: the origin
   echo is added per-request by applyCors() in main (approved origins only). */
export const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, x-jp-admin',
  'Access-Control-Max-Age': '86400',
};

export function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
