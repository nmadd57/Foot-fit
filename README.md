# Foot Fit

Measure a foot and build a 3D model with a phone camera and a printed ArUco-marker template.
Static web app (`web/`, deployable to GitHub Pages) plus an optional API (`worker/`) for GitHub
sign-in, per-account AI usage limits and an OpenAI-compatible LLM proxy.

- `web/template.html` – printable template (A4 / Letter / A3 / Tabloid, 1 or 2 sheets)
- `web/index.html` – scanner: top view + orbit capture, footprint measurement, voxel-carved 3D model (STL/OBJ)
- `worker/` – Cloudflare Worker (backend choice under discussion; see `worker/wrangler.toml`)
- `test/` – synthetic end-to-end test (`synthetic.html`, renders a known foot proxy and runs the real pipeline)

Work in progress.
