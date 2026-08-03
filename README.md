# Ez Screen Record

A minimal screen recorder for Windows 11, built for recording tutorial videos.
Pick your sources, drop the webcam where you want it, draw on the screen when
you need to point at something — and get a single finished MP4 out.

## Running it

```powershell
npm install      # once
npm start        # build + launch
```

For development with hot-reloading renderers:

```powershell
npm run dev
```

To produce the Windows installer (output in `release/`):

```powershell
npm run dist
```

On a **Mac**, build the macOS app (`.dmg` in `release/`) with one command:

```sh
./scripts/build-mac.sh
```

See [INSTALL-MACOS.md](INSTALL-MACOS.md) for building and installing on macOS,
including Gatekeeper/quarantine and permission steps.

## How it works

Everything is composited **live** and burned into one file. What you arrange in
the preview is exactly what lands in the MP4 — no editing step afterwards.

```
screen capture ─┐
webcam ─────────┼─► canvas compositor ─► MediaRecorder ─► ffmpeg remux ─► .mp4
images ─────────┘
```

Annotations are handled differently and deliberately so: the drawing surface is
a real transparent window sitting over your desktop, so the screen capture picks
it up on its own. That keeps strokes perfectly in sync with the video and means
you're drawing on the actual apps you're demonstrating, not on a preview.

## Controls

| Key | Action |
| --- | --- |
| `F9` | Start / stop recording |
| `F10` | Pause / resume |
| `F8` | Toggle drawing overlay |
| `Ctrl+Shift+X` | Clear all drawings |

These are global — they work while another app is focused, which is the whole
point during a demo.

While the drawing overlay is active:

| Key | Tool |
| --- | --- |
| `P` | Pen |
| `H` | Highlighter |
| `A` | Arrow |
| `R` | Rectangle |
| `O` | Ellipse |
| `E` | Eraser |
| `Ctrl+Z` | Undo last stroke |
| `Del` | Clear all |
| `Esc` | Exit drawing |

The overlay is click-through whenever you're not actively drawing, so it never
gets in the way of the app you're recording.

## Positioning the webcam and images

Drag anything in the preview to move it; grab the corner handle to resize. All
positions are stored as fractions of the frame rather than pixels, so a layout
you arrange against a 1080p preview still lands correctly on a 1440p capture.

Changes made **during** a recording take effect immediately — you can reposition
the camera mid-take.

## Notes

- **The recorder hides itself from capture.** The control panel is marked with
  content protection, so it won't appear in your recordings even when you're
  capturing the entire screen.
- **Output is MP4.** MediaRecorder produces a WebM stream with no duration
  header, which makes editors mis-seek. If `ffmpeg` is on your PATH the app
  remuxes to MP4 (stream copy — lossless and near-instant) and fixes the
  metadata. Without ffmpeg you get the WebM as-is.
- **System audio** uses Windows loopback capture. If an app holds exclusive
  control of the audio device, it may come through silent.
- A missing or busy webcam degrades gracefully — the take continues without it
  rather than failing.

## The WinUI version

`winui/` holds a second, Windows-native front end built on WinUI 3. It shares
this app's recording pipeline — the ffmpeg filter graph is ported verbatim, and
the generated command lines are byte-equivalent — but draws its UI with real
Windows 11 chrome (Mica, native title bar, system accent) rather than a web view.

It is a companion, not a replacement: this Electron app remains the
cross-platform one and is unchanged. See `winui/README.md`.

## Layout

```
src/
  main/       Electron main process — windows, overlay, hotkeys, saving
    main.ts       window lifecycle, IPC, global shortcuts
    settings.ts   persistence with forward-compatible merging
    remux.ts      ffmpeg remux to MP4
  preload/    the single contextBridge surface
  renderer/
    App.tsx            control panel
    overlay.tsx        transparent annotation surface
    components/        LayoutStage (drag/resize), SourcePicker
    lib/recorder.ts    capture, compositing and encoding
  shared/     types shared across processes
```
