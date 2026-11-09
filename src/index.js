// Foot Fit on Cloudflare Workers: serves the static web app (./web via Workers Assets)
// and the API on the same origin.
//  - GitHub OAuth sign-in  -> signed session (HS256 JWT) in an HttpOnly cookie
//  - Per-account + global quotas, enforced atomically in a Durable Object
//  - Proxy to any OpenAI-compatible /chat/completions endpoint; the upstream API key
//    never reaches the browser and the model / token caps are fixed server-side.
import { DurableObject } from 'cloudflare:workers';

// ---------------------------------------------------------------- config

function cfg(env) {
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    allowedUsers: list(env.ALLOWED_GITHUB_USERS).map((s) => s.toLowerCase()),
    allowedOrgs: list(env.ALLOWED_GITHUB_ORGS).map((s) => s.toLowerCase()),
    blockedUsers: list(env.BLOCKED_GITHUB_USERS).map((s) => s.toLowerCase()),
    minAccountAgeDays: num(env.MIN_ACCOUNT_AGE_DAYS, 30),
    sessionDays: num(env.SESSION_DAYS, 7),
    sessionVersion: String(env.SESSION_VERSION || '1'),
    dailyRequests: num(env.DAILY_REQUESTS_PER_USER, 20),
    monthlyRequests: num(env.MONTHLY_REQUESTS_PER_USER, 200),
    dailyTokens: num(env.DAILY_TOKENS_PER_USER, 200000),
    globalDailyRequests: num(env.GLOBAL_DAILY_REQUESTS, 1000),
    maxTokens: num(env.MAX_OUTPUT_TOKENS, 1000),
    maxImages: num(env.MAX_IMAGES_PER_REQUEST, 4),
    maxBodyBytes: num(env.MAX_BODY_BYTES, 3_000_000),
    upstreamBase: String(env.UPSTREAM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    upstreamModel: String(env.UPSTREAM_MODEL || 'gpt-4o-mini'),
    maxTokensParam: String(env.UPSTREAM_MAX_TOKENS_PARAM || 'max_tokens'),
    extraHeaders: (() => { try { return JSON.parse(env.UPSTREAM_EXTRA_HEADERS || '{}'); } catch { return {}; } })(),
  };
}

const PURPOSES = new Set(['setup_check', 'coach', 'segmentation_review', 'fit_report', 'test', 'general']);

// ---------------------------------------------------------------- helpers

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJSON = (o) => b64url(enc.encode(JSON.stringify(o)));
const fromB64url = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signJWT(payload, secret) {
  const head = b64urlJSON({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJSON(payload);
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

export async function verifyJWT(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  try {
    const head = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (head.alg !== 'HS256') return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    if (!p.exp || p.exp * 1000 < Date.now()) return null;
    return p;
  } catch { return null; }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const SESSION_COOKIE = 'ff_session';

function cookie(name, value, maxAge, path = '/') {
  return `${name}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Same-origin check for state-changing requests (defence in depth on top of SameSite=Lax). */
function sameOrigin(req) {
  const origin = req.headers.get('Origin');
  return !origin || origin === new URL(req.url).origin;
}

function periods(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return { day, month: day.slice(0, 7) };
}

function getCookie(req, name) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Only same-site relative paths are accepted as post-login destinations. */
function safePath(p) {
  return typeof p === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(p) ? p : '/';
}

function backWithError(path, msg) {
  return new Response(null, { status: 302, headers: { Location: `${path.split('#')[0]}#ff_error=${encodeURIComponent(msg)}` } });
}

// ---------------------------------------------------------------- quota Durable Object

export class QuotaCounter extends DurableObject {
  /**
   * Atomically check limits and reserve one request.
   * limits: {daily, monthly, dailyTokens}; p: {day, month}
   */
  async reserve(limits, p) {
    const s = this.ctx.storage;
    const k = { d: `d:${p.day}`, m: `m:${p.month}`, t: `t:${p.day}` };
    const v = await s.get([k.d, k.m, k.t]);
    const d = v.get(k.d) || 0, m = v.get(k.m) || 0, t = v.get(k.t) || 0;
    const usage = { day: d, month: m, tokens: t };
    if (limits.daily && d >= limits.daily) return { ok: false, reason: 'daily request limit reached', usage };
    if (limits.monthly && m >= limits.monthly) return { ok: false, reason: 'monthly request limit reached', usage };
    if (limits.dailyTokens && t >= limits.dailyTokens) return { ok: false, reason: 'daily token limit reached', usage };
    await s.put({ [k.d]: d + 1, [k.m]: m + 1 });
    if (d === 0) await this.cleanup(p);
    return { ok: true, usage: { day: d + 1, month: m + 1, tokens: t } };
  }

  async refund(p) {
    const s = this.ctx.storage;
    const k = { d: `d:${p.day}`, m: `m:${p.month}` };
    const v = await s.get([k.d, k.m]);
    await s.put({ [k.d]: Math.max(0, (v.get(k.d) || 1) - 1), [k.m]: Math.max(0, (v.get(k.m) || 1) - 1) });
  }

  async addTokens(p, n) {
    const key = `t:${p.day}`;
    const t = (await this.ctx.storage.get(key)) || 0;
    await this.ctx.storage.put(key, t + Math.max(0, n | 0));
  }

  async usage(p) {
    const v = await this.ctx.storage.get([`d:${p.day}`, `m:${p.month}`, `t:${p.day}`]);
    return { day: v.get(`d:${p.day}`) || 0, month: v.get(`m:${p.month}`) || 0, tokens: v.get(`t:${p.day}`) || 0 };
  }

  async cleanup(p) {
    // drop counters from previous periods (first request of a new day)
    const all = await this.ctx.storage.list();
    const stale = [...all.keys()].filter((key) => !key.endsWith(p.day) && !key.endsWith(p.month));
    if (stale.length) await this.ctx.storage.delete(stale.slice(0, 128));
  }
}

const quotaStub = (env, name) => env.QUOTA.get(env.QUOTA.idFromName(name));

// ---------------------------------------------------------------- routes

async function authLogin(req, env, c) {
  const url = new URL(req.url);
  const redirect = safePath(url.searchParams.get('redirect') || '/');
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const state = await signJWT({ r: redirect, n: nonce, exp: Math.floor(Date.now() / 1000) + 600 }, env.SESSION_SECRET);
  const gh = new URL('https://github.com/login/oauth/authorize');
  gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  gh.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
  gh.searchParams.set('state', state);
  gh.searchParams.set('scope', c.allowedOrgs.length ? 'read:org' : '');
  gh.searchParams.set('allow_signup', 'false');
  return new Response(null, {
    status: 302,
    headers: {
      Location: gh.toString(),
      'Set-Cookie': cookie('ff_oauth', nonce, 600, '/auth'),
    },
  });
}

async function authCallback(req, env, c) {
  const url = new URL(req.url);
  const st = await verifyJWT(url.searchParams.get('state'), env.SESSION_SECRET);
  if (!st) return backWithError('/', 'sign-in expired, please try again');
  st.r = safePath(st.r);
  if (getCookie(req, 'ff_oauth') !== st.n) return backWithError(st.r, 'sign-in session mismatch, please try again');
  const code = url.searchParams.get('code');
  if (!code) return backWithError(st.r, url.searchParams.get('error_description') || 'sign-in cancelled');

  const tokRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'foot-fit-worker' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${url.origin}/auth/callback` }),
  });
  const tok = await tokRes.json().catch(() => ({}));
  if (!tok.access_token) return backWithError(st.r, 'GitHub did not return a token');
  const ghHeaders = { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'foot-fit-worker' };
  const user = await (await fetch('https://api.github.com/user', { headers: ghHeaders })).json();
  if (!user || !user.id) return backWithError(st.r, 'could not read GitHub profile');

  const login = String(user.login).toLowerCase();
  if (c.blockedUsers.includes(login)) return backWithError(st.r, 'this account is not allowed');
  let allowed = !c.allowedUsers.length && !c.allowedOrgs.length;
  if (c.allowedUsers.includes(login)) allowed = true;
  if (!allowed && c.allowedOrgs.length) {
    const orgs = await (await fetch('https://api.github.com/user/orgs', { headers: ghHeaders })).json().catch(() => []);
    if (Array.isArray(orgs) && orgs.some((o) => c.allowedOrgs.includes(String(o.login).toLowerCase()))) allowed = true;
  }
  if (!allowed) return backWithError(st.r, 'this GitHub account is not on the allow list');
  const ageDays = (Date.now() - Date.parse(user.created_at)) / 86400000;
  if (c.minAccountAgeDays > 0 && !(ageDays >= c.minAccountAgeDays) && !c.allowedUsers.includes(login)) {
    return backWithError(st.r, `GitHub accounts must be at least ${c.minAccountAgeDays} days old`);
  }
  const now = Math.floor(Date.now() / 1000);
  const session = await signJWT({
    sub: String(user.id), login: user.login, av: user.avatar_url, v: c.sessionVersion,
    iat: now, exp: now + c.sessionDays * 86400,
  }, env.SESSION_SECRET);
  const h = new Headers({ Location: st.r });
  h.append('Set-Cookie', cookie(SESSION_COOKIE, session, c.sessionDays * 86400));
  h.append('Set-Cookie', cookie('ff_oauth', '', 0, '/auth'));
  return new Response(null, { status: 302, headers: h });
}

function logout(req) {
  if (!sameOrigin(req)) return json({ error: 'forbidden' }, 403);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
}

async function requireUser(req, env, c) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const p = await verifyJWT(token, env.SESSION_SECRET);
  if (!p || p.v !== c.sessionVersion) return null;
  if (c.blockedUsers.includes(String(p.login).toLowerCase())) return null;
  return p;
}

function quotaView(u, c) {
  return {
    day: u.day, dailyLimit: c.dailyRequests, dailyRemaining: Math.max(0, c.dailyRequests - u.day),
    month: u.month, monthlyLimit: c.monthlyRequests,
    tokens: u.tokens, dailyTokenLimit: c.dailyTokens,
  };
}

async function me(req, env, c) {
  const user = await requireUser(req, env, c);
  if (!user) return json({ signedIn: false });
  const u = await quotaStub(env, `user:${user.sub}`).usage(periods());
  return json({ signedIn: true, login: user.login, avatar: user.av, quota: quotaView(u, c) });
}

/** Validate and sanitise the client's chat request. Returns {error} or {messages, maxTokens, temperature, purpose}. */
export function sanitizeChat(body, c) {
  if (!body || typeof body !== 'object') return { error: 'invalid JSON body' };
  const purpose = PURPOSES.has(body.purpose) ? body.purpose : 'general';
  const msgs = body.messages;
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > 6) return { error: 'messages must be an array of 1-6 items' };
  let images = 0;
  const messages = [];
  for (const m of msgs) {
    if (!m || !['system', 'user', 'assistant'].includes(m.role)) return { error: 'invalid message role' };
    if (typeof m.content === 'string') {
      if (m.content.length > 20000) return { error: 'message too long' };
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) return { error: 'invalid message content' };
    const parts = [];
    for (const p of m.content) {
      if (p && p.type === 'text' && typeof p.text === 'string') {
        if (p.text.length > 20000) return { error: 'text part too long' };
        parts.push({ type: 'text', text: p.text });
      } else if (p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string') {
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(p.image_url.url)) return { error: 'images must be inline data: URLs' };
        if (++images > c.maxImages) return { error: `at most ${c.maxImages} images per request` };
        const detail = ['low', 'high', 'auto'].includes(p.image_url.detail) ? p.image_url.detail : 'low';
        parts.push({ type: 'image_url', image_url: { url: p.image_url.url, detail } });
      } else return { error: 'unsupported content part' };
    }
    messages.push({ role: m.role, content: parts });
  }
  const maxTokens = Math.max(1, Math.min(c.maxTokens, Number(body.max_tokens) || c.maxTokens));
  const temperature = Math.max(0, Math.min(1, Number(body.temperature ?? 0.2)));
  return { messages, maxTokens, temperature, purpose };
}

async function chat(req, env, c, ctx) {
  if (!sameOrigin(req)) return json({ error: 'forbidden' }, 403);
  if (!(req.headers.get('Content-Type') || '').includes('application/json')) return json({ error: 'expected JSON' }, 415);
  const user = await requireUser(req, env, c);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > c.maxBodyBytes) return json({ error: 'request too large' }, 413);
  const raw = await req.text();
  if (raw.length > c.maxBodyBytes) return json({ error: 'request too large' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'invalid JSON' }, 400); }
  const s = sanitizeChat(body, c);
  if (s.error) return json({ error: s.error }, 400);

  const p = periods();
  const userQ = quotaStub(env, `user:${user.sub}`);
  const globalQ = quotaStub(env, 'global');
  const g = await globalQ.reserve({ daily: c.globalDailyRequests }, p);
  if (!g.ok) return json({ error: 'The service has reached its daily AI budget. Please try again tomorrow, or use your own endpoint in settings.' }, 429);
  const r = await userQ.reserve({ daily: c.dailyRequests, monthly: c.monthlyRequests, dailyTokens: c.dailyTokens }, p);
  if (!r.ok) {
    ctx.waitUntil(globalQ.refund(p));
    return json({ error: `Usage limit: ${r.reason}. You can add your own OpenAI-compatible endpoint in settings.`, quota: quotaView(r.usage, c) }, 429);
  }

  const upstreamBody = { model: c.upstreamModel, messages: s.messages, temperature: s.temperature, [c.maxTokensParam]: s.maxTokens };
  let up;
  try {
    up = await fetch(`${c.upstreamBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.UPSTREAM_API_KEY}`, ...c.extraHeaders },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    ctx.waitUntil(Promise.all([userQ.refund(p), globalQ.refund(p)]));
    return json({ error: `AI provider unreachable: ${e.message}` }, 502);
  }
  const data = await up.json().catch(() => null);
  if (!up.ok || !data) {
    ctx.waitUntil(Promise.all([userQ.refund(p), globalQ.refund(p)]));
    const msg = data && data.error ? (data.error.message || JSON.stringify(data.error)) : `status ${up.status}`;
    return json({ error: `AI provider error: ${String(msg).slice(0, 300)}` }, 502);
  }
  const usage = data.usage || {};
  const tokens = usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  ctx.waitUntil(userQ.addTokens(p, tokens));
  console.log(JSON.stringify({ evt: 'chat', user: user.login, purpose: s.purpose, tokens }));
  return json({
    content: data.choices?.[0]?.message?.content ?? '',
    usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: tokens },
    quota: quotaView({ ...r.usage, tokens: r.usage.tokens + tokens }, c),
  });
}

const API_PATHS = /^\/(api|auth)\//;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!API_PATHS.test(url.pathname)) {
      // static web app
      return env.ASSETS ? env.ASSETS.fetch(req) : json({ error: 'not found' }, 404);
    }
    const c = cfg(env);
    let res;
    try {
      if (!env.SESSION_SECRET || !env.GITHUB_CLIENT_ID) res = json({ error: 'server not configured (missing secrets)' }, 500);
      else if (url.pathname === '/auth/login' && req.method === 'GET') res = await authLogin(req, env, c);
      else if (url.pathname === '/auth/callback' && req.method === 'GET') res = await authCallback(req, env, c);
      else if (url.pathname === '/auth/logout' && req.method === 'POST') res = logout(req);
      else if (url.pathname === '/api/me' && req.method === 'GET') res = await me(req, env, c);
      else if (url.pathname === '/api/chat' && req.method === 'POST') res = await chat(req, env, c, ctx);
      else if (url.pathname === '/api/health') res = json({ ok: true, service: 'foot-fit' });
      else res = json({ error: 'not found' }, 404);
    } catch (e) {
      console.error(e);
      res = json({ error: 'internal error' }, 500);
    }
    if (res.status < 300 || res.status >= 400) {
      const h = new Headers(res.headers);
      h.set('Cache-Control', 'no-store');
      res = new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },
};
