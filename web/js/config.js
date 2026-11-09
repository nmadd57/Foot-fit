// Deployment configuration. The app and its API are served from the same Cloudflare
// Worker, so the API lives at relative paths. Set hostedAI to false to ship a build
// without the hosted proxy (users can still bring their own endpoint).
export const CONFIG = {
  apiBase: '',
  hostedAI: true,
  appName: 'Foot Fit',
};
