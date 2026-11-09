// Visual-hull reconstruction (voxel carving) and mesh extraction.
import { projectPoint } from './math.js';

/**
 * Build the voxel volume from a footprint and carve it with silhouettes.
 * footprint: {mask,w,h,res,x0,y0} frame mm. views: [{cam, mask, w, h}]
 * Heights are positive mm (world z = -height).
 */
export function carve(footprint, views, { voxel = 2, zmax = 110, minVotes = 2, onProgress } = {}) {
  // bounding box of the footprint
  let i0 = footprint.w, i1 = 0, j0 = footprint.h, j1 = 0;
  for (let j = 0; j < footprint.h; j++) for (let i = 0; i < footprint.w; i++) if (footprint.mask[j * footprint.w + i]) {
    if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
  }
  const pad = 2 * voxel;
  const x0 = footprint.x0 + i0 * footprint.res - pad, x1 = footprint.x0 + (i1 + 1) * footprint.res + pad;
  const y0 = footprint.y0 + j0 * footprint.res - pad, y1 = footprint.y0 + (j1 + 1) * footprint.res + pad;
  const nx = Math.ceil((x1 - x0) / voxel), ny = Math.ceil((y1 - y0) / voxel), nz = Math.ceil(zmax / voxel);
  const N = nx * ny * nz;
  const occ = new Uint8Array(N);
  const inFp = (x, y) => {
    const i = Math.floor((x - footprint.x0) / footprint.res), j = Math.floor((y - footprint.y0) / footprint.res);
    return i >= 0 && j >= 0 && i < footprint.w && j < footprint.h && footprint.mask[j * footprint.w + i];
  };
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    if (!inFp(x0 + (ix + 0.5) * voxel, y0 + (iy + 0.5) * voxel)) continue;
    for (let iz = 0; iz < nz; iz++) occ[(iz * ny + iy) * nx + ix] = 1;
  }
  const out = new Uint8Array(N), seen = new Uint8Array(N);
  views.forEach((v, vi) => {
    const { cam, mask, w, h } = v;
    for (let iz = 0; iz < nz; iz++) {
      const Z = -(iz + 0.5) * voxel;
      for (let iy = 0; iy < ny; iy++) {
        const Y = y0 + (iy + 0.5) * voxel;
        let p = (iz * ny + iy) * nx;
        for (let ix = 0; ix < nx; ix++, p++) {
          if (!occ[p]) continue;
          const q = projectPoint(cam, [x0 + (ix + 0.5) * voxel, Y, Z]);
          if (q[2] <= 0) continue;
          const u = q[0] | 0, vv = q[1] | 0;
          if (u < 2 || vv < 2 || u >= w - 2 || vv >= h - 2) continue;
          seen[p]++;
          if (!mask[vv * w + u]) out[p]++;
        }
      }
    }
    onProgress && onProgress((vi + 1) / views.length);
  });
  for (let p = 0; p < N; p++) {
    if (!occ[p]) continue;
    const need = seen[p] <= 3 ? 1 : minVotes;
    if (out[p] >= need) occ[p] = 0;
  }
  keepLargest3D(occ, nx, ny, nz);
  return { occ, nx, ny, nz, voxel, x0, y0, zmax };
}

function keepLargest3D(occ, nx, ny, nz) {
  const N = nx * ny * nz, lab = new Int32Array(N), stack = new Int32Array(N);
  let best = 0, bestSize = 0, next = 1;
  for (let p = 0; p < N; p++) {
    if (!occ[p] || lab[p]) continue;
    let sp = 0, size = 0; stack[sp++] = p; lab[p] = next;
    while (sp) {
      const q = stack[--sp]; size++;
      const ix = q % nx, iy = ((q / nx) | 0) % ny, iz = (q / (nx * ny)) | 0;
      const nb = [ix > 0 ? q - 1 : -1, ix < nx - 1 ? q + 1 : -1, iy > 0 ? q - nx : -1, iy < ny - 1 ? q + nx : -1, iz > 0 ? q - nx * ny : -1, iz < nz - 1 ? q + nx * ny : -1];
      for (const r of nb) if (r >= 0 && occ[r] && !lab[r]) { lab[r] = next; stack[sp++] = r; }
    }
    if (size > bestSize) { bestSize = size; best = next; }
    next++;
  }
  for (let p = 0; p < N; p++) if (occ[p] && lab[p] !== best) occ[p] = 0;
}

/** Vertical projection of the volume (z <= hmax) as a footprint grid. */
export function volumeFootprint(vol, hmax = 40) {
  const { occ, nx, ny, voxel, x0, y0 } = vol;
  const nzMax = Math.min(vol.nz, Math.ceil(hmax / voxel));
  const mask = new Uint8Array(nx * ny);
  for (let iz = 0; iz < nzMax; iz++) for (let p = 0; p < nx * ny; p++) if (occ[iz * nx * ny + p]) mask[p] = 1;
  return { mask, w: nx, h: ny, res: voxel, x0, y0 };
}

/** Max height (mm) of the volume inside a band of the foot axis. */
export function heightProfile(vol, geom) {
  const { occ, nx, ny, nz, voxel, x0, y0 } = vol;
  const prof = new Map();
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    let top = -1;
    for (let iz = nz - 1; iz >= 0; iz--) if (occ[(iz * ny + iy) * nx + ix]) { top = iz; break; }
    if (top < 0) continue;
    const X = x0 + (ix + 0.5) * voxel - geom.centroid[0], Y = y0 + (iy + 0.5) * voxel - geom.centroid[1];
    const a = Math.round(X * geom.e1[0] + Y * geom.e1[1] - geom.amin);
    prof.set(a, Math.max(prof.get(a) || 0, (top + 1) * voxel));
  }
  return prof;
}

// ------------------------------------------------------------ mesh extraction

function blurField(occ, nx, ny, nz) {
  // 3x3x3 box blur of the binary occupancy -> scalar field in [0,1], padded by 1 voxel
  const px = nx + 2, py = ny + 2, pz = nz + 2;
  const f = new Float32Array(px * py * pz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++)
    f[((z + 1) * py + (y + 1)) * px + (x + 1)] = occ[(z * ny + y) * nx + x];
  // the paper plane closes the bottom: mirror the bottom layer into the pad so the sole is flat
  for (let y = 0; y < py; y++) for (let x = 0; x < px; x++) f[(0 * py + y) * px + x] = 0;
  const g = new Float32Array(f.length);
  const idx = (x, y, z) => (z * py + y) * px + x;
  for (let pass = 0; pass < 3; pass++) {
    const src = pass === 0 ? f : g.slice();
    const dst = g;
    for (let z = 0; z < pz; z++) for (let y = 0; y < py; y++) for (let x = 0; x < px; x++) {
      let s = 0, c = 0;
      for (let k = -1; k <= 1; k++) {
        const xx = pass === 0 ? x + k : x, yy = pass === 1 ? y + k : y, zz = pass === 2 ? z + k : z;
        if (xx < 0 || yy < 0 || zz < 0 || xx >= px || yy >= py || zz >= pz) continue;
        s += (pass === 0 ? f : src)[idx(xx, yy, zz)]; c++;
      }
      dst[idx(x, y, z)] = s / c;
    }
  }
  return { field: g, px, py, pz };
}

/**
 * Surface Nets isosurface. Returns {positions: Float32Array (x,y,z mm, Z up, Y toward toes), indices: Uint32Array}.
 */
export function extractMesh(vol, { smoothIters = 6 } = {}) {
  const { nx, ny, nz, voxel, x0, y0 } = vol;
  const { field, px, py, pz } = blurField(vol.occ, nx, ny, nz);
  const iso = 0.5;
  const vid = new Int32Array(px * py * pz).fill(-1);
  const pos = [];
  const idx = (x, y, z) => (z * py + y) * px + x;
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const val = new Float32Array(8);
  for (let z = 0; z < pz - 1; z++) for (let y = 0; y < py - 1; y++) for (let x = 0; x < px - 1; x++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { const [a, b, d] = corners[c]; val[c] = field[idx(x + a, y + b, z + d)]; if (val[c] > iso) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [e0, e1] of edges) {
      const in0 = val[e0] > iso, in1 = val[e1] > iso;
      if (in0 === in1) continue;
      const t = (iso - val[e0]) / (val[e1] - val[e0]);
      const A = corners[e0], B = corners[e1];
      sx += A[0] + t * (B[0] - A[0]); sy += A[1] + t * (B[1] - A[1]); sz += A[2] + t * (B[2] - A[2]); n++;
    }
    vid[idx(x, y, z)] = pos.length / 3;
    pos.push(x + sx / n, y + sy / n, z + sz / n);
  }
  const tris = [];
  for (let z = 0; z < pz - 1; z++) for (let y = 0; y < py - 1; y++) for (let x = 0; x < px - 1; x++) {
    const v0 = field[idx(x, y, z)] > iso;
    for (let axis = 0; axis < 3; axis++) {
      const xx = x + (axis === 0), yy = y + (axis === 1), zz = z + (axis === 2);
      // the four cells around this edge need the other two coordinates >= 1
      if ((axis !== 0 && x < 1) || (axis !== 1 && y < 1) || (axis !== 2 && z < 1)) continue;
      const v1 = field[idx(xx, yy, zz)] > iso;
      if (v0 === v1) continue;
      // the four cells sharing this edge
      let q;
      if (axis === 0) q = [idx(x, y - 1, z - 1), idx(x, y, z - 1), idx(x, y, z), idx(x, y - 1, z)];
      else if (axis === 1) q = [idx(x - 1, y, z - 1), idx(x - 1, y, z), idx(x, y, z), idx(x, y, z - 1)];
      else q = [idx(x - 1, y - 1, z), idx(x, y - 1, z), idx(x, y, z), idx(x - 1, y, z)];
      const vs = q.map((k) => vid[k]);
      if (vs.some((v) => v < 0)) continue;
      if (v0) { tris.push(vs[0], vs[1], vs[2], vs[0], vs[2], vs[3]); }
      else { tris.push(vs[0], vs[2], vs[1], vs[0], vs[3], vs[2]); }
    }
  }
  // grid -> mm, axes: X = frame x, Y = -frame y (toward toes), Z = height
  const positions = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    positions[i] = x0 + (pos[i] - 1 + 0.5) * voxel;
    positions[i + 1] = -(y0 + (pos[i + 1] - 1 + 0.5) * voxel);
    positions[i + 2] = Math.max(0, (pos[i + 2] - 1 + 0.5) * voxel);
  }
  const indices = Uint32Array.from(tris);
  taubinSmooth(positions, indices, smoothIters);
  // Correct orientation if needed (outward normals): check signed volume
  if (signedVolume(positions, indices) < 0) for (let i = 0; i < indices.length; i += 3) { const t = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = t; }
  return { positions, indices };
}

function taubinSmooth(P, I, iters) {
  const n = P.length / 3;
  const nbr = Array.from({ length: n }, () => new Set());
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i], b = I[i + 1], c = I[i + 2];
    nbr[a].add(b); nbr[a].add(c); nbr[b].add(a); nbr[b].add(c); nbr[c].add(a); nbr[c].add(b);
  }
  const tmp = new Float32Array(P.length);
  for (let it = 0; it < iters * 2; it++) {
    const lam = it % 2 === 0 ? 0.5 : -0.53;
    for (let v = 0; v < n; v++) {
      let sx = 0, sy = 0, sz = 0, k = 0;
      for (const u of nbr[v]) { sx += P[3 * u]; sy += P[3 * u + 1]; sz += P[3 * u + 2]; k++; }
      if (!k) { tmp[3 * v] = P[3 * v]; tmp[3 * v + 1] = P[3 * v + 1]; tmp[3 * v + 2] = P[3 * v + 2]; continue; }
      tmp[3 * v] = P[3 * v] + lam * (sx / k - P[3 * v]);
      tmp[3 * v + 1] = P[3 * v + 1] + lam * (sy / k - P[3 * v + 1]);
      tmp[3 * v + 2] = P[3 * v + 2] + lam * (sz / k - P[3 * v + 2]);
    }
    P.set(tmp);
  }
  for (let v = 0; v < n; v++) if (P[3 * v + 2] < 0) P[3 * v + 2] = 0;
}

function signedVolume(P, I) {
  let s = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = 3 * I[i], b = 3 * I[i + 1], c = 3 * I[i + 2];
    s += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return s / 6;
}

export function meshVolumeMl(mesh) { return Math.abs(signedVolume(mesh.positions, mesh.indices)) / 1000; }

/**
 * Girth: perimeter of the cross-section of the mesh with a vertical plane through point p
 * (frame mm) perpendicular to direction d (unit, frame xy). Returns mm.
 */
export function girth(mesh, p, d) {
  const P = mesh.positions, I = mesh.indices;
  // mesh coords: X = x, Y = -y
  const nx = d[0], ny = -d[1], px = p[0] + 0.0137 * d[0], py = -p[1] - 0.0137 * d[1]; // nudge off vertex rows
  const segs = [];
  const sd = (k) => (P[3 * k] - px) * nx + (P[3 * k + 1] - py) * ny;
  for (let i = 0; i < I.length; i += 3) {
    const v = [I[i], I[i + 1], I[i + 2]], s = v.map(sd);
    const pts = [];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3], sa = s[e], sb = s[(e + 1) % 3];
      if ((sa > 0) === (sb > 0)) continue;
      const t = sa / (sa - sb);
      pts.push([P[3 * a] + t * (P[3 * b] - P[3 * a]), P[3 * a + 1] + t * (P[3 * b + 1] - P[3 * a + 1]), P[3 * a + 2] + t * (P[3 * b + 2] - P[3 * a + 2])]);
    }
    if (pts.length === 2) segs.push(pts);
  }
  let len = 0;
  for (const [a, b] of segs) len += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return { perimeterMm: len, segments: segs.length };
}

// ------------------------------------------------------------ export

export function toSTL(mesh, name = 'foot') {
  const { positions: P, indices: I } = mesh;
  const nt = I.length / 3;
  const buf = new ArrayBuffer(84 + nt * 50);
  const dv = new DataView(buf);
  const header = `Foot Fit scan: ${name} (mm)`;
  for (let i = 0; i < Math.min(80, header.length); i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nt, true);
  let o = 84;
  for (let t = 0; t < nt; t++) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (const v of [nx, ny, nz]) { dv.setFloat32(o, v, true); o += 4; }
    for (const k of [a, b, c]) for (let q = 0; q < 3; q++) { dv.setFloat32(o, P[k + q], true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return new Blob([buf], { type: 'model/stl' });
}

export function toOBJ(mesh, name = 'foot') {
  const { positions: P, indices: I } = mesh;
  const lines = [`# Foot Fit scan: ${name}`, '# units: millimetres, Z up, +Y toward toes', `o ${name}`];
  for (let i = 0; i < P.length; i += 3) lines.push(`v ${P[i].toFixed(2)} ${P[i + 1].toFixed(2)} ${P[i + 2].toFixed(2)}`);
  for (let i = 0; i < I.length; i += 3) lines.push(`f ${I[i] + 1} ${I[i + 1] + 1} ${I[i + 2] + 1}`);
  return new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
}
