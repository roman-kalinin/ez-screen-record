/**
 * Download a full ffmpeg build into resources/ffmpeg for packaging.
 *
 * `ffmpeg-static` is deliberately not used: it ships a minimal build without
 * ddagrab, libplacebo or nvenc, all three of which this app depends on. The
 * fetched binary is verified for those features before being kept, so a build
 * that would fail at record time fails here instead.
 *
 *   node tools/fetch-ffmpeg.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, readdir, copyFile, stat, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'resources', 'ffmpeg');
const TMP = path.join(ROOT, '.ffmpeg-tmp');

const IS_MAC = process.platform === 'darwin';

// BtbN's win64-gpl build: has ddagrab, libplacebo and nvenc, and the URL is
// stable (it always points at the newest master build).
//
// macOS has no equivalent auto-updating GPL zip, so evermeet.cx is used — the
// long-standing source for static macOS ffmpeg builds. It is Intel-only, which
// is fine: it runs on Apple Silicon under Rosetta 2, and ffmpeg here is a
// short-lived subprocess whose work is done by the hardware encoder anyway.
const URL = IS_MAC
  ? 'https://evermeet.cx/ffmpeg/getrelease/zip'
  : 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

// What the recorder actually needs, per platform. Verified before install so a
// build that would fail at record time fails here instead.
//
// macOS deliberately does NOT require libplacebo: it is rare in macOS builds
// (Vulkan via MoltenVK) and only affects burned-in overlays, not capture. The
// recorder falls back to the on-screen camera bubble when it is missing.
const REQUIRED_FILTERS = IS_MAC ? [] : ['ddagrab', 'libplacebo'];
const REQUIRED_ENCODERS = IS_MAC ? ['h264_videotoolbox'] : ['h264_nvenc'];
const REQUIRED_DEVICES = IS_MAC ? ['avfoundation'] : ['dshow'];

const EXE_NAME = IS_MAC ? 'ffmpeg' : 'ffmpeg.exe';

async function findExe(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = await findExe(full);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === EXE_NAME) {
      return full;
    }
  }
  return null;
}

/**
 * Unzip `zip` into `dir`.
 *
 * Uses Windows' own bsdtar by absolute path, NOT whatever `tar` is on PATH:
 * when Git for Windows is installed its GNU tar shadows the system one, and
 * that build reads the `C:\...` in a Windows path as a remote host — it fails
 * with "Cannot connect to C: resolve failed". PowerShell's Expand-Archive is
 * the fallback for machines where the system tar is absent.
 */
function extract(zip, dir) {
  if (IS_MAC) {
    // ditto preserves the executable bit; unzip is also fine but ditto is the
    // macOS-native tool and is always present.
    execFileSync('ditto', ['-x', '-k', zip, dir], { stdio: 'inherit' });
    return;
  }

  const systemTar = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'tar.exe',
  );

  if (existsSync(systemTar)) {
    execFileSync(systemTar, ['-xf', zip, '-C', dir], { stdio: 'inherit' });
    return;
  }

  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`,
    ],
    { stdio: 'inherit' },
  );
}

/** Reject a build missing anything the recorder needs, rather than shipping it. */
function verify(exe) {
  const missing = [];
  const probe = (args) => spawnSync(exe, ['-hide_banner', ...args], { encoding: 'utf8' }).stdout ?? '';

  const filters = probe(['-filters']);
  for (const f of REQUIRED_FILTERS) {
    if (!new RegExp(`\\b${f}\\b`).test(filters)) missing.push(`filter ${f}`);
  }

  const encoders = probe(['-encoders']);
  for (const e of REQUIRED_ENCODERS) {
    if (!new RegExp(`\\b${e}\\b`).test(encoders)) missing.push(`encoder ${e}`);
  }

  // The capture device layer — without it there is no way to reach the screen
  // or the webcam at all, which is a more fundamental failure than a missing
  // filter and worth reporting separately.
  const devices = probe(['-devices']);
  for (const d of REQUIRED_DEVICES) {
    if (!new RegExp(`\\b${d}\\b`).test(devices)) missing.push(`device ${d}`);
  }

  return missing;
}

async function main() {
  if (!IS_MAC && process.platform !== 'win32') {
    console.error('Only Windows and macOS builds are fetched automatically. Skipping.');
    process.exit(0);
  }

  await mkdir(TMP, { recursive: true });
  await mkdir(DEST, { recursive: true });

  const zip = path.join(TMP, 'ffmpeg.zip');

  // Reuse an already-downloaded archive. This is ~170MB, and a failure during
  // extraction should not cost another download to retry.
  let haveZip = false;
  try {
    haveZip = (await stat(zip)).size > 50_000_000;
  } catch {
    haveZip = false;
  }

  if (haveZip) {
    console.log('Reusing previously downloaded archive.');
  } else {
    console.log(`Downloading ${URL}`);
    const res = await fetch(URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    console.log(`Downloaded ${(await stat(zip)).size} bytes`);
  }

  console.log('Extracting…');
  extract(zip, TMP);

  const exe = await findExe(TMP);
  if (!exe) throw new Error(`${EXE_NAME} not found in the archive`);

  const missing = verify(exe);
  if (missing.length) {
    throw new Error(
      `This build is missing: ${missing.join(', ')}. It would fail at record time — not installing it.`,
    );
  }
  const verified = [...REQUIRED_FILTERS, ...REQUIRED_ENCODERS, ...REQUIRED_DEVICES];
  console.log(`Verified: ${verified.join(', ')} all present.`);

  const dest = path.join(DEST, EXE_NAME);
  await copyFile(exe, dest);

  if (IS_MAC) {
    // copyFile does not carry the executable bit, and a downloaded binary is
    // quarantined — either one makes the spawn fail at record time with a
    // useless error.
    await chmod(dest, 0o755);
    try {
      execFileSync('xattr', ['-d', 'com.apple.quarantine', dest], { stdio: 'ignore' });
    } catch {
      // Absent when the file was never quarantined. Not a problem.
    }
  }

  await rm(TMP, { recursive: true, force: true });
  console.log(`Installed -> ${dest}`);
}

main().catch((err) => {
  // Deliberately NOT cleaning up .ffmpeg-tmp here: the download is ~170MB and
  // keeping it makes a retry after an extraction failure instant.
  console.error(`\nfetch-ffmpeg failed: ${err.message}`);
  console.error('You can instead drop ffmpeg.exe into resources/ffmpeg manually.');
  process.exit(1);
});
