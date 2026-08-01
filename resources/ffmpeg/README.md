# Bundled ffmpeg

Drop the ffmpeg binary here before running `npm run dist` / `npm run dist:mac`
and it ships inside the installer, so users do not need ffmpeg on their PATH.

## Build your own slim one (Windows)

A stock full build is ~138 MB and is by far the largest thing in the installer.
`tools/build-ffmpeg-slim.sh` cross-compiles one containing only what this app
actually calls — **~19 MB, with identical output quality** (verified: 1440p60
comes out High 4:4:4 Predictive / yuv444p either way).

```sh
# In WSL or any Linux with mingw-w64:
bash tools/build-ffmpeg-slim.sh
cp ~/ffbuild/out/ffmpeg.exe resources/ffmpeg/
```

Read that script's header before changing the enable list: several of the
entries look redundant but are load-bearing, and omitting them fails at record
time with errors that point somewhere else entirely.

- Windows: `ffmpeg.exe`
- macOS: `ffmpeg` (must keep its executable bit)

If this folder is empty the app falls back to whatever is on PATH. That is fine
for development, but a shipped build should bundle one.

Fetch the right build for the current platform automatically:

```
npm run fetch:ffmpeg
```

It verifies the required features and refuses a build that would fail at record
time.

## Which build

**Not `ffmpeg-static`.** That package ships a minimal build missing everything
below.

### Windows

- `ddagrab` — Desktop Duplication screen capture (the entire capture path)
- `libplacebo` — Vulkan compositing of camera/image overlays
- `h264_nvenc` — hardware encode

Use a **full** build:

- [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) — `ffmpeg-release-full`
- [BtbN](https://github.com/BtbN/FFmpeg-Builds/releases) — `ffmpeg-master-latest-win64-gpl`

### macOS

- `avfoundation` — screen, camera and microphone capture
- `h264_videotoolbox` — hardware encode

[evermeet.cx](https://evermeet.cx/ffmpeg/) is the usual source. `libplacebo` is
**not** required: it is rare in macOS builds (Vulkan via MoltenVK) and only
affects burned-in overlays, which the recorder falls back from by keeping the
on-screen camera bubble instead.

The evermeet binary is Intel-only and runs under Rosetta 2 on Apple Silicon.
That is fine here — ffmpeg is a short-lived subprocess and the actual encoding
is done by the hardware encoder either way.

## Verify a candidate

Windows:

```
ffmpeg -hide_banner -filters  | findstr /I "ddagrab libplacebo"
ffmpeg -hide_banner -encoders | findstr /I nvenc
```

macOS:

```sh
ffmpeg -hide_banner -devices  | grep -i avfoundation
ffmpeg -hide_banner -encoders | grep -i videotoolbox
```

## Licensing

The GPL builds above make the distributed installer GPL-encumbered. For an
MIT-licensed release, either build ffmpeg as LGPL (no `--enable-gpl`, no x264 —
you lose the software-encode fallback but keep NVENC) or keep ffmpeg out of the
installer and require the user to install it.
