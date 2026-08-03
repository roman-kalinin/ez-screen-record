/**
 * A periodic tick that survives window occlusion.
 *
 * Chromium clamps `setInterval` on the MAIN thread to once per second whenever
 * the window is backgrounded, hidden or parked off-screen — which is exactly
 * what a recording take does to the control window. Timers inside a Worker run
 * on their own task queue and are not clamped, so the compositing tick is
 * generated here and posted back for the main thread to draw on.
 *
 * A real module rather than a Blob URL: the renderer's CSP is `script-src
 * 'self'`, which refuses blob: workers outright. Built as a separate chunk by
 * Vite's `?worker` import, so it is same-origin and allowed.
 */

let id: ReturnType<typeof setInterval> | null = null;

self.onmessage = (e: MessageEvent<{ interval?: number; stop?: boolean }>) => {
  if (id !== null) {
    clearInterval(id);
    id = null;
  }
  if (e.data.stop) return;

  const interval = e.data.interval ?? 33;
  id = setInterval(() => self.postMessage(0), interval);
};
