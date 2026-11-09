// LLM-assisted steps. Every function degrades gracefully: callers catch errors and
// fall back to the deterministic pipeline.
import { chatJSON, toDataURL } from './llm.js';

const BASE = `You are the assistant inside "Foot Fit", a web app that measures a human foot with a phone camera.
The user places their foot on a printed paper template that has black square ArUco markers in two columns
down the left and right edges, a light-grey heel line near the bottom, and a 100 mm ruler bar under it.
The heel should touch the heel line and the toes point up the page. The app computes geometry itself;
your job is to judge image quality and give short, concrete, friendly advice. Never invent measurements.
Always answer with a single JSON object and nothing else.`;

const img = (url) => ({ type: 'image_url', image_url: { url, detail: 'low' } });

/** Check a live frame before scanning. */
export async function setupCheck(frameCanvas, ctx) {
  const { json } = await chatJSON({
    purpose: 'setup_check',
    maxTokens: 400,
    system: BASE,
    content: [
      { type: 'text', text: `This is the camera view before a scan. Detected markers: ${ctx.markers}. Check: is the template flat and fully visible, is the lighting even (no harsh shadows), does the floor contrast with the white paper, is the foot (bare or a coloured sock) clearly distinguishable from the paper, is the heel on the heel line?
Reply JSON: {"ok": boolean, "issues": [string], "tips": [string]} (max 3 items each, each under 20 words).` },
      img(toDataURL(frameCanvas, 768)),
    ],
  });
  return json;
}

/** Live coaching for the current scan step. */
export async function coach(frameCanvas, state) {
  const { json } = await chatJSON({
    purpose: 'coach',
    maxTokens: 250,
    system: BASE,
    content: [
      { type: 'text', text: `Scan step: ${state.step}. ${state.stepGoal}
Current camera: elevation ${state.elevation?.toFixed?.(0)}°, azimuth ${state.azimuth?.toFixed?.(0)}° (0 = in front of toes, 90 = right side, 180 = behind heel), ${state.markers} markers visible.
Captured so far: ${state.captured}. Missing directions: ${state.missing || 'none'}.
Look at the image and tell the user the single most useful thing to do next.
Reply JSON: {"say": string (under 25 words), "problem": string|null}` },
      img(toDataURL(frameCanvas, 640)),
    ],
  });
  return json;
}

/** Review segmentation overlays and suggest a sensitivity change. */
export async function reviewSegmentation(topOverlay, viewOverlays, measures) {
  const content = [
    { type: 'text', text: `Image 1 is the top view rectified onto the paper (1 px = 0.5 mm) with the detected foot outline in magenta.
${viewOverlays.length ? `Images 2-${viewOverlays.length + 1} are side views with the detected foot silhouette tinted magenta.` : ''}
Measured: length ${measures.lengthMm.toFixed(1)} mm, ball width ${measures.ballWidthMm.toFixed(1)} mm.
Judge whether the outline hugs the foot. Common errors: shadows included (outline too big on one side), pale skin or white sock missed (outline too small), the leg or trousers included, toes cut off.
Reply JSON: {"quality": "good"|"fair"|"poor", "problems": [string], "sensitivity_change": number between -0.4 and 0.4 (positive = include more, negative = include less, 0 = fine), "retake": boolean, "advice": string}` },
    img(toDataURL(topOverlay, 900)),
    ...viewOverlays.slice(0, 3).map((c) => img(toDataURL(c, 512))),
  ];
  const { json } = await chatJSON({ purpose: 'segmentation_review', maxTokens: 450, system: BASE, content });
  return json;
}

/** Fit report from final measurements (+ top view for toe shape). */
export async function fitReport(measures, topOverlay, side) {
  const { json } = await chatJSON({
    purpose: 'fit_report',
    maxTokens: 900,
    system: BASE,
    content: [
      { type: 'text', text: `Measurements of the user's ${side || 'unspecified'} foot (millimetres, from a phone scan, typical error ±2-4 mm):
${JSON.stringify(measures, null, 1)}
The image shows the top view with the outline.
Provide: shoe size estimates (US men, US women, UK, EU, Mondopoint/JP cm) using standard length-based conversions with typical toe allowance; width category (narrow/standard/wide/extra-wide) using length-to-ball-width relationship; toe shape (Egyptian, Greek/Morton, square) from the image if visible; notes on volume/instep if height data present; 3-5 practical fit tips. Mention uncertainty.
Reply JSON: {"sizes": {"us_men": string, "us_women": string, "uk": string, "eu": string, "mondopoint_mm": string}, "width": string, "toe_shape": string, "summary": string, "tips": [string], "confidence": "low"|"medium"|"high"}` },
      img(toDataURL(topOverlay, 768)),
    ],
  });
  return json;
}

/** Deterministic, approximate size conversions (Brannock-style, length only). */
export function localSizes(lengthMm) {
  const inch = lengthMm / 25.4;
  const usM = 3 * inch - 22;
  const usW = usM + 1.5;
  const uk = usM - 0.5;
  const eu = 1.5 * (lengthMm / 10 + 1.5);
  const half = (v) => Math.max(0, Math.round(v * 2) / 2);
  return {
    us_men: half(usM).toFixed(1), us_women: half(usW).toFixed(1), uk: half(uk).toFixed(1),
    eu: Math.round(eu).toString(), mondopoint_mm: (Math.round(lengthMm / 5) * 5).toString(),
  };
}
