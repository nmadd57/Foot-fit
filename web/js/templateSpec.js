// Shared definition of the printable tracking template.
// Coordinates are millimetres in "frame" space: origin at the top-left of the
// printed frame, x to the right, y down the page. The heel sits at the bottom
// (large y), toes point up the page (toward y = 0). Height above the paper is
// represented internally as world z = -height (right-handed with y down).

export const DICTIONARY = 'ARUCO_MIP_36h12';
export const MARGIN = 10;      // unprinted page margin (mm)
export const MARKER = 20;      // marker black-square side (mm)
export const CELLS = 8;        // 6x6 data bits + 1-cell black border each side
export const RULER_MM = 100;

export const PAPERS = {
  a4: { label: 'A4 (210 × 297 mm)', w: 210, h: 297 },
  letter: { label: 'US Letter (8.5 × 11 in)', w: 215.9, h: 279.4 },
  a3: { label: 'A3 (297 × 420 mm)', w: 297, h: 420 },
  tabloid: { label: 'Tabloid (11 × 17 in)', w: 279.4, h: 431.8 },
};

/**
 * Build the layout for a paper size and number of sheets taped end to end.
 * Sheet 0 is the heel sheet (bottom), sheet N-1 the toe sheet (top).
 */
export function makeLayout(paperKey = 'a4', sheets = 1) {
  const paper = PAPERS[paperKey] || PAPERS.a4;
  sheets = Math.max(1, Math.min(2, sheets | 0));
  const W = Math.min(paper.w - 2 * MARGIN, 200);
  const Hs = paper.h - 2 * MARGIN;
  const H = Hs * sheets;
  const markers = [];
  const sheetList = [];
  let id = 0;
  for (let s = 0; s < sheets; s++) {
    const y0 = H - Hs * (s + 1);
    sheetList.push({ index: s, x0: 0, y0, w: W, h: Hs });
    const n = Math.max(2, Math.floor((Hs - MARKER) / (MARKER * 1.75)) + 1);
    const pitch = (Hs - MARKER) / (n - 1);
    for (let i = 0; i < n; i++) {
      const y = y0 + i * pitch;
      markers.push({ id: id++, x: 0, y, s: MARKER, sheet: s });
      markers.push({ id: id++, x: W - MARKER, y, s: MARKER, sheet: s });
    }
  }
  const heelLineY = H - 14;
  const footArea = { x0: MARKER + 3, x1: W - MARKER - 3, y0: 0, y1: heelLineY + 5 };
  const ruler = { x: W / 2 - RULER_MM / 2, y: H - 8, w: RULER_MM, h: 5 };
  return {
    paperKey, paper, sheets, W, H, Hs, markers, sheetList, heelLineY, footArea, ruler,
    // paper bounds in frame coords (for "off-sheet" floor sampling)
    paperBounds: { x0: -(paper.w - W) / 2, x1: W + (paper.w - W) / 2, y0: -MARGIN, y1: H + MARGIN },
  };
}

/** Marker corner positions (TL, TR, BR, BL) in frame mm, after optional sheet corrections. */
export function markerCorners(m, corrections) {
  const pts = [[m.x, m.y], [m.x + m.s, m.y], [m.x + m.s, m.y + m.s], [m.x, m.y + m.s]];
  const c = corrections && corrections[m.sheet];
  if (!c) return pts;
  const cos = Math.cos(c.theta), sin = Math.sin(c.theta);
  return pts.map(([x, y]) => {
    const dx = x - c.cx, dy = y - c.cy;
    return [c.cx + cos * dx - sin * dy + c.tx, c.cy + sin * dx + cos * dy + c.ty];
  });
}

/** Return the 6x6 bit grid ('1' = white) for a marker id, using the vendored dictionary. */
export function markerBits(id) {
  const dict = getDictionary();
  const code = dict.codeList[id];
  const bits = [];
  for (let y = 0; y < 6; y++) {
    const row = [];
    for (let x = 0; x < 6; x++) row.push(code[y * 6 + x] === '1' ? 1 : 0);
    bits.push(row);
  }
  return bits;
}

let _dict = null;
function getDictionary() {
  if (!_dict) {
    if (!globalThis.AR) throw new Error('vendor/aruco.js must be loaded first');
    _dict = new globalThis.AR.Dictionary(DICTIONARY);
  }
  return _dict;
}

/** Render one sheet as an SVG string, sized in real millimetres. */
export function renderSheetSVG(layout, sheetIndex) {
  const { paper, W, sheetList, markers } = layout;
  const sh = sheetList[sheetIndex];
  const ox = (paper.w - W) / 2;            // frame offset on the page
  const oy = MARGIN - sh.y0;               // page y = frame y + oy
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${paper.w}mm" height="${paper.h}mm" viewBox="0 0 ${paper.w} ${paper.h}">`);
  out.push(`<rect width="${paper.w}" height="${paper.h}" fill="#fff"/>`);
  out.push(`<g transform="translate(${ox} ${oy})" font-family="Helvetica, Arial, sans-serif">`);
  const fa = layout.footArea;
  const top = sh.y0, bot = sh.y0 + sh.h;
  // faint foot-area guides (kept very light so they never look like "foot")
  out.push(`<rect x="${fa.x0}" y="${top + 0.5}" width="${fa.x1 - fa.x0}" height="${sh.h - 1}" fill="none" stroke="#e4e4e4" stroke-width="0.3" stroke-dasharray="2 2"/>`);
  out.push(`<line x1="${W / 2}" y1="${top + 2}" x2="${W / 2}" y2="${Math.min(bot, layout.heelLineY) - 2}" stroke="#e8e8e8" stroke-width="0.3" stroke-dasharray="1 3"/>`);
  for (const m of markers.filter((mm) => mm.sheet === sheetIndex)) {
    const cell = m.s / CELLS;
    out.push(`<rect x="${m.x}" y="${m.y}" width="${m.s}" height="${m.s}" fill="#000"/>`);
    const bits = markerBits(m.id);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
      if (bits[y][x]) out.push(`<rect x="${(m.x + (x + 1) * cell).toFixed(3)}" y="${(m.y + (y + 1) * cell).toFixed(3)}" width="${(cell + 0.02).toFixed(3)}" height="${(cell + 0.02).toFixed(3)}" fill="#fff"/>`);
    }
  }
  if (sheetIndex === 0) {
    const hy = layout.heelLineY;
    out.push(`<line x1="${fa.x0}" y1="${hy}" x2="${fa.x1}" y2="${hy}" stroke="#bbb" stroke-width="0.5"/>`);
    out.push(`<text x="${fa.x1 - 1}" y="${hy - 1.5}" font-size="3" fill="#aaa" text-anchor="end">HEEL LINE — back of heel here, toes point up the page</text>`);
    const r = layout.ruler;
    out.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1.2" fill="#000"/>`);
    for (let i = 0; i <= r.w; i += 10) {
      out.push(`<rect x="${r.x + i - 0.2}" y="${r.y}" width="0.4" height="${i % 50 === 0 ? r.h : r.h * 0.6}" fill="#000"/>`);
    }
    out.push(`<text x="${r.x + r.w + 2}" y="${r.y + 3.5}" font-size="2.6" fill="#555">must measure ${RULER_MM} mm</text>`);
  }
  // sheet labels in the marker columns' gaps
  const label = layout.sheets > 1 ? `Foot Fit template · sheet ${sheetIndex + 1}/${layout.sheets} (${sheetIndex === 0 ? 'heel' : 'toe'})` : 'Foot Fit template';
  out.push(`<text x="${W / 2}" y="${top + 4}" font-size="3" fill="#bbb" text-anchor="middle">${label} · ${paper.label} · print at 100% / actual size</text>`);
  if (layout.sheets > 1 && sheetIndex === 1) {
    out.push(`<line x1="-${ox}" y1="${bot}" x2="${W + ox}" y2="${bot}" stroke="#000" stroke-width="0.25" stroke-dasharray="3 2"/>`);
    out.push(`<text x="${W / 2}" y="${bot - 2}" font-size="3" fill="#555" text-anchor="middle">✂ cut along this line, then lay this edge on the line at the top of sheet 1</text>`);
  }
  if (layout.sheets > 1 && sheetIndex === 0) {
    out.push(`<line x1="-${ox}" y1="${top}" x2="${W + ox}" y2="${top}" stroke="#000" stroke-width="0.25"/>`);
    out.push(`<text x="${W / 2}" y="${top + 8}" font-size="3" fill="#555" text-anchor="middle">align the cut edge of sheet 2 with the line above · tape flat</text>`);
  }
  out.push('</g></svg>');
  return out.join('');
}
