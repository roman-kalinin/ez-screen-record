#!/bin/bash
#
# Ez Screen Record — make the app open on macOS (removes the quarantine flag).
#
# WHY THIS EXISTS
# The app is ad-hoc signed, not signed with a paid Apple Developer ID. When a
# download/AirDrop/Slack/email attaches macOS's "com.apple.quarantine" flag,
# Gatekeeper shows an "unidentified developer" or "damaged and can't be opened"
# warning. This clears that flag for THIS ONE APP — exactly what right-click →
# Open used to do before Apple removed that option in macOS 15 (Sequoia).
#
# It does NOT disable Gatekeeper system-wide and needs no admin password.
#
# HOW TO USE
# Double-click this file in Finder. A Terminal window opens, does the one step,
# and tells you it's done — you don't type anything.

set -u

APP="/Applications/Ez Screen Record.app"

# If it hasn't been moved to Applications yet, look next to this script.
if [ ! -d "$APP" ]; then
  HERE="$(cd "$(dirname "$0")" && pwd)"
  if [ -d "$HERE/Ez Screen Record.app" ]; then
    APP="$HERE/Ez Screen Record.app"
  fi
fi

printf '\nEz Screen Record — clearing the macOS quarantine flag\n\n'

if [ ! -d "$APP" ]; then
  printf 'Could not find "Ez Screen Record.app".\n'
  printf 'Drag it into your Applications folder first, then double-click this again.\n\n'
  read -n 1 -s -r -p "Press any key to close this window."
  printf '\n'
  exit 1
fi

if xattr -cr "$APP" 2>/dev/null; then
  printf 'Done. "%s" will now open normally — just double-click it.\n' "$APP"
else
  printf 'Could not change the app (permission denied?).\n'
  printf 'Try: right-click the app in Finder, then Open.\n'
fi

printf '\nStill blocked? System Settings > Privacy & Security > scroll down > Open Anyway.\n'
printf 'To record, also enable Ez Screen Record under Screen & System Audio Recording,\n'
printf 'then quit and reopen the app.\n\n'

read -n 1 -s -r -p "Press any key to close this window."
printf '\n'
