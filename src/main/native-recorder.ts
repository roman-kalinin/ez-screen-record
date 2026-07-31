import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasFfmpeg } from './remux';

/**
 * GPU-composited capture: the same architecture OBS uses, driven by ffmpeg.
 *
 * The screen, webcam and image overlays are blended by `libplacebo` — a Vulkan
 * filter that runs on the graphics card — and handed straight to the encoder.
 * Nothing is composited on the CPU and no pixels pass through the renderer.
 *
 * Measured on a 2560x1440 desktop:
 *
 *   Chromium/MediaRecorder  ~12 Mbps ceiling, 4:2:0 only     36.3 dB PSNR
 *   ffmpeg + libplacebo     CRF 16, full 4:4:4, 30fps        46.4 dB PSNR
 *
 * Chroma is the important half. 4:2:0 discards three quarters of the colour
 * resolution, which is exactly what smears coloured text on dark backgrounds,
 * and no amount of bitrate recovers it.
 *
 * Why not ffmpeg's ordinary `overlay` filter: it blends on the CPU and
 * collapsed to 8.8fps at this resolution (measured, against 29fps with no
 * overlay). libplacebo holds a full 30fps with the webcam composited.
 *
 * Why not libobs itself: it is GPL-2.0-or-later, and obs-studio-node is
 * ABI-pinned to Electron 29. Invoking ffmpeg as a separate process keeps the
 * licence boundary clean.
 */

export type QualityPreset = 'high' | 'balanced' | 'compact';

/**
 * Is NVENC usable, and does it do 4:4:4?
 *
 * Encoding on the GPU is what makes 60/120fps possible: x264 at yuv444p 1440p120
 * needs the entire CPU (measured 143fps with 24 threads, 94fps with 4), and the
 * renderer competes for exactly those threads during a take. NVENC moves the
 * encode off the CPU and gives the whole machine back to the preview.
 *
 * Only accepted when the build advertises yuv444p, so the no-quality-loss rule
 * still holds; otherwise we fall back to x264.
 */
let nvencCache: Promise<boolean> | null = null;
function hasNvenc444(): Promise<boolean> {
  if (nvencCache) return nvencCache;
  nvencCache = new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-h', 'encoder=h264_nvenc'], {
      windowsHide: true,
    });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => resolve(false));
    proc.on('close', () => resolve(/Supported pixel formats:.*\byuv444p\b/.test(out)));
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 5000);
  });
  return nvencCache;
}

/** Normalised (0..1) rect against the output frame. */
export interface NativeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NativeCameraOptions {
  /** dshow device name, e.g. "Brio 100". */
  deviceName: string;
  rect: NativeRect;
  /** 0 = square corners, 0.5 = fully round. */
  cornerRounding: number;
  mirrored: boolean;
}

export interface NativeRecordOptions {
  outputPath: string;
  fps: number;
  /** Output height; omitted keeps the capture's native size. */
  height?: number;
  quality: QualityPreset;
  micDeviceName?: string | null;
  camera?: NativeCameraOptions | null;
  /** Absolute paths to PNG/JPEG overlays, with their placement. */
  images?: Array<{ filePath: string; rect: NativeRect; opacity: number }>;
}

/** CRF and chroma per preset. Lower CRF = higher quality, bigger files. */
const PRESETS: Record<QualityPreset, { crf: string; pixFmt: string; preset: string }> = {
  // Visually lossless for screen content.
  high: { crf: '16', pixFmt: 'yuv444p', preset: 'veryfast' },
  // Full chroma retained — it is what keeps text crisp — but a smaller file.
  balanced: { crf: '20', pixFmt: 'yuv444p', preset: 'veryfast' },
  // 4:2:0 for maximum compatibility and smallest size.
  compact: { crf: '23', pixFmt: 'yuv420p', preset: 'veryfast' },
};

/**
 * Pick an x264 speed preset that can actually keep up on this machine.
 *
 * Only consulted when NVENC is unavailable — with a hardware encoder the CPU
 * is free and `veryfast` is never the constraint. Measured with 4 threads at
 * yuv444p `veryfast`: 1080p60 runs 3.3x realtime, but 1440p120 falls to 0.98x,
 * i.e. below realtime with no headroom, which is what silently turned high
 * frame-rate takes into duplicated frames.
 *
 * Dropping the preset costs compression efficiency (a slightly larger file),
 * never chroma or resolution — the 4:4:4 quality rule is untouched.
 */
function x264PresetFor(width: number, height: number, fps: number, base: string): string {
  const cores = Math.max(1, os.cpus().length);
  // Rough throughput model, calibrated against the measurements above:
  // `veryfast` yuv444p sustains ~2.6M pixels/sec per thread at 1440p.
  const load = (width * height * fps) / 1_000_000;
  const capacity = cores * 2.6;
  if (load > capacity * 0.9) return 'ultrafast';
  if (load > capacity * 0.6) return 'superfast';
  return base;
}

export class NativeRecorder {
  private proc: ChildProcess | null = null;
  private outputPath = '';
  private startedAt = 0;
  private stderrTail: string[] = [];

  get isRecording(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  get elapsedMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  static async isAvailable(): Promise<boolean> {
    if (!(await hasFfmpeg())) return false;
    // libplacebo is an optional build flag; without it there is no GPU
    // compositor and this whole path is unavailable.
    return hasFilter('libplacebo');
  }

  async start(opts: NativeRecordOptions): Promise<void> {
    if (this.proc) throw new Error('A native recording is already running.');
    if (!(await hasFfmpeg())) throw new Error('ffmpeg was not found on PATH.');

    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
    this.outputPath = opts.outputPath;

    const q = PRESETS[opts.quality];
    const args: string[] = ['-y'];

    // Is there anything to GPU-composite? With no camera and no images the
    // whole libplacebo stage is dead weight: it costs a Vulkan round-trip and
    // it is what swapped red/blue and left a black box around the cursor.
    // A plain `hwdownload,format=bgra` -> encode path is both faster and
    // visually correct (swscale converts bgra->yuv444 properly).
    const composites = Boolean(opts.camera) || (opts.images?.length ?? 0) > 0;

    // Vulkan device, shared by every libplacebo instance in the graph. Only
    // initialised when something is actually composited.
    if (composites) {
      args.push('-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk');
    }

    // --- Inputs ------------------------------------------------------------
    // [0] the desktop, via Desktop Duplication (D3D11, GPU-resident).
    //
    // `framerate` is a CEILING, not a guarantee, and that is a property of
    // Desktop Duplication rather than a bug to compensate for. DDA only hands
    // over a frame when the desktop actually changes, so the true rate is set
    // by what is on screen. Measured at framerate=120 on a 165Hz display, all
    // frames unique, no drops:
    //
    //   a static text window in front   ~20 fps
    //   an animation behind other UI    ~73 fps
    //   genuinely changing full screen  120+ fps
    //
    // Do NOT "fix" this by scaling the request up (asking for 195 to get 120).
    // The ratio that appears to justify it is just whatever happened to be on
    // screen while measuring; over-requesting only spins the capture loop
    // faster and burns GPU time re-checking for changes that have not happened.
    // When the desktop is idle nobody wants 120 recorded frames of nothing, and
    // when it is busy the requested rate is already met.
    args.push('-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=${opts.fps}`);
    let idx = 1;

    const camIdx = opts.camera ? idx++ : -1;
    if (opts.camera) {
      // Deliberately no -framerate/-video_size: webcams support a fixed set of
      // modes and dshow fails outright ("Could not set video options") when
      // asked for one they lack. A Logitech Brio, for instance, tops out at
      // 30fps while the screen may be captured at 60. Letting the camera
      // negotiate its own mode and having the filter graph reconcile the rates
      // is both more robust and works with any device.
      args.push(
        '-f', 'dshow',
        '-rtbufsize', '512M',
        '-i', `video=${opts.camera.deviceName}`,
      );
    }

    const imageIdxs: number[] = [];
    for (const img of opts.images ?? []) {
      args.push('-i', img.filePath);
      imageIdxs.push(idx++);
    }

    const micIdx = opts.micDeviceName ? idx++ : -1;
    if (opts.micDeviceName) {
      args.push('-f', 'dshow', '-rtbufsize', '256M', '-i', `audio=${opts.micDeviceName}`);
    }

    // --- Filter graph ------------------------------------------------------
    // Output geometry. libplacebo composites at a fixed canvas size, so every
    // layer is positioned against these dimensions.
    const outH = opts.height ?? 0;
    // Resolved after the first frame when scaling is off; ddagrab reports the
    // true desktop size, so use a sensible default and let scale fix it up.
    const canvasW = outH ? Math.round((outH * 16) / 9) : 2560;
    const canvasH = outH || 1440;

    const chains: string[] = [];
    const layers: string[] = [];

    // Base layer. hwdownload/hwupload bridges D3D11 to Vulkan — there is no
    // zero-copy path between them, but this is a straight memcpy rather than
    // CPU blending, which is why it keeps up where `overlay` did not.
    //
    // ddagrab's D3D11 surface downloads as BGRA (that exact format is required
    // here — `hwdownload,format=rgba` errors out). But libplacebo then treats
    // the channels as RGBA, which swaps red and blue: the desktop came out
    // sickly yellow-green and red UI turned blue. Converting BGRA→RGBA before
    // the hwupload puts the channels in the order libplacebo expects, so
    // colours are faithful.
    //
    // That BGRA→RGBA step is ALSO what mishandled the alpha of ddagrab's
    // composited hardware cursor and left a black box beside it — so it is
    // applied only on the libplacebo path, which is the only place it is
    // needed. Screen-only takes skip it and come out clean.
    const scaleStep = outH ? `,scale=-2:${outH}:flags=lanczos` : '';
    if (composites) {
      chains.push(`[0:v]hwdownload,format=bgra${scaleStep},format=rgba,hwupload[bg]`);
      layers.push('[bg]');
    }

    // Each overlay needs its OWN libplacebo instance to position it. Putting
    // pos_* on the multi-input instance would transform the base layer too.
    if (opts.camera && camIdx >= 0) {
      const r = opts.camera.rect;
      const px = Math.round(r.x * canvasW);
      const py = Math.round(r.y * canvasH);
      const pw = Math.round(r.w * canvasW);
      const ph = Math.round(r.h * canvasH);
      const mirror = opts.camera.mirrored ? 'hflip,' : '';
      // NO `fps=` here, deliberately.
      //
      // Resampling the webcam up to the output rate looks harmless but is
      // catastrophic: it makes the camera branch the slow one, and libplacebo's
      // multi-input blend then paces the WHOLE graph off it. Measured at
      // 1440p120 with a 30fps webcam, `fps=120` on this input collapsed the
      // recording to 6.5 genuinely-unique frames per second; removing it gave
      // 65.5 — a 10x difference, from one filter. The file still reported its
      // nominal 120fps either way, because ddagrab pads the gaps with duplicate
      // frames, which is what made this so hard to see.
      //
      // Instead the camera runs at its own native rate and libplacebo's blend
      // reuses its most recent frame between updates, so the screen is never
      // held back by the webcam.
      chains.push(
        `[${camIdx}:v]${mirror}format=yuva420p,hwupload,` +
          `libplacebo@cam=w=${canvasW}:h=${canvasH}:fit_mode=none:` +
          `pos_x=${px}:pos_y=${py}:pos_w=${pw}:pos_h=${ph}:` +
          `corner_rounding=${opts.camera.cornerRounding}:fillcolor=black@0[cam]`,
      );
      layers.push('[cam]');
    }

    (opts.images ?? []).forEach((img, i) => {
      const inputIdx = imageIdxs[i];
      const r = img.rect;
      const px = Math.round(r.x * canvasW);
      const py = Math.round(r.y * canvasH);
      const pw = Math.round(r.w * canvasW);
      const ph = Math.round(r.h * canvasH);
      chains.push(
        `[${inputIdx}:v]format=yuva420p,hwupload,` +
          `libplacebo@img${i}=w=${canvasW}:h=${canvasH}:fit_mode=none:` +
          `pos_x=${px}:pos_y=${py}:pos_w=${pw}:pos_h=${ph}:fillcolor=black@0[img${i}]`,
      );
      layers.push(`[img${i}]`);
    });

    if (composites) {
      // Final blend. Everything above is already GPU-resident.
      chains.push(
        `${layers.join('')}libplacebo=inputs=${layers.length}:` +
          `w=${canvasW}:h=${canvasH}:fit_mode=fill:format=${q.pixFmt}[out]`,
      );
    } else {
      // Nothing to composite: straight off the GPU and into the encoder. No
      // Vulkan, no rgba round-trip — correct colours and a clean cursor.
      chains.push(`[0:v]hwdownload,format=bgra${scaleStep},format=${q.pixFmt}[out]`);
    }

    args.push('-filter_complex', chains.join(';'), '-map', '[out]');

    // --- Encode ------------------------------------------------------------
    // Prefer NVENC. x264 at 4:4:4 needs the whole CPU at 1440p120 (measured
    // 143fps on 24 threads, 94fps on 4), and the renderer competes for those
    // same threads during a take — which is what turned 120fps recordings into
    // ~20-30 genuinely-unique frames per second. NVENC encodes on the GPU and
    // hands the CPU back to the preview. Quality is unchanged: high444p keeps
    // full 4:4:4 chroma, and CQ is the same rate-control idea as CRF.
    const useNvenc = await hasNvenc444();
    if (useNvenc) {
      args.push(
        '-c:v', 'h264_nvenc',
        // 4:2:0 only for the 'compact' preset, matching x264's behaviour.
        '-profile:v', q.pixFmt === 'yuv420p' ? 'high' : 'high444p',
        '-preset', 'p4',
        '-tune', 'hq',
        '-rc', 'vbr',
        '-cq', q.crf,
        // No cap: CQ decides the bitrate. A maxrate here would defeat it.
        '-b:v', '0',
        '-pix_fmt', q.pixFmt,
        '-g', String(opts.fps * 2),
        '-movflags', '+faststart',
      );
    } else {
      // No hardware encoder: fall back to x264, but pick a speed preset this
      // CPU can sustain. A preset that cannot keep up does not degrade
      // gracefully — ddagrab pads the gaps with duplicate frames and the take
      // silently judders while still claiming its nominal frame rate.
      args.push(
        '-c:v', 'libx264',
        '-preset', x264PresetFor(canvasW, canvasH, opts.fps, q.preset),
        '-crf', q.crf,
        '-pix_fmt', q.pixFmt,
        // Two-second GOP: keeps seeking responsive in editors.
        '-g', String(opts.fps * 2),
        '-movflags', '+faststart',
      );
    }

    if (micIdx >= 0) {
      args.push('-map', `${micIdx}:a`, '-c:a', 'aac', '-b:a', '192k');
    }

    args.push(opts.outputPath);

    this.proc = spawn('ffmpeg', args, { windowsHide: true });
    this.startedAt = Date.now();
    this.stderrTail = [];

    this.proc.stderr?.on('data', (d: Buffer) => {
      this.stderrTail.push(String(d));
      if (this.stderrTail.length > 60) this.stderrTail.shift();
    });

    this.proc.on('error', () => {
      this.proc = null;
    });

    // Surface an immediate failure (bad device, missing filter) rather than
    // letting the caller believe recording is under way.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1800);
      this.proc?.once('close', (code) => {
        clearTimeout(timer);
        this.proc = null;
        reject(new Error(explainFailure(this.stderrTail.join(''), code)));
      });
    });
  }

  /**
   * Stop cleanly. `q` on stdin asks ffmpeg to finalise the container; killing
   * the process would leave an unplayable file with no moov atom.
   *
   * The SIGKILL fallback is generous on purpose. Every take used to end with a
   * 275-558ms stall that swallowed the last 25-67 frames: the encoder was still
   * draining its queue when the process was torn down. Giving ffmpeg room to
   * flush is what makes the final second of a recording usable.
   */
  async stop(): Promise<string> {
    const proc = this.proc;
    if (!proc) throw new Error('No native recording is running.');

    const done = new Promise<void>((resolve) => {
      proc.once('close', () => resolve());
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
        resolve();
      }, 15000);
    });

    try {
      proc.stdin?.write('q');
      proc.stdin?.end();
    } catch {
      proc.kill();
    }

    await done;
    this.proc = null;
    this.startedAt = 0;
    return this.outputPath;
  }

  async cancel(): Promise<void> {
    if (!this.proc) return;
    const file = this.outputPath;
    try {
      await this.stop();
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Turn ffmpeg's output into something a user can act on. Its stderr is a wall
 * of version banners and stream metadata, and the one useful line is usually
 * buried hundreds of characters in.
 */
function explainFailure(stderr: string, code: number | null): string {
  if (/Could not set video options/i.test(stderr)) {
    return 'The webcam rejected the requested mode. It may not support this frame rate — try 30 fps, or close any other app using the camera.';
  }
  if (/Could not set audio options|Error opening input.*audio=/i.test(stderr)) {
    return 'The microphone could not be opened. Another app may be using it exclusively.';
  }
  if (/I\/O error/i.test(stderr) && /video=/i.test(stderr)) {
    return 'The webcam could not be opened. It may be in use by another app.';
  }
  if (/Device or resource busy|Device in use/i.test(stderr)) {
    return 'A capture device is already in use by another application.';
  }
  if (/No such (file or )?device|Cannot find a device/i.test(stderr)) {
    return 'A selected device is no longer connected. Re-pick it in the menu.';
  }
  if (/Vulkan|libplacebo/i.test(stderr) && /error|failed|not (found|supported)/i.test(stderr)) {
    return 'GPU compositing failed to initialise. Updating your graphics driver usually fixes this.';
  }
  if (/ddagrab|Desktop Duplication/i.test(stderr) && /error|failed/i.test(stderr)) {
    return 'Screen capture failed to start. This can happen on a locked screen or during a display change.';
  }
  // Fall back to the last meaningful line rather than the whole banner.
  const lastLine =
    stderr
      .split(/\r?\n/)
      .filter((l) => /error|failed|invalid|unable/i.test(l))
      .pop()
      ?.trim() ?? '';
  return lastLine
    ? `Recording could not start: ${lastLine}`
    : `Recording could not start (ffmpeg exit ${code}).`;
}

/** Is a given ffmpeg filter compiled into this build? */
function hasFilter(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-filters'], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => resolve(false));
    proc.on('close', () => resolve(new RegExp(`\\b${name}\\b`).test(out)));
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 5000);
  });
}

/** dshow device names — ffmpeg addresses devices by name, not by id. */
export async function listDshowDevices(): Promise<{ audio: string[]; video: string[] }> {
  return new Promise((resolve) => {
    const proc = spawn(
      'ffmpeg',
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { windowsHide: true },
    );
    let out = '';
    proc.stderr.on('data', (d) => (out += d));
    proc.on('error', () => resolve({ audio: [], video: [] }));
    proc.on('close', () => {
      const audio: string[] = [];
      const video: string[] = [];
      // Lines look like:  [dshow @ ...] "Brio 100" (video)
      const re = /"([^"]+)"\s*\((audio|video)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(out))) {
        (m[2] === 'audio' ? audio : video).push(m[1]);
      }
      resolve({
        audio: [...new Set(audio)],
        video: [...new Set(video)],
      });
    });
    setTimeout(() => {
      proc.kill();
      resolve({ audio: [], video: [] });
    }, 6000);
  });
}

/** Back-compat helper for callers that only need microphones. */
export async function listDshowAudioDevices(): Promise<string[]> {
  return (await listDshowDevices()).audio;
}
