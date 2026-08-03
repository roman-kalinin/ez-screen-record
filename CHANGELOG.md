# Changelog

Versions follow [semver](https://semver.org/): `MAJOR.MINOR.PATCH` — a patch
release is bugfixes only, a minor release adds behaviour, a major release breaks
something. The version is stamped into the installer filename
(`Ez Screen Record Setup 1.2.0.exe`) and shown in the app's Settings menu, so an
installed copy can always be identified.

## 1.4.0 — 2026-08-03

### Added
- **Optional macOS menu-bar icon (off by default).** Enable it under Settings →
  Recording behaviour → "Show menu bar icon". It adds an Ez Screen Record status
  item with quick actions — Open, Start/Stop Recording, Pause/Resume (enabled
  while recording), Toggle Drawing, Settings…, the version, and Quit. The
  recording actions reuse the same paths as the global shortcuts, so they behave
  identically to the in-app controls, and the Start/Stop and Pause/Resume labels
  track the current take.

## 1.3.3 — 2026-08-03

### Fixed
- **First recording after launch was low quality.** Chromium's desktop capturer
  reports a small placeholder size (~1280×720) on its first frame and ramps to
  full resolution a beat later; the recorder trusted that first number and
  pinned the whole take to a low resolution and bitrate. Later takes were fine
  because the capturer was already warm. It now waits for the reported size to
  settle before sizing the canvas and choosing the bitrate.
- **A window source smaller than the screen was stretched when picked
  mid-recording.** The canvas is fixed to the screen's size for the whole take,
  so a smaller/different-shaped source was distorted to fill it. Sources are now
  letterboxed to preserve their aspect ratio; a full-screen source still fills
  edge-to-edge exactly as before.
- **macOS: no dock icon.** The app came up as an accessory (NSApplication
  UIElement), so its dock icon flashed at launch and then disappeared and could
  not be pinned. It now forces a regular activation policy on macOS and shows
  the dock tile.

## 1.3.2 — 2026-08-03

### Fixed
- **macOS: the main window was left squeezed against the left edge of the screen
  during a recording.** To keep the browser engine's canvas compositor running,
  the control window is parked out of sight rather than hidden — but it did this
  by moving off-screen to `x: -32000`, and macOS clamps a window's position to
  keep it partly on the desktop, so it stayed visible. On macOS it is now hidden
  by making it fully transparent and click-through for the duration of the take
  (the renderer stays live, so the recording keeps compositing) and restored
  when the take ends. Windows still parks off-screen.

## 1.3.1 — 2026-08-03

### Fixed
- **macOS kept showing the screen-recording indicator after the app was
  closed.** Closing the window (especially via the native traffic light, which
  skips the in-app "stop first" prompt) left the ffmpeg/avfoundation capture
  process running, so macOS still believed a recording was in progress. The app
  now force-kills any active capture — the recorder and the system-audio helper
  — when the control window closes and again on `before-quit`, and closing the
  controller quits the app deterministically instead of leaving it alive behind
  its hidden overlay windows.

## 1.3.0 — 2026-08-03

### Added
- **Auto source selection on first launch.** With nothing saved yet, the app now
  picks the first microphone in the list and defaults to capturing the whole
  primary screen, so a new install can record immediately without opening the
  pickers. (The camera already defaulted to the first device.)

### Changed
- **The browser ("Flexible") engine is now the default capture engine.** It is
  the most stable across platforms — records single windows, switches source
  mid-take with no seam, and does not depend on the OS hardware-encoder path
  that can stutter. Existing installs keep whatever engine they had saved; only
  fresh installs get the new default. Switch to "Best quality" for maximum text
  sharpness on a machine whose ffmpeg encode keeps up in real time.

### Fixed
- **macOS window header.** The control window was built with Windows-only chrome
  and never knew the platform, so on macOS the native traffic lights overlapped
  the app title and the app drew its own Minimize/Close buttons that duplicated
  the system controls. macOS now centres the real traffic lights in the title
  bar, insets the title clear of them, and hides the duplicate buttons (the
  keep-on-top pin stays — it has no native equivalent).
- **macOS ffmpeg ("Best quality") engine stutter.** `h264_videotoolbox` now
  encodes with `-realtime`/`-prio_speed`, so it keeps pace with live capture
  instead of queuing frames, and the screen-only filter path does a single
  swscale conversion (was two) with a cheaper `bilinear` downscale. The Windows
  ddagrab + NVENC path is unchanged.

## 1.2.1 — 2026-08-03

### Fixed
- **macOS: the source picker showed "No screens found" when Screen Recording
  permission was missing.** On macOS `desktopCapturer.getSources` *throws* when
  the permission is denied rather than returning an empty list, and the
  rejection surfaced as a bare, empty picker with no explanation. The list call
  now swallows that error, and the picker reads the permission state and shows a
  "Screen Recording permission needed" panel with a button that deep-links
  straight to the correct System Settings pane, plus the reminder to quit and
  reopen the app so macOS actually applies the grant.

### Housekeeping
- `scripts/build-mac.sh` is now marked executable, so `./scripts/build-mac.sh`
  runs directly instead of failing with "permission denied".
- Added `scripts/Fix-Ez-Screen-Record.command`, a double-clickable helper that
  clears the macOS quarantine flag for users who receive the app by download,
  Slack, email or AirDrop — no Terminal typing required.

## 1.2.0 — 2026-08-03

### Added
- **System (desktop) audio on the ffmpeg "crisp" engine (Windows).** ffmpeg has
  no WASAPI/loopback input on Windows, so a small bundled helper
  (`ez-audio-loopback.exe`) captures the default playback endpoint to a WAV,
  which is muxed into the finished recording. The helper pauses and resumes in
  lockstep with the take's segment boundaries, so the audio drops exactly the
  same span the video does and never drifts. When a microphone is also recorded
  the two are mixed; muxing is best-effort, so a failure leaves a valid,
  audio-less recording rather than losing the take.

### Fixed
- **System audio on the browser ("overlay") engine.** It used a legacy
  `getUserMedia({ chromeMediaSource: 'desktop' })` loopback path that yields no
  audio track on current Electron, so desktop sound was silently missing. It now
  uses `getDisplayMedia` answered with `audio: 'loopback'`, the supported route.
- **The on-screen camera bubble no longer duplicates or ghosts in the
  recording.** Dragging it left a frozen copy at the old position (the overlay
  window was captured *and* composited — now excluded from capture), teleported
  on release (the live rect is now streamed to the recorder each frame), and
  left a stale ghost on the layered window (now repainted per frame).

### Housekeeping
- Repo-wide cleanup: corrected inaccurate comments, removed dead code, and fixed
  three latent bugs (wrong-display fallback in the display-media handler,
  front-trimming that deleted the user's oldest image overlays past the cap, and
  the toolbar not re-enumerating devices plugged in mid-take).

## 1.1.0 — 2026-08-03

### Fixed
- **Pause now works on the ffmpeg engine.** It previously did nothing at all:
  `togglePause` only ever spoke to the browser recorder, whose state is
  `inactive` during a native take, so the click fell through in silence.
  ffmpeg has no pause, so each pause now finalises a segment and each resume
  spawns the next; stop rejoins them losslessly with the concat demuxer. A
  take that was never paused is a single segment and is simply moved into
  place, so ordinary recording needs no concat support at all.
- **Recording no longer starts before ffmpeg is ready.** Start waited a flat
  1800ms, then briefly keyed off `Output #0` — which ffmpeg prints while still
  opening devices (~200ms), nearly two seconds before the first real frame
  (~2180ms on a 1440p ddagrab path). Readiness is now a non-zero `frame=`
  count, with the timeout kept only as a backstop.
- **The elapsed clock counts the startup period.** It was anchored after the
  readiness wait rather than at process launch, so every take under-reported
  itself by however long ffmpeg took to come up.
- **Changing the source mid-take restores the toolbar.** Opening the picker
  hides the toolbar so the dialog can be seen, but nothing put it back —
  closing it left the main window on screen with its content hidden and no
  toolbar, while the take kept running.
- **The toolbar learns about pause.** It lives in its own window and only sees
  state pushed over IPC; nothing pushed on pause, so the bar kept showing a
  Pause button on a held take.

### Added
- A paused take is now unmistakable: a **"Paused"** badge, an amber status dot
  that stops pulsing, an amber timer, and an amber pause button — on both the
  main window and the recording toolbar.
- **"Starting…", "Pausing…" and "Resuming…"** states. Spawning or finalising an
  ffmpeg segment takes a moment, and the controls used to absorb the click and
  look dead until it finished; the transition is now shown immediately and the
  button is disabled while it runs.
- The status dot now pulses while recording, so live and held are distinct at a
  glance.
- The app version is shown in the Settings menu.
- `EZ_FFMPEG_DEBUG=1` writes the exact ffmpeg command and full stderr to
  `ffmpeg-debug.log` beside the recording.
- The bundled ffmpeg build now enables the concat demuxer, so joining paused
  segments needs no system ffmpeg.

### Changed
- Record, Stop, Pause and Play use filled icons instead of outlines. The thin
  outline variants were hard to read on the dark toolbar over arbitrary desktop
  content.

## 1.0.0

Initial release.
