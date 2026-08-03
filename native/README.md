# Native capture accelerator (optional, Windows + NVIDIA only)

Windows Graphics Capture + D3D11 + NVENC. Keeps frames on the GPU end to end,
which is the only way past Desktop Duplication's ~57fps ceiling at 1440p.

**This is optional.** The app ships to Windows and macOS and runs fine without
it — `src/main/native-capture.ts` probes for the binary and silently falls back
to the portable ffmpeg path. Never make the app's build depend on it.

## Build (Windows only)

    cd native
    npm install node-addon-api node-gyp --no-save
    npx node-gyp configure && npx node-gyp build

Requires VS 2022 + Windows SDK 10.0.26100 or newer (`MinUpdateInterval`, needed
to exceed 60fps, ships in build 26100).

Node-API only, so the resulting `.node` is ABI-stable — it loads in both Node
and Electron with no `electron-rebuild`.

## Licensing

`include/nvEncodeAPI.h` is the MIT-licensed copy from FFmpeg/nv-codec-headers;
its per-file MIT grant is intact and must stay. No NVIDIA binary is
redistributed — `nvEncodeAPI64.dll` is loaded at runtime from the driver.
