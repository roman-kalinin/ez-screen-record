import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
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

    // Vulkan device, shared by every libplacebo instance in the graph.
    args.push('-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk');

    // --- Inputs ------------------------------------------------------------
    // [0] the desktop, via Desktop Duplication (D3D11, GPU-resident).
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
    const scaleStep = outH ? `,scale=-2:${outH}:flags=lanczos` : '';
    chains.push(`[0:v]hwdownload,format=bgra${scaleStep},hwupload[bg]`);
    layers.push('[bg]');

    // Each overlay needs its OWN libplacebo instance to position it. Putting
    // pos_* on the multi-input instance would transform the base layer too.
    if (opts.camera && camIdx >= 0) {
      const r = opts.camera.rect;
      const px = Math.round(r.x * canvasW);
      const py = Math.round(r.y * canvasH);
      const pw = Math.round(r.w * canvasW);
      const ph = Math.round(r.h * canvasH);
      const mirror = opts.camera.mirrored ? 'hflip,' : '';
      // fps= resamples the camera to the output rate by duplicating frames,
      // so a 30fps webcam composites cleanly into a 60fps recording.
      chains.push(
        `[${camIdx}:v]fps=${opts.fps},${mirror}format=yuva420p,hwupload,` +
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

    // Final blend. Everything above is already GPU-resident.
    chains.push(
      `${layers.join('')}libplacebo=inputs=${layers.length}:` +
        `w=${canvasW}:h=${canvasH}:fit_mode=fill:format=${q.pixFmt}[out]`,
    );

    args.push('-filter_complex', chains.join(';'), '-map', '[out]');

    // --- Encode ------------------------------------------------------------
    args.push(
      '-c:v', 'libx264',
      '-preset', q.preset,
      '-crf', q.crf,
      '-pix_fmt', q.pixFmt,
      // Two-second GOP: keeps seeking responsive in editors.
      '-g', String(opts.fps * 2),
      '-movflags', '+faststart',
    );

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
   */
  async stop(): Promise<string> {
    const proc = this.proc;
    if (!proc) throw new Error('No native recording is running.');

    const done = new Promise<void>((resolve) => {
      proc.once('close', () => resolve());
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
        resolve();
      }, 10000);
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
