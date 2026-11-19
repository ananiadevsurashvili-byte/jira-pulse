/**
 * JiraPulse relay test mocks — Val Town blob, Jira REST, Google JWKS and
 * FormSubmit, all in-process. No network access happens in the tests.
 */
import { generateKeyPairSync, createSign } from 'node:crypto';

/* ── blob mock (Val Town std/blob) ───────────────────────────────────── */
export function makeBlobMock() {
  const store = new Map<string, unknown>();
  return {
    store,
    async getJSON(key: string): Promise<unknown> {
      if (!store.has(key)) return undefined;
      return JSON.parse(JSON.stringify(store.get(key)));
    },
    async setJSON(key: string, value: unknown): Promise<void> {
      store.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<string[]> {
      return [...store.keys()];
    },
  };
}

/* ── upstream (Jira + Google + FormSubmit) fetch mock ────────────────── */
export type UpstreamCall = { url: string; method: string; auth: string; body: string | null };
export type UpstreamMock = {
  calls: UpstreamCall[];
  jiraCalls: () => UpstreamCall[];
  clearCalls: () => void;
  routes: Map<string, (u: URL, call: UpstreamCall) => { status: number; json?: unknown }>;
  formSubmits: { email: string; payload: any }[];
  fetch: (input: any, init?: any) => Promise<Response>;
};

export function makeUpstreamMock(): UpstreamMock {
  const calls: UpstreamCall[] = [];
  const formSubmits: { email: string; payload: any }[] = [];
  const routes = new Map<string, (u: URL, call: UpstreamCall) => { status: number; json?: unknown }>();

  async function fetch(input: any, init?: any): Promise<Response> {
    const url = typeof input === 'string' ? input : String(input.url ?? input);
    const method = String(init?.method || 'GET').toUpperCase();
    const headers = new Headers(init?.headers || (typeof input !== 'string' ? input.headers : undefined));
    const auth = headers.get('authorization') || '';
    const body = init?.body != null ? String(init.body) : null;
    const call: UpstreamCall = { url, method, auth, body };
    calls.push(call);

    const u = new URL(url);

    /* FormSubmit (server-side email delivery of the one-time code) */
    if (u.hostname === 'formsubmit.co' && u.pathname.startsWith('/ajax/')) {
      const email = decodeURIComponent(u.pathname.slice('/ajax/'.length));
      const payload = body ? JSON.parse(body) : {};
      formSubmits.push({ email, payload });
      return jsonRes(200, { success: 'true' });
    }

    /* route table (Jira / Google JWKS) */
    const key = u.host + u.pathname;
    const route = routes.get(key) || routes.get(u.host + u.pathname.replace(/\?.*$/, ''));
    if (route) {
      const r = route(u, call);
      return jsonRes(r.status, r.json);
    }
    return jsonRes(404, { error: 'no mock route for ' + key });
  }

  return {
    calls,
    jiraCalls: () => calls.filter((c) => c.url.includes('.atlassian.net/')),
    clearCalls: () => { calls.length = 0; },
    routes,
    formSubmits,
    fetch,
  };
}

function jsonRes(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj ?? {}), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* ── Google ID token signer (test RSA key + JWKS) ────────────────────── */
export const { publicKey: GOOGLE_TEST_PUBLIC_KEY, privateKey: GOOGLE_TEST_PRIVATE_KEY } =
  generateKeyPairSync('rsa', { modulusLength: 2048 });

export const GOOGLE_TEST_KID = 'test-key-1';

export function googleTestJwks() {
  const jwk = GOOGLE_TEST_PUBLIC_KEY.export({ format: 'jwk' }) as any;
  return { keys: [{ ...jwk, kid: GOOGLE_TEST_KID, alg: 'RS256', use: 'sig' }] };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signGoogleIdToken(payload: Record<string, unknown>, kid = GOOGLE_TEST_KID): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(header + '.' + body);
  const sig = b64url(signer.sign(GOOGLE_TEST_PRIVATE_KEY));
  return header + '.' + body + '.' + sig;
}

export function googleClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: '671098966570-21bp1aeud5o2glbjsliif3foi6n71gmh.apps.googleusercontent.com',
    sub: '1234567890',
    email: 'viewer@caucasusauto.com',
    email_verified: true,
    hd: 'caucasusauto.com',
    name: 'Org Viewer',
    iat: now - 60,
    exp: now + 300,
    ...overrides,
  };
}
