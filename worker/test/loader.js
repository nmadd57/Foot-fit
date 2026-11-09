// Maps the Workers runtime module to a local stub so the worker can be unit-tested in Node.
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: new URL('./cf-stub.js', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
