#!/bin/bash
#
# Ez Screen Record — one-line installer for macOS.
#
#   curl -fsSL https://roman-kalinin.github.io/ez-screen-record/install.sh | bash
#
# Downloads the latest release DMG for this Mac's CPU (Apple Silicon or Intel),
# copies the app into /Applications, clears the download quarantine flag (the
# app is ad-hoc signed, not notarized) and opens it.

set -euo pipefail

REPO="roman-kalinin/ez-screen-record"
APP_NAME="Ez Screen Record"
# Builds older than this bundle an Intel-only ffmpeg that cannot start on an
# Apple Silicon Mac without Rosetta ("spawn Unknown system error -86").
MIN_VERSION="1.5.1"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || fail "This installer is for macOS."

case "$(uname -m)" in
  arm64)  ARCH="arm64"; KIND="Apple Silicon" ;;
  x86_64)
    # An Intel shell on Apple Silicon (Rosetta Terminal) still wants arm64.
    if [[ "$(sysctl -in hw.optional.arm64 2>/dev/null)" == "1" ]]; then
      ARCH="arm64"; KIND="Apple Silicon"
    else
      ARCH="x64"; KIND="Intel"
    fi ;;
  *) fail "Unsupported CPU: $(uname -m)" ;;
esac

say "Looking up the latest release for ${KIND}…"
RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" \
  || fail "Could not reach GitHub. Check your internet connection and try again."

TAG="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"v\{0,1\}\([^"]*\)"$/\1/')"
URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*'"$ARCH"'\.dmg"' | head -1 | sed 's/.*"\(https[^"]*\)"$/\1/')"

# Is the published version at least MIN_VERSION?
version_ok() {
  awk -v a="$1" -v b="$MIN_VERSION" 'BEGIN {
    split(a, x, "."); split(b, y, ".");
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 0 }'
}

if [[ -z "$URL" ]] || ! version_ok "${TAG:-0}"; then
  fail "The fixed Mac build ($MIN_VERSION) isn't published yet. Please try again a bit later."
fi

TMP="$(mktemp -d)"
MNT="$TMP/mnt"
cleanup() {
  hdiutil detach "$MNT" -quiet >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

say "Downloading $APP_NAME $TAG ($ARCH)…"
curl -fL --progress-bar -o "$TMP/app.dmg" "$URL" || fail "Download failed."

say "Installing…"
mkdir -p "$MNT"
hdiutil attach "$TMP/app.dmg" -nobrowse -quiet -mountpoint "$MNT" || fail "Could not open the disk image."
SRC="$MNT/$APP_NAME.app"
[[ -d "$SRC" ]] || fail "The disk image does not contain $APP_NAME.app."

# /Applications is writable for admin accounts; fall back to ~/Applications.
DEST_DIR="/Applications"
[[ -w "$DEST_DIR" ]] || { DEST_DIR="$HOME/Applications"; mkdir -p "$DEST_DIR"; }
DEST="$DEST_DIR/$APP_NAME.app"

# Quit a running copy so it can be replaced.
osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
sleep 1

rm -rf "$DEST"
ditto "$SRC" "$DEST"
xattr -cr "$DEST" 2>/dev/null || true

say "Installed to $DEST"
open "$DEST"

cat <<'EOF'

Done. On first launch macOS will ask for Screen Recording (and, if you use
them, Camera and Microphone) permission. After granting Screen Recording,
quit and reopen the app once.
EOF
