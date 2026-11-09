// Unit tests for the worker using an in-memory Durable Object and a mocked fetch.
import assert from 'node:assert/strict';
import worker, { QuotaCounter, signJWT, verifyJWT, sanitizeChat } from '../src/index.js';

class MemStorage {
  constructor() { this.m = new Map(); }
  async get(k) { if (Array.isArray(k)) return new Map(k.filter((x) => this.m.has(x)).map((x) => [x, this.m.get(x)])); return this.m.get(k); }
  async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) this.m.set(a, b); else this.m.set(k, v); }
  async list() { return new Map(this.m); }
  async delete(keys) { for (const k of [].concat(keys)) this.m.delete(k); }
}
const objects = new Map();
const QUOTA = {
  idFromName: (n) => n,
  get: (id) => { if (!objects.has(id)) objects.set(id, new QuotaCounter({ storage: new MemStorage() }, {})); return objects.get(id); },
};
const env = {
  QUOTA, SESSION_SECRET: 'test-secret', GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', UPSTREAM_API_KEY: 'sk-up',
  ALLOWED_ORIGINS: 'https://me.github.io', DAILY_REQUESTS_PER_USER: '3', GLOBAL_DAILY_REQUESTS: '100', MIN_ACCOUNT_AGE_DAYS: '30',
  UPSTREAM_BASE_URL: 'https://llm.example/v1', UPSTREAM_MODEL: 'vision-model',
};
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const call = async (path, init = {}) => { const r = await worker.fetch(new Request(`https://api.example${path}`, init), env, ctx); await Promise.all(waits.splice(0)); return r; };

let upstreamCalls = [];
let upstreamFail = false;
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.startsWith('https://github.com/login/oauth/access_token')) return Response.json({ access_token: 'gho_x' });
  if (url === 'https://api.github.com/user') return Response.json({ id: 42, login: 'Octo', avatar_url: 'https://a/x.png', created_at: '2015-01-01T00:00:00Z' });
  if (url === 'https://llm.example/v1/chat/completions') {
    upstreamCalls.push({ init, body: JSON.parse(init.body) });
    if (upstreamFail) return Response.json({ error: { message: 'boom' } }, { status: 500 });
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  }
  throw new Error(`unexpected fetch ${url}`);
};

// JWT round trip and tamper detection
const t = await signJWT({ a: 1, exp: Math.floor(Date.now() / 1000) + 60 }, 's');
assert.deepEqual((await verifyJWT(t, 's')).a, 1);
assert.equal(await verifyJWT(t, 'other'), null);
assert.equal(await verifyJWT(t.slice(0, -2) + 'xx', 's'), null);
assert.equal(await verifyJWT(await signJWT({ exp: 1 }, 's'), 's'), null, 'expired');

// login: rejects foreign redirect, accepts allowed one
assert.equal((await call('/auth/login?redirect=https://evil.example/')).status, 400);
const login = await call('/auth/login?redirect=' + encodeURIComponent('https://me.github.io/foot-fit/'));
assert.equal(login.status, 302);
const loc = new URL(login.headers.get('Location'));
assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
const state = loc.searchParams.get('state');
const nonce = login.headers.get('Set-Cookie').match(/ff_oauth=([^;]+)/)[1];

// callback without the cookie fails (CSRF protection)
const bad = await call(`/auth/callback?code=abc&state=${state}`);
assert.match(bad.headers.get('Location'), /#ff_error=/);
// callback with cookie succeeds and returns a session in the fragment
const cb = await call(`/auth/callback?code=abc&state=${state}`, { headers: { Cookie: `ff_oauth=${nonce}` } });
assert.equal(cb.status, 302);
const back = cb.headers.get('Location');
assert.ok(back.startsWith('https://me.github.io/foot-fit/#ff_token='), back);
const session = back.split('ff_token=')[1];

// /api/me
const auth = { Authorization: `Bearer ${session}`, Origin: 'https://me.github.io' };
const meRes = await call('/api/me', { headers: auth });
assert.equal(meRes.status, 200);
assert.equal(meRes.headers.get('Access-Control-Allow-Origin'), 'https://me.github.io');
assert.equal((await meRes.json()).quota.dailyRemaining, 3);
assert.equal((await call('/api/me')).status, 401);

// chat: sanitisation
const img = 'data:image/jpeg;base64,AAAA';
const body = (extra = {}) => JSON.stringify({ purpose: 'coach', model: 'gpt-expensive', max_tokens: 99999, messages: [{ role: 'system', content: 'x' }, { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: img } }] }], ...extra });
const c1 = await call('/api/chat', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: body() });
assert.equal(c1.status, 200, await c1.clone().text());
const j1 = await c1.json();
assert.equal(j1.content, '{"ok":true}');
assert.equal(j1.quota.dailyRemaining, 2);
const sent = upstreamCalls[0];
assert.equal(sent.body.model, 'vision-model', 'client cannot choose the model');
assert.equal(sent.body.max_tokens, 1000, 'max tokens capped');
assert.equal(sent.init.headers.Authorization, 'Bearer sk-up');
assert.ok(!('user' in sent.body));
assert.equal(sanitizeChat({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }] }, { maxImages: 4, maxTokens: 10 }).error, 'images must be inline data: URLs');
assert.ok(sanitizeChat({ messages: [{ role: 'tool', content: 'x' }] }, { maxImages: 4, maxTokens: 10 }).error);

// upstream failure refunds the quota
upstreamFail = true;
const c2 = await call('/api/chat', { method: 'POST', headers: auth, body: body() });
assert.equal(c2.status, 502);
upstreamFail = false;
assert.equal((await (await call('/api/me', { headers: auth })).json()).quota.dailyRemaining, 2, 'refunded');

// daily limit enforced
assert.equal((await call('/api/chat', { method: 'POST', headers: auth, body: body() })).status, 200);
assert.equal((await call('/api/chat', { method: 'POST', headers: auth, body: body() })).status, 200);
const c5 = await call('/api/chat', { method: 'POST', headers: auth, body: body() });
assert.equal(c5.status, 429);
assert.match((await c5.json()).error, /daily request limit/);
assert.equal(upstreamCalls.length, 4, 'no upstream call when over quota');

// session version bump signs everyone out
assert.equal((await worker.fetch(new Request('https://api.example/api/me', { headers: auth }), { ...env, SESSION_VERSION: '2' }, ctx)).status, 401);

// young accounts are rejected
globalThis.fetch = (orig => async (url, init) => String(url) === 'https://api.github.com/user'
  ? Response.json({ id: 7, login: 'newbie', created_at: new Date().toISOString() }) : orig(url, init))(globalThis.fetch);
const l2 = await call('/auth/login?redirect=' + encodeURIComponent('https://me.github.io/'));
const st2 = new URL(l2.headers.get('Location')).searchParams.get('state');
const n2 = l2.headers.get('Set-Cookie').match(/ff_oauth=([^;]+)/)[1];
const cb2 = await call(`/auth/callback?code=abc&state=${st2}`, { headers: { Cookie: `ff_oauth=${n2}` } });
assert.match(decodeURIComponent(cb2.headers.get('Location')), /at least 30 days old/);

console.log('worker tests passed');
