import { BrowserWindow, dialog, ipcMain, protocol, screen } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { ffmpegPath } from './remux';
import type {
  EditorExportProgress,
  EditorExportRequest,
  EditorExportResult,
  EditorMediaInfo,
  EditorQuality,
  EditorSession,
} from '../shared/types';

/**
 * The built-in single-video editor: window management, media serving and the
 * ffmpeg export.
 *
 * Export has two strategies, chosen by what the available ffmpeg can do:
 *
 *  - single-pass (preferred): ONE ffmpeg process, one filter_complex that
 *    trims every kept range and concatenates them on one continuous timeline,
 *    re-encoding video and audio exactly once. Audio cannot drift because there
 *    is only one timeline and one AAC encoder. This is the rule carried over
 *    from the standalone editor and must not be weakened: never join
 *    separately-encoded AAC segments with -c copy.
 *
 *  - segmented (fallback): the BUNDLED ffmpeg is a slim build with no concat /
 *    setpts / asetpts filters (see tools/build-ffmpeg-slim.sh — the script now
 *    enables them, but already-shipped binaries lack them). Each kept range is
 *    encoded to a temporary MKV with frame-exact video and **PCM** audio, then
 *    the concat demuxer joins them, copying video and encoding the whole audio
 *    track to AAC in one go. PCM has no encoder priming, and boundaries are
 *    snapped to the frame grid so each segment's audio and video are the same
 *    length — measured within 1 ms of the single-pass output on a flash/beep
 *    sync test clip. Used only when no capable ffmpeg is available.
 */

const SCHEME = 'ezmedia';

/** Must run before app 'ready' — privileged schemes are fixed at startup. */
export function registerEditorScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Media elements need streaming + range support to seek.
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Media protocol: ezmedia://media/<token> -> the file an editor was opened on.
// Only files explicitly opened in an editor are reachable, by random token.
// ---------------------------------------------------------------------------

const mediaTokens = new Map<string, string>();

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

async function serveMedia(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.pathname.replace(/^\/+/, '');
  const filePath = mediaTokens.get(token);
  if (!filePath) return new Response('Not found', { status: 404 });

  let size: number;
  try {
    size = (await fs.promises.stat(filePath)).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const base: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    // The renderer loads this with crossOrigin="anonymous" so frames can be
    // drawn to a canvas (hover preview, filmstrip) without tainting it.
    'Access-Control-Allow-Origin': '*',
  };

  const range = req.headers.get('range');
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    let start: number;
    let end: number;
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else {
      // Suffix range: the last N bytes.
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
      status: 206,
      headers: {
        ...base,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }

  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers: { ...base, 'Content-Length': String(size) },
  });
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------

function run(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    let proc: ChildProcess;
    try {
      proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: -1, stdout, stderr: 'spawn failed' });
      return;
    }
    const timer = setTimeout(() => {
      proc.kill();
      done(-1);
    }, timeoutMs);
    proc.stdout?.on('data', (d) => (stdout += d));
    proc.stderr?.on('data', (d) => (stderr += d));
    proc.on('error', () => done(-1));
    proc.on('close', (code) => done(code ?? -1));
  });
}

/** Parse `ffmpeg -i <file>` — the bundled build ships no ffprobe. */
export async function probeMedia(filePath: string): Promise<EditorMediaInfo | null> {
  const { stderr } = await run(ffmpegPath(), ['-hide_banner', '-i', filePath], 15000);
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const video = /Stream #\d+:\d+[^\n]*?: Video: ([^\n]*)/.exec(stderr);
  if (!video) return null;
  const vline = video[1];
  const dims = /\b(\d{2,5})x(\d{2,5})\b/.exec(vline);
  // tbr is the nominal rate; "fps" can read 29.98 for a slightly-VFR take.
  const tbr = /([\d.]+)(k?) tbr/.exec(vline);
  const fpsM = /([\d.]+) fps/.exec(vline);
  let fps = tbr ? Number(tbr[1]) * (tbr[2] ? 1000 : 1) : fpsM ? Number(fpsM[1]) : 30;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) fps = 30;
  const pix = /\b(yuv\w+|nv12|rgb\w+|bgr\w+|gbrp\w*)\b/.exec(vline);
  return {
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    width: dims ? Number(dims[1]) : 0,
    height: dims ? Number(dims[2]) : 0,
    fps,
    hasAudio: /Stream #\d+:\d+[^\n]*?: Audio:/.test(stderr),
    pixFmt: pix ? pix[1] : 'yuv420p',
  };
}

const filterCache = new Map<string, Promise<Set<string>>>();
function filtersOf(bin: string): Promise<Set<string>> {
  let p = filterCache.get(bin);
  if (!p) {
    p = run(bin, ['-hide_banner', '-filters'], 8000).then(({ code, stdout }) => {
      const set = new Set<string>();
      if (code !== 0) return set;
      // Rows look like " TS crop   V->V   Crop the input video." (2 flag
      // columns in current ffmpeg, 3 in older builds).
      for (const m of stdout.matchAll(/^\s*[A-Z.|]{2,3}\s+(\w+)\s+\S+->\S+/gm)) set.add(m[1]);
      return set;
    });
    filterCache.set(bin, p);
  }
  return p;
}

const SINGLE_PASS_FILTERS = ['trim', 'atrim', 'setpts', 'asetpts', 'concat', 'fps', 'scale', 'aresample', 'aformat'];

/** Which ffmpeg to export with, and how. Cached for the app's lifetime. */
let exportBinary: Promise<{ bin: string; mode: 'single-pass' | 'segmented' }> | null = null;
function pickExportFfmpeg() {
  if (exportBinary) return exportBinary;
  exportBinary = (async () => {
    const bundled = ffmpegPath();
    const candidates = [bundled];
    // Same precedent as the paused-take join in native-recorder.ts: the slim
    // bundled build may lack a component a stock PATH ffmpeg has.
    if (bundled !== 'ffmpeg') candidates.push('ffmpeg');
    if (!process.env.EZ_EDITOR_FORCE_SEGMENTED) {
      for (const bin of candidates) {
        const f = await filtersOf(bin);
        if (SINGLE_PASS_FILTERS.every((n) => f.has(n))) return { bin, mode: 'single-pass' as const };
      }
    }
    return { bin: bundled, mode: 'segmented' as const };
  })();
  return exportBinary;
}

// --- Encoder choice ---------------------------------------------------------

/** Rate-control targets per preset. Lower = better; VideoToolbox is inverted. */
const QUALITY: Record<EditorQuality, { nvenc: number; amf: number; qsv: number; vt: number; x264: number }> = {
  high: { nvenc: 19, amf: 19, qsv: 19, vt: 75, x264: 18 },
  balanced: { nvenc: 23, amf: 23, qsv: 23, vt: 62, x264: 22 },
  small: { nvenc: 28, amf: 28, qsv: 28, vt: 50, x264: 27 },
};

function encoderArgs(enc: string, quality: EditorQuality, fps: number, pixFmt: string): string[] {
  const q = QUALITY[quality];
  // Fixed ~2s GOP so players (VLC, browsers) seek instantly — kept from the
  // standalone editor.
  const gop = String(Math.max(1, Math.round(fps * 2)));
  const is444 = pixFmt === 'yuv444p';
  switch (enc) {
    case 'h264_nvenc':
      return [
        '-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq',
        '-profile:v', is444 ? 'high444p' : 'high',
        '-rc', 'vbr', '-cq', String(q.nvenc), '-b:v', '0',
        '-g', gop, '-forced-idr', '1', '-no-scenecut', '1',
        '-pix_fmt', pixFmt,
      ];
    case 'h264_amf':
      return [
        '-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp',
        '-qp_i', String(q.amf), '-qp_p', String(q.amf), '-g', gop, '-pix_fmt', pixFmt,
      ];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(q.qsv), '-g', gop, '-pix_fmt', pixFmt];
    case 'h264_videotoolbox':
      return [
        '-c:v', 'h264_videotoolbox', '-q:v', String(q.vt), '-allow_sw', '0',
        '-g', gop, '-max_key_interval_duration', '2', '-pix_fmt', pixFmt,
      ];
    default:
      return [
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(q.x264),
        '-g', gop, '-keyint_min', gop, '-x264-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0`,
        '-pix_fmt', pixFmt,
      ];
  }
}

const encoderCache = new Map<string, Promise<boolean>>();
/**
 * Does `enc` actually work here? A compiled-in hardware encoder still fails
 * without the hardware (AMF on an NVIDIA box), so probe with a real 3-frame
 * encode of the source itself — the slim build has no lavfi test sources and
 * no null muxer, so the frames go to a discarded Matroska pipe.
 */
function encoderWorks(bin: string, src: string, enc: string, pixFmt: string): Promise<boolean> {
  const key = `${bin}|${enc}|${pixFmt}`;
  let p = encoderCache.get(key);
  if (!p) {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-i', src, '-frames:v', '3', '-an',
      ...encoderArgs(enc, 'balanced', 30, pixFmt), '-f', 'matroska', '-',
    ];
    p = run(bin, args, 20000).then((r) => r.code === 0);
    encoderCache.set(key, p);
  }
  return p;
}

async function pickEncoder(bin: string, src: string, pixFmt: string): Promise<string> {
  const order =
    process.platform === 'darwin'
      ? ['h264_videotoolbox', 'libx264']
      : ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'];
  for (const enc of order) {
    if (await encoderWorks(bin, src, enc, pixFmt)) return enc;
  }
  return 'libx264';
}

// --- Export -----------------------------------------------------------------

interface Job {
  proc: ChildProcess | null;
  cancelled: boolean;
}

/** Run ffmpeg with `-progress pipe:1`, reporting output seconds as they land. */
function runWithProgress(
  bin: string,
  args: string[],
  job: Job,
  onTime: (seconds: number, speed?: string) => void,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...args], {
      windowsHide: true,
    });
    job.proc = proc;
    let stderr = '';
    let buf = '';
    let speed: string | undefined;
    proc.stdout.on('data', (d) => {
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq);
        const v = line.slice(eq + 1);
        if (k === 'speed') speed = v;
        else if (k === 'out_time_us' || k === 'out_time_ms') {
          const us = Number(v);
          if (Number.isFinite(us) && us >= 0) onTime(us / 1e6, speed);
        }
      }
    });
    proc.stderr.on('data', (d) => {
      stderr += String(d);
      // Keep only the tail; long exports print a lot.
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    proc.on('error', (e) => resolve({ code: -1, stderr: String(e) }));
    proc.on('close', (code) => {
      job.proc = null;
      resolve({ code: code ?? -1, stderr });
    });
  });
}

function lastError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = [...lines].reverse().find((l) => /error|invalid|failed|no such|not found|cannot/i.test(l));
  return hit ?? lines[lines.length - 1] ?? 'ffmpeg failed';
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

/** `<dir>/<name>_edited.mp4`, or `_edited-2`, `-3`… — never an existing file. */
export function defaultOutputFor(src: string): string {
  const dir = path.dirname(src);
  const base = path.basename(src, path.extname(src)).replace(/_edited(-\d+)?$/, '');
  for (let i = 1; i < 1000; i++) {
    const name = `${base}_edited${i === 1 ? '' : `-${i}`}.mp4`;
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${base}_edited-${Date.now()}.mp4`);
}

const fmt = (n: number) => n.toFixed(6);

async function runExport(
  src: string,
  info: EditorMediaInfo,
  req: EditorExportRequest,
  job: Job,
  report: (p: EditorExportProgress) => void,
): Promise<EditorExportResult> {
  if (!fs.existsSync(src)) return { ok: false, error: 'The original recording is missing.' };
  if (!req.outputPath || samePath(req.outputPath, src)) {
    return { ok: false, error: 'Choose a different file name — the original is never overwritten.' };
  }

  const fps = info.fps || 30;
  // Snap every boundary to the frame grid so a range's video (whole frames)
  // and audio (samples) are the same length. Required by the segmented path,
  // harmless for single-pass.
  const snap = (t: number) => Math.round(t * fps) / fps;
  const keep = req.keep
    .map(([s, e]) => [Math.max(0, snap(s)), Math.min(info.duration || e, snap(e))] as [number, number])
    .filter(([s, e]) => e - s >= 1 / fps);
  if (!keep.length) return { ok: false, error: 'Nothing left to export — every part is cut.' };
  const total = keep.reduce((a, [s, e]) => a + (e - s), 0);

  report({ phase: 'preparing', fraction: 0 });
  const { bin, mode } = await pickExportFfmpeg();

  // 4:4:4 only survives on High; everything else is 4:2:0 for compatibility.
  const pixFmt = req.quality === 'high' && info.pixFmt === 'yuv444p' ? 'yuv444p' : 'yuv420p';
  let encoder = await pickEncoder(bin, src, pixFmt);
  let usedPix = pixFmt;
  if (pixFmt !== 'yuv420p' && !(await encoderWorks(bin, src, encoder, pixFmt))) {
    usedPix = 'yuv420p';
    encoder = await pickEncoder(bin, src, usedPix);
  }
  if (job.cancelled) return { ok: false, cancelled: true };

  const wantH = req.resolution === 'source' ? 0 : Number(req.resolution);
  const scale = wantH && info.height && wantH < info.height ? `scale=-2:${wantH}:flags=lanczos` : '';
  const keepAudio = req.keepAudio && info.hasAudio;
  const audioOut = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];

  fs.mkdirSync(path.dirname(req.outputPath), { recursive: true });
  // Write to a temp name and rename on success, so a failed or cancelled
  // export never leaves a half-written file behind under the real name.
  const partial = req.outputPath.replace(/\.mp4$/i, '') + `.partial-${process.pid}.mp4`;
  const tmpDirs: string[] = [];
  const cleanup = () => {
    try {
      fs.rmSync(partial, { force: true });
    } catch {
      /* ignore */
    }
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };

  try {
    if (mode === 'single-pass') {
      const parts: string[] = [];
      const ins: string[] = [];
      keep.forEach(([s, e], i) => {
        // Shift by the RANGE start, not the first frame (PTS-STARTPTS): a
        // browser-engine take's video can start ~40ms after its audio, and
        // STARTPTS would silently pull the picture ahead of the sound.
        const vchain = [
          `trim=start=${fmt(s)}:end=${fmt(e)}`,
          `setpts=PTS-${fmt(s)}/TB`,
          // start_time=0 back-fills to the range start. Without it a range
          // whose first frame lands late (the take's opening ~130ms) comes out
          // short, and concat butts the next range against the short video —
          // pulling every later range's picture ahead of its sound.
          `fps=${fps}:start_time=0`,
          // …and cap it, so rounding at the far end cannot add a frame.
          `trim=end=${fmt(e - s)}`,
          scale,
          `format=${usedPix}`,
        ].filter(Boolean);
        parts.push(`[0:v]${vchain.join(',')}[v${i}]`);
        if (keepAudio) {
          parts.push(
            `[0:a]atrim=start=${fmt(s)}:end=${fmt(e)},asetpts=PTS-${fmt(s)}/TB,` +
              `aresample=48000:async=1,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
          );
          ins.push(`[v${i}][a${i}]`);
        } else {
          ins.push(`[v${i}]`);
        }
      });
      parts.push(`${ins.join('')}concat=n=${keep.length}:v=1:a=${keepAudio ? 1 : 0}[vout]${keepAudio ? '[aout]' : ''}`);

      const args = [
        '-y', '-i', src,
        '-filter_complex', parts.join(';'),
        '-map', '[vout]',
        ...(keepAudio ? ['-map', '[aout]', ...audioOut] : ['-an']),
        ...encoderArgs(encoder, req.quality, fps, usedPix),
        // A take's audio often runs a little past its last video frame; end
        // the file with the picture so both streams have the same length.
        ...(keepAudio ? ['-shortest'] : []),
        '-movflags', '+faststart',
        partial,
      ];
      report({ phase: 'encoding', fraction: 0, encoder });
      const r = await runWithProgress(bin, args, job, (t, speed) =>
        report({ phase: 'encoding', fraction: Math.min(0.99, t / total), encoder, speed }),
      );
      if (job.cancelled) {
        cleanup();
        return { ok: false, cancelled: true };
      }
      if (r.code !== 0) {
        cleanup();
        return { ok: false, error: lastError(r.stderr), encoder, mode };
      }
    } else {
      // Segmented fallback: frame-exact video + PCM audio per range, then one
      // join that encodes the whole audio track once.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-editor-'));
      tmpDirs.push(dir);
      const list: string[] = ['ffconcat version 1.0'];
      let done = 0;
      for (let i = 0; i < keep.length; i++) {
        const [s, e] = keep[i];
        const seg = path.join(dir, `seg${i}.mkv`);
        const vf = [`fps=${fps}:start_time=0`, scale, `format=${usedPix}`].filter(Boolean).join(',');
        const args = [
          // No -ss for a range at 0: ffmpeg's seek-to-zero drops the first
          // audio packets (measured: audio starts 85ms late), while plain
          // decoding from the top keeps both streams where they belong.
          '-y', ...(s > 0.0005 ? ['-ss', fmt(s)] : []), '-i', src, '-t', fmt(e - s),
          '-map', '0:v:0', ...(keepAudio ? ['-map', '0:a:0'] : []),
          '-vf', vf,
          ...encoderArgs(encoder, req.quality, fps, usedPix),
          ...(keepAudio ? ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2'] : ['-an']),
          // The take's audio can outlast its last frame; end with the picture.
          ...(keepAudio && i === keep.length - 1 ? ['-shortest'] : []),
          seg,
        ];
        const r = await runWithProgress(bin, args, job, (t, speed) =>
          report({ phase: 'encoding', fraction: Math.min(1, (done + t) / total) * 0.97, encoder, speed }),
        );
        if (job.cancelled) {
          cleanup();
          return { ok: false, cancelled: true };
        }
        if (r.code !== 0) {
          cleanup();
          return { ok: false, error: lastError(r.stderr), encoder, mode };
        }
        done += e - s;
        list.push(`file '${seg.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
      }
      const listPath = path.join(dir, 'list.ffconcat');
      fs.writeFileSync(listPath, list.join('\n') + '\n');
      report({ phase: 'joining', fraction: 0.97, encoder });
      const r = await runWithProgress(
        bin,
        [
          '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
          '-map', '0:v', ...(keepAudio ? ['-map', '0:a', ...audioOut] : ['-an']),
          // No -shortest here: on a stream-copied video it drops the last few
          // frames. Segments are frame-snapped, so the streams already match.
          '-c:v', 'copy', '-movflags', '+faststart', partial,
        ],
        job,
        (t) => report({ phase: 'joining', fraction: 0.97 + 0.03 * Math.min(1, t / total), encoder }),
      );
      if (job.cancelled) {
        cleanup();
        return { ok: false, cancelled: true };
      }
      if (r.code !== 0) {
        cleanup();
        return { ok: false, error: lastError(r.stderr), encoder, mode };
      }
    }

    if (!fs.existsSync(partial)) {
      cleanup();
      return { ok: false, error: 'ffmpeg finished but wrote no file.', encoder, mode };
    }
    fs.rmSync(req.outputPath, { force: true });
    fs.renameSync(partial, req.outputPath);
    cleanup();
    return {
      ok: true,
      outputPath: req.outputPath,
      encoder,
      mode,
      sizeBytes: fs.statSync(req.outputPath).size,
    };
  } catch (err) {
    cleanup();
    return { ok: false, error: (err as Error).message, encoder, mode };
  }
}

// ---------------------------------------------------------------------------
// Windows + IPC
// ---------------------------------------------------------------------------

interface EditorEntry {
  win: BrowserWindow;
  filePath: string;
  token: string;
  info: Promise<EditorMediaInfo | null>;
  job: Job | null;
}

const editors = new Map<number, EditorEntry>();

export interface EditorDeps {
  rendererUrl: () => string;
  preloadPath: string;
  iconPath: string;
  isDev: boolean;
  log: (...args: unknown[]) => void;
}

let deps: EditorDeps | null = null;

export function openEditor(filePath: string): boolean {
  if (!deps) return false;
  if (!filePath || !fs.existsSync(filePath)) return false;

  for (const e of editors.values()) {
    if (samePath(e.filePath, filePath) && !e.win.isDestroyed()) {
      if (e.win.isMinimized()) e.win.restore();
      e.win.focus();
      return true;
    }
  }

  const isMac = process.platform === 'darwin';
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(1240, wa.width - 60);
  const height = Math.min(840, wa.height - 60);

  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    minWidth: 820,
    minHeight: 580,
    show: false,
    frame: isMac,
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    backgroundColor: '#141312',
    icon: deps.iconPath || undefined,
    title: `${path.basename(filePath)} — Ez Screen Record`,
    webPreferences: {
      preload: deps.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const token = randomUUID();
  mediaTokens.set(token, filePath);
  const entry: EditorEntry = { win, filePath, token, info: probeMedia(filePath), job: null };
  const id = win.webContents.id;
  editors.set(id, entry);

  if (deps.isDev) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) deps?.log('error', `[editor] ${message} (${sourceId}:${line})`);
    });
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (entry.job) {
      entry.job.cancelled = true;
      entry.job.proc?.kill();
    }
    mediaTokens.delete(token);
    editors.delete(id);
  });

  win.loadURL(deps.rendererUrl());
  return true;
}

function entryFor(sender: Electron.WebContents): EditorEntry | null {
  return editors.get(sender.id) ?? null;
}

export function registerEditor(d: EditorDeps): void {
  deps = d;
  protocol.handle(SCHEME, (req) => serveMedia(req));

  ipcMain.handle('editor:open', (_e, filePath: string) => openEditor(filePath));

  ipcMain.handle('editor:session', async (event): Promise<EditorSession | null> => {
    const e = entryFor(event.sender);
    if (!e) return null;
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(e.filePath).size;
    } catch {
      /* missing — the renderer reports the load error */
    }
    return {
      filePath: e.filePath,
      fileName: path.basename(e.filePath),
      mediaUrl: `${SCHEME}://media/${e.token}`,
      sizeBytes,
      info: await e.info,
      defaultOutputPath: defaultOutputFor(e.filePath),
    };
  });

  ipcMain.handle('editor:chooseOutput', async (event, current: string) => {
    const e = entryFor(event.sender);
    if (!e) return null;
    const res = await dialog.showSaveDialog(e.win, {
      title: 'Save edited video',
      defaultPath: current || defaultOutputFor(e.filePath),
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (res.canceled || !res.filePath) return null;
    let out = res.filePath;
    if (!/\.mp4$/i.test(out)) out += '.mp4';
    // Overwriting the source would destroy the recording being edited.
    if (samePath(out, e.filePath)) return { error: 'That is the original recording — pick another name.' };
    return { path: out };
  });

  ipcMain.handle('editor:export', async (event, req: EditorExportRequest): Promise<EditorExportResult> => {
    const e = entryFor(event.sender);
    if (!e) return { ok: false, error: 'Editor session not found.' };
    if (e.job) return { ok: false, error: 'An export is already running.' };
    const info = await e.info;
    if (!info) return { ok: false, error: 'ffmpeg could not read this recording.' };
    const job: Job = { proc: null, cancelled: false };
    e.job = job;
    try {
      return await runExport(e.filePath, info, req, job, (p) => {
        if (!event.sender.isDestroyed()) event.sender.send('editor:exportProgress', p);
      });
    } finally {
      e.job = null;
    }
  });

  ipcMain.handle('editor:cancelExport', (event) => {
    const e = entryFor(event.sender);
    if (!e?.job) return false;
    e.job.cancelled = true;
    e.job.proc?.kill();
    return true;
  });

  ipcMain.handle('editor:window', (event, action: 'minimize' | 'maximize' | 'close') => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else win.close();
  });
}
