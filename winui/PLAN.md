# WinUI 3 port — plan

A second, Windows-native front end for Ez Screen Record, living beside the
Electron app rather than replacing it. Goal: native Windows 11 look and feel,
full feature parity with the Electron version.

Nothing in this folder is built yet. This document is the agreed plan.

## Why this is a rewrite and not a port

Three quarters of the Electron app is web code with no mechanical translation
to XAML:

| Electron | Lines | Fate under WinUI |
| --- | ---: | --- |
| `renderer/App.tsx` | 1510 | Rewrite — XAML + C# |
| `renderer/lib/recorder.ts` | 667 | **Delete.** Canvas + MediaRecorder has no equivalent |
| `renderer/components/LayoutStage.tsx` | 662 | Rewrite on Win2D `CanvasControl` |
| `renderer/overlay.tsx` | 397 | Rewrite as a Win32 layered window |
| `renderer/toolbar.tsx` + `camera.tsx` | 747 | Rewrite as separate WinUI windows |
| `main/main.ts` | 1016 | Rewrite — window/IPC orchestration is Electron-shaped |
| `main/native-recorder.ts` | 739 | **Logic reusable.** The ffmpeg graph is the asset |
| `main/window-list.ts` | 170 | Near-direct — already P/Invoke-shaped |
| `main/capture-backend.ts` | 146 | Windows half survives; macOS half drops |
| `native/` (C++ WGC + NVENC) | ~700 | **Reusable** — already native Windows |
| `main/mac-permissions.ts`, macOS paths | ~200 | Not applicable |

The genuinely valuable, hard-won parts — the tuned ffmpeg filter graph, the
HDR gamma correction, the WGC/NVENC C++ — all survive. The UI does not.

## Correction to the size premise

The 148 MB installer was **not** Electron's runtime. Two things dominated it,
and both are now fixed — in the Electron app, with no WinUI rewrite involved:

| Component | Before | After |
| --- | ---: | ---: |
| `ffmpeg.exe` (BtbN full GPL build → slim build) | 138.5 MB | 19.9 MB |
| `app.asar` (production `node_modules` shipped by default) | 189.0 MB | 1.0 MB |
| **Installer total** | **147.9 MB** | **83.5 MB** |

An earlier draft of this document claimed Electron compressed to ~9 MB. That
was arithmetic on the installer/ffmpeg difference rather than a measurement,
and the asar bloat hid behind it.

What remains is genuinely Chromium, and it is the one part a WinUI build would
avoid: a self-contained WinUI app with the same bundled ffmpeg should land
around 40-60 MB. That is a real difference, but it arrives only at the end of
a full rewrite. **Do not justify the port on size — justify it on native look
and feel.**

## Layout

```
winui/
  EzScreenRecord.sln
  EzScreenRecord/           WinUI 3 app — C#, .NET 9, unpackaged
  EzScreenRecord.Capture/   C#/WinRT wrapper over ../native (WGC + NVENC)
  EzScreenRecord.Overlay/   Win32 layered window for annotations
```

The Electron app is untouched. `native/` is shared by both and must keep
building for Node — do not break its `binding.gyp`.

## Phases

### Phase 1 — Scaffold and source picker

- WinUI 3 project, .NET 9, unpackaged deployment.
- Mica backdrop (`MicaBackdrop`) and `AppWindowTitleBar` for the custom title
  bar. This is the direct analogue of `platform-window.ts`'s Windows branch;
  the Mica-on-maximize caveat there is an Electron bug and does not apply.
- Port `window-list.ts` → C#. It is already `EnumWindows`/`GetWindowText`
  P/Invoke logic, so it maps almost line for line.
- Port `SourceDialog.tsx` → a XAML `ContentDialog` with a `GridView` of
  thumbnails.

Deliverable: launches, looks native, lists monitors and windows. No recording.

### Phase 2 — Screen recording

- `EzScreenRecord.Capture`: C# wrapper over the existing C++.
- Shell out to the same bundled `ffmpeg.exe` with the graph from
  `native-recorder.ts`, minus the macOS branches.
- Port `settings.ts` (small — JSON to `%APPDATA%`).

**Known gap:** `native/src/addon.cpp` exports only `isSupported`,
`hasMinUpdateInterval`, `hasNvenc`, `captureTest` and `selfTest`. It is a
validated spike, not a production capture path — there is no start/stop or
frame-delivery API. The C++ capture and encode internals in `capture.cpp` /
`encoder.cpp` are real and reusable, but a session API has to be written. That
work benefits the Electron app equally and should be done in C++ behind a
neutral interface, not in C# glue.

Deliverable: F9 records the screen to a playable MP4.

### Phase 3 — Live compositor

- Port `LayoutStage.tsx` to Win2D `CanvasControl`: drag/resize of camera and
  image overlays, with fractional (not pixel) coordinates preserved — that is
  what makes a 1080p-preview layout land correctly on a 1440p capture.
- Camera preview via `MediaCapture` / `MediaPlayerElement`.
- Feed overlay rects into the existing `libplacebo` ffmpeg graph.

Deliverable: camera and image overlays burned into the recording, positionable
mid-take as they are today.

### Phase 4 — Annotation overlay (highest risk)

The drawing surface must be a real transparent, click-through, always-on-top
window over the desktop, because the screen capture picks it up on its own —
that is what keeps strokes in sync with the video.

WinUI 3 does not do per-pixel alpha well. Plan for a **Win32 layered window
(`WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW`) hosting a Win2D
swap-chain**, not a XAML `Window`.

Carry over from the Electron implementation:
- Click-through toggling — the analogue of `setIgnoreMouseEvents(true, {forward: true})`.
- Tools: pen, highlighter, arrow, rectangle, ellipse, eraser; undo; clear.
- Keeping the toolbar out of the capture. On Windows this is
  `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, which is what Electron's
  `setContentProtection` calls underneath. The documented trap — that it
  silently depends on `WS_EX_LAYERED` and breaks when that style is cleared —
  applies here too, and applies *more* directly since we manage the style
  ourselves. Verify with `tools/check-display-affinity.ps1`.

This phase is the most likely to stall. Evaluate it before committing to the
remaining phases.

### Phase 5 — Hotkeys, settings, packaging

- Global F8/F9/F10 and Ctrl+Shift+X via `RegisterHotKey` (Electron's
  `globalShortcut` is the same Win32 call underneath).
- Settings UI.
- Packaging: unpackaged + WiX, or MSIX for Store distribution.

## Risks

1. **Phase 4** — transparent click-through overlays are a real WinUI 3 weak
   spot. Highest chance of forcing a rethink.
2. **Divergence** — two front ends over one pipeline. Every capture fix must be
   applied twice unless shared logic is pushed down into `native/`.
3. **`native/` has no session API** — Phase 2 is larger than the addon's
   existence suggests. See the gap noted above.
4. **NVENC-only** — the native path needs an NVIDIA GPU. The ffmpeg fallback
   must stay, so both paths need maintaining regardless.

## Status

All five phases are implemented and building. See `winui/README.md` for how to
build and run, and the git history for what each phase entailed.

The riskiest call in this plan turned out to be wrong in a good way: **Phase 4
was not the blocker.** WinUI 3 handles the transparent click-through overlay,
and `--overlay-selftest` verifies all 13 window-style and hotkey properties,
including that display affinity survives the interactivity toggle that silently
dropped it in Electron.

Still outstanding, and each is honest in the UI rather than silently absent:

- **Window capture** — ddagrab captures whole outputs, so a window source
  records the display it sits on.
- **Pause** — ffmpeg has no pause; it needs process suspension plus timestamp
  stitching.
- **System audio** — the mic path works; loopback capture is not wired up.
- **The `native/` session API** — still unbuilt, and still needed by both front
  ends. See the gap noted under Phase 2.

## Follow-up

The ffmpeg slimming that was queued here is **done** (138.5 MB → 19.9 MB), as
is a much larger asar fix; both landed in the Electron app and are reflected in
the table above.

It stayed GPL rather than becoming LGPL. Dropping x264 would have left
Intel-graphics machines with no encoder at all, and `libmfx` (QSV) needs an SDK
outside this toolchain. `tools/build-ffmpeg-slim.sh` documents how to revisit
that if the MIT release matters more than recording on those machines.
