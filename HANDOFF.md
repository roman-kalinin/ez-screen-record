# Ez Screen Record — Handoff / TODO

Context for another session picking up this work. Rewritten 2026-07-31 after the
frame-rate investigation; the previous version's conclusions were wrong and are
corrected below.

Repo: `github.com/roman-kalinin/ez-screen-record` (private), branch
**`feature/camera-on-screen`** (NOT merged to `main`).

Two recording engines:
- **Native (preferred):** ffmpeg + `ddagrab` → NVENC/libx264, 4:4:4.
  `src/main/native-recorder.ts`.
- **Browser fallback:** in-renderer `MediaRecorder`. `src/renderer/lib/recorder.ts`.

Entry point for recording decisions: `beginRecording` in `src/renderer/App.tsx`.

---

## HOW TO MEASURE — read this first

**Timestamps lie. Never judge frame rate from `pts`, `avg_frame_rate` or
`nb_frames`.** `ddagrab` defaults to `dup_frames=true` and pads gaps with
duplicate frames carrying perfect timestamps, so a juddering recording reports a
flawless 120fps. Count *unique* frames:

```
ffmpeg -i file.mp4 -vf mpdecimate -f null -     # the frame= count is unique frames
```

Two things that invalidated hours of measurement — avoid both:
- **Whatever window is in the foreground IS what you are measuring.** A terminal
  left on top made a healthy pipeline read as ~20 unique fps.
- `WmiMonitorListedSupportedSourceModes` reports EDID base modes (claimed 60Hz on
  a 165Hz panel). Use `(Get-CimInstance Win32_VideoController).CurrentRefreshRate`.

---

## RESOLVED

### 1. Colour swap + black box around the cursor — ✅ FIXED
Both were caused by the `format=rgba` step feeding libplacebo. Screen-only takes
now skip libplacebo entirely (`hwdownload,format=bgra` → encoder), which fixes
colours and the cursor together. libplacebo is used only when something is
actually composited. Verified visually.

### 2. Frame rate collapse with the camera on — ✅ FIXED (13.6 → 72.8 unique fps)
**Cause: the webcam paced the whole recording.** libplacebo's multi-input blend is
a framesync filter — `libplacebo_activate()` emits nothing while any input lacks a
queued frame and pins the output clock to the slowest input. A 30fps webcam
(~15fps in dim light) therefore gated a 120fps screen capture.

Measured and rejected — **do not retry these**: `fps=` before or after the overlay
(and `fps=` ON the blend is worse: it interpolates, 5.7 unique fps), explicit
`-vcodec mjpeg -framerate 30` on the input, `-rtbufsize`/`thread_queue_size`,
`filter_complex_threads`, a separate camera process, CPU `overlay`, `overlay_cuda`
(no yuv444p), and `eof_action`/`shortest`/`repeatlast` (**not valid libplacebo
options** — it errors `Option not found`).

**Fix:** take the camera out of ffmpeg's graph. `camera.showOnScreen` now defaults
to **true** (with a one-time migration in `settings.ts`): the bubble renders in an
always-on-top window, Windows composites it, ffmpeg captures a plain screen. This
is also the only mode that keeps the preview live, so both hard rules are met by
one decision.

### 3. End-of-take stall — ✅ FIXED
Every take lost 25–67 frames in its final ~0.6s (a 275–558ms gap) because the
process was torn down while the encoder drained. Stop timeout 10s → 15s.

### 4. Encoder — ✅ NVENC with x264 fallback
`h264_nvenc` supports `yuv444p`, so quality is unchanged (verified
`High 4:4:4 Predictive`) while the CPU is freed — x264 at yuv444p 1440p120
measured 143fps on 24 threads but only 94fps on 4. `x264PresetFor()` lowers the
speed preset (never chroma) when NVENC is absent, so weaker machines degrade
gracefully. 1080p60 is comfortable either way (3.3× at 4 threads).

**Colour range:** both NVENC and the existing x264 path tag `color_range=tv`.
Measured cost of limited vs full range on screen content: 39.86 dB vs 40.43 dB
PSNR — 0.57 dB, irrelevant next to the 36→46 dB gap that justified 4:4:4.

---

## OPEN

### 5. ddagrab's own ceiling — 🔴 the remaining frame-rate limit
Screen-only at 1440p with full-screen motion on a 165Hz display measured only
**~57 unique fps**, and `fps=` in ffmpeg's own progress output confirms it is
receiving that few. Desktop Duplication is bound to the DWM compositor rate and
only delivers on content change. Requesting a higher rate scales sub-linearly
(request 240 → ~77 unique fps) but never reaches the panel's real rate.

**Do NOT "fix" this by over-requesting.** The apparent "delivers ~62% of request"
ratio is an artifact of whatever was on screen while measuring, not a constant.

**Fix in progress:** the native path below.

### 6. Native WGC + NVENC path — 🟡 SCAFFOLDING ONLY, nothing calls it
`native/` builds and loads but is not wired into the app. Done: WGC session setup,
`LatestSlot`, capability probing. Verified on this machine — `isSupported()` and
`hasMinUpdateInterval()` both true (Windows 11 build 26200; the API needs 26100+),
compiles with plain node-gyp against VS 2022 + SDK 10.0.26100, and being Node-API
only it loads in both Node and Electron with no `electron-rebuild`.

**Not written:** NVENC encoder session, D3D11 compositor loop, webcam upload,
N-API wiring. Roughly 1500 lines of C++.

Pitfalls that fail *silently* — all documented inline in `native/src/capture.cpp`:
- `MinUpdateInterval` under 1000us disables the override; exactly `1/target`
  undershoots badly. Request ~1.5× faster and clamp at 1ms.
- WGC delivers only on content change → the fixed-rate loop must re-submit the
  last surface (this is also what makes the stream genuinely CFR, which matters
  because raw H.264 has nowhere to put a PTS).
- `ID3D11DeviceContext` is not thread-safe (the device is). Lock the immediate
  context; do not use deferred contexts.
- Media Foundation returns the *same* texture with a different array slice —
  `IMFDXGIBuffer::GetSubresourceIndex()` is mandatory or frames go stale.
- NVENC struct version macros OR in `(1u<<31)`; seed `NV_ENC_CONFIG` from
  `nvEncGetEncodePresetConfigEx`, and set `chromaFormatIDC = 3` or you silently
  get 4:2:0.
- Electron's main thread is STA — init MTA only on our own worker thread.
- Known upstream `E_ACCESSDENIED` from WGC in Electron: capture in the **main**
  process, and test elevated + non-elevated.

Mux by piping raw H.264 to the bundled ffmpeg:
`-f h264 -framerate <fps> -i pipe:0 -c:v copy -movflags +frag_keyframe+empty_moov`.
**`-framerate` defaults to 25** — omitting it on a 120fps stream gives a 4.8×-slow
file. Out-of-process muxing also survives a native crash with a playable file.

### 7. macOS backend — 🔵 separate project, researched not started
Mirrors Windows stage for stage: **ScreenCaptureKit → Metal → VideoToolbox →
AVAssetWriter**. `LatestSlot`, pacing, PTS logic and the N-API surface are shared;
everything touching the platform APIs is not (~70–80% of native line count).
Realistically 2–4 weeks.

Two things to steal immediately: OBS sets `minimumFrameInterval` ~10% *shorter*
than target (`1/132` for 120fps) to defeat a silent 60fps throttle, and
`SCFrameStatus.idle` must be handled or stale frames ship.

**Decision needed before starting:** VideoToolbox H.264 is **4:2:0 only** — there
is no macOS equivalent of NVENC H.264 4:4:4. Realistic macOS default is
high-bitrate HEVC 4:2:2. Note the 4:4:4 rule was written against a *browser 4:2:0*
regression, and 4:2:2 keeps full horizontal chroma, but this is the user's call.

Also researched and rejected: WebCodecs (4:2:0 only — the exact regression already
rejected), ffmpeg `avfoundation` (legacy pre-SCK path, poor), `scap` (MIT, wraps
both APIs, but capture-only and self-described as not production-ready).

---

## HARD RULES (user-stated)

1. **No recording-quality degradation, ever.** Native 4:4:4 is the baseline. Do not
   route camera takes through the browser MediaRecorder (a rejected 4:2:0
   regression).
2. **120fps must work with any camera.**
3. **The preview must stay live and editable during recording** — same behaviour
   and quality as before the take starts.
4. **The drawing tool must keep working** (transparent click-through overlay).
5. **Ships to Windows AND macOS**, working on most devices. Anything
   platform-specific must be an optional accelerator that degrades to the portable
   path, never a hard dependency.

Rules 2 and 3 are why `showOnScreen` defaults on: it is the only mode that
satisfies both.

---

## BUILD / TEST

- `npm run build`; typecheck `npx tsc -p tsconfig.json --noEmit` and
  `npx tsc -p tsconfig.main.json --noEmit`. `npm run dev` to run.
- Native addon (optional, Windows): see `native/README.md`.
- ffmpeg 8.1 full build (gyan.dev) with libplacebo, ddagrab, h264_nvenc.
- Test ffmpeg pipelines standalone before wiring, and **always count unique frames**.
