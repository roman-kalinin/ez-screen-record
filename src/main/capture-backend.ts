/**
 * Per-platform capture and encode selection.
 *
 * The ffmpeg filter graph in native-recorder.ts is identical on both platforms;
 * only the edges differ — how the desktop is grabbed, how devices are addressed,
 * and which encoder is available. Isolating those here keeps the tuned graph
 * (and the measurements justifying it) from being buried under platform
 * branches.
 *
 * Windows: ddagrab (Desktop Duplication, GPU-resident D3D11) -> NVENC.
 * macOS:   avfoundation (backed by ScreenCaptureKit on 12.3+) -> VideoToolbox.
 */

import { spawn } from 'child_process';
import { ffmpegPath } from './remux';

export const IS_MAC = process.platform === 'darwin';
export const IS_WIN = process.platform === 'win32';

/** ffmpeg's device layer for camera/microphone input. */
export const DEVICE_FORMAT = IS_MAC ? 'avfoundation' : 'dshow';

/**
 * Does the desktop arrive on the GPU?
 *
 * ddagrab hands over a D3D11 texture, so it needs `hwdownload` before any CPU
 * filter can touch it. avfoundation delivers ordinary system-memory frames, so
 * that step must be skipped — asking to download a frame that was never
 * uploaded is a hard error, not a no-op.
 */
export const CAPTURE_IS_HW = !IS_MAC;

/**
 * Pixel format arriving from the capture device.
 *
 * ddagrab's D3D11 surface downloads as BGRA and nothing else will do.
 * avfoundation yields UYVY422 or NV12 depending on the display; `format=bgra`
 * normalises it so the rest of the graph is platform-agnostic.
 */
export const CAPTURE_PIX_FMT = 'bgra';

/**
 * Build the desktop-capture input arguments.
 *
 * `displayId` is the platform's own identifier — an output index on Windows, an
 * avfoundation device index on macOS.
 *
 * On both platforms `fps` is a CEILING rather than a guarantee: the compositor
 * only produces a frame when something changes. See the long note in
 * native-recorder.ts — do NOT over-request to compensate.
 */
export function screenInputArgs(fps: number, displayId = 0): string[] {
  if (IS_MAC) {
    return [
      '-f', 'avfoundation',
      '-capture_cursor', '1',
      // Must precede -i: avfoundation reads it when opening the device.
      '-framerate', String(fps),
      // "<screen>:<audio>" — the trailing colon with no audio index means
      // video only. Screens are indexed after cameras in avfoundation's device
      // list, which is why the caller resolves this rather than hardcoding it.
      '-i', `${displayId}:`,
    ];
  }
  return ['-f', 'lavfi', '-i', `ddagrab=output_idx=${displayId}:framerate=${fps}`];
}

/** Camera input arguments. Device is addressed by name on Windows, index on macOS. */
export function cameraInputArgs(device: string): string[] {
  if (IS_MAC) {
    return [
      '-f', 'avfoundation',
      '-rtbufsize', '512M',
      // No -framerate/-video_size, matching Windows: cameras support a fixed
      // set of modes and fail outright when asked for one they lack.
      '-i', `${device}:`,
    ];
  }
  return ['-f', 'dshow', '-rtbufsize', '512M', '-i', `video=${device}`];
}

/** Microphone input arguments. */
export function micInputArgs(device: string): string[] {
  if (IS_MAC) {
    return [
      '-f', 'avfoundation',
      '-rtbufsize', '256M',
      // Leading colon: audio-only device index.
      '-i', `:${device}`,
    ];
  }
  return [
    '-f', 'dshow',
    // See native-recorder.ts: dshow's default buffer stalls the VIDEO path in a
    // regular rhythm. avfoundation has no equivalent knob and no equivalent
    // problem.
    '-audio_buffer_size', '50',
    '-rtbufsize', '256M',
    '-i', `audio=${device}`,
  ];
}

/** Is a given ffmpeg encoder compiled into this build? */
const encoderCache = new Map<string, Promise<boolean>>();
export function hasEncoder(name: string): Promise<boolean> {
  const cached = encoderCache.get(name);
  if (cached) return cached;

  const probe = new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-encoders'], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => resolve(false));
    proc.on('close', () => resolve(new RegExp(`\\b${name}\\b`).test(out)));
    setTimeout(() => {
      proc.kill();
      resolve(false);
    }, 5000);
  });

  encoderCache.set(name, probe);
  return probe;
}

/**
 * The hardware encoder for this platform, or null when there is none.
 *
 * macOS has no NVIDIA hardware, so NVENC is never an option; VideoToolbox is
 * the equivalent and is present on every Mac Electron can run on.
 */
export async function hardwareEncoder(): Promise<string | null> {
  if (IS_MAC) {
    return (await hasEncoder('h264_videotoolbox')) ? 'h264_videotoolbox' : null;
  }
  return null; // Windows NVENC is probed separately — it also gates on 4:4:4.
}

/**
 * Highest chroma the platform's hardware encoder can deliver.
 *
 * VideoToolbox's H.264 encoder is **4:2:0 only** — there is no 4:4:4 path, so
 * the Windows "visually lossless 4:4:4" promise cannot be met on a Mac. Rather
 * than silently degrade a preset the user picked for its chroma, the recorder
 * clamps to this and reports the substitution.
 */
export const MAX_HW_PIX_FMT = IS_MAC ? 'yuv420p' : 'yuv444p';
