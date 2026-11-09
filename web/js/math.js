// Small linear-algebra / projective-geometry toolkit (no dependencies).
// Matrices are flat row-major arrays.

export function mat3mul(A, B) {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += A[i * 3 + k] * B[k * 3 + j];
    C[i * 3 + j] = s;
  }
  return C;
}

export function mat3inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-300) return null;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  return inv.map((v) => v / det);
}

export function mat3T(m) { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Jacobi eigen-decomposition of a symmetric n×n matrix (flat). Returns {values, vectors(columns)}. */
export function jacobiEigen(Ain, n) {
  const A = Ain.slice();
  const V = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p * n + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = A[p * n + q];
      if (Math.abs(apq) < 1e-300) continue;
      const app = A[p * n + p], aqq = A[q * n + q];
      const theta = (aqq - app) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = A[k * n + p], akq = A[k * n + q];
        A[k * n + p] = c * akp - s * akq;
        A[k * n + q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = A[p * n + k], aqk = A[q * n + k];
        A[p * n + k] = c * apk - s * aqk;
        A[q * n + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k * n + p], vkq = V[k * n + q];
        V[k * n + p] = c * vkp - s * vkq;
        V[k * n + q] = s * vkp + c * vkq;
      }
    }
  }
  const values = [];
  for (let i = 0; i < n; i++) values.push(A[i * n + i]);
  return { values, vectors: V };
}

function normalizer(pts) {
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let d = 0;
  for (const [x, y] of pts) d += Math.hypot(x - mx, y - my);
  d /= pts.length;
  const s = d > 0 ? Math.SQRT2 / d : 1;
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}

/** Normalised DLT homography mapping src[i] -> dst[i]. */
export function homographyDLT(src, dst) {
  const n = src.length;
  if (n < 4) return null;
  const Ts = normalizer(src), Td = normalizer(dst);
  const ATA = new Array(81).fill(0);
  const row = new Array(9);
  const addRow = () => {
    for (let i = 0; i < 9; i++) for (let j = i; j < 9; j++) ATA[i * 9 + j] += row[i] * row[j];
  };
  for (let k = 0; k < n; k++) {
    const [x, y] = applyH(Ts, src[k][0], src[k][1]);
    const [u, v] = applyH(Td, dst[k][0], dst[k][1]);
    row[0] = -x; row[1] = -y; row[2] = -1; row[3] = 0; row[4] = 0; row[5] = 0; row[6] = u * x; row[7] = u * y; row[8] = u; addRow();
    row[0] = 0; row[1] = 0; row[2] = 0; row[3] = -x; row[4] = -y; row[5] = -1; row[6] = v * x; row[7] = v * y; row[8] = v; addRow();
  }
  for (let i = 0; i < 9; i++) for (let j = 0; j < i; j++) ATA[i * 9 + j] = ATA[j * 9 + i];
  const { values, vectors } = jacobiEigen(ATA, 9);
  let mi = 0;
  for (let i = 1; i < 9; i++) if (values[i] < values[mi]) mi = i;
  const h = [];
  for (let i = 0; i < 9; i++) h.push(vectors[i * 9 + mi]);
  const Tdi = mat3inv(Td);
  let H = mat3mul(mat3mul(Tdi, h), Ts);
  const s = H[8] !== 0 ? H[8] : 1;
  H = H.map((v) => v / s);
  return H;
}

/** Homography with iterative outlier rejection. Returns {H, rms, inliers}. */
export function robustHomography(src, dst) {
  let idx = src.map((_, i) => i);
  let H = null, errs = [];
  for (let iter = 0; iter < 3; iter++) {
    H = homographyDLT(idx.map((i) => src[i]), idx.map((i) => dst[i]));
    if (!H) return null;
    errs = src.map((p, i) => { const q = applyH(H, p[0], p[1]); return Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1]); });
    const sorted = idx.map((i) => errs[i]).sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const thr = Math.max(2.5, med * 4);
    const next = src.map((_, i) => i).filter((i) => errs[i] < thr);
    if (next.length === idx.length || next.length < 8) break;
    idx = next;
  }
  const rms = Math.sqrt(idx.reduce((s, i) => s + errs[i] ** 2, 0) / idx.length);
  return { H, rms, inliers: idx };
}

// ---------- camera / pose ----------

export function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function norm(a) { return Math.hypot(a[0], a[1], a[2]); }

/** Single-view focal-length estimate (px) from a homography, assuming principal point (cx, cy). */
export function focalFromH(H, cx, cy) {
  // H' = T H with T translating the principal point to the origin.
  const h = [H[0] - cx * H[6], H[1] - cx * H[7], H[2] - cx * H[8],
    H[3] - cy * H[6], H[4] - cy * H[7], H[5] - cy * H[8], H[6], H[7], H[8]];
  const h1 = [h[0], h[3], h[6]], h2 = [h[1], h[4], h[7]];
  const a1 = h1[0] * h2[0] + h1[1] * h2[1], b1 = h1[2] * h2[2];
  const a2 = h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2, b2 = h1[2] ** 2 - h2[2] ** 2;
  // least squares for w = 1/f^2 in a*w + b = 0
  const den = a1 * a1 + a2 * a2;
  if (den <= 0) return null;
  const w = -(a1 * b1 + a2 * b2) / den;
  if (!(w > 0)) return null;
  return 1 / Math.sqrt(w);
}

export function rodrigues(rv) {
  const th = norm(rv);
  if (th < 1e-12) return [1, -rv[2], rv[1], rv[2], 1, -rv[0], -rv[1], rv[0], 1];
  const k = rv.map((v) => v / th);
  const c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return [
    c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s,
    k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s,
    k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v,
  ];
}

export function rotToVec(R) {
  const tr = R[0] + R[4] + R[8];
  const c = Math.max(-1, Math.min(1, (tr - 1) / 2));
  const th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  if (Math.PI - th < 1e-6) {
    // near 180°: take axis from the largest diagonal element
    const xx = (R[0] + 1) / 2, yy = (R[4] + 1) / 2, zz = (R[8] + 1) / 2;
    let ax;
    if (xx >= yy && xx >= zz) { const x = Math.sqrt(xx); ax = [x, R[1] / (2 * x), R[2] / (2 * x)]; }
    else if (yy >= zz) { const y = Math.sqrt(yy); ax = [R[1] / (2 * y), y, R[5] / (2 * y)]; }
    else { const z = Math.sqrt(zz); ax = [R[2] / (2 * z), R[5] / (2 * z), z]; }
    return ax.map((v) => v * th);
  }
  const s = 2 * Math.sin(th);
  return [(R[7] - R[5]) / s * th, (R[2] - R[6]) / s * th, (R[3] - R[1]) / s * th];
}

function orthonormalize(R) {
  let M = R.slice();
  for (let i = 0; i < 20; i++) {
    const inv = mat3inv(M);
    if (!inv) break;
    const invT = mat3T(inv);
    M = M.map((v, k) => 0.5 * (v + invT[k]));
  }
  return M;
}

/** Initial pose from homography. K = [[f,0,cx],[0,f,cy],[0,0,1]]. */
export function poseFromH(H, f, cx, cy) {
  const Ki = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1];
  const M = mat3mul(Ki, H);
  let m1 = [M[0], M[3], M[6]], m2 = [M[1], M[4], M[7]], m3 = [M[2], M[5], M[8]];
  let lam = 2 / (norm(m1) + norm(m2));
  if (m3[2] * lam < 0) lam = -lam;
  const r1 = m1.map((v) => v * lam), r2 = m2.map((v) => v * lam), t = m3.map((v) => v * lam);
  const r3 = cross(r1, r2);
  const R = orthonormalize([r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]]);
  return { R, t };
}

export function projectPoint(cam, X) {
  const { R, t, f, cx, cy } = cam;
  const xc = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
  const yc = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
  const zc = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
  return [f * xc / zc + cx, f * yc / zc + cy, zc];
}

export function cameraCenter(cam) {
  const { R, t } = cam;
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

/** Solve small dense linear system (Gaussian elimination with partial pivoting). */
export function solve(A, b, n) {
  const M = A.slice(), x = b.slice();
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (Math.abs(M[p * n + c]) < 1e-18) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const tmp = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = tmp; }
      const tmp = x[c]; x[c] = x[p]; x[p] = tmp;
    }
    for (let r = c + 1; r < n; r++) {
      const fct = M[r * n + c] / M[c * n + c];
      if (!fct) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= fct * M[c * n + k];
      x[r] -= fct * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x;
}

/**
 * Levenberg–Marquardt refinement of a planar-target pose.
 * obj: [[x,y,0],...] world pts; img: [[u,v],...]. Returns {R,t,rms}.
 */
export function refinePose(obj, img, f, cx, cy, R0, t0, iters = 15) {
  let p = [...rotToVec(R0), ...t0];
  const residuals = (pp) => {
    const cam = { R: rodrigues(pp.slice(0, 3)), t: pp.slice(3), f, cx, cy };
    const r = new Array(obj.length * 2);
    for (let i = 0; i < obj.length; i++) {
      const q = projectPoint(cam, obj[i]);
      r[2 * i] = q[0] - img[i][0];
      r[2 * i + 1] = q[1] - img[i][1];
    }
    return r;
  };
  let r = residuals(p);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let lambda = 1e-3;
  for (let it = 0; it < iters; it++) {
    const J = [];
    for (let k = 0; k < 6; k++) {
      const d = k < 3 ? 1e-6 : 1e-4 * Math.max(1, Math.abs(p[k]));
      const pp = p.slice(); pp[k] += d;
      const rr = residuals(pp);
      J.push(rr.map((v, i) => (v - r[i]) / d));
    }
    const JTJ = new Array(36).fill(0), JTr = new Array(6).fill(0);
    for (let a = 0; a < 6; a++) {
      for (let b = a; b < 6; b++) {
        let s = 0;
        for (let i = 0; i < r.length; i++) s += J[a][i] * J[b][i];
        JTJ[a * 6 + b] = s; JTJ[b * 6 + a] = s;
      }
      let s = 0;
      for (let i = 0; i < r.length; i++) s += J[a][i] * r[i];
      JTr[a] = -s;
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const A = JTJ.slice();
      for (let a = 0; a < 6; a++) A[a * 6 + a] *= 1 + lambda;
      const dp = solve(A, JTr, 6);
      if (!dp) { lambda *= 10; continue; }
      const pn = p.map((v, k) => v + dp[k]);
      const rn = residuals(pn);
      const cn = rn.reduce((s, v) => s + v * v, 0);
      if (cn < cost) {
        p = pn; r = rn;
        const rel = (cost - cn) / cost;
        cost = cn; lambda = Math.max(1e-7, lambda / 5); improved = true;
        if (rel < 1e-9) it = iters;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { R: rodrigues(p.slice(0, 3)), t: p.slice(3), rms: Math.sqrt(cost / obj.length) };
}

export function median(arr) {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

export function goldenSection(fn, a, b, iters = 18) {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a);
  let fc = fn(c), fd = fn(d);
  for (let i = 0; i < iters; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = fn(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = fn(d); }
  }
  return fc < fd ? c : d;
}
