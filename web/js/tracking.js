// Marker detection client + per-frame geometry (homography, camera pose, view angles).
import { markerCorners } from './templateSpec.js';
import { robustHomography, poseFromH, refinePose, cameraCenter, focalFromH } from './math.js';

export class Detector {
  constructor() {
    this.worker = new Worker(new URL('./detect-worker.js', import.meta.url));
    this.seq = 0;
    this.pending = new Map();
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (p) { this.pending.delete(e.data.id); p(e.data.markers || []); }
    };
  }
  /** Detect markers in an ImageData. The ImageData's buffer is copied (not transferred). */
  detect(imageData) {
    const id = ++this.seq;
    const buffer = imageData.data.slice().buffer;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ id, width: imageData.width, height: imageData.height, buffer }, [buffer]);
    });
  }
  get busy() { return this.pending.size > 0; }
}

/** Pair detected marker corners with template coordinates. */
export function correspondences(dets, layout, corrections, scale = 1) {
  const byId = new Map(layout.markers.map((m) => [m.id, m]));
  const src = [], dst = [], ids = [], sheetOf = [];
  for (const d of dets) {
    const m = byId.get(d.id);
    if (!m) continue;
    const wc = markerCorners(m, corrections);
    for (let k = 0; k < 4; k++) {
      src.push(wc[k]);
      dst.push([d.corners[k][0] * scale, d.corners[k][1] * scale]);
      sheetOf.push(m.sheet);
    }
    ids.push(d.id);
  }
  return { src, dst, ids, sheetOf };
}

export function defaultFocal(w, h) { return 0.78 * Math.max(w, h); }

export const FOOT_CENTER = (layout) => [layout.W / 2, layout.heelLineY - 125, 0];

/**
 * Compute geometry for one frame. dets: marker detections in image pixels (already scaled).
 * Returns null if not enough markers.
 */
export function frameGeometry(dets, layout, { corrections, f, width, height, refine = false, minMarkers = 3 } = {}) {
  const c = correspondences(dets, layout, corrections);
  if (c.ids.length < minMarkers) return null;
  const hr = robustHomography(c.src, c.dst);
  if (!hr) return null;
  const cx = width / 2, cy = height / 2;
  const fUse = f || defaultFocal(width, height);
  let { R, t } = poseFromH(hr.H, fUse, cx, cy);
  let rms = hr.rms;
  if (refine) {
    const obj = hr.inliers.map((i) => [c.src[i][0], c.src[i][1], 0]);
    const img = hr.inliers.map((i) => c.dst[i]);
    const r = refinePose(obj, img, fUse, cx, cy, R, t);
    R = r.R; t = r.t; rms = r.rms;
  }
  const cam = { R, t, f: fUse, cx, cy, width, height };
  return { H: hr.H, rms, nMarkers: c.ids.length, ids: c.ids, corr: c, inliers: hr.inliers, cam, ...viewAngles(cam, layout), fSingle: focalFromH(hr.H, cx, cy) };
}

export function viewAngles(cam, layout) {
  const C = cameraCenter(cam);
  const P0 = FOOT_CENTER(layout);
  const v = [C[0] - P0[0], C[1] - P0[1], C[2] - P0[2]];
  const height = -v[2];
  const horiz = Math.hypot(v[0], v[1]);
  const tiltDeg = Math.acos(Math.max(-1, Math.min(1, cam.R[8]))) * 180 / Math.PI;
  const elevationDeg = Math.atan2(height, horiz) * 180 / Math.PI;
  let azimuthDeg = Math.atan2(v[0], -v[1]) * 180 / Math.PI;
  if (azimuthDeg < 0) azimuthDeg += 360;
  return { center: C, heightMm: height, distanceMm: Math.hypot(v[0], v[1], v[2]), tiltDeg, elevationDeg, azimuthDeg };
}
