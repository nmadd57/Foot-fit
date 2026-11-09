// Offline processing of captured keyframes -> measurements, overlays, 3D mesh.
import { correspondences, frameGeometry, defaultFocal } from './tracking.js';
import { robustHomography, mat3inv, applyH, refinePose, poseFromH, median, goldenSection } from './math.js';
import { rectify, fitPaperModel, topScores, topMask, measureFootprint, segmentView, erode, dilate } from './segment.js';
import { carve, volumeFootprint, heightProfile, extractMesh, girth, meshVolumeMl } from './reconstruct.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Estimate rigid offsets of taped-on sheets relative to sheet 0. */
export function estimateSheetCorrections(frames, layout) {
  if (layout.sheets < 2) return null;
  const acc = [];
  for (const fr of frames) {
    const c = correspondences(fr.dets, layout, null);
    const s0 = c.src.map((_, i) => i).filter((i) => c.sheetOf[i] === 0);
    const s1 = c.src.map((_, i) => i).filter((i) => c.sheetOf[i] === 1);
    if (s0.length < 12 || s1.length < 8) continue;
    const hr = robustHomography(s0.map((i) => c.src[i]), s0.map((i) => c.dst[i]));
    if (!hr || hr.rms > 3) continue;
    const Hi = mat3inv(hr.H);
    const a = s1.map((i) => c.src[i]);
    const b = s1.map((i) => applyH(Hi, c.dst[i][0], c.dst[i][1]));
    const ma = mean2(a), mb = mean2(b);
    let sc = 0, ss = 0;
    for (let k = 0; k < a.length; k++) {
      const ax = a[k][0] - ma[0], ay = a[k][1] - ma[1], bx = b[k][0] - mb[0], by = b[k][1] - mb[1];
      sc += ax * bx + ay * by; ss += ax * by - ay * bx;
    }
    acc.push({ cx: ma[0], cy: ma[1], theta: Math.atan2(ss, sc), tx: mb[0] - ma[0], ty: mb[1] - ma[1], w: 1 / (1 + (fr.geo?.tiltDeg || 0) / 10) });
  }
  if (!acc.length) return null;
  const m = (k) => median(acc.map((x) => x[k]));
  return { 1: { cx: m('cx'), cy: m('cy'), theta: m('theta'), tx: m('tx'), ty: m('ty'), n: acc.length } };
}

function mean2(p) { let x = 0, y = 0; for (const q of p) { x += q[0]; y += q[1]; } return [x / p.length, y / p.length]; }

/** Focal length: median of single-view estimates, then refined by total reprojection error. */
export function calibrateFocal(frames, layout, corrections) {
  const w = frames[0].img.width, h = frames[0].img.height;
  const prior = defaultFocal(w, h);
  const ests = [];
  const data = [];
  for (const fr of frames) {
    const g = frameGeometry(fr.dets, layout, { corrections, width: fr.img.width, height: fr.img.height, minMarkers: 4 });
    if (!g) continue;
    if (g.tiltDeg > 20 && g.fSingle && g.fSingle > 0.4 * Math.max(w, h) && g.fSingle < 2.5 * Math.max(w, h)) ests.push(g.fSingle * Math.max(w, h) / Math.max(fr.img.width, fr.img.height));
    data.push({ g, fr });
  }
  let f0 = ests.length >= 2 ? median(ests) : prior;
  const sub = data.filter((d) => d.g.tiltDeg > 15).slice(0, 12);
  if (sub.length >= 3) {
    const cost = (f) => {
      let s = 0;
      for (const { g, fr } of sub) {
        const fi = f * Math.max(fr.img.width, fr.img.height) / Math.max(w, h);
        const cx = fr.img.width / 2, cy = fr.img.height / 2;
        const obj = g.inliers.map((i) => [g.corr.src[i][0], g.corr.src[i][1], 0]);
        const img = g.inliers.map((i) => g.corr.dst[i]);
        const p0 = poseFromH(g.H, fi, cx, cy);
        s += refinePose(obj, img, fi, cx, cy, p0.R, p0.t, 8).rms ** 2;
      }
      return s;
    };
    f0 = goldenSection(cost, f0 * 0.75, f0 * 1.3, 14);
  }
  return { f: f0, refW: w, refH: h, singleEstimates: ests.length };
}

function focalFor(cal, img) { return cal.f * Math.max(img.width, img.height) / Math.max(cal.refW, cal.refH); }

function maskToCanvas(rect, mask, geom, layout) {
  const c = document.createElement('canvas'); c.width = rect.w; c.height = rect.h;
  const g = c.getContext('2d');
  const id = g.createImageData(rect.w, rect.h);
  for (let p = 0; p < rect.w * rect.h; p++) {
    id.data[4 * p] = rect.rgb[3 * p]; id.data[4 * p + 1] = rect.rgb[3 * p + 1]; id.data[4 * p + 2] = rect.rgb[3 * p + 2]; id.data[4 * p + 3] = 255;
  }
  // outline
  for (let j = 1; j < rect.h - 1; j++) for (let i = 1; i < rect.w - 1; i++) {
    const p = j * rect.w + i;
    if (mask[p] && (!mask[p - 1] || !mask[p + 1] || !mask[p - rect.w] || !mask[p + rect.w])) {
      for (const q of [p, p + 1, p + rect.w]) { id.data[4 * q] = 255; id.data[4 * q + 1] = 0; id.data[4 * q + 2] = 200; }
    }
  }
  g.putImageData(id, 0, 0);
  if (geom) {
    const toPx = ([x, y]) => [(x - rect.x0) / rect.res, (y - rect.y0) / rect.res];
    const line = (a, b, col) => { g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(...toPx(a)); g.lineTo(...toPx(b)); g.stroke(); };
    line(geom.heel, geom.toe, '#00c2ff');
    line(geom.ballA, geom.ballB, '#ffb000');
    line(geom.heelA, geom.heelB, '#5bd95b');
  }
  if (layout) {
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.setLineDash([4, 4]);
    const y = (layout.heelLineY - rect.y0) / rect.res;
    g.beginPath(); g.moveTo(0, y); g.lineTo(rect.w, y); g.stroke(); g.setLineDash([]);
  }
  return c;
}

export function viewOverlay(img, mask) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  const id = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  for (let p = 0; p < img.width * img.height; p++) if (mask[p]) {
    id.data[4 * p] = 0.55 * id.data[4 * p] + 0.45 * 255; id.data[4 * p + 1] *= 0.55; id.data[4 * p + 2] = 0.55 * id.data[4 * p + 2] + 0.45 * 200;
  }
  g.putImageData(id, 0, 0);
  return c;
}

/** Resample a coarse binary grid with bilinear interpolation, threshold 0.5. */
function resampleMaskBilinear(src, dst) {
  const out = new Uint8Array(dst.w * dst.h);
  const at = (i, j) => (i >= 0 && j >= 0 && i < src.w && j < src.h ? src.mask[j * src.w + i] : 0);
  for (let j = 0; j < dst.h; j++) for (let i = 0; i < dst.w; i++) {
    const fx = (dst.x0 + (i + 0.5) * dst.res - src.x0) / src.res - 0.5, fy = (dst.y0 + (j + 0.5) * dst.res - src.y0) / src.res - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fy), ax = fx - i0, ay = fy - j0;
    const v = (at(i0, j0) * (1 - ax) + at(i0 + 1, j0) * ax) * (1 - ay) + (at(i0, j0 + 1) * (1 - ax) + at(i0 + 1, j0 + 1) * ax) * ay;
    out[j * dst.w + i] = v >= 0.5 ? 1 : 0;
  }
  return out;
}

function boundaryWarnings(mask, rect, layout) {
  const w = [];
  const { w: W, h: H, res, x0, y0 } = rect;
  let top = 0, side = 0, heel = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (!mask[j * W + i]) continue;
    const x = x0 + (i + 0.5) * res, y = y0 + (j + 0.5) * res;
    if (y < 3) top++;
    if (x < layout.footArea.x0 + 1.5 || x > layout.footArea.x1 - 1.5) side++;
    if (y > layout.heelLineY + 3) heel++;
  }
  if (top > 10) w.push('The toes reach the top edge of the template — your foot may be longer than this sheet. Use the 2-sheet template.');
  if (side > 20) w.push('The outline touches the marker columns — centre your foot on the template.');
  if (heel > 40) w.push('The heel extends past the heel line — place the back of your heel on the line.');
  return w;
}

/**
 * Process keyframes.
 * frames: [{img: ImageData, dets: [{id, corners}], kind: 'top'|'orbit'}]
 */
export async function processScan(frames, layout, opts = {}) {
  const { sensitivity = 1, scale = 1, voxel = 2, zmax = 110, onStatus = () => {} } = opts;
  const warnings = [];
  const dbg = {};
  if (!frames.length) throw new Error('No frames captured.');

  onStatus('Calibrating template and camera…', 0.05); await tick();
  const corrections = estimateSheetCorrections(frames, layout);
  const cal = calibrateFocal(frames, layout, corrections);

  onStatus('Refining camera poses…', 0.12); await tick();
  const geos = [];
  for (const fr of frames) {
    const g = frameGeometry(fr.dets, layout, { corrections, f: focalFor(cal, fr.img), width: fr.img.width, height: fr.img.height, refine: true, minMarkers: 4 });
    if (g && g.rms < 6) geos.push({ fr, g });
  }
  if (!geos.length) throw new Error('Could not track the template in any captured frame.');
  const tops = geos.filter((x) => x.g.tiltDeg < 28).sort((a, b) => a.g.tiltDeg - b.g.tiltDeg).slice(0, 3);
  if (!tops.length) throw new Error('No top-down frame captured. Hold the phone directly above the foot for the first step.');

  onStatus('Measuring footprint from the top view…', 0.2); await tick();
  const region = { x0: 0, y0: 0, x1: layout.W, y1: layout.H };
  const topResults = [];
  for (const t of tops) {
    const rect = rectify(t.fr.img, t.g.H, region, 0.5);
    const paper = fitPaperModel(rect, layout);
    const scores = topScores(rect, paper);
    const mask = topMask(rect, scores, layout, sensitivity);
    const m = measureFootprint(mask, { ...rect });
    if (m) topResults.push({ t, rect, mask, scores, m });
    await tick();
  }
  if (!topResults.length) throw new Error('Could not find the foot in the top view. Make sure the foot contrasts with the white paper.');
  topResults.sort((a, b) => a.m.lengthMm - b.m.lengthMm);
  const primary = topResults[topResults.length >> 1];
  const rect = primary.rect;
  const topGrid = { mask: primary.mask, w: rect.w, h: rect.h, res: rect.res, x0: rect.x0, y0: rect.y0 };

  // ---------- 3D
  const views = geos.filter((x) => !tops.includes(x) || x.g.tiltDeg > 10);
  let vol = null, mesh = null, finalMask = primary.mask, viewOverlays = [];
  const L0 = primary.m.lengthMm;
  if (views.length >= 4) {
    onStatus(`Segmenting ${views.length} views…`, 0.3); await tick();
    const fpDil = { ...topGrid, mask: dilate(primary.mask, rect.w, rect.h, 6) };
    // core region: eroded footprint in the midfoot band, safely inside the foot
    let core = erode(primary.mask, rect.w, rect.h, 24);
    const geo = primary.m.geometry;
    for (let j = 0; j < rect.h; j++) for (let i = 0; i < rect.w; i++) {
      const p = j * rect.w + i; if (!core[p]) continue;
      const x = rect.x0 + (i + 0.5) * rect.res - geo.centroid[0], y = rect.y0 + (j + 0.5) * rect.res - geo.centroid[1];
      const a = x * geo.e1[0] + y * geo.e1[1] - geo.amin;
      if (a < 0.15 * L0 || a > 0.65 * L0) core[p] = 0;
    }
    if (!core.some((v) => v)) core = erode(primary.mask, rect.w, rect.h, 10);
    const coreGrid = { ...topGrid, mask: core };
    const volBox = { x0: geo.centroid[0] - 90, x1: geo.centroid[0] + 90, y0: geo.centroid[1] - L0 / 2 - 20, y1: geo.centroid[1] + L0 / 2 + 20, zmax };
    const silhouettes = [];
    for (let k = 0; k < views.length; k++) {
      const { fr, g } = views[k];
      const seg = segmentView(fr.img, g.cam, layout, fpDil, coreGrid, { volume: volBox, seed: 11 + k });
      silhouettes.push({ cam: g.cam, mask: seg.mask, w: seg.w, h: seg.h, fr, g });
      onStatus(`Segmenting views… ${k + 1}/${views.length}`, 0.3 + 0.35 * (k + 1) / views.length); await tick();
    }
    onStatus('Carving the 3D volume…', 0.68); await tick();
    vol = carve(fpDil, silhouettes, { voxel, zmax });
    const vfp = volumeFootprint(vol, 40);
    if (opts.debug) { dbg.volFootprint = vfp; dbg.silhouettes = silhouettes; }
    const vmask = resampleMaskBilinear(vfp, topGrid);
    finalMask = primary.mask.map((v, p) => (v && vmask[p] ? 1 : 0));
    // pick a few overlays for the AI review (spread in azimuth)
    const sorted = silhouettes.slice().sort((a, b) => a.g.azimuthDeg - b.g.azimuthDeg);
    for (let k = 0; k < Math.min(3, sorted.length); k++) {
      const s = sorted[Math.floor(k * sorted.length / Math.min(3, sorted.length))];
      viewOverlays.push(viewOverlay(s.fr.img, s.mask));
    }
    onStatus('Building the mesh…', 0.85); await tick();
    mesh = extractMesh(vol, { smoothIters: 6 });
  } else {
    warnings.push('Not enough side views for a 3D model — only the footprint was measured. Capture at least 4 views around the foot.');
  }

  const m = measureFootprint(finalMask, topGrid) || primary.m;
  warnings.push(...boundaryWarnings(finalMask, rect, layout));
  const measures = {
    lengthMm: m.lengthMm * scale,
    ballWidthMm: m.ballWidthMm * scale,
    heelWidthMm: m.heelWidthMm * scale,
    waistWidthMm: m.waistWidthMm * scale,
    heelToBallMm: m.heelToBallMm * scale,
    axisAngleDeg: m.axisAngleDeg,
  };
  const spread = topResults.map((r) => r.m.lengthMm * scale);
  // frame-to-frame spread is only meaningful when the top view alone defines the outline
  measures.lengthSpreadMm = !vol && spread.length > 1 ? Math.max(...spread) - Math.min(...spread) : null;
  if (vol) {
    const prof = heightProfile(vol, m.geometry);
    const maxIn = (f0, f1) => { let b = 0; for (const [a, h] of prof) if (a >= f0 * m.lengthMm && a <= f1 * m.lengthMm) b = Math.max(b, h); return b; };
    measures.instepHeightMm = maxIn(0.45, 0.6) * scale;
    measures.ballHeightMm = maxIn(m.heelToBallMm / m.lengthMm - 0.03, m.heelToBallMm / m.lengthMm + 0.03) * scale;
    measures.toeBoxHeightMm = maxIn(0.85, 0.92) * scale;
    if (mesh) {
      const g = m.geometry;
      const at = (a) => [g.centroid[0] + (a + g.amin) * g.e1[0], g.centroid[1] + (a + g.amin) * g.e1[1]];
      measures.ballGirthMm = girth(mesh, at(m.heelToBallMm), g.e1).perimeterMm * scale;
      measures.instepGirthMm = girth(mesh, at(0.5 * m.lengthMm), g.e1).perimeterMm * scale;
      measures.volumeMl = meshVolumeMl(mesh) * scale ** 3;
      if (scale !== 1) for (let i = 0; i < mesh.positions.length; i++) mesh.positions[i] *= scale;
    }
  }
  onStatus('Done', 1);
  return {
    measures,
    warnings,
    topCanvas: maskToCanvas(rect, finalMask, m.geometry, layout),
    viewOverlays,
    mesh,
    debug: {
      ...dbg,
      focalPx: cal.f, focalRef: [cal.refW, cal.refH], singleEstimates: cal.singleEstimates,
      sheetCorrections: corrections, frames: frames.length, tracked: geos.length, topFrames: tops.length,
      views: views.length, reprojRms: median(geos.map((x) => x.g.rms)),
      tilt: tops.map((t) => t.g.tiltDeg),
    },
  };
}
