// Foot Fit — UI orchestration.
import { CONFIG } from './config.js';
import { makeLayout } from './templateSpec.js';
import { Detector, frameGeometry, defaultFocal, FOOT_CENTER } from './tracking.js';
import { processScan } from './pipeline.js';
import { toSTL, toOBJ } from './reconstruct.js';
import { median, projectPoint } from './math.js';
import * as llm from './llm.js';
import * as ai from './assistant.js';

const $ = (id) => document.getElementById(id);
const BINS = 12;

// ------------------------------------------------------------------ prefs

const PREFS_KEY = 'ff_prefs';
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; } }
function savePrefs() {
  const p = { paper: $('paper').value, sheets: $('sheets').value, rulerMm: $('rulerMm').value, side: $('side').value };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
  $('templateLink').href = `template.html?paper=${p.paper}&sheets=${p.sheets}`;
}
function applyPrefs() {
  const p = loadPrefs();
  for (const k of ['paper', 'sheets', 'rulerMm', 'side']) if (p[k] != null) $(k).value = p[k];
  savePrefs();
}

function currentLayout() { return makeLayout($('paper').value, +$('sheets').value); }
function printScale() { const v = parseFloat($('rulerMm').value); return v > 80 && v < 120 ? v / 100 : 1; }

// ------------------------------------------------------------------ ui helpers

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
}
let toastTimer = null;
function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ------------------------------------------------------------------ account / AI backend

async function renderAccount() {
  const el = $('account');
  el.innerHTML = '';
  const user = await llm.fetchMe();
  if (!llm.hostedAvailable()) { renderAIStatus(); return; }
  if (!user) {
    const b = document.createElement('button');
    b.className = 'btn secondary'; b.textContent = 'Sign in with GitHub';
    b.onclick = () => llm.signIn();
    el.appendChild(b);
  } else {
    el.innerHTML = `${user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : ''}<div><div>${esc(user.login)}</div><div class="quota" id="quota"></div></div>`;
    const out = document.createElement('button');
    out.className = 'icon-btn'; out.title = 'Sign out'; out.textContent = '⎋';
    out.onclick = async () => { await llm.signOut(); renderAccount(); };
    el.appendChild(out);
    if (user.quota) showQuota(user.quota);
  }
  renderAIStatus();
}
function showQuota(q) {
  const el = $('quota');
  if (el && q) el.textContent = `AI: ${q.dailyRemaining} left today`;
}

function renderAIStatus() {
  const backend = llm.activeBackend();
  const s = llm.getSettings();
  let msg;
  if (backend === 'hosted') msg = 'Using the hosted AI (GitHub account, daily limit applies).';
  else if (backend === 'custom') msg = `Using your endpoint: ${s.model} @ ${s.baseUrl}`;
  else if (s.mode === 'off') msg = 'AI features are turned off (⚙︎ to enable). Measurements still work.';
  else if (llm.hostedAvailable()) msg = 'Sign in with GitHub (top right) or add your own OpenAI-compatible endpoint in ⚙︎ to enable AI features.';
  else msg = 'Add an OpenAI-compatible endpoint in ⚙︎ to enable AI features.';
  $('aiStatus').textContent = msg;
  for (const id of ['btnReview', 'btnReport']) $(id).disabled = !backend;
  $('btnCoach').hidden = !backend;
}

function openSettings() {
  const d = $('settings'), f = d.querySelector('form');
  const s = llm.getSettings();
  const hostedRadio = f.querySelector('input[value=hosted]');
  hostedRadio.disabled = !llm.hostedAvailable();
  if (!llm.hostedAvailable()) hostedRadio.parentElement.title = 'This deployment has no hosted AI proxy configured.';
  let mode = s.mode;
  if (mode === 'hosted' && !llm.hostedAvailable()) mode = s.baseUrl ? 'custom' : 'off';
  f.querySelector(`input[value=${mode}]`).checked = true;
  f.baseUrl.value = s.baseUrl; f.apiKey.value = s.apiKey; f.model.value = s.model;
  $('settingsTest').textContent = '';
  d.showModal();
}
function readSettingsForm() {
  const f = $('settings').querySelector('form');
  return { mode: f.querySelector('input[name=mode]:checked')?.value || 'off', baseUrl: f.baseUrl.value.trim(), apiKey: f.apiKey.value.trim(), model: f.model.value.trim() };
}

// ------------------------------------------------------------------ scanner

class Scanner {
  constructor() {
    this.detector = new Detector();
    this.video = $('video');
    this.view = $('view');
    this.dc = document.createElement('canvas');
    this.running = false;
  }

  async start(layout) {
    this.layout = layout;
    this.frames = [];
    this.bins = new Array(BINS).fill(0);
    this.step = 'top';
    this.fEst = [];
    this.lastGeo = null; this.lastDets = []; this.lastDetAt = 0;
    this.steady = 0; this.lastCaptureAt = 0; this.capturing = false; this.detecting = false;
    this.flash = 0;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play();
    this.running = true;
    this.updateStepUI();
    this.renderRing(null);
    requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  focal(w, h) {
    if (this.fEst.length >= 5) return median(this.fEst.slice(-40)) * Math.max(w, h);
    return defaultFocal(w, h);
  }

  loop = () => {
    if (!this.running) return;
    this.draw();
    if (!this.detecting && !this.capturing) this.detectNow();
    requestAnimationFrame(this.loop);
  };

  grab(maxDim) {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const s = Math.min(1, maxDim / Math.max(vw, vh));
    const c = this.dc;
    c.width = Math.round(vw * s); c.height = Math.round(vh * s);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(this.video, 0, 0, c.width, c.height);
    return { img: g.getImageData(0, 0, c.width, c.height), s, vw, vh };
  }

  async detectNow() {
    const vw = this.video.videoWidth;
    if (!vw) return;
    this.detecting = true;
    try {
      const { img, s, vh } = this.grab(960);
      const dets = await this.detector.detect(img);
      const scaled = dets.map((d) => ({ id: d.id, corners: d.corners.map(([x, y]) => [x / s, y / s]) }));
      this.onDetections(scaled, vw, vh);
    } finally { this.detecting = false; }
  }

  onDetections(dets, w, h) {
    const geo = frameGeometry(dets, this.layout, { f: this.focal(w, h), width: w, height: h, minMarkers: 3 });
    this.lastDets = dets; this.lastDetAt = performance.now();
    if (geo && geo.tiltDeg > 20 && geo.fSingle) {
      const rel = geo.fSingle / Math.max(w, h);
      if (rel > 0.45 && rel < 2) this.fEst.push(rel);
    }
    if (geo && this.lastGeo) {
      const d = Math.hypot(...geo.center.map((v, i) => v - this.lastGeo.center[i]));
      this.steady = d < 12 ? this.steady + 1 : 0;
    } else this.steady = 0;
    this.lastGeo = geo;
    this.updateHUD(geo, dets.length);
    if (!geo || this.capturing) return;
    const now = performance.now();
    if (now - this.lastCaptureAt < 600) return;
    if (this.step === 'top') {
      if (geo.nMarkers >= 6 && geo.tiltDeg < 15 && this.steady >= 2) this.capture('top');
    } else if (this.step === 'orbit') {
      if (geo.nMarkers >= 4 && geo.tiltDeg > 20 && geo.elevationDeg > 12 && geo.elevationDeg < 70 && this.steady >= 2) {
        const bin = Math.floor(geo.azimuthDeg / (360 / BINS)) % BINS;
        if (!this.bins[bin]) this.capture('orbit', bin);
      }
    }
  }

  hint(geo, n) {
    if (n < 3) return 'Point the camera at the template so the black markers are visible.';
    if (!geo) return 'Hold still — finding the template…';
    if (this.step === 'top') {
      if (geo.tiltDeg > 15) return 'Hold the phone flat, directly above the foot.';
      if (geo.nMarkers < 6) return 'Move higher so more markers are visible.';
      if (this.steady < 2) return 'Hold still…';
      return 'Good — capturing.';
    }
    if (geo.elevationDeg >= 70) return 'Tilt the phone and move lower — aim at the foot from the side.';
    if (geo.elevationDeg <= 12) return 'Move a little higher so the markers stay visible.';
    if (geo.nMarkers < 4) return 'Step back a little so more markers are visible.';
    const missing = this.bins.map((b, i) => (b ? null : i)).filter((v) => v != null);
    if (!missing.length) return 'All around! Tap Finish.';
    if (this.steady < 2) return 'Hold still…';
    return 'Walk slowly around the foot — fill the ring.';
  }

  updateHUD(geo, n) {
    const m = $('hudMarkers');
    m.textContent = `markers ${geo ? geo.nMarkers : n}`;
    m.className = `chip ${(geo ? geo.nMarkers : n) >= 4 ? 'ok' : 'bad'}`;
    $('hudAngle').textContent = geo ? `tilt ${geo.tiltDeg.toFixed(0)}° · elev ${geo.elevationDeg.toFixed(0)}°` : '–';
    const tops = this.frames.filter((f) => f.kind === 'top').length, orb = this.frames.length - tops;
    $('hudCount').textContent = `${tops} top · ${orb} side`;
    if (!this.aiSayUntil || performance.now() > this.aiSayUntil) $('stepHint').textContent = this.hint(geo, n);
    this.renderRing(geo);
  }

  updateStepUI() {
    if (this.step === 'top') {
      $('stepTitle').textContent = 'Step 1 · Top view';
      $('btnNext').textContent = 'Next ▸';
    } else {
      $('stepTitle').textContent = 'Step 2 · Around the foot';
      $('btnNext').textContent = 'Finish ✓';
    }
  }

  renderRing(geo) {
    const svg = $('ring');
    const parts = ['<circle r="54" fill="rgba(0,0,0,.45)"/>'];
    for (let i = 0; i < BINS; i++) {
      const a0 = (i * 360 / BINS - 90 + 2) * Math.PI / 180, a1 = ((i + 1) * 360 / BINS - 90 - 2) * Math.PI / 180;
      const r0 = 36, r1 = 50;
      const p = (r, a) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
      parts.push(`<path d="M${p(r0, a0)} L${p(r1, a0)} A${r1} ${r1} 0 0 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 0 0 ${p(r0, a0)}Z" fill="${this.bins?.[i] ? '#2bb3a8' : 'rgba(255,255,255,.18)'}"/>`);
    }
    parts.push('<ellipse rx="9" ry="20" fill="rgba(255,255,255,.75)"/><text y="-24" font-size="8" fill="#fff" text-anchor="middle">toes</text>');
    if (geo && this.step === 'orbit') {
      const a = (geo.azimuthDeg - 90) * Math.PI / 180;
      parts.push(`<circle cx="${(43 * Math.cos(a)).toFixed(1)}" cy="${(43 * Math.sin(a)).toFixed(1)}" r="6" fill="#ffb000" stroke="#000" stroke-width="1"/>`);
    }
    svg.innerHTML = parts.join('');
    svg.style.display = this.step === 'orbit' ? '' : 'none';
  }

  async capture(kind, bin) {
    if (this.capturing) return;
    this.capturing = true;
    this.lastCaptureAt = performance.now();
    try {
      const { img } = this.grab(kind === 'top' ? 1920 : 1280);
      const dets = await this.detector.detect(img);
      if (dets.length < 4) { this.capturing = false; return; }
      this.frames.push({ img, dets, kind });
      if (bin != null) this.bins[bin] = 1;
      this.flash = 1;
      if (navigator.vibrate) navigator.vibrate(25);
      const tops = this.frames.filter((f) => f.kind === 'top').length;
      if (this.step === 'top' && tops >= 3) {
        this.step = 'orbit';
        this.updateStepUI();
        toast('Top view done. Now walk around the foot, aiming at it from about 30–50° above the floor.', 5000);
      }
    } finally {
      this.capturing = false;
    }
  }

  manualCapture() {
    const g = this.lastGeo;
    if (!g) { toast('Template not found in view.'); return; }
    if (g.tiltDeg < 20) this.capture('top');
    else this.capture('orbit', Math.floor(g.azimuthDeg / (360 / BINS)) % BINS);
  }

  draw() {
    const v = this.video, c = this.view;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = c.getContext('2d');
    const vw = v.videoWidth, vh = v.videoHeight;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    if (!vw) return;
    const s = Math.max(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2; // cover
    g.drawImage(v, ox, oy, vw * s, vh * s);
    const T = (p) => [ox + p[0] * s, oy + p[1] * s];
    const fresh = performance.now() - this.lastDetAt < 400;
    if (fresh) {
      g.lineWidth = 2 * dpr; g.strokeStyle = '#2bf5a0';
      for (const d of this.lastDets) {
        g.beginPath(); d.corners.forEach((p, i) => { const q = T(p); i ? g.lineTo(...q) : g.moveTo(...q); }); g.closePath(); g.stroke();
      }
      const geo = this.lastGeo;
      if (geo) {
        const L = this.layout, cam = geo.cam;
        const P = (x, y, hgt = 0) => { const q = projectPoint(cam, [x, y, -hgt]); return q[2] > 0 ? T(q) : null; };
        const poly = (pts, col, w = 2) => {
          if (pts.some((p) => !p)) return;
          g.strokeStyle = col; g.lineWidth = w * dpr; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(...p) : g.moveTo(...p))); g.closePath(); g.stroke();
        };
        poly([P(0, 0), P(L.W, 0), P(L.W, L.H), P(0, L.H)], 'rgba(255,255,255,.8)');
        const fa = L.footArea;
        poly([P(fa.x0, L.heelLineY), P(fa.x1, L.heelLineY)], '#ffb000', 3);
        if (this.step === 'orbit') {
          const c0 = FOOT_CENTER(L), hw = 60, hl = 150, hh = 100;
          const box = [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]].map(([dx, dy]) => [c0[0] + dx, Math.min(c0[1] + dy, L.heelLineY)]);
          poly(box.map(([x, y]) => P(x, y, hh)), 'rgba(43,179,168,.7)');
          for (const [x, y] of box) { const a = P(x, y, 0), b = P(x, y, hh); if (a && b) { g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke(); } }
        }
      }
    }
    if (this.flash > 0) {
      g.fillStyle = `rgba(255,255,255,${this.flash * 0.6})`; g.fillRect(0, 0, W, H);
      this.flash = Math.max(0, this.flash - 0.12);
    }
  }

  coachState() {
    const g = this.lastGeo;
    const names = ['front', 'front-right', 'right-front', 'right', 'right-back', 'back-right', 'back', 'back-left', 'left-back', 'left', 'left-front', 'front-left'];
    return {
      step: this.step === 'top' ? 'top view' : 'orbit around the foot',
      stepGoal: this.step === 'top'
        ? 'Goal: phone held flat 40–60 cm directly above the foot, whole template visible.'
        : 'Goal: capture the foot from all around at 20–60° elevation, 40–70 cm away, with at least 4 markers visible.',
      elevation: g?.elevationDeg, azimuth: g?.azimuthDeg, markers: g?.nMarkers || this.lastDets.length,
      captured: `${this.frames.length} frames`,
      missing: this.step === 'orbit' ? this.bins.map((b, i) => (b ? null : names[i])).filter(Boolean).join(', ') : '',
    };
  }
}

// ------------------------------------------------------------------ results

const state = { frames: null, layout: null, result: null, side: 'right', disposeViewer: null };

const LABELS = [
  ['lengthMm', 'Foot length'],
  ['ballWidthMm', 'Ball width'],
  ['heelWidthMm', 'Heel width'],
  ['heelToBallMm', 'Heel to ball'],
  ['instepHeightMm', 'Instep height'],
  ['toeBoxHeightMm', 'Toe height'],
  ['ballGirthMm', 'Ball girth (approx.)'],
  ['instepGirthMm', 'Instep girth (approx.)'],
];

async function runProcessing() {
  show('processing');
  const bar = $('progBar'), txt = $('progText');
  try {
    const res = await processScan(state.frames, state.layout, {
      sensitivity: parseFloat($('sensitivity').value),
      scale: printScale(),
      onStatus: (s, p) => { txt.textContent = s; if (p != null) bar.style.width = `${Math.round(p * 100)}%`; },
    });
    state.result = res;
    renderResults();
    saveHistory(res.measures);
    show('results');
  } catch (e) {
    console.error(e);
    txt.textContent = e.message || String(e);
    toast(e.message || 'Processing failed', 6000);
    setTimeout(() => show('home'), 3500);
  }
}

function renderResults() {
  const r = state.result, m = r.measures;
  $('resTitle').textContent = `${state.side === 'left' ? 'Left' : 'Right'} foot`;
  $('warnings').innerHTML = r.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('');
  const rows = [];
  for (const [k, label] of LABELS) {
    if (m[k] == null || !isFinite(m[k])) continue;
    rows.push(`<tr><td>${label}</td><td>${m[k].toFixed(1)} mm</td></tr>`);
  }
  if (m.volumeMl) rows.push(`<tr><td>Volume (below ${110} mm)</td><td>${Math.round(m.volumeMl)} ml</td></tr>`);
  const sz = ai.localSizes(m.lengthMm);
  rows.push(`<tr><td>Length-based size (approx.)</td><td class="sub">EU ${sz.eu} · US M ${sz.us_men} · US W ${sz.us_women} · UK ${sz.uk}</td></tr>`);
  rows.push(`<tr><td>Width ÷ length</td><td class="sub">${(m.ballWidthMm / m.lengthMm * 100).toFixed(1)} %</td></tr>`);
  if (m.lengthSpreadMm != null) rows.push(`<tr><td>Frame-to-frame spread</td><td class="sub">±${(m.lengthSpreadMm / 2).toFixed(1)} mm</td></tr>`);
  $('measureTable').innerHTML = rows.join('');
  const top = $('topImg'); top.innerHTML = ''; top.appendChild(r.topCanvas);
  const sv = $('sideViews'); sv.innerHTML = '';
  r.viewOverlays.forEach((c) => sv.appendChild(c));
  if (!r.viewOverlays.length) sv.innerHTML = '<p class="hint">None.</p>';
  if (state.disposeViewer) { state.disposeViewer(); state.disposeViewer = null; }
  const v3 = $('viewer3d');
  if (r.mesh) {
    import('./viewer.js').then(({ showMesh }) => showMesh(v3, r.mesh)).then((d) => { state.disposeViewer = d; })
      .catch((e) => { v3.innerHTML = `<p class="hint">3D preview unavailable (${esc(e.message)}). Downloads still work.</p>`; });
  } else v3.innerHTML = '<p class="hint">No 3D model — capture at least 4 views around the foot.</p>';
  $('btnDlSTL').disabled = $('btnDlOBJ').disabled = !r.mesh;
  $('aiOut').innerHTML = '';
  renderAIStatus();
}

function saveHistory(m) {
  try {
    const h = JSON.parse(localStorage.getItem('ff_history') || '[]');
    h.unshift({ t: Date.now(), side: state.side, length: +m.lengthMm.toFixed(1), width: +m.ballWidthMm.toFixed(1) });
    localStorage.setItem('ff_history', JSON.stringify(h.slice(0, 10)));
  } catch { /* ignore */ }
  renderHistory();
}
function renderHistory() {
  let h = [];
  try { h = JSON.parse(localStorage.getItem('ff_history') || '[]'); } catch { /* ignore */ }
  $('history').innerHTML = h.length ? '<b>Previous scans</b>' + h.map((x) => `<div class="item"><span>${new Date(x.t).toLocaleDateString()} · ${x.side}</span><span>${x.length} × ${x.width} mm</span></div>`).join('') : '';
}

function roundedMeasures() {
  const out = {};
  for (const [k, v] of Object.entries(state.result.measures)) if (typeof v === 'number' && isFinite(v)) out[k] = +v.toFixed(1);
  return out;
}

async function aiReview() {
  const out = $('aiOut');
  out.innerHTML = '<p class="hint">Asking the AI to check the outline…</p>';
  try {
    const r = state.result;
    const j = await ai.reviewSegmentation(r.topCanvas, r.viewOverlays, r.measures);
    if (!j) throw new Error('The AI reply could not be read.');
    const change = Math.max(-0.4, Math.min(0.4, +j.sensitivity_change || 0));
    const cur = parseFloat($('sensitivity').value);
    const next = Math.max(0.6, Math.min(1.5, +(cur + change).toFixed(2)));
    out.innerHTML = `<h3>Outline quality: ${esc(j.quality || '?')}</h3>
      ${j.problems?.length ? `<ul>${j.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      ${j.advice ? `<p>${esc(j.advice)}</p>` : ''}
      ${j.retake ? '<div class="warn">The AI suggests retaking the scan.</div>' : ''}
      ${Math.abs(next - cur) >= 0.05 ? `<button class="btn secondary" id="btnApplyAI">Apply suggestion (sensitivity ${cur} → ${next})</button>` : ''}`;
    const b = $('btnApplyAI');
    if (b) b.onclick = () => { $('sensitivity').value = next; runProcessing(); };
    refreshQuota();
  } catch (e) { out.innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
}

async function aiReport() {
  const out = $('aiOut');
  out.innerHTML = '<p class="hint">Writing your fit report…</p>';
  try {
    const j = await ai.fitReport(roundedMeasures(), state.result.topCanvas, state.side);
    if (!j) throw new Error('The AI reply could not be read.');
    const s = j.sizes || {};
    out.innerHTML = `<div class="sizes">
        ${[['EU', s.eu], ['US men', s.us_men], ['US women', s.us_women], ['UK', s.uk], ['Mondo', s.mondopoint_mm]].map(([k, v]) => `<div>${k}<b>${esc(v ?? '–')}</b></div>`).join('')}
      </div>
      <h3>Width: ${esc(j.width || '–')} · Toe shape: ${esc(j.toe_shape || '–')}</h3>
      <p>${esc(j.summary || '')}</p>
      ${j.tips?.length ? `<h3>Fit tips</h3><ul>${j.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <p class="hint">Confidence: ${esc(j.confidence || '?')}. AI-generated — sizes vary by brand; try shoes on when you can.</p>`;
    refreshQuota();
  } catch (e) { out.innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
}

async function refreshQuota() {
  if (llm.activeBackend() !== 'hosted') return;
  const me = await llm.fetchMe();
  if (me?.quota) showQuota(me.quota);
}

// ------------------------------------------------------------------ photo import

async function importPhotos(files) {
  const layout = currentLayout();
  const det = scanner.detector;
  show('processing');
  $('progText').textContent = 'Reading photos…';
  const frames = [];
  let i = 0;
  for (const file of files) {
    i++;
    $('progText').textContent = `Finding markers in photo ${i}/${files.length}…`;
    $('progBar').style.width = `${Math.round(i / files.length * 30)}%`;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const s = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0, c.width, c.height);
      const img = g.getImageData(0, 0, c.width, c.height);
      const dets = await det.detect(img);
      if (dets.length < 4) continue;
      const geo = frameGeometry(dets, layout, { width: img.width, height: img.height });
      frames.push({ img, dets, kind: geo && geo.tiltDeg < 20 ? 'top' : 'orbit' });
    } catch (e) { console.warn('photo failed', e); }
  }
  if (!frames.length) { toast('No template markers found in those photos.', 5000); show('home'); return; }
  state.frames = frames; state.layout = layout; state.side = $('side').value;
  runProcessing();
}

// ------------------------------------------------------------------ wiring

const scanner = new Scanner();

function init() {
  const err = llm.captureAuthError();
  if (err) setTimeout(() => toast(`Sign-in failed: ${err}`, 6000), 300);
  applyPrefs();
  for (const id of ['paper', 'sheets', 'rulerMm', 'side']) $(id).addEventListener('change', savePrefs);
  renderAccount();
  renderAIStatus();
  renderHistory();

  $('btnSettings').onclick = openSettings;
  $('btnSaveSettings').onclick = (e) => {
    const s = readSettingsForm();
    if (s.mode === 'custom' && (!s.baseUrl || !s.model)) { e.preventDefault(); $('settingsTest').textContent = 'Base URL and model are required.'; return; }
    if (s.mode === 'hosted' && !llm.currentUser()) toast('Now sign in with GitHub (top right).');
    llm.saveSettings(s); renderAIStatus();
  };
  $('btnTestAI').onclick = async () => {
    const prev = llm.getSettings();
    llm.saveSettings(readSettingsForm());
    $('settingsTest').textContent = 'Testing…';
    try {
      const r = await llm.chat({ system: 'Reply with the single word OK.', content: [{ type: 'text', text: 'ping' }], purpose: 'test', maxTokens: 5 });
      $('settingsTest').textContent = `✓ Connected: “${(r.text || '').trim().slice(0, 40)}”`;
    } catch (e) { $('settingsTest').textContent = `✗ ${e.message}`; }
    llm.saveSettings(prev);
  };

  $('btnScan').onclick = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { toast('Camera not available in this browser. Use photos instead.'); return; }
    state.layout = currentLayout(); state.side = $('side').value;
    show('scan');
    try { await scanner.start(state.layout); }
    catch (e) { show('home'); toast(`Camera error: ${e.message}`, 6000); }
  };
  $('btnCancel').onclick = () => { scanner.stop(); show('home'); };
  $('btnCapture').onclick = () => scanner.manualCapture();
  $('btnNext').onclick = () => {
    if (scanner.step === 'top') {
      if (!scanner.frames.some((f) => f.kind === 'top')) { toast('Capture at least one top view first (hold the phone flat above the foot).'); return; }
      scanner.step = 'orbit'; scanner.updateStepUI(); return;
    }
    const sides = scanner.frames.filter((f) => f.kind === 'orbit').length;
    if (sides < 4 && !confirm(`Only ${sides} side views — the 3D model needs at least 4 (ideally 8+). Finish anyway?`)) return;
    scanner.stop();
    state.frames = scanner.frames;
    runProcessing();
  };
  $('btnCoach').onclick = async () => {
    const say = $('aiSay');
    say.hidden = false; say.textContent = '✨ Thinking…';
    try {
      const { img } = scanner.grab(768);
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(img, 0, 0);
      let text;
      if (!scanner.frames.length && scanner.step === 'top') {
        const j = await ai.setupCheck(c, { markers: scanner.lastDets.length });
        text = j ? [...(j.issues || []), ...(j.tips || [])].slice(0, 3).join(' · ') || 'Setup looks good — hold the phone flat above the foot.' : 'No answer.';
      } else {
        const j = await ai.coach(c, scanner.coachState());
        text = j?.say || 'No answer.';
      }
      say.textContent = `✨ ${text}`;
      refreshQuota();
    } catch (e) { say.textContent = `✨ ${e.message}`; }
    scanner.aiSayUntil = performance.now() + 9000;
    setTimeout(() => { if (performance.now() >= scanner.aiSayUntil) say.hidden = true; }, 9100);
  };

  $('filePhotos').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importPhotos(f); };
  $('btnRecompute').onclick = () => { if (state.frames) runProcessing(); };
  $('btnReview').onclick = aiReview;
  $('btnReport').onclick = aiReport;
  $('btnNewScan').onclick = () => { state.frames = null; state.result = null; show('home'); };
  const stamp = () => `${state.side}-foot-${new Date().toISOString().slice(0, 10)}`;
  $('btnDlSTL').onclick = () => state.result?.mesh && download(toSTL(state.result.mesh, stamp()), `${stamp()}.stl`);
  $('btnDlOBJ').onclick = () => state.result?.mesh && download(toOBJ(state.result.mesh, stamp()), `${stamp()}.obj`);
  $('btnDlJSON').onclick = () => state.result && download(new Blob([JSON.stringify({
    app: CONFIG.appName, date: new Date().toISOString(), side: state.side,
    template: { paper: state.layout.paperKey, sheets: state.layout.sheets, printScale: printScale() },
    measurementsMm: roundedMeasures(), warnings: state.result.warnings, debug: { ...state.result.debug, tilt: undefined },
  }, null, 2)], { type: 'application/json' }), `${stamp()}.json`);
  $('btnDlPNG').onclick = () => state.result && state.result.topCanvas.toBlob((b) => download(b, `${stamp()}-outline.png`));
}

init();
