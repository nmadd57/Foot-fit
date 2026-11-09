// Foot segmentation: top-view (rectified onto the paper plane) and oblique views.
import { applyH, projectPoint, cameraCenter, solve } from './math.js';
import { MARKER } from './templateSpec.js';

// ---------------------------------------------------------------- utilities

function sampleBilinear(img, x, y, out, o) {
  const { width: w, height: h, data } = img;
  if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return false;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
  for (let c = 0; c < 3; c++) {
    out[o + c] = (data[i00 + c] * (1 - fx) + data[i10 + c] * fx) * (1 - fy) + (data[i01 + c] * (1 - fx) + data[i11 + c] * fx) * fy;
  }
  return true;
}

/** Warp an image onto the paper plane. region in frame mm. Returns {w,h,res,x0,y0,rgb,valid}. */
export function rectify(img, H, region, res = 0.5) {
  const w = Math.round((region.x1 - region.x0) / res), h = Math.round((region.y1 - region.y0) / res);
  const rgb = new Float32Array(w * h * 3);
  const valid = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const y = region.y0 + (j + 0.5) * res;
    for (let i = 0; i < w; i++) {
      const x = region.x0 + (i + 0.5) * res;
      const [u, v] = applyH(H, x, y);
      if (sampleBilinear(img, u, v, rgb, (j * w + i) * 3)) valid[j * w + i] = 1;
    }
  }
  return { w, h, res, x0: region.x0, y0: region.y0, rgb, valid };
}

export function erode(mask, w, h, r = 1) { return morph(mask, w, h, r, true); }
export function dilate(mask, w, h, r = 1) { return morph(mask, w, h, r, false); }
function morph(mask, w, h, r, isErode) {
  // separable square structuring element
  let src = mask;
  for (let pass = 0; pass < 2; pass++) {
    const dst = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = isErode ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const xx = pass === 0 ? x + k : x, yy = pass === 0 ? y : y + k;
        const inside = xx >= 0 && yy >= 0 && xx < w && yy < h;
        const s = inside ? src[yy * w + xx] : 0;
        if (isErode) { if (!s) { v = 0; break; } } else if (s) { v = 1; break; }
      }
      dst[y * w + x] = v;
    }
    src = dst;
  }
  return src;
}

/** Label connected components (4-connectivity). Returns {labels, sizes}. */
export function components(mask, w, h) {
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let p = 0; p < w * h; p++) {
    if (!mask[p] || labels[p]) continue;
    let sp = 0, size = 0;
    stack[sp++] = p; labels[p] = next;
    while (sp) {
      const q = stack[--sp]; size++;
      const x = q % w, y = (q / w) | 0;
      if (x > 0 && mask[q - 1] && !labels[q - 1]) { labels[q - 1] = next; stack[sp++] = q - 1; }
      if (x < w - 1 && mask[q + 1] && !labels[q + 1]) { labels[q + 1] = next; stack[sp++] = q + 1; }
      if (y > 0 && mask[q - w] && !labels[q - w]) { labels[q - w] = next; stack[sp++] = q - w; }
      if (y < h - 1 && mask[q + w] && !labels[q + w]) { labels[q + w] = next; stack[sp++] = q + w; }
    }
    sizes.push(size); next++;
  }
  return { labels, sizes };
}

export function largestComponent(mask, w, h) {
  const { labels, sizes } = components(mask, w, h);
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > (sizes[best] || 0)) best = i;
  const out = new Uint8Array(w * h);
  if (!best) return out;
  for (let p = 0; p < w * h; p++) out[p] = labels[p] === best ? 1 : 0;
  return out;
}

export function fillHoles(mask, w, h) {
  const inv = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) inv[p] = mask[p] ? 0 : 1;
  const { labels } = components(inv, w, h);
  const border = new Set();
  for (let x = 0; x < w; x++) { border.add(labels[x]); border.add(labels[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { border.add(labels[y * w]); border.add(labels[y * w + w - 1]); }
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = mask[p] || !border.has(labels[p]) ? 1 : 0;
  return out;
}

// ---------------------------------------------------------------- top view

/** Fit a smooth (quadratic) paper-colour model from known-blank areas of the template. */
export function fitPaperModel(rect, layout) {
  const { w, h, res, x0, y0, rgb, valid } = rect;
  const pts = [];
  const add = (x, y) => {
    const i = Math.floor((x - x0) / res), j = Math.floor((y - y0) / res);
    if (i < 0 || j < 0 || i >= w || j >= h || !valid[j * w + i]) return;
    const o = (j * w + i) * 3;
    pts.push([x, y, rgb[o], rgb[o + 1], rgb[o + 2]]);
  };
  const W = layout.W;
  for (let y = 1; y < layout.H - 1; y += 2) {
    for (const x of [MARKER + 1.0, MARKER + 2.2, W - MARKER - 2.2, W - MARKER - 1.0]) add(x, y);
  }
  // gaps between markers in the side columns
  const ms = layout.markers;
  for (const m of ms) {
    const below = ms.find((o) => o.x === m.x && o.y > m.y && o.y - m.y < 3 * MARKER);
    if (!below) continue;
    for (let y = m.y + m.s + 2; y < below.y - 2; y += 2) for (let x = m.x + 2; x < m.x + m.s - 2; x += 3) add(x, y);
  }
  // strips at top of frame and just below the heel line
  for (let x = layout.footArea.x0 + 2; x < layout.footArea.x1 - 2; x += 3) {
    add(x, 7); add(x, 10); add(x, layout.heelLineY + 2.5);
  }
  const W2 = W / 2, H2 = layout.H / 2;
  const basis = (x, y) => { const u = (x - W2) / W2, v = (y - H2) / H2; return [1, u, v, u * v, u * u, v * v]; };
  let weights = pts.map(() => 1);
  let coef = null;
  for (let iter = 0; iter < 6; iter++) {
    coef = [0, 1, 2].map((c) => {
      const A = new Array(36).fill(0), b = new Array(6).fill(0);
      pts.forEach((p, k) => {
        const B = basis(p[0], p[1]); const wk = weights[k];
        for (let a = 0; a < 6; a++) { b[a] += wk * B[a] * p[2 + c]; for (let d = 0; d < 6; d++) A[a * 6 + d] += wk * B[a] * B[d]; }
      });
      for (let a = 0; a < 6; a++) A[a * 6 + a] += 1e-6;
      return solve(A, b, 6) || [200, 0, 0, 0, 0, 0];
    });
    // robust reweighting by luminance residual (rejects samples covered by foot/shadow)
    const resid = pts.map((p) => {
      const B = basis(p[0], p[1]);
      let r = 0;
      for (let c = 0; c < 3; c++) r += Math.abs(p[2 + c] - B.reduce((s, v, a) => s + v * coef[c][a], 0));
      return r / 3;
    });
    const sorted = resid.slice().sort((a, b) => a - b);
    const scale = Math.max(3, 1.5 * sorted[sorted.length >> 1]);
    weights = resid.map((r) => (r < scale ? 1 : scale / r) ** 2);
  }
  return {
    at(x, y) { const B = basis(x, y); return coef.map((cc) => Math.max(1, B.reduce((s, v, a) => s + v * cc[a], 0))); },
    samples: pts.length,
  };
}

/**
 * Per-pixel "foot score" on the rectified top view (score >= 1 means foot).
 * sensitivity > 1 makes the detector more inclusive.
 */
export function topScores(rect, paper) {
  const { w, h, res, x0, y0, rgb } = rect;
  const lum = new Float32Array(w * h), chroma = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const y = y0 + (j + 0.5) * res;
    let P = null;
    for (let i = 0; i < w; i++) {
      if ((i & 15) === 0) P = paper.at(x0 + (i + 8) * res, y);
      const o = (j * w + i) * 3;
      const r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
      const s = r + g + b + 1e-3, sp = P[0] + P[1] + P[2];
      lum[j * w + i] = s / sp;
      chroma[j * w + i] = Math.hypot(r / s - P[0] / sp, g / s - P[1] / sp, b / s - P[2] / sp);
    }
  }
  return { lum, chroma };
}

export function topMask(rect, scores, layout, sensitivity = 1) {
  const { w, h, res, x0, y0, valid } = rect;
  const lumThr = 1 - 0.38 * sensitivity;      // darker than 62% of paper -> foot
  const chThr = 0.035 / sensitivity;           // or clearly coloured (skin, socks)
  const fa = layout.footArea;
  const raw = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const y = y0 + (j + 0.5) * res;
    if (y > layout.heelLineY + 4 || y < fa.y0) continue;
    for (let i = 0; i < w; i++) {
      const x = x0 + (i + 0.5) * res;
      if (x < fa.x0 || x > fa.x1) continue;
      const p = j * w + i;
      if (!valid[p]) continue;
      const L = scores.lum[p], C = scores.chroma[p];
      // shadows are dark but neutral; skin/socks are coloured or very dark
      if (L < lumThr || (C > chThr && L < 1.08)) raw[p] = 1;
    }
  }
  let m = erode(raw, w, h, 1);
  m = dilate(m, w, h, 1);
  m = largestComponent(m, w, h);
  m = fillHoles(m, w, h);
  m = dilate(erode(m, w, h, 2), w, h, 2); // remove thin protrusions (stray lines)
  return largestComponent(m, w, h);
}

// ---------------------------------------------------------------- measurement

/** Measure a footprint mask on a metric grid. */
export function measureFootprint(mask, grid) {
  const { w, h, res, x0, y0 } = grid;
  let n = 0, mx = 0, my = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (mask[j * w + i]) { n++; mx += i; my += j; }
  if (n < 50) return null;
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (mask[j * w + i]) {
    const dx = i - mx, dy = j - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let e1 = [Math.cos(ang), Math.sin(ang)];
  if (e1[1] > 0) e1 = [-e1[0], -e1[1]];      // point toward the toes (up the page)
  const e2 = [-e1[1], e1[0]];
  // project mask boundary onto axes
  const bins = new Map();
  let amin = Infinity, amax = -Infinity;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!mask[j * w + i]) continue;
    const dx = (i - mx) * res, dy = (j - my) * res;
    const a = dx * e1[0] + dy * e1[1], b = dx * e2[0] + dy * e2[1];
    if (a < amin) amin = a;
    if (a > amax) amax = a;
    const k = Math.round(a);
    const bb = bins.get(k);
    if (!bb) bins.set(k, [b, b]); else { if (b < bb[0]) bb[0] = b; if (b > bb[1]) bb[1] = b; }
  }
  amin -= res / 2; amax += res / 2;
  const L = amax - amin;
  const widthAt = (a) => { const bb = bins.get(Math.round(a)); return bb ? bb[1] - bb[0] + res : 0; };
  const maxIn = (f0, f1) => {
    let best = { w: 0, a: amin };
    for (let a = amin + f0 * L; a <= amin + f1 * L; a += 1) { const wv = widthAt(a); if (wv > best.w) best = { w: wv, a }; }
    return best;
  };
  const minIn = (f0, f1) => {
    let best = { w: Infinity, a: amin };
    for (let a = amin + f0 * L; a <= amin + f1 * L; a += 1) { const wv = widthAt(a); if (wv > 0 && wv < best.w) best = { w: wv, a }; }
    return best;
  };
  const ball = maxIn(0.55, 0.85);
  const heel = maxIn(0.04, 0.25);
  const waist = minIn(0.3, 0.55);
  const profile = [];
  for (let a = Math.ceil(amin); a <= amax; a += 2) { const bb = bins.get(Math.round(a)); if (bb) profile.push([a - amin, bb[0] + res / 2, bb[1] + res / 2]); }
  // centroid in frame mm
  const cxmm = x0 + (mx + 0.5) * res, cymm = y0 + (my + 0.5) * res;
  const toFrame = (a, b) => [cxmm + a * e1[0] + b * e2[0], cymm + a * e1[1] + b * e2[1]];
  const bAt = (a) => bins.get(Math.round(a)) || [0, 0];
  return {
    lengthMm: L,
    ballWidthMm: ball.w,
    heelWidthMm: heel.w,
    waistWidthMm: waist.w,
    heelToBallMm: ball.a - amin,
    axisAngleDeg: Math.atan2(-e1[0], -e1[1]) * 180 / Math.PI, // 0 = aligned with template
    areaMm2: n * res * res,
    geometry: {
      heel: toFrame(amin, 0), toe: toFrame(amax, 0),
      ballA: toFrame(ball.a, bAt(ball.a)[0]), ballB: toFrame(ball.a, bAt(ball.a)[1]),
      heelA: toFrame(heel.a, bAt(heel.a)[0]), heelB: toFrame(heel.a, bAt(heel.a)[1]),
      e1, e2, centroid: [cxmm, cymm], amin, amax,
    },
    profile,
  };
}

// ---------------------------------------------------------------- oblique views

function feat(r, g, b, out, o) {
  const Y = (r + g + b) / 3;
  out[o] = Y * 0.6; out[o + 1] = r - g; out[o + 2] = (r + g) / 2 - b;
}

function kmeans(samples, dim, k, iters = 12) {
  const n = samples.length / dim;
  if (n === 0) return [];
  k = Math.min(k, n);
  const centers = [];
  // k-means++ style deterministic init: farthest-point
  centers.push(Array.from(samples.subarray(0, dim)));
  while (centers.length < k) {
    let best = -1, bi = 0;
    for (let i = 0; i < n; i++) {
      let dmin = Infinity;
      for (const c of centers) { let d = 0; for (let q = 0; q < dim; q++) d += (samples[i * dim + q] - c[q]) ** 2; if (d < dmin) dmin = d; }
      if (dmin > best) { best = dmin; bi = i; }
    }
    centers.push(Array.from(samples.subarray(bi * dim, bi * dim + dim)));
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let dmin = Infinity, ci = 0;
      centers.forEach((c, j) => { let d = 0; for (let q = 0; q < dim; q++) d += (samples[i * dim + q] - c[q]) ** 2; if (d < dmin) { dmin = d; ci = j; } });
      assign[i] = ci;
    }
    const sums = centers.map(() => new Array(dim + 1).fill(0));
    for (let i = 0; i < n; i++) { const s = sums[assign[i]]; for (let q = 0; q < dim; q++) s[q] += samples[i * dim + q]; s[dim]++; }
    sums.forEach((s, j) => { if (s[dim]) for (let q = 0; q < dim; q++) centers[j][q] = s[q] / s[dim]; });
  }
  return centers;
}

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** Is the paper/floor point P (z=0) hidden behind the foot as seen from camera centre C? */
function occluded(P, C, inFoot) {
  const Ch = -C[2];
  if (Ch <= 0) return true;
  for (let hgt = 8; hgt <= 130; hgt += 12) {
    const t = hgt / Ch;
    if (inFoot(P[0] + (C[0] - P[0]) * t, P[1] + (C[1] - P[1]) * t)) return true;
  }
  return false;
}

/**
 * Segment the foot in an oblique view using colour models sampled from that same view:
 *   foot  = points inside the (eroded) footprint a little above the paper,
 *   other = unoccluded paper, marker and floor points.
 * footprint: {mask,w,h,res,x0,y0} in frame mm (dilated outline), core: eroded mask same grid.
 * Returns {mask: Uint8Array(width*height), w, h, stats}.
 */
export function segmentView(img, cam, layout, footprint, core, opts = {}) {
  const { width: W, height: H, data } = img;
  const C = cameraCenter(cam);
  const fp = footprint;
  const inGrid = (g, x, y) => { const i = Math.floor((x - g.x0) / g.res), j = Math.floor((y - g.y0) / g.res); return i >= 0 && j >= 0 && i < g.w && j < g.h && g.mask[j * g.w + i]; };
  const inFoot = (x, y) => inGrid(fp, x, y);
  const rand = rng(opts.seed || 7);
  const fs = [], bs = [], fsPix = [];
  const tmp = [0, 0, 0];
  const pushSample = (arr, X, pix) => {
    const q = projectPoint(cam, X);
    if (q[2] <= 0 || q[0] < 1 || q[1] < 1 || q[0] >= W - 1 || q[1] >= H - 1) return false;
    const o = ((q[1] | 0) * W + (q[0] | 0)) * 4;
    feat(data[o], data[o + 1], data[o + 2], tmp, 0);
    arr.push(tmp[0], tmp[1], tmp[2]);
    if (pix) pix.push(q[0] | 0, q[1] | 0);
    return true;
  };
  // foot samples
  const coreCells = [];
  for (let j = 0; j < core.h; j++) for (let i = 0; i < core.w; i++) if (core.mask[j * core.w + i]) coreCells.push([core.x0 + (i + 0.5) * core.res, core.y0 + (j + 0.5) * core.res]);
  for (let k = 0; k < 400 && coreCells.length; k++) {
    const p = coreCells[(rand() * coreCells.length) | 0];
    pushSample(fs, [p[0], p[1], -(8 + rand() * 14)], fsPix);
  }
  // paper samples (white areas only, avoid markers & ruler)
  const markers = layout.markers;
  const onMarker = (x, y) => markers.some((m) => x > m.x - 1.5 && x < m.x + m.s + 1.5 && y > m.y - 1.5 && y < m.y + m.s + 1.5);
  let tries = 0, nPaper = 0;
  while (nPaper < 250 && tries++ < 4000) {
    const x = rand() * layout.W, y = rand() * (layout.heelLineY - 1);
    if (onMarker(x, y) || inFoot(x, y)) continue;
    const P = [x, y, 0];
    if (occluded(P, C, inFoot)) continue;
    if (pushSample(bs, P)) nPaper++;
  }
  // marker samples (black and white cells mixed — both are "not foot")
  let nMark = 0; tries = 0;
  while (nMark < 120 && tries++ < 2000) {
    const m = markers[(rand() * markers.length) | 0];
    const P = [m.x + rand() * m.s, m.y + rand() * m.s, 0];
    if (occluded(P, C, inFoot)) continue;
    if (pushSample(bs, P)) nMark++;
  }
  // floor samples outside the paper
  const pb = layout.paperBounds;
  let nFloor = 0; tries = 0;
  while (nFloor < 300 && tries++ < 6000) {
    const x = pb.x0 - 150 + rand() * (pb.x1 - pb.x0 + 300), y = pb.y0 - 150 + rand() * (pb.y1 - pb.y0 + 300);
    if (x > pb.x0 - 12 && x < pb.x1 + 12 && y > pb.y0 - 12 && y < pb.y1 + 12) continue;
    const P = [x, y, 0];
    if (occluded(P, C, inFoot)) continue;
    if (pushSample(bs, P)) nFloor++;
  }
  // far background: image pixels well away from the volume's projection (e.g. walls) — sampled later if needed
  const fc = kmeans(Float32Array.from(fs), 3, 5);
  const bc = kmeans(Float32Array.from(bs), 3, 10);
  const mask = new Uint8Array(W * H);
  if (!fc.length) return { mask, w: W, h: H, stats: { foot: 0, bg: bs.length / 3 } };
  // region of interest: projection of the reconstruction volume
  const vol = opts.volume;
  let rx0 = 0, ry0 = 0, rx1 = W, ry1 = H;
  if (vol) {
    rx0 = W; ry0 = H; rx1 = 0; ry1 = 0;
    for (const x of [vol.x0, vol.x1]) for (const y of [vol.y0, vol.y1]) for (const z of [0, -vol.zmax]) {
      const q = projectPoint(cam, [x, y, z]);
      if (q[2] <= 0) { rx0 = 0; ry0 = 0; rx1 = W; ry1 = H; break; }
      rx0 = Math.min(rx0, q[0]); ry0 = Math.min(ry0, q[1]); rx1 = Math.max(rx1, q[0]); ry1 = Math.max(ry1, q[1]);
    }
    rx0 = Math.max(0, Math.floor(rx0) - 2); ry0 = Math.max(0, Math.floor(ry0) - 2);
    rx1 = Math.min(W, Math.ceil(rx1) + 2); ry1 = Math.min(H, Math.ceil(ry1) + 2);
  }
  const bias = opts.bias || 1.0;
  for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) {
    const o = (y * W + x) * 4;
    feat(data[o], data[o + 1], data[o + 2], tmp, 0);
    let df = Infinity, db = Infinity;
    for (const c of fc) { const d = (tmp[0] - c[0]) ** 2 + (tmp[1] - c[1]) ** 2 + (tmp[2] - c[2]) ** 2; if (d < df) df = d; }
    for (const c of bc) { const d = (tmp[0] - c[0]) ** 2 + (tmp[1] - c[1]) ** 2 + (tmp[2] - c[2]) ** 2; if (d < db) db = d; }
    if (df < db * bias) mask[y * W + x] = 1;
  }
  // cleanup: majority filter, keep components that contain foot samples, fill holes
  let m = dilate(erode(mask, W, H, 1), W, H, 1);
  const { labels } = components(m, W, H);
  const keep = new Set();
  for (let k = 0; k < fsPix.length; k += 2) { const l = labels[fsPix[k + 1] * W + fsPix[k]]; if (l) keep.add(l); }
  for (let p = 0; p < W * H; p++) m[p] = keep.has(labels[p]) ? 1 : 0;
  m = fillHoles(m, W, H);
  return { mask: m, w: W, h: H, stats: { foot: fs.length / 3, bg: bs.length / 3, paper: nPaper, floor: nFloor, markers: nMark } };
}
