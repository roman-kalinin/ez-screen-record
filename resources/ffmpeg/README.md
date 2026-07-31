# Bundled ffmpeg

Drop `ffmpeg.exe` here before running `npm run dist` and it ships inside the
installer, so users do not need ffmpeg on their PATH.

If this folder has no `ffmpeg.exe`, the app falls back to whatever is on PATH.
That is fine for development, but a shipped build should bundle one.

## Which build

**Not `ffmpeg-static`.** That package ships a minimal build. This app needs all
three of:

- `ddagrab` — Desktop Duplication screen capture (the entire capture path)
- `libplacebo` — Vulkan compositing of camera/image overlays
- `h264_nvenc` — hardware encode

Use a **full** build:

- [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) — `ffmpeg-release-full`
- [BtbN](https://github.com/BtbN/FFmpeg-Builds/releases) — `ffmpeg-master-latest-win64-gpl`

Or fetch it automatically:

```
npm run fetch:ffmpeg
```

## Verify a candidate

```
ffmpeg -hide_banner -filters  | findstr /I "ddagrab libplacebo"
ffmpeg -hide_banner -encoders | findstr /I nvenc
```

All three must be present.

## Licensing

The GPL builds above make the distributed installer GPL-encumbered. For an
MIT-licensed release, either build ffmpeg as LGPL (no `--enable-gpl`, no x264 —
you lose the software-encode fallback but keep NVENC) or keep ffmpeg out of the
installer and require the user to install it.
