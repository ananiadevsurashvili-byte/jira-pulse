// Deploy the updated relay code (cors-relay/relay-source.ts) to the existing
// jira-relay HTTP val via Val Town's v2 REST API, then smoke-test the commands.
// NOTE: run from the workspace copy: deploy_relay_v2.js (same content).
import { readFileSync } from 'node:fs';

const TOKEN = process.env.VALTOWN_TOKEN || '';      // set VALTOWN_TOKEN in env — never commit secrets
const API = 'https://api.val.town';
const VAL_ID = '9891c927-1c5d-4b37-8396-a0cac13233d8';
const SRC = 'C:\\Users\\ANANIA\\AppData\\Roaming\\TRAE SOLO\\ModularData\\ai-agent\\work-mode-projects\\6a8c2c06f104de8ab9161b14\\cors-relay\\relay-source.ts';
const ENDPOINT = 'https://gensweaty--65df49bca6d911f19f231607ee4eb77e.web.val.run';
const ADMIN_TOKEN = process.env.JP_ADMIN_TOKEN || '';   // set JP_ADMIN_TOKEN in env — never commit secrets

const code = readFileSync(SRC, 'utf8');

async function api(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// 1. update main.tsx
try {
  await api('PUT', `/v2/vals/${VAL_ID}/files?path=main.tsx`, { content: code, type: 'http' });
  console.log('main.tsx updated');
} catch (e) {
  console.error('update failed:', e.message);
  process.exit(1);
}

// 2. wait for the val to pick up the new code, then smoke-test
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4000);

async function call(path, opts) {
  const r = await fetch(ENDPOINT + path, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

let ok = true;

const ping = await call('/?cmd=ping');
console.log('ping:', ping.status, JSON.stringify(ping.body));
ok = ok && ping.status === 200 && ping.body?.ok === true;

const badAuth = await call('/?cmd=publish:set', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-jp-admin': 'wrong' },
  body: JSON.stringify({ bogus: true }),
});
console.log('publish:set with WRONG token (expect 401):', badAuth.status, JSON.stringify(badAuth.body));
ok = ok && badAuth.status === 401;

const set = await call('/?cmd=publish:set', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-jp-admin': ADMIN_TOKEN },
  body: JSON.stringify({ v: 1, scope: 'all', boards: [], savedAt: 0 }),
});
console.log('publish:set (expect 200):', set.status, JSON.stringify(set.body));
ok = ok && set.status === 200;

const get = await call('/?cmd=config:get');
console.log('config:get (expect the config back):', get.status, JSON.stringify(get.body));
ok = ok && get.status === 200 && get.body?.config?.v === 1;

const badBoard = await call('/?cmd=board&bid=999999');
console.log('board without creds (expect 401 while no creds stored):', badBoard.status, JSON.stringify(badBoard.body).slice(0, 120));
ok = ok && badBoard.status === 401;

const badProxy = await call('/?url=' + encodeURIComponent('https://evil.example.com/x'));
console.log('proxy with disallowed host (expect 403):', badProxy.status, JSON.stringify(badProxy.body));
ok = ok && badProxy.status === 403;

// clean the test config back out so the app starts from a clean slate
const clear = await call('/?cmd=publish:clear', {
  method: 'POST',
  headers: { 'x-jp-admin': ADMIN_TOKEN },
});
console.log('publish:clear (expect 200):', clear.status, JSON.stringify(clear.body));
ok = ok && clear.status === 200;

const cleared = await call('/?cmd=config:get');
console.log('config:get after clear (expect config:null):', cleared.status, JSON.stringify(cleared.body));
ok = ok && cleared.body?.config === null;

console.log(ok ? '\nSMOKE TESTS PASSED' : '\nSMOKE TESTS FAILED');
process.exit(ok ? 0 : 1);
