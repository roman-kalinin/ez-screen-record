import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * MediaRecorder writes a live WebM stream with no duration header, so players
 * and editors report an unknown length and seeking misbehaves. If ffmpeg is on
 * the system we remux (stream copy — no re-encode, so it's fast and lossless)
 * into an MP4 with proper metadata and a faststart header.
 *
 * This is best-effort: when ffmpeg is missing we simply keep the original file.
 */

let ffmpegChecked = false;
let ffmpegAvailable = false;
let resolvedFfmpeg: string | null = null;

/**
 * Locate the ffmpeg binary.
 *
 * An installed app cannot assume ffmpeg is on PATH, so a bundled copy under
 * resources/ffmpeg wins when present. Note that `ffmpeg-static` is NOT a valid
 * source for it: on Windows this app needs `ddagrab`, `libplacebo` and
 * `h264_nvenc`, and that package ships a minimal build with none of them. Use a
 * full build (gyan.dev "full", or BtbN win64-gpl); on macOS, evermeet.cx.
 *
 * Falling back to PATH keeps `npm run dev` working without a vendored binary.
 */
export function ffmpegPath(): string {
  if (resolvedFfmpeg) return resolvedFfmpeg;

  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = [
    // Packaged: extraResources lands beside app.asar.
    path.join(process.resourcesPath ?? '', 'ffmpeg', exe),
    // Dev: a binary dropped into the repo for testing the packaged layout.
    path.join(process.cwd(), 'resources', 'ffmpeg', exe),
    // Dev on a Mac: fetch-ffmpeg stores one binary per architecture.
    path.join(process.cwd(), 'resources', `ffmpeg-mac-${process.arch}`, exe),
  ];

  const found = bundled.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  // Zip extraction and some copy paths drop the executable bit, and a binary
  // without it fails to spawn with EACCES — which surfaces as "ffmpeg not
  // found" and sends you looking in entirely the wrong place. Restoring it is
  // cheap and idempotent.
  if (found && process.platform !== 'win32') {
    try {
      fs.accessSync(found, fs.constants.X_OK);
    } catch {
      try {
        fs.chmodSync(found, 0o755);
      } catch {
        /* read-only install; the spawn will report the real error */
      }
    }
  }

  resolvedFfmpeg = found ?? 'ffmpeg';
  return resolvedFfmpeg;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    // spawn() reports most failures through the 'error' event, but some it
    // THROWS synchronously -- notably "Bad CPU type in executable" (EBADARCH,
    // errno -86) when an Intel-only ffmpeg is launched on an Apple Silicon Mac
    // without Rosetta. Uncaught, that rejected hasFfmpeg() and remuxToMp4(),
    // and every save on such a Mac ended in "Could not save recording" even
    // though the file had already been written.
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffmpegPath(), args, { windowsHide: true });
    } catch {
      resolve({ code: -1, stderr: 'spawn failed' });
      return;
    }
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ code: -1, stderr: 'timed out' });
    }, timeoutMs);

    proc.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: 'spawn failed' });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegChecked) return ffmpegAvailable;
  const { code } = await runFfmpeg(['-version'], 5000);
  ffmpegAvailable = code === 0;
  ffmpegChecked = true;
  return ffmpegAvailable;
}

/**
 * Convert `input` to a sibling .mp4. Returns the path that should be presented
 * to the user — the new MP4 on success, or the untouched input on failure.
 *
 * Stream copy only — fast and lossless. Re-encoding was tried and rejected:
 * MediaRecorder's encoder caps around 5 Mbps at 1440p no matter what bitrate
 * is requested, and a CRF pass over that output just shrinks it further
 * (0.78 Mbps from a 7.5 Mbps source) because there is no detail left to keep.
 * Capture quality has to be fixed at the source, not in post.
 */
export async function remuxToMp4(input: string): Promise<string> {
  if (!(await hasFfmpeg())) return input;

  const output = input.replace(/\.(webm|mp4)$/i, '') + '.mp4';
  // Never clobber a file that is already the target.
  if (path.resolve(output) === path.resolve(input)) return input;

  // Video is always a stream copy: the source is already H.264 and
  // re-encoding cannot recover detail the capture encoder discarded — it only
  // costs time and throws away more. Quality has to be won at capture.
  //
  // Audio is tried as AAC first, then copied.
  //
  // MediaRecorder writes WebM with OPUS audio, and re-encoding that to AAC
  // needs an Opus DECODER. The bundled ffmpeg is built `--disable-everything`
  // and shipped without one, so this failed with "no decoder found for: opus",
  // the whole remux was abandoned, and every browser-engine recording stayed a
  // .webm. The build now enables the decoder, but an already-installed copy
  // will not have it — so fall back to copying the Opus stream into the MP4
  // rather than losing the container conversion over the audio codec.
  const attempts: string[][] = [
    ['-c:a', 'aac', '-b:a', '192k'],
    ['-c:a', 'copy'],
  ];

  let code = 1;
  for (const audioArgs of attempts) {
    ({ code } = await runFfmpeg(
      [
        '-y',
        '-fflags', '+genpts',
        '-i', input,
        '-c:v', 'copy',
        ...audioArgs,
        '-movflags', '+faststart',
        output,
      ],
      // Generous: long tutorials still finish, but never hang forever.
      30 * 60 * 1000,
    ));
    if (code === 0 && fs.existsSync(output)) break;
  }

  if (code !== 0 || !fs.existsSync(output)) {
    // Clean up a partial file so the user isn't left with a broken MP4.
    try {
      if (fs.existsSync(output)) fs.unlinkSync(output);
    } catch {
      /* ignore */
    }
    return input;
  }

  // Remux succeeded — drop the intermediate WebM.
  try {
    if (path.resolve(output) !== path.resolve(input)) fs.unlinkSync(input);
  } catch {
    /* keeping the original is harmless */
  }

  return output;
}
