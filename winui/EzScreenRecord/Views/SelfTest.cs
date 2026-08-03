using EzScreenRecord.Capture;
using EzScreenRecord.Interop;
using EzScreenRecord.Models;
using Microsoft.UI.Dispatching;

namespace EzScreenRecord.Views;

/// <summary>
/// All of the app's self-checks, reported live into a visible window.
///
/// Run with <c>EzScreenRecord.exe --selftest</c>. Checks appear on screen as
/// they execute, so a slow step is visibly a slow step rather than an app that
/// might be hung. A plain-text copy is written to
/// <c>%TEMP%\ez-selftest.txt</c> for scripting, and the exit code is non-zero
/// on failure -- but the window is the primary channel.
/// </summary>
internal static class SelfTest
{
    private static string ReportPath =>
        Path.Combine(Path.GetTempPath(), "ez-selftest.txt");

    public static void Run()
    {
        var window = new SelfTestWindow("Ez Screen Record — self-test");
        window.Activate();

        var queue = window.DispatcherQueue;

        // Off the UI thread so the window paints each line as it arrives; the
        // checks themselves are slow enough (PrintWindow, ffmpeg probes) that
        // running them inline would freeze the window until the very end.
        _ = Task.Run(async () =>
        {
            void Section(string s) => queue.TryEnqueue(() => window.Section(s));
            void Info(string s) => queue.TryEnqueue(() => window.Info(s));
            void Check(string n, bool ok) => queue.TryEnqueue(() => window.Check(n, ok));
            void Error(string s) => queue.TryEnqueue(() => window.Error(s));

            // A beat between groups so progress is legible rather than a wall
            // of text appearing at once.
            async Task Breathe() => await Task.Delay(120);

            try
            {
                await RunSources(Section, Info, Check, Error, Breathe);
                await RunFfmpeg(Section, Info, Check, Breathe);
                await RunOverlay(queue, Section, Info, Check, Error, Breathe);
                await RunHotkeys(Section, Info, Check, Breathe);
            }
            catch (Exception ex)
            {
                Error($"Unhandled: {ex}");
            }

            queue.TryEnqueue(() => window.Done(ReportPath));
        });
    }

    // --- Sources ------------------------------------------------------------

    private static async Task RunSources(
        Action<string> section, Action<string> info,
        Action<string, bool> check, Action<string> error, Func<Task> breathe)
    {
        section("Displays");
        await breathe();
        try
        {
            var monitors = MonitorList.Enumerate();
            check($"enumerated {monitors.Count} display(s)", monitors.Count > 0);
            foreach (var m in monitors)
                info($"[{m.Index}] {m.Name}  {m.Width}x{m.Height}  at ({m.X},{m.Y})  primary={m.Primary}");
        }
        catch (Exception ex)
        {
            error($"MonitorList.Enumerate: {ex.Message}");
        }

        section("Windows");
        await breathe();
        try
        {
            var windows = WindowList.Enumerate();
            check($"enumerated {windows.Count} window(s)", windows.Count > 0);
            foreach (var w in windows.Take(6))
                info($"{w.Handle.ToInt64():x}  minimized={w.Minimized}  \"{Trim(w.Title)}\"");
            if (windows.Count > 6) info($"… and {windows.Count - 6} more");
        }
        catch (Exception ex)
        {
            error($"WindowList.Enumerate: {ex.Message}");
        }

        section("Thumbnails");
        await breathe();
        try
        {
            // The XAML-free pixel path: BitmapImage can only be constructed on
            // a thread with a DispatcherQueue, and these checks run off the UI
            // thread so the window keeps painting. What matters here is that
            // PrintWindow/BitBlt actually produce pixels.
            var monitors = MonitorList.Enumerate();
            if (monitors.Count > 0)
            {
                var m = monitors[0];
                check("screen pixels captured",
                    Thumbnails.CanCaptureScreen(m.X, m.Y, m.Width, m.Height));
            }

            var windows = WindowList.Enumerate();
            var target = windows.FirstOrDefault(w => !w.Minimized);
            if (target is not null)
            {
                check($"window pixels captured (\"{Trim(target.Title)}\")",
                    Thumbnails.CanCaptureWindow(target.Handle));
            }
        }
        catch (Exception ex)
        {
            error($"thumbnails: {ex.Message}");
        }
    }

    // --- ffmpeg -------------------------------------------------------------

    private static async Task RunFfmpeg(
        Action<string> section, Action<string> info,
        Action<string, bool> check, Func<Task> breathe)
    {
        section("ffmpeg");
        await breathe();

        info(FfmpegLocator.FfmpegPath);

        var available = FfmpegLocator.IsAvailable;
        check("ffmpeg runs", available);
        if (!available) return;

        foreach (var f in new[] { "ddagrab", "libplacebo", "hwdownload", "hwupload" })
            check($"filter {f}", FfmpegLocator.HasFilter(f));

        foreach (var e in new[] { "h264_nvenc", "libx264", "aac" })
            check($"encoder {e}", FfmpegLocator.HasEncoder(e));

        info($"NVENC 4:4:4 available: {FfmpegLocator.HasNvenc444()}");

        section("Capture devices");
        await breathe();
        var mics = AudioDevices.ListMicrophones();
        var cams = AudioDevices.ListCameras();
        check($"{mics.Count} microphone(s) found", mics.Count > 0);
        foreach (var m in mics) info(m);
        info($"{cams.Count} camera(s): {(cams.Count > 0 ? string.Join(", ", cams) : "none")}");

        // MediaCapture is what the live preview uses, and it can fail where
        // ffmpeg's dshow enumeration succeeds -- privacy settings, or another
        // app holding the device. Worth separating the two.
        if (cams.Count > 0)
        {
            string? error = null;
            Windows.Media.Capture.MediaCapture? probe = null;
            try
            {
                probe = new Windows.Media.Capture.MediaCapture();
                await probe.InitializeAsync(
                    new Windows.Media.Capture.MediaCaptureInitializationSettings
                    {
                        StreamingCaptureMode = Windows.Media.Capture.StreamingCaptureMode.Video,
                        MemoryPreference =
                            Windows.Media.Capture.MediaCaptureMemoryPreference.Cpu,
                    });
            }
            catch (Exception ex)
            {
                error = ex.Message;
            }
            finally
            {
                try { probe?.Dispose(); } catch { /* already gone */ }
            }

            check("MediaCapture can open the webcam (live preview)", error is null);
            if (error is not null) info(error);
        }
    }

    // --- Overlay ------------------------------------------------------------

    private static async Task RunOverlay(
        DispatcherQueue queue, Action<string> section, Action<string> info,
        Action<string, bool> check, Action<string> error, Func<Task> breathe)
    {
        section("Annotation overlay");
        await breathe();

        LayeredOverlay? overlay = null;
        try
        {
            overlay = new LayeredOverlay();
            var hwnd = overlay.Handle;

            check("window created", hwnd != IntPtr.Zero);
            check("WS_EX_LAYERED set", Win32.HasExStyle(hwnd, Win32.WS_EX_LAYERED));
            check("WS_EX_TOOLWINDOW set (out of Alt-Tab)",
                Win32.HasExStyle(hwnd, Win32.WS_EX_TOOLWINDOW));
            // Deliberately NOT NOACTIVATE and NOT click-through: the overlay
            // only exists while the user is drawing, so it must take focus for
            // the tool keys and accept the mouse from the first stroke.
            check("takes focus (needed for tool keys)",
                !Win32.HasExStyle(hwnd, Win32.WS_EX_NOACTIVATE));
            check("interactive from the start",
                !Win32.HasExStyle(hwnd, Win32.WS_EX_TRANSPARENT));
            check("WS_EX_LAYERED survives the toggle",
                Win32.HasExStyle(hwnd, Win32.WS_EX_LAYERED));

            overlay.SetClickThrough(true);
            check("click-through restored",
                Win32.HasExStyle(hwnd, Win32.WS_EX_TRANSPARENT));

            check("display affinity can be set", overlay.SetExcludedFromCapture(true));
            check("display affinity can be cleared", overlay.SetExcludedFromCapture(false));

            // Did the surface actually get pushed? A visible window with the
            // right styles that was never painted is indistinguishable from a
            // working one until you ask.
            await Task.Delay(400);
            info($"UpdateLayeredWindow calls: {overlay.PushCount}");
            check("surface painted at least once", overlay.PushCount > 0);
            check("last UpdateLayeredWindow succeeded", overlay.LastPushOk);
            if (!overlay.LastPushOk) info($"last error: {overlay.LastPushError}");

            // Draw a stroke programmatically and look for its pixels on screen.
            // This is the end-to-end check: paint, composite, and be visible.
            overlay.DebugDrawTestStroke();
            await Task.Delay(400);
            check("a drawn stroke is visible on screen", overlay.DebugStrokeIsVisible());

            // THE check whose absence let a fully opaque overlay pass every
            // style test: sample real screen pixels and require more than one
            // colour. A window hiding the desktop reads as one flat colour.
            check("overlay is actually transparent (desktop shows through)",
                DesktopIsVisibleThrough());
        }
        catch (Exception ex)
        {
            error($"overlay: {ex.Message}");
        }
        finally
        {
            overlay?.Dispose();
        }
    }

    /// <summary>
    /// Sample the live screen in several places. If the overlay were opaque
    /// every sample would return the same colour; a varied desktop showing
    /// through gives several.
    /// </summary>
    private static bool DesktopIsVisibleThrough()
    {
        var dc = GetDC(IntPtr.Zero);
        try
        {
            var seen = new HashSet<uint>();
            foreach (var (x, y) in new[] { (300, 300), (900, 500), (1500, 800), (600, 1000) })
                seen.Add(GetPixel(dc, x, y));
            return seen.Count > 1;
        }
        finally
        {
            ReleaseDC(IntPtr.Zero, dc);
        }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hwnd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);

    [System.Runtime.InteropServices.DllImport("gdi32.dll")]
    private static extern uint GetPixel(IntPtr dc, int x, int y);

    // --- Hotkeys ------------------------------------------------------------

    private static async Task RunHotkeys(
        Action<string> section, Action<string> info,
        Action<string, bool> check, Func<Task> breathe)
    {
        section("Global hotkeys");
        await breathe();

        using (var hotkeys = new HotkeyManager())
        {
            var ok = hotkeys.Failed.Count == 0;
            check("F8/F9/F10/Ctrl+Shift+X registered", ok);
            if (!ok)
            {
                info($"unavailable: {string.Join(", ", hotkeys.Failed)}");
                if (hotkeys.LastError is { } err) info(err);
            }
        }

        using (var again = new HotkeyManager())
        {
            check("released on dispose (re-registration works)", again.Failed.Count == 0);
        }
    }

    private static string Trim(string s, int max = 48)
        => s.Length <= max ? s : s[..max] + "…";
}
