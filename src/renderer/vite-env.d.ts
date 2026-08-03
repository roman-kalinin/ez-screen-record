/**
 * Types for Vite's asset-query imports.
 *
 * The project does not pull in `vite/client` wholesale (it would also drag in
 * ImportMeta and asset-module declarations the app has no use for), so the one
 * form actually used is declared here: `?worker`, which compiles a module into
 * a same-origin Worker chunk. That same-origin part is load-bearing — the
 * renderer CSP is `script-src 'self'` and rejects blob: workers.
 */
declare module '*?worker' {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
