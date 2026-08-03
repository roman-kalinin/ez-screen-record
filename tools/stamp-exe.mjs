/**
 * Stamp the app icon and version metadata into the packaged .exe.
 *
 * electron-builder normally does this itself, but only as part of the same step
 * that signs the binary — and that step first unpacks a winCodeSign archive
 * containing macOS symlinks. Creating a symlink on Windows needs either admin
 * or Developer Mode, so on a stock machine the whole step fails and the build
 * produces no installer at all. It also re-extracts to a NEW random cache
 * directory every run, so pre-populating the cache does not help.
 *
 * With `win.signAndEditExecutable: false` the build succeeds, but the exe keeps
 * Electron's icon and identity ("Electron", "GitHub, Inc."). This restores the
 * branding using rcedit directly — the same tool electron-builder would have
 * used, minus the signing detour.
 *
 * Runs as electron-builder's `afterPack` hook, so it applies to win-unpacked
 * BEFORE NSIS wraps it into the installer.
 */

import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CACHE = path.join(
  process.env.LOCALAPPDATA ?? '',
  'electron-builder',
  'Cache',
  'winCodeSign',
);

/** Find any cached rcedit; every winCodeSign package ships the same one. */
function findRcedit() {
  const local = path.join(process.cwd(), 'tools', 'rcedit-x64.exe');
  if (existsSync(local)) return local;

  if (!existsSync(CACHE)) return null;
  for (const entry of readdirSync(CACHE)) {
    const candidate = path.join(CACHE, entry, 'rcedit-x64.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const { productFilename } = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${productFilename}.exe`);
  const icon = path.join(process.cwd(), 'build', 'icon.ico');

  const rcedit = findRcedit();
  if (!rcedit) {
    // Not fatal: the installer is still valid, it just carries Electron's
    // identity. Say so loudly rather than shipping wrong branding silently.
    console.warn(
      '\n  ! rcedit not found — the .exe will keep Electron’s icon and metadata.\n' +
        '    Drop rcedit-x64.exe into tools/ to fix.\n',
    );
    return;
  }

  const { productName, version, copyright } = context.packager.appInfo;

  execFileSync(rcedit, [
    exe,
    '--set-icon', icon,
    '--set-file-version', version,
    '--set-product-version', version,
    '--set-version-string', 'ProductName', productName,
    '--set-version-string', 'FileDescription', productName,
    '--set-version-string', 'CompanyName', 'joket',
    '--set-version-string', 'LegalCopyright', copyright ?? '',
    '--set-version-string', 'OriginalFilename', `${productFilename}.exe`,
    '--set-version-string', 'InternalName', productName,
  ]);

  console.log(`  • stamped icon and metadata into ${productFilename}.exe`);
}
