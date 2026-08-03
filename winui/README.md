# Ez Screen Record — WinUI 3

A native Windows front end, built beside the Electron app rather than replacing
it. Same recording pipeline, same output; the difference is that the chrome is
the real Windows 11 article — Mica, native title bar, system accent — instead of
a web view imitating it.

The Electron version is unchanged and still the cross-platform one. This is
Windows-only by construction.

## Building

```powershell
cd winui
dotnet build EzScreenRecord\EzScreenRecord.csproj
```

Needs the .NET 9 SDK and Windows SDK 10.0.26100. The Windows App SDK arrives as
a NuGet package, so there is no workload to install.

To publish a self-contained build with ffmpeg staged beside it:

```powershell
.\build.ps1
```

## Self-test

The annotation overlay's window behaviour is verified without a human:

```powershell
.\bin\Debug\net9.0-windows10.0.26100.0\win-x64\EzScreenRecord.exe --overlay-selftest
```

13 checks covering per-pixel alpha, click-through toggling, capture exclusion
and global hotkey registration. Results go to `%TEMP%\ez-overlay-selftest.txt`
and the exit code is non-zero on failure. Worth running after any change to
window styles — every property it checks can be set successfully and then
silently dropped by a later call.

## Layout

```
EzScreenRecord/
  Capture/     Recorder (the ffmpeg graph), source enumeration, thumbnails
  Interop/     Win32 P/Invoke, global hotkeys
  Models/      Settings, persisted to %APPDATA%\Ez Screen Record
  Views/       Layout stage, source picker, overlay, toolbar, camera bubble
```

## What carried over, and what did not

The valuable part of the Electron app is not its UI — it is the tuned ffmpeg
filter graph and the measurements behind it. That transferred intact:
`Capture/Recorder.cs` generates command lines byte-equivalent to
`src/main/native-recorder.ts` for the same inputs, and `LayoutGeometry` matches
`LayoutStage.tsx`'s resize maths to four decimal places across its edge cases.

The renderers did not transfer. `recorder.ts` (canvas + MediaRecorder) has no
WinUI equivalent and is simply absent; the ffmpeg path was always the
higher-quality one and is now the only one.

### Differences worth knowing

- **Window capture** is not wired up. ddagrab captures whole outputs, so a
  window source currently records the display it sits on, and the UI says so.
- **Pause** is not implemented. ffmpeg has no pause; it would mean suspending
  the process and stitching timestamps afterwards. The hotkey reports this
  rather than silently doing nothing.
- **System audio** is not captured yet. The mic path works.

## Notes for whoever touches this next

Four failure modes here cost real time and none of them report the actual
problem:

1. **The XAML compiler exits 1 and prints nothing** when a comment contains
   `--`. It is illegal in XML, and MSBuild surfaces only "exited with code 1".
2. **`required` members break the generated XamlTypeInfo**, which constructs
   bindable types with a parameterless `new`. Use property initialisers.
3. **LINQ cannot enumerate WinRT collection projections** such as
   `DisplayArea.FindAll()`. `Min`/`Max` throw
   `InvalidCastException("No such interface supported")` from inside the
   projection, which surfaces as a `0xC0000409` crash. Use indexed loops.
4. **`SetWindowDisplayAffinity` silently depends on `WS_EX_LAYERED`** and
   returns TRUE even when the prerequisite is missing. Anything that rewrites
   the ex-style word — including toggling click-through — drops the affinity
   with no error, and the toolbar reappears in the recording. Always re-assert
   the style and read the affinity back.
