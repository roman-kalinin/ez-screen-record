#!/usr/bin/env bash
#
# Build the macOS app (.dmg) from source, in one step.
#
# electron-builder cannot cross-build a Mac app from Windows/Linux — the
# signing, hardened runtime and .dmg tooling are macOS-only — so this must run
# ON a Mac. It installs dependencies, fetches the macOS ffmpeg build (with the
# videotoolbox/avfoundation features the recorder needs), then packages the app.
#
#   ./scripts/build-mac.sh
#
# The finished installer lands in release/ as:
#   Ez Screen Record <version> arm64.dmg   (Apple Silicon)
#   Ez Screen Record <version> x64.dmg      (Intel)
#
# See INSTALL-MACOS.md for how to install and grant permissions afterward.

set -euo pipefail

# Run from the repo root regardless of where the script was invoked.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script builds the macOS app and must be run on a Mac." >&2
  echo "On Windows, use: npm run dist  (builds the Windows installer)." >&2
  exit 1
fi

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

step "Checking prerequisites"
command -v node >/dev/null || { echo "Node.js is required (https://nodejs.org)." >&2; exit 1; }
command -v npm  >/dev/null || { echo "npm is required." >&2; exit 1; }
echo "node $(node -v), npm $(npm -v)"

step "Installing dependencies (npm install)"
npm install

step "Fetching the macOS ffmpeg builds (arm64 + x64)"
# One binary per architecture: each DMG must carry an ffmpeg for its own CPU.
# An Intel-only ffmpeg on an Apple Silicon Mac without Rosetta cannot start at
# all ("spawn Unknown system error -86"). Only fetch what is missing.
for arch in arm64 x64; do
  if [[ -x "resources/ffmpeg-mac-$arch/ffmpeg" ]]; then
    echo "resources/ffmpeg-mac-$arch/ffmpeg already present — skipping."
  else
    node tools/fetch-ffmpeg.mjs --arch="$arch"
  fi
done

step "Building the app and packaging the .dmg"
npm run dist:mac

step "Done"
echo "Installers are in ./release :"
ls -1 release/*.dmg 2>/dev/null || echo "  (no .dmg found — check the electron-builder output above)"
echo
echo "Next: open the .dmg, drag the app to Applications, then follow INSTALL-MACOS.md"
echo "to clear quarantine (if needed) and grant Screen Recording permission."
