import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasFfmpeg, ffmpegPath } from './remux';
import { SystemAudioHelper } from './system-audio';
import {
  CAPTURE_IS_HW,
  CAPTURE_PIX_FMT,
  IS_MAC,
  MAX_HW_PIX_FMT,
  cameraInputArgs,
  hardwareEncoder,
  micInputArgs,
  screenInputArgs,
} from './capture-backend';

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
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-h', 'encoder=h264_nvenc'], {
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
  /**
   * Which display to capture, in the platform's own terms: a ddagrab output
   * index on Windows, an avfoundation device index on macOS.
   */
  displayId?: number;
  /** Output height; omitted keeps the capture's native size. */
  height?: number;
  quality: QualityPreset;
  micDeviceName?: string | null;
  /**
   * Capture desktop (system) audio via the WASAPI loopback helper and mux it
   * into the finished file. Windows only; ffmpeg has no loopback input of its
   * own. See system-audio.ts.
   */
  systemAudioEnabled?: boolean;
  camera?: NativeCameraOptions | null;
  /** Absolute paths to PNG/JPEG overlays, with their placement. */
  images?: Array<{ filePath: string; rect: NativeRect; opacity: number }>;
}

/**
 * Backstop for "did ffmpeg start?", only reached when no frame is ever
 * reported. Measured: `Output #0` at ~200ms, but the first NON-ZERO frame
 * count at ~2180ms on a 1440p ddagrab path — so this has to sit comfortably
 * above that, or a healthy-but-slow start would be declared ready before it
 * was.
 */
const START_TIMEOUT_MS = 4000;

// CRF and chroma per quality preset. Lower CRF = higher quality, bigger files.
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

/**
 * Target bitrate in Mbps for a bitrate-controlled encoder (VideoToolbox).
 *
 * CRF/CQ encoders pick their own bitrate from a quality target; VideoToolbox
 * has no true constant-quality mode for H.264, so the rate has to be chosen
 * explicitly. Scaled by pixel rate so 4K120 is not starved at the same number
 * that suits 1080p30.
 *
 * Deliberately generous. The macOS path already gives up 4:4:4 chroma, which is
 * the thing that keeps small coloured text sharp; spending bitrate is the only
 * compensation available, and a screen recording that smears during a scroll is
 * worse than a large file.
 */
function bitrateFor(
  width: number,
  height: number,
  fps: number,
  quality: QualityPreset,
): number {
  // Bits per pixel per frame, tuned for screen content (sharp edges, large flat
  // areas) rather than camera footage, which tolerates far less.
  const bpp = quality === 'high' ? 0.13 : quality === 'balanced' ? 0.09 : 0.06;
  const mbps = (width * height * fps * bpp) / 1_000_000;
  // Floor keeps small/low-fps takes from looking soft; ceiling avoids files
  // nothing will play smoothly.
  return Math.round(Math.min(Math.max(mbps, 8), 200));
}

export class NativeRecorder {
  private proc: ChildProcess | null = null;
  private outputPath = '';
  private startedAt = 0;
  private stderrTail: string[] = [];
  /** Set when EZ_FFMPEG_DEBUG is on; full stderr is mirrored here. */
  private debugLog = '';

  /**
   * Pause is implemented by SPLITTING THE TAKE INTO SEGMENTS.
   *
   * ffmpeg has no pause: it is a pipe, and there is no signal that suspends
   * capture without also breaking the container. SIGSTOP looks right and is
   * not — the muxer keeps the wall-clock timestamps it had already queued, so
   * the paused span reappears in the output as a frozen frame of exactly that
   * duration, and the audio drifts by the same amount for the rest of the take.
   *
   * So each pause finalises the current segment (`q` on stdin, the same clean
   * shutdown stop uses, which is what gives it a moov atom) and each resume
   * spawns a fresh ffmpeg writing the next one. Stop concatenates them with
   * the concat demuxer and `-c copy`: a stream copy, so it is lossless and
   * effectively instant. The paused span genuinely does not exist in the
   * output rather than being encoded and cut later.
   *
   * These mirror the WinUI port's Recorder.PauseAsync/ResumeAsync, which
   * solved the same problem the same way.
   */
  private segments: string[] = [];
  private currentSegment = '';
  /** Monotonic segment counter; drives the .partN suffix. */
  private segmentSeq = 0;
  private resumeOpts: NativeRecordOptions | null = null;
  private pausedAt = 0;
  private pausedTotal = 0;
  /** Desktop-audio loopback capture, when systemAudioEnabled (Windows only). */
  private systemAudio: SystemAudioHelper | null = null;

  get isRecording(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  get isPaused(): boolean {
    return this.pausedAt !== 0;
  }

  /** Wall-clock since start, MINUS every paused span. */
  get elapsedMs(): number {
    if (!this.startedAt) return 0;
    const now = this.pausedAt || Date.now();
    return now - this.startedAt - this.pausedTotal;
  }

  /**
   * `take.mp4` -> `take.partN.mp4`, beside the real output.
   *
   * EVERY segment gets its own file, including the first.
   *
   * Segment one used to be written straight to `outputPath`, which made the
   * join read and overwrite the same file: `-f concat -i list.txt -c copy
   * out.mp4` truncated its own first input, and an 11.6s take collapsed to
   * the 0.46s that survived the race. The output path is now purely a
   * destination that nothing records into.
   */
  private nextSegmentPath(): string {
    const ext = path.extname(this.outputPath);
    const base = this.outputPath.slice(0, -ext.length);
    return `${base}.part${++this.segmentSeq}${ext}`;
  }

  /**
   * Change inputs mid-take: a different monitor, a different microphone.
   *
   * ffmpeg's inputs are fixed when the process is spawned -- there is no way
   * to hand it a new device on a running graph. So this reuses the pause
   * machinery: finalise the current segment, respawn with the new options,
   * and let stop() concatenate. The seam costs the ~2s ffmpeg needs to come
   * up, which is why the caller shows a transitional state rather than
   * pretending the swap is instant.
   *
   * The take is NOT paused around this: pausedTotal is untouched, so the
   * elapsed clock keeps running across the swap the way a viewer expects.
   *
   * On failure the old segment is already closed and cannot be reopened, so
   * the recorder is left paused rather than silently dead -- the caller can
   * resume (retrying with the previous options) or stop and keep what exists.
   */
  async reconfigure(patch: Partial<NativeRecordOptions>): Promise<void> {
    if (!this.proc || this.isPaused) throw new Error('No native recording is running.');
    if (!this.resumeOpts) throw new Error('No native recording is running.');

    const finished = this.currentSegment;
    await this.stopProcess();
    this.segments.push(finished);

    const nextOpts = { ...this.resumeOpts, ...patch };
    const next = this.nextSegmentPath();
    try {
      await this.spawnFfmpeg({ ...nextOpts, outputPath: next });
    } catch (err) {
      // Leave it held rather than half-dead; the finished segments are safe.
      this.pausedAt = Date.now();
      try {
        if (fs.existsSync(next)) fs.unlinkSync(next);
      } catch {
        /* best effort */
      }
      throw err;
    }

    // Only once the respawn worked do the new options become the ones a
    // later resume would use.
    this.resumeOpts = nextOpts;
    this.currentSegment = next;
  }

  async pause(): Promise<void> {
    if (!this.proc || this.isPaused) throw new Error('No native recording is running.');

    // Finish the segment properly so it can be concatenated; killing the
    // process would leave an unplayable fragment with no moov atom.
    const finished = this.currentSegment || this.outputPath;
    await this.stopProcess();

    // Drop the same span from the audio: stop appending without finalising so
    // the single WAV stays exactly as long as the concatenated video.
    this.systemAudio?.pause();

    this.segments.push(finished);
    this.pausedAt = Date.now();
  }

  async resume(): Promise<void> {
    if (!this.isPaused || !this.resumeOpts) throw new Error('The recording is not paused.');

    const next = this.nextSegmentPath();
    try {
      await this.spawnFfmpeg({ ...this.resumeOpts, outputPath: next });
    } catch (err) {
      // Stay paused and leave the clock untouched. Crediting the pause before
      // knowing the restart worked meant a failed resume followed by a
      // successful one counted the same span twice, and a pause longer than
      // the footage drove elapsed negative.
      try {
        if (fs.existsSync(next)) fs.unlinkSync(next);
      } catch {
        /* best effort */
      }
      throw err;
    }

    // Only resume audio once the video respawn actually worked, mirroring the
    // clock accounting below — a failed resume must not append an audio span
    // that has no matching video segment.
    this.systemAudio?.resume();

    this.pausedTotal += Date.now() - this.pausedAt;
    this.pausedAt = 0;
    this.currentSegment = next;
  }

  /**
   * Join the segments into the real output with the concat demuxer.
   * `-c copy` is a stream copy: no re-encode, so it is lossless and fast.
   *
   * The demuxer is NOT guaranteed to be present. The bundled ffmpeg is built
   * `--disable-everything` with an explicit enable list, and `concat` was not
   * on it (tools/build-ffmpeg-slim.sh now adds it, but an already-installed
   * copy predates that). There is no fallback worth having: this build also
   * lacks the concat FILTER, and the raw-elementary-stream trick cannot carry
   * the microphone because the `adts` muxer is missing too.
   *
   * So when the join is impossible, the SEGMENTS ARE KEPT and the caller is
   * told. Losing a take to a missing muxer would be far worse than handing
   * back two playable files.
   */
  private async concatSegments(parts: string[]): Promise<void> {
    const joiner = await concatCapableFfmpeg();
    if (!joiner) {
      throw new Error(
        `No available ffmpeg can join paused segments, so the take was left as ` +
          `${parts.length} separate files next to the output:\n` +
          parts.map((p) => path.basename(p)).join('\n') +
          `\n\nThey are playable as-is. Install a full ffmpeg, or rebuild the ` +
          `bundled one with --enable-demuxer=concat (tools/build-ffmpeg-slim.sh).`,
      );
    }

    const listPath = `${this.outputPath}.concat.txt`;
    // The concat demuxer resolves relative paths against the list file, and
    // treats `'` specially — quote and escape rather than interpolating raw.
    const body = parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, body, 'utf8');

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(
          joiner,
          ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
            '-c', 'copy', this.outputPath],
          { windowsHide: true },
        );
        let err = '';
        proc.stderr?.on('data', (d: Buffer) => (err += String(d)));
        proc.on('error', reject);
        proc.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(explainFailure(err, code))),
        );
      });
    } catch (err) {
      // Leave the pieces on disk -- they are the whole take.
      try {
        fs.unlinkSync(listPath);
      } catch {
        /* best effort */
      }
      throw err;
    }

    // Only once the join succeeded is it safe to drop the pieces.
    try {
      fs.unlinkSync(listPath);
    } catch {
      /* best effort */
    }
    for (const p of parts) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* best effort */
      }
    }
  }

  static async isAvailable(): Promise<boolean> {
    if (!(await hasFfmpeg())) return false;
    // libplacebo is an optional build flag; without it there is no GPU
    // compositor. That only disables COMPOSITING (camera and image overlays),
    // not capture itself — a screen-only take never enters the Vulkan path.
    //
    // This matters on macOS, where Vulkan runs through MoltenVK and many ffmpeg
    // builds ship without libplacebo at all. Gating the whole engine on it
    // would disable recording entirely on those machines for a filter that a
    // plain screen capture never uses.
    return true;
  }

  /**
   * Can a take be paused and still come back as ONE file?
   *
   * Pause splits the take into segments, and joining them needs the concat
   * demuxer. Without it the pieces cannot be recombined at all, so the button
   * is hidden rather than offered — a pause that silently fragments the
   * recording is worse than no pause.
   */
  static async canPause(): Promise<boolean> {
    if (!(await hasFfmpeg())) return false;
    return hasConcatDemuxer();
  }

  async start(opts: NativeRecordOptions): Promise<void> {
    if (this.proc) throw new Error('A native recording is already running.');

    this.outputPath = opts.outputPath;
    this.segments = [];
    this.segmentSeq = 0;
    // Kept so resume can respawn with identical settings.
    this.resumeOpts = opts;
    // Cleared so spawnFfmpeg stamps a fresh start; a leftover value from an
    // earlier take would make the new one begin mid-clock.
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.systemAudio = null;

    // Start desktop-audio capture BEFORE ffmpeg, so sound is already recording
    // when the first video frame lands. Best-effort: a missing or failing
    // helper must never stop a take from starting — it just means no system
    // audio in the file.
    if (opts.systemAudioEnabled) {
      const helper = new SystemAudioHelper();
      try {
        await helper.start();
        this.systemAudio = helper;
      } catch (err) {
        this.systemAudio = null;
        console.warn('[native-recorder] system audio unavailable, continuing without it', err);
      }
    }

    // Record into part1, NOT into outputPath -- see nextSegmentPath.
    this.currentSegment = this.nextSegmentPath();
    try {
      await this.spawnFfmpeg({ ...opts, outputPath: this.currentSegment });
    } catch (err) {
      // ffmpeg failed to come up — don't leave the audio helper capturing.
      await this.systemAudio?.discard();
      this.systemAudio = null;
      throw err;
    }
    // Stamped INSIDE spawnFfmpeg, at the moment the process was launched --
    // not here, after the readiness wait. Setting it afterwards discarded the
    // whole startup period, so the timer under-reported every take by however
    // long ffmpeg took to come up.
  }

  /**
   * Build the graph and spawn ffmpeg for ONE segment.
   *
   * Split out of `start` so `resume` produces a byte-identical pipeline for
   * the next segment — the concat demuxer requires matching codec parameters
   * across the pieces, so rebuilding the arguments any other way would risk
   * segments that refuse to join.
   */
  private async spawnFfmpeg(opts: NativeRecordOptions): Promise<void> {
    if (!(await hasFfmpeg())) {
      throw new Error(
        IS_MAC
          ? 'ffmpeg was not found. Install it (brew install ffmpeg) or place the ffmpeg binary in the app’s resources/ffmpeg folder.'
          : 'ffmpeg was not found. Install a full ffmpeg build (winget install Gyan.FFmpeg) or place ffmpeg.exe in the app’s resources/ffmpeg folder.',
      );
    }

    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });

    const preset = PRESETS[opts.quality];

    // Resolve the encoder BEFORE building the filter graph.
    //
    // The graph's final `format=` has to match what the encoder accepts. When
    // VideoToolbox clamps 4:4:4 down to 4:2:0 but the graph still hands it
    // yuv444p, ffmpeg fails on the format mismatch — so the chroma decision has
    // to be made once, here, and used by both halves.
    const macEncoder = IS_MAC ? await hardwareEncoder() : null;
    const useNvenc = !IS_MAC && (await hasNvenc444());

    const q = {
      ...preset,
      // VideoToolbox H.264 has no 4:4:4 mode at all on macOS.
      pixFmt: macEncoder && preset.pixFmt === 'yuv444p' ? MAX_HW_PIX_FMT : preset.pixFmt,
    };

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
    args.push(...screenInputArgs(opts.fps, opts.displayId ?? 0));
    let idx = 1;

    const camIdx = opts.camera ? idx++ : -1;
    if (opts.camera) {
      // Deliberately no -framerate/-video_size: webcams support a fixed set of
      // modes and dshow fails outright ("Could not set video options") when
      // asked for one they lack. A Logitech Brio, for instance, tops out at
      // 30fps while the screen may be captured at 60. Letting the camera
      // negotiate its own mode and having the filter graph reconcile the rates
      // is both more robust and works with any device.
      args.push(...cameraInputArgs(opts.camera.deviceName));
    }

    const imageIdxs: number[] = [];
    for (const img of opts.images ?? []) {
      args.push('-i', img.filePath);
      imageIdxs.push(idx++);
    }

    const micIdx = opts.micDeviceName ? idx++ : -1;
    if (opts.micDeviceName) {
      // On Windows this carries `-audio_buffer_size 50`, which is worth more
      // than it looks: dshow's default buffer is large enough that each refill
      // blocked the capture path and stalled VIDEO in a regular rhythm —
      // recordings had a ~300ms freeze roughly every half second, for their
      // whole length.
      //
      // Measured at 1440p120, same machine, same moment, mic the only
      // difference:
      //   no mic                       70fps,  10 drops,  2 stalls
      //   mic, default buffer          38fps, 194 drops, 27 stalls
      //   mic, audio_buffer_size 50    81fps,  14 drops,  2 stalls
      //
      // `-thread_queue_size` barely helped (27 -> 23), because the queue was
      // never the constraint; the buffer refill was.
      args.push(...micInputArgs(opts.micDeviceName));
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
    // ddagrab hands over a D3D11 texture, so it must come off the GPU before any
    // CPU filter can touch it. avfoundation already delivers system-memory
    // frames — asking to download one that was never uploaded is a hard error,
    // so the step is omitted entirely rather than made conditional inside the
    // graph.
    const download = CAPTURE_IS_HW ? `hwdownload,format=${CAPTURE_PIX_FMT}` : `format=${CAPTURE_PIX_FMT}`;
    if (composites) {
      chains.push(`[0:v]${download}${scaleStep},format=rgba,hwupload[bg]`);
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
    } else if (CAPTURE_IS_HW) {
      // Windows: ddagrab hands over a D3D11 texture. Download it, then scale.
      // No Vulkan, no rgba round-trip — correct colours and a clean cursor.
      chains.push(`[0:v]${download}${scaleStep},format=${q.pixFmt}[out]`);
    } else {
      // macOS: avfoundation already delivers system-memory frames, typically at
      // a large Retina backing size, and every filter here runs on the CPU per
      // frame. Two changes cut the stutter:
      //   * ONE swscale pass — the old `format=bgra` intermediate was a whole
      //     extra full-frame conversion before the final `format=yuv420p`.
      //   * `bilinear` instead of `lanczos` when downscaling: lanczos is far
      //     heavier and the difference is invisible on a live screen grab.
      const macScale = outH ? `scale=-2:${outH}:flags=bilinear,` : '';
      chains.push(`[0:v]${macScale}format=${q.pixFmt}[out]`);
    }

    args.push('-filter_complex', chains.join(';'), '-map', '[out]');

    // --- Encode ------------------------------------------------------------
    // Prefer NVENC. x264 at 4:4:4 needs the whole CPU at 1440p120 (measured
    // 143fps on 24 threads, 94fps on 4), and the renderer competes for those
    // same threads during a take — which is what turned 120fps recordings into
    // ~20-30 genuinely-unique frames per second. NVENC encodes on the GPU and
    // hands the CPU back to the preview. Quality is unchanged: high444p keeps
    // full 4:4:4 chroma, and CQ is the same rate-control idea as CRF.
    if (macEncoder) {
      // VideoToolbox: Apple's hardware encoder, present on every Mac. It is
      // **4:2:0 only** — there is no 4:4:4 H.264 path on macOS at all, so the
      // Windows "visually lossless full chroma" promise cannot be kept here.
      // `q.pixFmt` was already clamped above, so the graph and the encoder
      // agree.
      //
      // Chroma is where screen-content quality is won or lost, and 4:2:0 has
      // already given away three quarters of it. Bitrate is the only lever
      // left, so it is set generously — scaled by pixel rate rather than fixed,
      // since a 4K120 take needs far more than 1080p30 to look the same.
      const mbps = bitrateFor(canvasW, canvasH, opts.fps, opts.quality);

      args.push(
        '-c:v', 'h264_videotoolbox',
        // This is a LIVE screen grab, so the encoder must keep pace with the
        // capture rather than fall behind and buffer — the default lets it
        // queue frames, which is exactly the stutter seen on Macs. `realtime`
        // trades a little quality for pace only when it can't otherwise keep
        // up; `prio_speed` biases the same way. Together they are the single
        // biggest fix for VideoToolbox lag during capture.
        '-realtime', 'true',
        '-prio_speed', 'true',
        '-b:v', `${mbps}M`,
        // Ceiling well above the target: screen content is mostly static and
        // then changes all at once, and a tight cap smears exactly those
        // moments (scrolling text, window switches).
        '-maxrate', `${Math.round(mbps * 1.5)}M`,
        '-bufsize', `${mbps * 2}M`,
        // Let the encoder use as much quality as the bitrate allows.
        '-profile:v', 'high',
        '-pix_fmt', q.pixFmt,
        '-g', String(opts.fps * 2),
        '-movflags', '+faststart',
      );
    } else if (useNvenc) {
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

    if (process.env.EZ_FFMPEG_DEBUG) {
      const logPath = path.join(path.dirname(opts.outputPath), 'ffmpeg-debug.log');
      try {
        fs.appendFileSync(
          logPath,
          `\n\n===== ${new Date().toISOString()} =====\n${ffmpegPath()} ${args.join(' ')}\n`,
        );
        this.debugLog = logPath;
      } catch {
        /* best effort */
      }
    }

    this.proc = spawn(ffmpegPath(), args, { windowsHide: true });
    this.stderrTail = [];
    // Only on the FIRST segment: a resume must not restart the clock.
    if (!this.startedAt) this.startedAt = Date.now();

    // Resolve as soon as ffmpeg PROVES it is encoding, not after a fixed wait.
    //
    // This used to be a flat `setTimeout(resolve, 1800)`, which made every
    // start -- and every resume, which comes back through here -- cost 1.8s of
    // dead time before the UI was told anything. The clock therefore sat at
    // 00:00 while capture was already running, and the first ~1.8s of every
    // take was missing from the timer.
    //
    // Readiness is a NON-ZERO frame count and nothing else. Measured on the
    // 1440p ddagrab path: "Output #0" at ~200ms, first real frame at ~2180ms.
    //
    // The timeout stays as a BACKSTOP only: some configurations buffer stderr
    // differently, and a take that is genuinely running must not be refused
    // just because the expected line never showed up.
    let sawProgress: (() => void) | null = null;

    this.proc.stderr?.on('data', (d: Buffer) => {
      const chunk = String(d);
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 60) this.stderrTail.shift();
      if (this.debugLog) {
        try {
          fs.appendFileSync(this.debugLog, chunk);
        } catch {
          /* best effort */
        }
      }
      // A NON-ZERO frame count is the only honest proof that capture is
      // running.
      //
      // `Output #0` was tried here and is wrong: ffmpeg prints it while still
      // opening devices -- measured at 99ms, against 1620ms for the first real
      // frame. Treating it as readiness let start() return before ddagrab had
      // produced anything.
      //
      // `frame=    0` is equally untrustworthy: ffmpeg emits progress lines on
      // a timer from the moment encoding begins, and the first two carried a
      // zero count.
      const m = /frame=\s*(\d+)/.exec(chunk);
      if (sawProgress && m && Number(m[1]) > 0) sawProgress();
    });

    this.proc.on('error', () => {
      this.proc = null;
    });

    // Surface an immediate failure (bad device, missing filter) rather than
    // letting the caller believe recording is under way.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sawProgress = null;
        resolve();
      };
      const timer = setTimeout(finish, START_TIMEOUT_MS);
      sawProgress = finish;

      this.proc?.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sawProgress = null;
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
    // A paused take has no live process, but it does have finished segments
    // that still need joining — returning early here would strand them on
    // disk and lose everything recorded before the pause.
    if (!this.proc && !this.isPaused) throw new Error('No native recording is running.');

    if (this.proc) {
      await this.stopProcess();
      if (this.currentSegment) this.segments.push(this.currentSegment);
    }

    // Finalise the desktop-audio WAV before ffmpeg reads it — its header is only
    // valid once the helper has flushed and exited.
    const audioWav = this.systemAudio ? await this.systemAudio.stop() : null;
    this.systemAudio = null;

    const parts = this.segments.filter((p) => {
      try {
        return fs.statSync(p).size > 0;
      } catch {
        return false;
      }
    });

    try {
      if (parts.length === 1) {
        // A take that was never paused is ONE segment: just move it into
        // place. No ffmpeg, so an unpaused take never depends on the concat
        // demuxer being present.
        fs.renameSync(parts[0], this.outputPath);
      } else if (parts.length > 1) {
        await this.concatSegments(parts);
      }

      // Mux desktop audio into the finished video, if any was captured. Done
      // last so the video path above is unchanged whether or not audio exists —
      // a failed mux still leaves a valid, audio-less recording in place.
      if (audioWav && parts.length >= 1) {
        await this.muxSystemAudio(audioWav);
      }
    } finally {
      if (audioWav) {
        try {
          fs.unlinkSync(audioWav);
        } catch {
          /* best effort */
        }
      }
      this.segments = [];
      this.currentSegment = '';
      this.segmentSeq = 0;
      this.resumeOpts = null;
      this.startedAt = 0;
      this.pausedAt = 0;
      this.pausedTotal = 0;
    }

    return this.outputPath;
  }

  /**
   * Mux a captured desktop-audio WAV into the finished video at this.outputPath.
   *
   * The video already has its own audio only if a mic was recorded, so we mix
   * rather than replace: `amix` when a mic track is present, otherwise the WAV
   * simply becomes the audio track. Video is stream-copied (`-c:v copy`) so this
   * is a fast remux, not a re-encode.
   *
   * Best-effort: on any failure the original audio-less (or mic-only) file is
   * left in place. A recording without desktop sound beats no recording.
   */
  private async muxSystemAudio(wavPath: string): Promise<void> {
    const ext = path.extname(this.outputPath);
    const videoOnly = `${this.outputPath.slice(0, -ext.length)}.beforemux${ext}`;
    fs.renameSync(this.outputPath, videoOnly);

    // Does the finished video already carry an audio track (a mic)?
    const hasMic = Boolean(this.resumeOpts?.micDeviceName);

    const args = ['-hide_banner', '-y', '-i', videoOnly, '-i', wavPath];
    if (hasMic) {
      args.push(
        '-filter_complex',
        '[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[a]',
        '-map', '0:v:0', '-map', '[a]',
      );
    } else {
      args.push('-map', '0:v:0', '-map', '1:a:0');
    }
    args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', this.outputPath);

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(ffmpegPath(), args, { windowsHide: true });
        let err = '';
        proc.stderr?.on('data', (d: Buffer) => (err += String(d)));
        proc.on('error', reject);
        proc.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(explainFailure(err, code))),
        );
      });
      // Muxed file is in place; drop the video-only intermediate.
      try {
        fs.unlinkSync(videoOnly);
      } catch {
        /* best effort */
      }
    } catch (err) {
      // Restore the un-muxed video so the take is never lost to an audio mux.
      try {
        if (!fs.existsSync(this.outputPath)) fs.renameSync(videoOnly, this.outputPath);
        else fs.unlinkSync(videoOnly);
      } catch {
        /* best effort */
      }
      console.warn('[native-recorder] could not mux system audio; kept video without it', err);
    }
  }

  /** Ask ffmpeg to finalise the current segment and wait for it to exit. */
  private async stopProcess(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;

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
  }

  /**
   * Immediately tear down capture without finalising anything.
   *
   * macOS keeps the screen-recording indicator (and the avfoundation session)
   * alive until the ffmpeg process actually exits, so on app quit we cannot
   * rely on the graceful, async `stop()` — the process must be killed
   * synchronously and unconditionally, including when a take was left running
   * because the window was closed via the native traffic light.
   */
  dispose(): void {
    try {
      this.proc?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    this.proc = null;
    this.systemAudio?.dispose();
    this.systemAudio = null;
  }

  async cancel(): Promise<void> {
    // A paused take has no process but does have segments on disk. Returning
    // early here would leave them orphaned and the recorder stuck paused.
    if (!this.proc && !this.isPaused) return;

    const file = this.outputPath;
    const parts = [...this.segments, this.currentSegment];

    try {
      await this.stop();
    } catch {
      /* ignore */
    }
    for (const p of new Set([...parts, file])) {
      try {
        if (p && fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }

    this.segments = [];
    this.currentSegment = '';
    this.resumeOpts = null;
    this.pausedAt = 0;
    this.pausedTotal = 0;
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
  // macOS gates screen capture behind TCC. When permission is missing the
  // failure is opaque — an input-open error naming the avfoundation device,
  // with nothing about permissions — so it is worth translating.
  if (IS_MAC && /avfoundation/i.test(stderr) && /error|failed|denied|cannot open/i.test(stderr)) {
    if (/audio/i.test(stderr) && !/video/i.test(stderr)) {
      return 'The microphone could not be opened. Grant Microphone access in System Settings › Privacy & Security, then restart the app.';
    }
    return 'Screen capture could not start. Grant Screen Recording access in System Settings › Privacy & Security, then restart the app — macOS only applies this permission on a fresh launch.';
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

/** Does the ffmpeg at `bin` have the concat demuxer compiled in? */
function probeConcat(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const proc = spawn(bin, ['-hide_banner', '-demuxers'], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => done(false));
    // Match the listing's own column layout ("  D   concat"), so a stray
    // mention of the word elsewhere in the output cannot pass for support.
    proc.on('close', () => done(/^\s*D\s+concat\s/m.test(out)));
    setTimeout(() => {
      proc.kill();
      done(false);
    }, 5000);
  });
}

/**
 * An ffmpeg that can join segments, or null if there is none.
 *
 * The BUNDLED binary is deliberately slim (`--disable-everything` plus an
 * enable list) and shipped without the concat demuxer, so joining a paused
 * take can need a different binary than capturing it did. That split is safe:
 * capture needs ddagrab/libplacebo/nvenc and must stay on the bundled build,
 * but the join is a plain stream copy that any stock ffmpeg performs
 * identically.
 *
 * Cached — probed on every stop of a paused take, and the answer cannot
 * change while the app is running.
 */
let concatBin: string | null | undefined;
async function concatCapableFfmpeg(): Promise<string | null> {
  if (concatBin !== undefined) return concatBin;

  const candidates = [ffmpegPath()];
  // A PATH ffmpeg is worth trying only when it is not the one already checked.
  if (ffmpegPath() !== 'ffmpeg') candidates.push('ffmpeg');

  for (const bin of candidates) {
    if (await probeConcat(bin)) {
      concatBin = bin;
      return concatBin;
    }
  }
  concatBin = null;
  return concatBin;
}

function hasConcatDemuxer(): Promise<boolean> {
  return concatCapableFfmpeg().then((b) => b !== null);
}

/** Is a given ffmpeg filter compiled into this build? */
function hasFilter(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-filters'], { windowsHide: true });
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

/**
 * Capture devices as ffmpeg addresses them.
 *
 * The identifier is what must be handed back to the recorder, and it differs by
 * platform: dshow addresses devices by NAME, avfoundation by INDEX. Callers
 * must treat `id` as opaque and never assume it is one or the other.
 */
export interface CaptureDevice {
  /** What to pass to the recorder: a dshow name, or an avfoundation index. */
  id: string;
  /** Human-readable name for the UI. */
  label: string;
}

/** Run a device-listing command and collect stderr, where ffmpeg prints it. */
function listDevicesRaw(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath(), args, { windowsHide: true });
    let out = '';
    proc.stderr.on('data', (d) => (out += d));
    // `-list_devices` always exits non-zero (it never opens an input), so the
    // exit code is not a failure signal here — the output is what matters.
    proc.on('error', () => resolve(''));
    proc.on('close', () => resolve(out));
    setTimeout(() => {
      proc.kill();
      resolve(out);
    }, 6000);
  });
}

/**
 * Enumerate cameras, microphones and (on macOS) capturable screens.
 *
 * macOS lists screens as video devices in the same numbering as cameras, which
 * is why screens are separated out here rather than being left for the caller
 * to guess at — picking the wrong index records a webcam instead of a display.
 */
export async function listCaptureDevices(): Promise<{
  audio: CaptureDevice[];
  video: CaptureDevice[];
  screens: CaptureDevice[];
}> {
  if (IS_MAC) {
    const out = await listDevicesRaw([
      '-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '',
    ]);

    const video: CaptureDevice[] = [];
    const screens: CaptureDevice[] = [];
    const audio: CaptureDevice[] = [];

    // Output is two labelled sections:
    //   [AVFoundation indev @ ...] AVFoundation video devices:
    //   [AVFoundation indev @ ...] [0] FaceTime HD Camera
    //   [AVFoundation indev @ ...] [1] Capture screen 0
    //   [AVFoundation indev @ ...] AVFoundation audio devices:
    //   [AVFoundation indev @ ...] [0] MacBook Pro Microphone
    let section: 'video' | 'audio' | null = null;
    for (const line of out.split(/\r?\n/)) {
      if (/AVFoundation video devices:/i.test(line)) {
        section = 'video';
        continue;
      }
      if (/AVFoundation audio devices:/i.test(line)) {
        section = 'audio';
        continue;
      }
      const m = /\[(\d+)\]\s+(.+?)\s*$/.exec(line.replace(/^\[[^\]]*\]\s*/, ''));
      if (!m || !section) continue;

      const device = { id: m[1], label: m[2] };
      if (section === 'audio') audio.push(device);
      // Screens are video devices too; the label is the only thing telling
      // them apart.
      else if (/capture screen/i.test(device.label)) screens.push(device);
      else video.push(device);
    }

    return { audio, video, screens };
  }

  const out = await listDevicesRaw([
    '-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy',
  ]);

  const audio: CaptureDevice[] = [];
  const video: CaptureDevice[] = [];
  // Lines look like:  [dshow @ ...] "Brio 100" (video)
  const re = /"([^"]+)"\s*\((audio|video)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) {
    (m[2] === 'audio' ? audio : video).push({ id: m[1], label: m[1] });
  }

  const dedupe = (list: CaptureDevice[]) => {
    const seen = new Set<string>();
    return list.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  };

  // Windows enumerates displays through ddagrab output indices, not through the
  // device layer, so there is nothing to list here.
  return { audio: dedupe(audio), video: dedupe(video), screens: [] };
}

/**
 * Legacy name, kept because several call sites use it.
 *
 * Returns bare strings, which is only correct on Windows where the id and the
 * label are the same. New code should prefer `listCaptureDevices`.
 */
export async function listDshowDevices(): Promise<{ audio: string[]; video: string[] }> {
  const { audio, video } = await listCaptureDevices();
  return { audio: audio.map((d) => d.id), video: video.map((d) => d.id) };
}

/** Back-compat helper for callers that only need microphones. */
export async function listDshowAudioDevices(): Promise<string[]> {
  return (await listDshowDevices()).audio;
}
