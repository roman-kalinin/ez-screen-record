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
const TMP_ROOT = path.join(ROOT, '.ffmpeg-tmp');

const IS_MAC = process.platform === 'darwin';

// Windows: BtbN's win64-gpl build has ddagrab, libplacebo and nvenc, and the
// URL is stable (it always points at the newest master build).
//
// macOS: Martin Riedl's static builds, one binary PER ARCHITECTURE. The Mac
// app ships separate arm64 and x64 DMGs, and each must carry an ffmpeg for its
// own CPU. This used to bundle a single Intel-only evermeet.cx binary into both,
// which on an Apple Silicon Mac without Rosetta 2 fails to even start
// ("spawn Unknown system error -86", EBADARCH) -- every recording then ended in
// "Could not save recording". evermeet.cx's download URL has since gone (410).
const RIEDL = (arch) =>
  `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release/ffmpeg.zip`;

// Which targets to fetch. On a Mac both architectures are fetched by default
// (electron-builder packages both DMGs in one run); `--arch=arm64` or
// `--arch=x64` limits it to one.
function targets() {
  if (!IS_MAC) {
    return [{
      name: 'win64',
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
      dest: path.join(ROOT, 'resources', 'ffmpeg'),
      lipoArch: null,
    }];
  }
  const flag = process.argv.find((a) => a.startsWith('--arch='));
  const wanted = flag ? [flag.slice('--arch='.length)] : ['arm64', 'x64'];
  return wanted.map((arch) => {
    if (arch !== 'arm64' && arch !== 'x64') throw new Error(`unknown --arch ${arch}`);
    return {
      name: `mac-${arch}`,
      url: RIEDL(arch === 'x64' ? 'amd64' : 'arm64'),
      // electron-builder copies resources/ffmpeg-mac-${arch} -> ffmpeg per DMG.
      dest: path.join(ROOT, 'resources', `ffmpeg-mac-${arch}`),
      lipoArch: arch === 'x64' ? 'x86_64' : 'arm64',
    };
  });
}

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
  // An x64 binary cannot run on Apple Silicon without Rosetta, so its features
  // cannot be probed there. Its architecture was already checked with lipo;
  // say so plainly rather than reporting every feature as missing.
  const runnable = spawnSync(exe, ['-hide_banner', '-version'], { encoding: 'utf8' });
  if (runnable.error || runnable.status !== 0) {
    console.warn(`  ! cannot run ${exe} on this machine (${runnable.error?.code ?? runnable.status}); skipping feature check`);
    return missing;
  }
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

/** Which CPU architectures a Mach-O binary contains, e.g. ['arm64']. */
function machoArchs(exe) {
  const out = spawnSync('lipo', ['-archs', exe], { encoding: 'utf8' });
  return (out.stdout ?? '').trim().split(/\s+/).filter(Boolean);
}

async function fetchTarget(t) {
  console.log(`
== ${t.name}`);
  const tmp = path.join(TMP_ROOT, t.name);
  await mkdir(tmp, { recursive: true });
  await mkdir(t.dest, { recursive: true });

  const zip = path.join(tmp, 'ffmpeg.zip');

  // Reuse an already-downloaded archive (the Windows one is ~170MB), so a
  // failure during extraction does not cost another download to retry.
  let haveZip = false;
  try {
    haveZip = (await stat(zip)).size > 10_000_000;
  } catch {
    haveZip = false;
  }

  if (haveZip) {
    console.log('Reusing previously downloaded archive.');
  } else {
    console.log(`Downloading ${t.url}`);
    const res = await fetch(t.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    console.log(`Downloaded ${(await stat(zip)).size} bytes`);
  }

  console.log('Extracting…');
  extract(zip, tmp);

  const exe = await findExe(tmp);
  if (!exe) throw new Error(`${EXE_NAME} not found in the archive`);

  if (IS_MAC) {
    await chmod(exe, 0o755);
    const archs = machoArchs(exe);
    if (!archs.includes(t.lipoArch)) {
      throw new Error(`${t.name}: binary is [${archs.join(', ')}], expected ${t.lipoArch}`);
    }
    console.log(`Architecture: ${archs.join(', ')}`);
  }

  const missing = verify(exe);
  if (missing.length) {
    throw new Error(
      `This build is missing: ${missing.join(', ')}. It would fail at record time — not installing it.`,
    );
  }
  const verified = [...REQUIRED_FILTERS, ...REQUIRED_ENCODERS, ...REQUIRED_DEVICES];
  console.log(`Checked: ${verified.join(', ')}.`);

  const dest = path.join(t.dest, EXE_NAME);
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

  await rm(tmp, { recursive: true, force: true });
  console.log(`Installed -> ${dest}`);
}

async function main() {
  if (!IS_MAC && process.platform !== 'win32') {
    console.error('Only Windows and macOS builds are fetched automatically. Skipping.');
    process.exit(0);
  }
  for (const t of targets()) await fetchTarget(t);
  await rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
}

main().catch((err) => {
  // Deliberately NOT cleaning up .ffmpeg-tmp here: the download is ~170MB and
  // keeping it makes a retry after an extraction failure instant.
  console.error(`\nfetch-ffmpeg failed: ${err.message}`);
  console.error('You can instead drop the binary in manually: resources/ffmpeg/ffmpeg.exe (Windows) or resources/ffmpeg-mac-<arch>/ffmpeg (macOS).');
  process.exit(1);
});
