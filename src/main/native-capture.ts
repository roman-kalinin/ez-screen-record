/**
 * Optional native capture accelerator (Windows + NVIDIA only).
 *
 * This module must NEVER be required at import time and must NEVER throw: the
 * app ships to Windows and macOS and has to run on machines with no addon
 * built, no NVIDIA GPU, and no Windows Graphics Capture. Everything here is
 * probed once, cached, and degrades to `null` so the caller falls back to the
 * portable ffmpeg path.
 *
 * Engine selection, best first:
 *   1. native   — WGC + D3D11 + NVENC. Windows 11 26100+ w/ NVIDIA. Keeps the
 *                 frame on the GPU end to end and is the only path that beats
 *                 Desktop Duplication's ~57fps ceiling at 1440p.
 *   2. ffmpeg   — screen-only capture with the camera in an on-screen window
 *                 (Mode A). Portable, and measured 72.8 unique fps at 1440p.
 *   3. browser  — MediaRecorder. Universal, lowest quality; last resort.
 */

import { createRequire } from 'module';
import * as path from 'path';

export interface NativeCaptureAddon {
  isSupported(): boolean;
  hasMinUpdateInterval(): boolean;
  listMonitors(): Array<{ index: number; width: number; height: number; primary: boolean }>;
}

let cached: NativeCaptureAddon | null | undefined;

/**
 * Load the addon, or return null on any failure. A missing or stale binary is
 * an expected state on most machines, not an error worth surfacing.
 */
export function loadNativeCapture(appRoot: string): NativeCaptureAddon | null {
  if (cached !== undefined) return cached;

  // macOS and Linux have no WGC/NVENC; skip the probe entirely.
  if (process.platform !== 'win32') {
    cached = null;
    return cached;
  }

  try {
    const require = createRequire(__filename);
    const candidates = [
      path.join(appRoot, 'native', 'build', 'Release', 'ezcapture.node'),
      path.join(appRoot, 'build', 'Release', 'ezcapture.node'),
    ];
    for (const candidate of candidates) {
      try {
        const addon = require(candidate) as NativeCaptureAddon;
        // Built for a different ABI, or the OS lacks WGC — treat as absent.
        if (typeof addon?.isSupported === 'function' && addon.isSupported()) {
          cached = addon;
          return cached;
        }
      } catch {
        /* try the next location */
      }
    }
  } catch {
    /* fall through to null */
  }

  cached = null;
  return cached;
}

/** Which capture engine this machine should use. */
export type CaptureEngineKind = 'native' | 'ffmpeg' | 'browser';

export function describeEngine(kind: CaptureEngineKind): string {
  switch (kind) {
    case 'native':
      return 'GPU capture (Windows Graphics Capture + NVENC)';
    case 'ffmpeg':
      return 'ffmpeg capture';
    default:
      return 'Browser capture';
  }
}
