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
import { mkdir, rm, readdir, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'resources', 'ffmpeg');
const TMP = path.join(ROOT, '.ffmpeg-tmp');

// BtbN's win64-gpl build: has ddagrab, libplacebo and nvenc, and the URL is
// stable (it always points at the newest master build).
const URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

const REQUIRED_FILTERS = ['ddagrab', 'libplacebo'];
const REQUIRED_ENCODERS = ['h264_nvenc'];

async function findExe(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = await findExe(full);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === 'ffmpeg.exe') {
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

  const filters = spawnSync(exe, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '';
  for (const f of REQUIRED_FILTERS) {
    if (!new RegExp(`\\b${f}\\b`).test(filters)) missing.push(`filter ${f}`);
  }

  const encoders = spawnSync(exe, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
  for (const e of REQUIRED_ENCODERS) {
    if (!new RegExp(`\\b${e}\\b`).test(encoders)) missing.push(`encoder ${e}`);
  }

  return missing;
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('This fetcher targets the Windows build. Skipping.');
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
  if (!exe) throw new Error('ffmpeg.exe not found in the archive');

  const missing = verify(exe);
  if (missing.length) {
    throw new Error(
      `This build is missing: ${missing.join(', ')}. It would fail at record time — not installing it.`,
    );
  }
  console.log('Verified: ddagrab, libplacebo, h264_nvenc all present.');

  await copyFile(exe, path.join(DEST, 'ffmpeg.exe'));
  await rm(TMP, { recursive: true, force: true });
  console.log(`Installed -> ${path.join(DEST, 'ffmpeg.exe')}`);
}

main().catch((err) => {
  // Deliberately NOT cleaning up .ffmpeg-tmp here: the download is ~170MB and
  // keeping it makes a retry after an extraction failure instant.
  console.error(`\nfetch-ffmpeg failed: ${err.message}`);
  console.error('You can instead drop ffmpeg.exe into resources/ffmpeg manually.');
  process.exit(1);
});
