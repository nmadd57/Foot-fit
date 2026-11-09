// LLM client: either the hosted proxy (GitHub sign-in, per-account quota) or a
// user-supplied OpenAI-compatible endpoint called directly from the browser.
import { CONFIG } from './config.js';

const SETTINGS_KEY = 'ff_llm_settings';
const api = (path) => `${CONFIG.apiBase}${path}`;

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } }

/** Read (and clear) a sign-in error passed back in the URL fragment. */
export function captureAuthError() {
  const e = location.hash.match(/ff_error=([^&]+)/);
  if (!e) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return decodeURIComponent(e[1]);
}

// The session lives in an HttpOnly cookie; the page only knows what /api/me reports.
let me = null;
export function currentUser() { return me && me.signedIn ? me : null; }

export async function fetchMe() {
  if (!CONFIG.hostedAI) return null;
  try {
    const r = await fetch(api('/api/me'), { credentials: 'same-origin' });
    me = r.ok ? await r.json() : null;
  } catch { me = null; }
  return currentUser();
}

export function signIn() {
  location.href = api(`/auth/login?redirect=${encodeURIComponent(location.pathname + location.search)}`);
}
export async function signOut() {
  await fetch(api('/auth/logout'), { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  me = null;
}

export function getSettings() {
  try { return { mode: 'hosted', baseUrl: '', apiKey: '', model: '', ...JSON.parse(lsGet(SETTINGS_KEY) || '{}') }; }
  catch { return { mode: 'hosted', baseUrl: '', apiKey: '', model: '' }; }
}
export function saveSettings(s) { lsSet(SETTINGS_KEY, JSON.stringify(s)); }

export function hostedAvailable() { return !!CONFIG.hostedAI && me !== null; }

/** Which backend will be used right now, or null if none is configured. */
export function activeBackend() {
  const s = getSettings();
  if (s.mode === 'custom' && s.baseUrl && s.model) return 'custom';
  if (s.mode === 'off') return null;
  if (hostedAvailable() && currentUser()) return 'hosted';
  return null;
}

export class QuotaError extends Error {}

/**
 * Send a chat request. content parts follow the OpenAI format:
 *   [{type:'text', text}, {type:'image_url', image_url:{url:'data:image/jpeg;base64,...'}}]
 */
export async function chat({ system, content, purpose = 'general', maxTokens = 700, temperature = 0.2 }) {
  const backend = activeBackend();
  if (!backend) throw new Error('No AI backend configured. Sign in with GitHub or add your own endpoint in Settings.');
  const messages = [{ role: 'system', content: system }, { role: 'user', content }];
  if (backend === 'hosted') {
    const r = await fetch(api('/api/chat'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose, messages, max_tokens: maxTokens, temperature }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) throw new QuotaError(j.error || 'Usage limit reached for your account.');
    if (r.status === 401) { me = { signedIn: false }; throw new Error('Session expired — please sign in again.'); }
    if (!r.ok) throw new Error(j.error || `AI proxy error ${r.status}`);
    return { text: j.content || '', quota: j.quota, usage: j.usage };
  }
  const s = getSettings();
  const headers = { 'Content-Type': 'application/json' };
  if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
  const r = await fetch(`${s.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: s.model, messages, max_tokens: maxTokens, temperature }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || `Endpoint error ${r.status}`);
  return { text: j.choices?.[0]?.message?.content || '', usage: j.usage };
}

/** Extract the first JSON object from a model reply. */
export function parseJSON(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

export async function chatJSON(opts) {
  const res = await chat(opts);
  return { ...res, json: parseJSON(res.text) };
}

/** Downscale a canvas/ImageData/bitmap to a JPEG data URL for the model. */
export function toDataURL(source, maxDim = 768, quality = 0.8) {
  const w0 = source.width, h0 = source.height;
  const s = Math.min(1, maxDim / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
  const g = c.getContext('2d');
  if (source instanceof ImageData) {
    const t = document.createElement('canvas'); t.width = w0; t.height = h0;
    t.getContext('2d').putImageData(source, 0, 0);
    g.drawImage(t, 0, 0, c.width, c.height);
  } else g.drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}
