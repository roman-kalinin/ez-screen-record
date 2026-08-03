import FrameClockWorker from './frame-clock.worker?worker';
import { bitrateFor } from '../../shared/types';
import type { AppSettings, CameraOverlay, ImageOverlay, Rect } from '../../shared/types';

/**
 * Live compositor + encoder.
 *
 * The screen capture is drawn to an offscreen canvas every frame, with the
 * webcam and any image overlays painted on top. The canvas is then captured as
 * a MediaStream and fed to MediaRecorder together with the mixed audio, so the
 * resulting file already has everything burned in — no post-processing.
 *
 * Drawing/annotation is deliberately NOT composited here: the annotation
 * overlay is a real transparent window on the desktop, so the screen capture
 * picks it up naturally and it stays perfectly in sync.
 */

export interface RecorderCallbacks {
  onTick?: (elapsedMs: number) => void;
  onStop?: (blob: Blob) => void;
  onError?: (err: Error) => void;
}

interface LoadedImage {
  overlay: ImageOverlay;
  bitmap: HTMLImageElement;
}

/** Pick a mime type this build of Chromium can actually encode. */
function pickMimeType(): string {
  const candidates = [
    'video/mp4;codecs=h264,aac',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

/**
 * A periodic timer that survives window occlusion.
 *
 * Chromium clamps `setInterval` in a backgrounded, hidden or off-screen window
 * to one call per second. A take parks the control window off-screen (so its
 * canvas keeps compositing while staying out of the capture), which puts the
 * compositing loop squarely in that clamp. `backgroundThrottling: false` on the
 * window is necessary but not sufficient — an off-screen window can be treated
 * as occluded and throttled anyway. Timers inside a Worker have their own task
 * queue and are not clamped, so the tick is generated there and posted back to
 * the main thread, which does the drawing.
 *
 * The Worker must be a real module (`frame-clock.worker.ts`), not a Blob URL:
 * the renderer's CSP is `script-src 'self'` and rejects blob: workers.
 */
class FrameClock {
  private worker: Worker | null = null;
  /** Fallback when the Worker cannot be constructed at all. */
  private fallbackId: number | null = null;

  constructor(intervalMs: number, onTick: () => void) {
    try {
      this.worker = new FrameClockWorker();
      this.worker.onmessage = onTick;
      this.worker.postMessage({ interval: intervalMs });
    } catch (err) {
      // Degrade to a plain timer rather than record nothing — but this IS the
      // throttled path, so it costs frame rate. Warn loudly so a regression
      // here (e.g. the worker failing to load) can't pass unnoticed.
      console.warn('[recorder] worker timer unavailable, frame rate WILL drop', err);
      this.fallbackId = window.setInterval(onTick, intervalMs);
    }
  }

  stop(): void {
    if (this.worker) {
      this.worker.postMessage({ stop: true });
      this.worker.terminate();
      this.worker = null;
    }
    if (this.fallbackId !== null) {
      window.clearInterval(this.fallbackId);
      this.fallbackId = null;
    }
  }
}

export class ScreenRecorder {
  private screenStream: MediaStream | null = null;
  private cameraStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  /** Desktop-audio loopback stream (Windows), kept so it can be stopped on cleanup. */
  private systemStream: MediaStream | null = null;

  private screenVideo: HTMLVideoElement | null = null;
  private cameraVideo: HTMLVideoElement | null = null;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private frameTimer: FrameClock | null = null;
  private frameIntervalMs = 33;
  private tickId: number | null = null;

  private audioContext: AudioContext | null = null;

  private images: LoadedImage[] = [];
  private camera: CameraOverlay | null = null;
  private acquiringCamera = false;
  private swappingScreen = false;
  private swappingMic = false;
  /** Kept so the mic can be swapped without rebuilding the audio graph. */
  private audioDest: MediaStreamAudioDestinationNode | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  /** Bumped per updateImages call so a slow decode can't overwrite newer state. */
  private imagesToken = 0;
  private imageCache = new Map<string, HTMLImageElement>();

  private startedAt = 0;
  private pausedAccum = 0;
  private pausedAt = 0;

  private cbs: RecorderCallbacks = {};
  private mimeType = '';

  get state(): 'inactive' | 'recording' | 'paused' {
    return this.recorder?.state ?? 'inactive';
  }

  /** File extension matching whatever the encoder actually produced. */
  get fileExtension(): string {
    return this.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  }

  async start(settings: AppSettings, cbs: RecorderCallbacks = {}): Promise<void> {
    this.cbs = cbs;
    const { recording, camera } = settings;
    if (!recording.screenSourceId) throw new Error('No screen source selected.');

    this.camera = camera.enabled ? camera : null;

    // --- Screen capture ----------------------------------------------------
    // Electron's chromeMediaSource path lets us target the exact source the
    // user picked, which getDisplayMedia alone cannot do.
    // The display's real pixel dimensions. Without an explicit maxWidth/
    // maxHeight, Chromium's desktop capture silently defaults to about
    // 1280x720 — which is why every resolution preset produced a soft image
    // regardless of the monitor. minWidth/minHeight force the full-resolution
    // capture path.
    const capW = Math.round(window.screen.width * window.devicePixelRatio);
    const capH = Math.round(window.screen.height * window.devicePixelRatio);

    this.screenStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // Electron-specific `mandatory` constraints; not part of the standard
        // MediaTrackConstraints, hence the cast on the whole object below.
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: recording.screenSourceId,
          maxFrameRate: recording.fps,
          minWidth: capW,
          minHeight: capH,
          maxWidth: capW,
          maxHeight: capH,
        },
      },
    } as unknown as MediaStreamConstraints);

    this.screenVideo = await this.attachVideo(this.screenStream);
    // Desktop capture often reports a small placeholder size at loadedmetadata
    // and only ramps to full resolution a beat later, so wait for it to settle
    // before sizing anything off it. See waitForStableSize.
    await this.waitForStableSize(this.screenVideo);

    const nativeW = this.screenVideo.videoWidth;
    const nativeH = this.screenVideo.videoHeight;
    if (!nativeW || !nativeH) throw new Error('Could not read screen dimensions.');

    // Scale to the requested output height, preserving the source aspect ratio.
    // Never upscale — encoding a 1080p screen at "4K" only wastes bitrate.
    let width = nativeW;
    let height = nativeH;
    if (recording.resolution !== 'source') {
      const targetH = Number(recording.resolution);
      if (targetH < nativeH) {
        height = targetH;
        width = Math.round((nativeW / nativeH) * targetH);
      }
    }
    // H.264 requires even dimensions.
    width -= width % 2;
    height -= height % 2;

    // --- Webcam ------------------------------------------------------------
    if (this.camera?.deviceId) {
      try {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            deviceId: { exact: this.camera.deviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        this.cameraVideo = await this.attachVideo(this.cameraStream);
      } catch (err) {
        // A missing/busy webcam should degrade gracefully, not abort the take.
        console.warn('[recorder] camera unavailable, continuing without it', err);
        this.camera = null;
      }
    }

    // --- Image overlays ----------------------------------------------------
    this.images = await this.loadImages(settings.images.filter((i) => i.visible));

    // --- Canvas compositor -------------------------------------------------
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('Could not create canvas context.');

    const canvasStream = this.canvas.captureStream(recording.fps);

    // Tell the encoder this is SCREEN content, not camera footage, so it
    // preserves sharpness rather than trading it away to hold a bitrate. This
    // hint governs the quality/rate trade only, not frame timing.
    const canvasTrack = canvasStream.getVideoTracks()[0];
    if (canvasTrack) canvasTrack.contentHint = 'detail';

    // Same for the source: the desktop capture track feeding the canvas.
    const screenTrack = this.screenStream.getVideoTracks()[0];
    if (screenTrack) screenTrack.contentHint = 'detail';

    // --- Audio mixing ------------------------------------------------------
    const audioTrack = await this.buildAudioTrack(settings);
    if (audioTrack) canvasStream.addTrack(audioTrack);

    // --- Encode ------------------------------------------------------------
    this.mimeType = pickMimeType();
    this.chunks = [];
    this.recorder = new MediaRecorder(canvasStream, {
      mimeType: this.mimeType || undefined,
      // Derived from the actual output size and frame rate.
      videoBitsPerSecond: bitrateFor(height, recording.fps),
      audioBitsPerSecond: 128_000,
    });

    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mimeType || 'video/webm' });
      this.cleanup();
      this.cbs.onStop?.(blob);
    };
    this.recorder.onerror = (e) => {
      // Release hardware before surfacing the error — otherwise the webcam and
      // screen capture stay live indefinitely after a failed take.
      this.cleanup();
      this.cbs.onError?.(new Error(`Recorder error: ${(e as any).error?.name ?? 'unknown'}`));
    };

    // If the user stops sharing via the OS, end the take cleanly.
    this.screenStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.state !== 'inactive') this.stop();
    });

    this.startedAt = performance.now();
    this.pausedAccum = 0;
    // Timeslice keeps data flowing so a crash doesn't lose the whole take.
    this.recorder.start(1000);
    this.frameIntervalMs = Math.max(8, Math.round(1000 / recording.fps));
    this.renderFrame();
    this.frameTimer = new FrameClock(this.frameIntervalMs, this.renderFrame);

    this.tickId = window.setInterval(() => {
      this.cbs.onTick?.(this.elapsedMs());
    }, 200);
  }

  elapsedMs(): number {
    if (!this.startedAt) return 0;
    const now = this.pausedAt || performance.now();
    return now - this.startedAt - this.pausedAccum;
  }

  pause(): void {
    if (this.recorder?.state !== 'recording') return;
    this.recorder.pause();
    this.pausedAt = performance.now();
    // Stop compositing while paused — no point burning CPU on frames that
    // aren't being encoded.
    this.frameTimer?.stop();
    this.frameTimer = null;
  }

  resume(): void {
    if (this.recorder?.state !== 'paused') return;
    this.recorder.resume();
    if (this.pausedAt) this.pausedAccum += performance.now() - this.pausedAt;
    this.pausedAt = 0;
    if (this.frameTimer === null) {
      this.frameTimer = new FrameClock(this.frameIntervalMs, this.renderFrame);
    }
  }

  stop(): void {
    if (!this.recorder || this.recorder.state === 'inactive') return;
    this.stopTimers();
    this.recorder.stop();
  }

  private stopTimers(): void {
    this.frameTimer?.stop();
    this.frameTimer = null;
    if (this.tickId !== null) {
      window.clearInterval(this.tickId);
      this.tickId = null;
    }
  }

  /**
   * Live updates while recording, so repositioning is reflected immediately.
   *
   * Acquires the webcam on demand: if the take started with the camera off (or
   * before a device was resolved) there is no video element yet, and simply
   * setting `this.camera` would leave the overlay silently absent from the
   * recording while the UI happily showed it as enabled.
   */
  async updateCamera(camera: CameraOverlay): Promise<void> {
    if (!camera.enabled || !camera.deviceId) {
      this.camera = null;
      return;
    }

    const deviceChanged =
      this.cameraStream?.getVideoTracks()[0]?.getSettings().deviceId !== camera.deviceId;

    if (!this.cameraVideo || deviceChanged) {
      // Guard against overlapping acquisitions from rapid toggling.
      if (this.acquiringCamera) {
        this.camera = camera;
        return;
      }
      this.acquiringCamera = true;
      try {
        this.cameraStream?.getTracks().forEach((t) => t.stop());
        this.cameraStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            deviceId: { exact: camera.deviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        this.cameraVideo = await this.attachVideo(this.cameraStream);
      } catch (err) {
        console.warn('[recorder] could not start camera mid-recording', err);
        this.camera = null;
        return;
      } finally {
        this.acquiringCamera = false;
      }
    }

    this.camera = camera;
  }

  /**
   * Swap the capture source mid-recording.
   *
   * The canvas keeps its original dimensions, so the encoded stream is
   * uninterrupted — only what is drawn into it changes. The new source is
   * fully attached before the old one is torn down, so no frame is lost.
   */
  async updateScreenSource(sourceId: string, fps: number): Promise<void> {
    if (!this.screenStream) return;
    const current = this.screenStream.getVideoTracks()[0];
    if (current?.getSettings().deviceId === sourceId) return;
    if (this.swappingScreen) return;

    this.swappingScreen = true;
    const oldStream = this.screenStream;
    try {
      // Match the original capture resolution (see start()) so a mid-take
      // source switch doesn't silently drop to Chromium's 720p default.
      const capW = Math.round(window.screen.width * window.devicePixelRatio);
      const capH = Math.round(window.screen.height * window.devicePixelRatio);

      const next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxFrameRate: fps,
            minWidth: capW,
            minHeight: capH,
            maxWidth: capW,
            maxHeight: capH,
          },
        },
      } as unknown as MediaStreamConstraints);

      const video = await this.attachVideo(next);
      this.screenStream = next;
      this.screenVideo = video;

      next.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (this.state !== 'inactive') this.stop();
      });

      oldStream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      console.warn('[recorder] could not switch screen source', err);
    } finally {
      this.swappingScreen = false;
    }
  }

  /** Swap the microphone mid-recording by re-routing the WebAudio graph. */
  async updateMicrophone(deviceId: string | null, enabled: boolean): Promise<void> {
    if (!this.audioContext || !this.audioDest) return;
    if (this.swappingMic) return;

    this.swappingMic = true;
    try {
      // Detach the previous mic from the mix.
      this.micSourceNode?.disconnect();
      this.micSourceNode = null;
      this.micStream?.getTracks().forEach((t) => t.stop());
      this.micStream = null;

      if (!enabled) return;

      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId
          ? {
              deviceId: { exact: deviceId },
              echoCancellation: false,
              noiseSuppression: true,
              autoGainControl: true,
            }
          : true,
        video: false,
      });
      this.micSourceNode = this.audioContext.createMediaStreamSource(this.micStream);
      this.micSourceNode.connect(this.audioDest);
    } catch (err) {
      console.warn('[recorder] could not switch microphone', err);
    } finally {
      this.swappingMic = false;
    }
  }

  async updateImages(images: ImageOverlay[]): Promise<void> {
    const token = ++this.imagesToken;
    const loaded = await this.loadImages(images.filter((i) => i.visible));
    // A newer call finished first — discard this stale result.
    if (token !== this.imagesToken) return;
    this.images = loaded;
  }

  // -------------------------------------------------------------------------

  private async loadImages(overlays: ImageOverlay[]): Promise<LoadedImage[]> {
    const loaded = await Promise.all(
      overlays.map(async (overlay) => {
        // Decoded bitmaps are cached by source, so dragging an overlay (which
        // fires an update per pointer-move) only re-reads the rect rather than
        // re-decoding the whole base64 payload every frame.
        const cached = this.imageCache.get(overlay.src);
        if (cached) return { overlay, bitmap: cached };

        return new Promise<LoadedImage | null>((resolve) => {
          const img = new Image();
          img.onload = () => {
            this.imageCache.set(overlay.src, img);
            resolve({ overlay, bitmap: img });
          };
          img.onerror = () => resolve(null);
          img.src = overlay.src;
        });
      }),
    );

    const result = loaded.filter((x): x is LoadedImage => x !== null);

    // Drop cache entries for images the user removed.
    const live = new Set(overlays.map((o) => o.src));
    for (const key of this.imageCache.keys()) {
      if (!live.has(key)) this.imageCache.delete(key);
    }

    return result;
  }

  /**
   * Wait for a capture's reported dimensions to stop changing.
   *
   * Chromium's desktop capturer frequently reports a small placeholder size
   * (~1280x720) at `loadedmetadata` and ramps to the real resolution a beat
   * later. Sizing the canvas and bitrate off that placeholder pins the WHOLE
   * take to a low resolution — the "first recording right after launch is
   * blurry, the next one is fine" bug, since the capturer is already warm on
   * later takes. Poll until the size is non-zero and unchanged across two
   * reads, or a short cap elapses (a nearly-static screen may deliver few
   * frames, and by then whatever size we have is the real one).
   */
  private waitForStableSize(video: HTMLVideoElement): Promise<void> {
    return new Promise((resolve) => {
      let last = -1;
      const deadline = performance.now() + 700;
      const poll = () => {
        const w = video.videoWidth;
        if (w > 0 && w === last) return resolve();
        last = w;
        if (performance.now() >= deadline) return resolve();
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  private attachVideo(stream: MediaStream): Promise<HTMLVideoElement> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      const done = () => {
        video
          .play()
          .then(() => resolve(video))
          .catch(reject);
      };
      if (video.readyState >= 2) done();
      else video.onloadedmetadata = done;
      video.onerror = () => reject(new Error('Failed to attach media stream.'));
    });
  }

  /**
   * Mix mic + system audio into one track. Two sources have to go through a
   * WebAudio graph because MediaRecorder only accepts a single audio track.
   */
  private async buildAudioTrack(settings: AppSettings): Promise<MediaStreamTrack | null> {
    const { recording } = settings;
    const inputs: MediaStream[] = [];

    if (recording.micEnabled) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: recording.micDeviceId
            ? {
                deviceId: { exact: recording.micDeviceId },
                echoCancellation: false,
                noiseSuppression: true,
                autoGainControl: true,
              }
            : true,
          video: false,
        });
        inputs.push(this.micStream);
      } catch (err) {
        console.warn('[recorder] microphone unavailable', err);
      }
    }

    if (recording.systemAudioEnabled) {
      try {
        // System (desktop) audio on Windows comes from a getDisplayMedia request
        // that main answers with `audio: 'loopback'` (see the
        // setDisplayMediaRequestHandler in main.ts). The legacy
        // getUserMedia({ chromeMediaSource: 'desktop' }) audio path does NOT go
        // through that handler and yields no loopback track on current Electron,
        // which is why desktop sound was silently missing from recordings.
        const sys = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: true,
        });
        // We only want the audio; drop the video track the handler paired with it.
        sys.getVideoTracks().forEach((t) => t.stop());
        if (sys.getAudioTracks().length) {
          this.systemStream = sys;
          inputs.push(sys);
        } else {
          sys.getTracks().forEach((t) => t.stop());
          console.warn('[recorder] system audio requested but no loopback track was granted');
        }
      } catch (err) {
        console.warn('[recorder] system audio unavailable', err);
      }
    }

    // Always build the graph, even with no inputs yet: the user may enable the
    // mic mid-recording, and there would be nothing to attach it to otherwise.
    this.audioContext = new AudioContext();
    const dest = this.audioContext.createMediaStreamDestination();
    this.audioDest = dest;

    for (const stream of inputs) {
      if (!stream.getAudioTracks().length) continue;
      const src = this.audioContext.createMediaStreamSource(stream);
      const gain = this.audioContext.createGain();
      gain.gain.value = 1;
      src.connect(gain).connect(dest);
      // Remember the mic node specifically so it can be swapped later.
      if (stream === this.micStream) this.micSourceNode = src;
    }

    return dest.stream.getAudioTracks()[0] ?? null;
  }

  /** Convert a normalised rect to canvas pixels. */
  private toPixels(rect: Rect, cw: number, ch: number) {
    return {
      x: Math.round(rect.x * cw),
      y: Math.round(rect.y * ch),
      w: Math.round(rect.w * cw),
      h: Math.round(rect.h * ch),
    };
  }

  /**
   * Composite one frame. Driven by a Worker timer (FrameClock), because while
   * recording the control window is parked off-screen where rAF is halted and
   * setInterval is clamped to 1/s — only a Worker's timer is exempt. See
   * FrameClock for the full rationale.
   */
  private renderFrame = (): void => {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas || !this.screenVideo) return;

    const cw = canvas.width;
    const ch = canvas.height;

    // Fit the source to the canvas preserving its aspect ratio, rather than
    // stretching to fill. The canvas is locked to the screen's size for the
    // whole take (H.264 needs constant dimensions), so a source with a
    // different shape — e.g. a window smaller than the screen picked mid-take —
    // must be letterboxed, not distorted. The common case (source fills the
    // canvas) still draws edge-to-edge, byte-for-byte as before.
    const vw = this.screenVideo.videoWidth || cw;
    const vh = this.screenVideo.videoHeight || ch;
    const scale = Math.min(cw / vw, ch / vh);
    const dw = Math.round(vw * scale);
    const dh = Math.round(vh * scale);
    if (cw - dw <= 2 && ch - dh <= 2) {
      ctx.drawImage(this.screenVideo, 0, 0, cw, ch);
    } else {
      // Clear to black so the letterbox bars are clean and no previous, larger
      // frame shows through around a smaller source.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(this.screenVideo, Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), dw, dh);
    }

    // Image overlays sit under the webcam so the presenter is never hidden.
    for (const { overlay, bitmap } of this.images) {
      const r = this.toPixels(overlay.rect, cw, ch);
      ctx.save();
      ctx.globalAlpha = overlay.opacity;
      ctx.drawImage(bitmap, r.x, r.y, r.w, r.h);
      ctx.restore();
    }

    if (this.camera && this.cameraVideo && this.cameraVideo.readyState >= 2) {
      this.drawCamera(ctx, this.cameraVideo, this.camera, cw, ch);
    }
  };

  private drawCamera(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    cam: CameraOverlay,
    cw: number,
    ch: number,
  ): void {
    const r = this.toPixels(cam.rect, cw, ch);
    if (r.w <= 0 || r.h <= 0) return;

    ctx.save();

    if (cam.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = Math.max(12, r.w * 0.06);
      ctx.shadowOffsetY = Math.max(4, r.h * 0.02);
    }

    // Clip to the chosen shape.
    ctx.beginPath();
    if (cam.shape === 'circle') {
      const d = Math.min(r.w, r.h);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    } else if (cam.shape === 'rounded') {
      const radius = Math.min(r.w, r.h) * 0.12;
      this.roundRect(ctx, r.x, r.y, r.w, r.h, radius);
    } else {
      ctx.rect(r.x, r.y, r.w, r.h);
    }
    ctx.closePath();
    // Paint the shadow via a fill, then clip for the video itself.
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.clip();

    // Cover-fit: fill the target box without distorting the camera aspect.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const targetAspect = r.w / r.h;
    const sourceAspect = vw / vh;
    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;
    if (sourceAspect > targetAspect) {
      sw = vh * targetAspect;
      sx = (vw - sw) / 2;
    } else {
      sh = vw / targetAspect;
      sy = (vh - sh) / 2;
    }

    if (cam.mirrored) {
      ctx.translate(r.x + r.w, r.y);
      ctx.scale(-1, 1);
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, r.w, r.h);
    } else {
      ctx.drawImage(video, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
    }

    ctx.restore();
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
  }

  private cleanup(): void {
    this.stopTimers();
    for (const s of [this.screenStream, this.cameraStream, this.micStream, this.systemStream]) {
      s?.getTracks().forEach((t) => t.stop());
    }
    this.screenStream = null;
    this.cameraStream = null;
    this.micStream = null;
    this.systemStream = null;
    this.screenVideo = null;
    this.cameraVideo = null;
    this.micSourceNode?.disconnect();
    this.micSourceNode = null;
    this.audioDest = null;
    this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.recorder = null;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedAccum = 0;
  }
}
