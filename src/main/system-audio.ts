import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Desktop (system) audio capture for the ffmpeg "crisp" engine, on Windows.
 *
 * ffmpeg has no WASAPI/loopback audio input on Windows — its only audio backend
 * is dshow, which sees microphones only. So a tiny bundled helper exe
 * (native/audio-helper/loopback.cpp) records the default render endpoint's
 * loopback to a single WAV, which native-recorder muxes into the finished file.
 *
 * A file rather than a live pipe, deliberately: keeping the audio out-of-process
 * and on disk means a stall in capture can never stall the video encode — the
 * same reasoning that keeps ffmpeg itself out-of-process.
 *
 * Pause/resume MUST run in lockstep with ffmpeg's segment boundaries. The
 * helper stops appending on `pause` without finalising, so the single WAV holds
 * only the recorded spans and stays exactly as long as the concatenated video.
 * Letting it run through a pause would make every later sound land early, by the
 * pause duration, cumulatively.
 */

const HELPER_EXE = 'ez-audio-loopback.exe';

/** Locate the loopback helper the same way ffmpeg is located (beside it). */
export function systemAudioHelperPath(): string | null {
  if (process.platform !== 'win32') return null;
  const candidates = [
    // Packaged: extraResources lands beside app.asar.
    path.join(process.resourcesPath ?? '', 'ffmpeg', HELPER_EXE),
    // Dev: dropped into the repo for testing the packaged layout.
    path.join(process.cwd(), 'resources', 'ffmpeg', HELPER_EXE),
    // Dev: the freshly-built binary next to its source.
    path.join(process.cwd(), 'native', 'audio-helper', HELPER_EXE),
  ];
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }) ?? null;
}

/** True when desktop-audio capture is possible on this machine. */
export function systemAudioAvailable(): boolean {
  return systemAudioHelperPath() !== null;
}

export class SystemAudioHelper {
  private proc: ChildProcess | null = null;
  private wavPath = '';
  private paused = false;

  /** Where the captured audio is being written, or null if not running. */
  get outputPath(): string | null {
    return this.proc ? this.wavPath : null;
  }

  /**
   * Start capturing to a fresh temp WAV. Resolves once the helper reports it is
   * live (so the caller can start ffmpeg knowing audio is already recording),
   * or rejects if the helper cannot be launched. A missing helper must never
   * stop a recording from starting — the caller treats a throw as "no system
   * audio" and carries on.
   */
  async start(): Promise<void> {
    const exe = systemAudioHelperPath();
    if (!exe) throw new Error('system-audio helper not found');

    this.wavPath = path.join(os.tmpdir(), `ez-sysaudio-${Date.now()}.wav`);
    const proc = spawn(exe, [this.wavPath], { windowsHide: true });
    this.proc = proc;
    this.paused = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      // The helper prints "ready" once loopback capture is live.
      const onData = (d: Buffer) => {
        if (String(d).includes('ready')) done(resolve);
      };
      proc.stdout?.on('data', onData);
      proc.on('error', (err) => done(() => reject(err)));
      proc.on('exit', (code) =>
        done(() => reject(new Error(`system-audio helper exited early (code ${code})`))),
      );
      // Guard against a helper that never says ready.
      setTimeout(() => done(() => reject(new Error('system-audio helper did not become ready'))), 4000);
    });
  }

  private send(cmd: 'pause' | 'resume' | 'stop'): void {
    try {
      this.proc?.stdin?.write(`${cmd}\n`);
    } catch {
      /* the helper is already gone; nothing to do */
    }
  }

  /**
   * Force-kill the helper immediately, without finalising the WAV. Used on app
   * quit, where waiting for a clean stop is neither possible nor useful.
   */
  dispose(): void {
    try {
      this.proc?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    this.proc = null;
  }

  /** Stop appending WITHOUT finalising, in lockstep with an ffmpeg pause. */
  pause(): void {
    if (!this.proc || this.paused) return;
    this.paused = true;
    this.send('pause');
  }

  resume(): void {
    if (!this.proc || !this.paused) return;
    this.paused = false;
    this.send('resume');
  }

  /**
   * Finalise the WAV and return its path, or null if capture never ran or the
   * file is unusable. Must be awaited before ffmpeg reads the file: the WAV
   * header is only valid once the helper has finalised it on exit.
   */
  async stop(): Promise<string | null> {
    const proc = this.proc;
    const wav = this.wavPath;
    if (!proc) return null;

    this.send('stop');

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      proc.on('exit', finish);
      proc.on('error', finish);
      // The helper finalises and exits promptly; don't hang a stop on it.
      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
        finish();
      }, 3000);
    });

    this.proc = null;
    this.paused = false;

    try {
      // A bare 44-byte header means no audio was captured; treat as none.
      if (fs.existsSync(wav) && fs.statSync(wav).size > 44) return wav;
    } catch {
      /* fall through */
    }
    return null;
  }

  /** Best-effort teardown for an aborted take; discards the partial WAV. */
  async discard(): Promise<void> {
    const wav = this.wavPath;
    await this.stop();
    try {
      if (wav && fs.existsSync(wav)) fs.unlinkSync(wav);
    } catch {
      /* best effort */
    }
  }
}
