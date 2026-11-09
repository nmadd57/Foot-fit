# Foot Fit

Measure a foot and build a 3D model with a phone camera and a printed marker template.
Everything runs on **one Cloudflare Worker**: it serves the web app (`web/`, as static
assets) and a small API on the same domain for GitHub sign-in, per-account AI usage limits
and a proxy to any OpenAI-compatible LLM endpoint.

## How it works

1. **Template** (`/template.html`) – A4, Letter, A3 or Tabloid; 1 sheet, or 2 sheets taped end
   to end for long feet. Two columns of ArUco markers track the paper; a 100 mm ruler checks
   the print scale. Taping misalignment between sheets is measured and corrected automatically.
2. **Scan** – step 1: phone held flat above the foot (3 frames auto-captured). Step 2: walk
   around the foot; a ring fills as 12 directions are captured. Frames are taken automatically
   when the camera is steady and enough markers are visible. "Use photos instead" accepts
   existing pictures.
3. **Processing** (all in the browser) – camera focal length is self-calibrated from the
   markers, poses are refined, the top view is rectified onto the paper and the foot outlined;
   side views are segmented with colour models sampled from each view and carved into a
   voxel volume (visual hull), which also removes the leg/shadow from the footprint. Output:
   length, ball/heel width, heel-to-ball, instep/toe height, ball/instep girth, volume,
   approximate sizes, and an STL/OBJ mesh.
4. **AI assistant (optional)** – live scan tips, an outline check (can adjust sensitivity),
   and a shoe-fit report. Either the hosted proxy (GitHub sign-in, quota) or the user's own
   OpenAI-compatible endpoint, called directly from the browser.

Typical accuracy on the synthetic test: length/width within ~1 mm; heights and girths are
over-estimated by a few percent (a visual hull can't see concavities).

## Deploy

Requires a Cloudflare account (free plan is fine) and Node 20+.

```sh
npm ci
npx wrangler login
npx wrangler deploy            # first deploy gives you https://foot-fit.<you>.workers.dev
```

1. Create a **GitHub OAuth App** (GitHub → Settings → Developer settings → OAuth Apps):
   - Homepage URL: `https://foot-fit.<you>.workers.dev`
   - Authorization callback URL: `https://foot-fit.<you>.workers.dev/auth/callback`
2. Set secrets:
   ```sh
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET      # any long random string: openssl rand -hex 32
   npx wrangler secret put UPSTREAM_API_KEY    # key for your LLM provider
   ```
3. Edit `[vars]` in `wrangler.toml`: `UPSTREAM_BASE_URL` (any OpenAI-compatible `/v1` base URL),
   `UPSTREAM_MODEL` (must accept images), and the limits below. Redeploy.

A custom domain can be attached in the Cloudflare dashboard (Workers → foot-fit → Domains);
update the OAuth App URLs to match.

### Limits and access control (`wrangler.toml` `[vars]`)

| Variable | Default | Meaning |
|---|---|---|
| `DAILY_REQUESTS_PER_USER` | 20 | AI requests per GitHub account per UTC day |
| `MONTHLY_REQUESTS_PER_USER` | 200 | per calendar month |
| `DAILY_TOKENS_PER_USER` | 200000 | tokens per account per day |
| `GLOBAL_DAILY_REQUESTS` | 1000 | hard cap across all users — your worst-case daily bill |
| `MAX_OUTPUT_TOKENS` / `MAX_IMAGES_PER_REQUEST` / `MAX_BODY_BYTES` | 1000 / 4 / 3 MB | per-request caps |
| `MIN_ACCOUNT_AGE_DAYS` | 30 | rejects brand-new GitHub accounts |
| `ALLOWED_GITHUB_USERS` / `ALLOWED_GITHUB_ORGS` | empty | optional allow lists |
| `BLOCKED_GITHUB_USERS` | empty | block list |
| `SESSION_VERSION` | 1 | bump to sign everyone out |

Counters live in a Durable Object, so limits hold under concurrent requests. Failed upstream
calls are refunded. The client can't choose the model or exceed the caps; images must be
inline data URLs. Also set a spending limit with your LLM provider as a final backstop.

### CI/CD

`.github/workflows/deploy.yml` runs the tests and a dry-run build on every push. To deploy
automatically from `main`, set repository variable `DEPLOY=true` and secrets
`CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers") and `CLOUDFLARE_ACCOUNT_ID`.

## Development

```sh
cp .dev.vars.example .dev.vars   # fill in
npm run dev                      # http://localhost:8787 — app + API
npm test                         # API unit tests
```

Camera access needs HTTPS or `localhost`; to try on a phone, deploy or use a tunnel.

`test/synthetic.html` renders the template and a foot-shaped proxy of known size from many
camera poses with three.js and runs the real pipeline (serve the repo root, e.g.
`python3 -m http.server 8123`, then open `/test/synthetic.html`, or run
`node test/run-synthetic.cjs` with Playwright installed).

## Layout

```
web/            static app (index.html, template.html, js/, css/)
  js/vendor/    js-aruco2 marker detector (MIT)
src/index.js    Worker: assets, GitHub OAuth, quotas (Durable Object), LLM proxy
test/           synthetic end-to-end test, worker unit tests
wrangler.toml   Cloudflare configuration
```
