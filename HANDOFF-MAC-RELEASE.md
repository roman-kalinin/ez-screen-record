# Handoff: build and publish the macOS 1.5.1 release

For the Claude Code session on the MacBook. Written 2026-11-16 from the Windows machine.

## Why

A friend on an Apple Silicon Mac got **"Could not save recording — spawn Unknown system error -86"**.
Error -86 is `EBADARCH` ("Bad CPU type in executable"). Both Mac DMGs bundled the same
**Intel-only** ffmpeg (from evermeet.cx), and on an Apple Silicon Mac without Rosetta 2 it
cannot start. Node throws that error synchronously from `spawn()`, which escaped
`hasFfmpeg()`/`remuxToMp4()` and turned every save into a failure, even though the WebM
had already been written to disk.

Branch `feat/video-editor` has the fix commit:

- `src/main/remux.ts`: `runFfmpeg` catches synchronous `spawn` throws, so a broken
  ffmpeg just means "no ffmpeg" (the browser engine is used and the recording stays WebM).
- `src/main/main.ts`: `recording:save` never fails because of the remux step.
- `tools/fetch-ffmpeg.mjs`: on macOS, fetches **one ffmpeg per architecture** from
  Martin Riedl's static builds (evermeet.cx now returns 410) into
  `resources/ffmpeg-mac-arm64/` and `resources/ffmpeg-mac-x64/`, and checks the arch with `lipo`.
- `package.json`: version 1.5.1. `extraResources` moved per platform; mac copies
  `resources/ffmpeg-mac-${arch}` → `Contents/Resources/ffmpeg`, so each DMG gets its own binary.
- `scripts/build-mac.sh`: fetches both arches.
- `site/`: landing page + `install.sh` (one-line installer), published on GitHub Pages
  from the `gh-pages` branch at https://roman-kalinin.github.io/ez-screen-record/

GitHub Actions minutes for macOS are used up, so the build has to happen locally on this Mac.

## Steps

1. `git fetch && git checkout feat/video-editor && git pull`
2. Remove any old shared binary so it can't be confused with the new ones:
   `rm -rf resources/ffmpeg/ffmpeg .ffmpeg-tmp`
3. `./scripts/build-mac.sh`
   - If the arm64 fetch fails its feature check (needs `h264_videotoolbox` and `avfoundation`),
     stop and report back instead of shipping it. The x64 feature check is skipped
     automatically if Rosetta isn't installed; the arch check still runs.
4. Verify that each packaged app carries the right ffmpeg:
   ```sh
   lipo -archs "release/mac-arm64/Ez Screen Record.app/Contents/Resources/ffmpeg/ffmpeg"   # → arm64
   lipo -archs "release/mac/Ez Screen Record.app/Contents/Resources/ffmpeg/ffmpeg"         # → x86_64
   ```
   (The x64 output folder may be named `release/mac` or `release/mac-x64`; check `ls release`.)
5. Smoke test the arm64 app: open it, record about 5 seconds on the browser engine and on the
   "crisp" (ffmpeg) engine, and confirm both save as `.mp4` without an error toast.
6. Publish the release. gh turns the spaces in the asset names into dots, which is what
   `install.sh` expects (`…arm64.dmg` / `…x64.dmg`):
   ```sh
   gh release create v1.5.1 "release/Ez Screen Record 1.5.1 arm64.dmg" "release/Ez Screen Record 1.5.1 x64.dmg" \
     --title "Ez Screen Record 1.5.1" \
     --notes "Fix 'spawn Unknown system error -86' on Apple Silicon Macs: each Mac build now ships an ffmpeg for its own CPU, and a failing ffmpeg can no longer make a save fail."
   ```
   If a Windows installer for 1.5.1 is wanted too, it gets built on the Windows machine and
   added later with `gh release upload v1.5.1 …`.
7. Test the one-liner exactly as a user would:
   ```sh
   curl -fsSL https://roman-kalinin.github.io/ez-screen-record/install.sh | bash
   ```
   Until step 6 is done it deliberately refuses to install (it requires ≥ 1.5.1, so it never
   installs the broken 1.4.0).
8. Add a 1.5.1 entry to `CHANGELOG.md`, commit, push.

## Editing the landing page

Its source is `site/` on the feature branch. The live copy is the `gh-pages` branch
(only `index.html`, `install.sh`, `icon.png`). After changing `site/`, copy the files onto
`gh-pages` and push.
