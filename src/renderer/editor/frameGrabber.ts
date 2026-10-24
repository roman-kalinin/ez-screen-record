/**
 * Frames for the timeline hover preview and filmstrip, from a hidden second
 * <video> on the same file — so hovering never moves the real playhead and no
 * ffmpeg process is needed.
 *
 * Seeks are serialized: a <video> can only be at one place at a time. Hover
 * requests are "latest wins" and jump the queue; filmstrip requests are a
 * background queue that can be cleared when the timeline view changes.
 */
type Job = { t: number; draw: (v: HTMLVideoElement) => void };

export class FrameGrabber {
  private video: HTMLVideoElement;
  private ready: Promise<void>;
  private busy = false;
  private hoverJob: Job | null = null;
  private queue: Job[] = [];
  private disposed = false;

  constructor(url: string) {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    // Paired with Access-Control-Allow-Origin on the ezmedia protocol, this
    // keeps canvases we draw into untainted.
    v.crossOrigin = 'anonymous';
    v.src = url;
    this.video = v;
    this.ready = new Promise((resolve) => {
      if (v.readyState >= 2) resolve();
      else v.addEventListener('loadeddata', () => resolve(), { once: true });
    });
  }

  hover(t: number, draw: Job['draw']): void {
    this.hoverJob = { t, draw };
    void this.pump();
  }

  enqueue(t: number, draw: Job['draw']): void {
    this.queue.push({ t, draw });
    void this.pump();
  }

  clearQueue(): void {
    this.queue = [];
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.hoverJob = null;
    this.video.removeAttribute('src');
    this.video.load();
  }

  private seek(t: number): Promise<void> {
    const v = this.video;
    return new Promise((resolve) => {
      if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) {
        resolve();
        return;
      }
      const timer = window.setTimeout(done, 2000);
      function done() {
        window.clearTimeout(timer);
        v.removeEventListener('seeked', done);
        resolve();
      }
      v.addEventListener('seeked', done);
      v.currentTime = t;
    });
  }

  private async pump(): Promise<void> {
    if (this.busy || this.disposed) return;
    const job = this.hoverJob ?? this.queue.shift();
    if (!job) return;
    if (job === this.hoverJob) this.hoverJob = null;
    this.busy = true;
    try {
      await this.ready;
      await this.seek(Math.max(0, Math.min(job.t, (this.video.duration || job.t) - 0.001)));
      if (!this.disposed) job.draw(this.video);
    } catch {
      /* a failed grab just leaves the previous frame */
    } finally {
      this.busy = false;
    }
    void this.pump();
  }
}

/** Draw `v` into `ctx` covering w×h (object-fit: cover). */
export function drawCover(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, x: number, y: number, w: number, h: number) {
  const vw = v.videoWidth || 16;
  const vh = v.videoHeight || 9;
  const scale = Math.max(w / vw, h / vh);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
}
