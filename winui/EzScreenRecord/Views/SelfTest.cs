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
                await RunOverlay(queue, Section, Check, Error, Breathe);
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
    }

    // --- Overlay ------------------------------------------------------------

    private static async Task RunOverlay(
        DispatcherQueue queue, Action<string> section,
        Action<string, bool> check, Action<string> error, Func<Task> breathe)
    {
        section("Annotation overlay");
        await breathe();

        // The overlay is a Window, so it must be built on the UI thread.
        var done = new TaskCompletionSource();
        queue.TryEnqueue(() =>
        {
            OverlayWindow? overlay = null;
            try
            {
                overlay = new OverlayWindow(new AppSettings());
                overlay.Activate();
                var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(overlay);

                check("WS_EX_LAYERED set", Win32.HasExStyle(hwnd, Win32.WS_EX_LAYERED));
                check("WS_EX_TOOLWINDOW set (out of Alt-Tab)",
                    Win32.HasExStyle(hwnd, Win32.WS_EX_TOOLWINDOW));
                check("WS_EX_NOACTIVATE set (does not steal focus)",
                    Win32.HasExStyle(hwnd, Win32.WS_EX_NOACTIVATE));
                check("click-through by default",
                    Win32.HasExStyle(hwnd, Win32.WS_EX_TRANSPARENT));

                overlay.SetInteractive(true);
                check("interactive clears WS_EX_TRANSPARENT",
                    !Win32.HasExStyle(hwnd, Win32.WS_EX_TRANSPARENT));
                check("WS_EX_LAYERED survives the toggle",
                    Win32.HasExStyle(hwnd, Win32.WS_EX_LAYERED));

                overlay.SetInteractive(false);
                check("click-through restored",
                    Win32.HasExStyle(hwnd, Win32.WS_EX_TRANSPARENT));

                check("display affinity can be set", overlay.SetExcludedFromCapture(true));
                check("display affinity can be cleared", overlay.SetExcludedFromCapture(false));

                overlay.SetExcludedFromCapture(true);
                overlay.SetInteractive(true);
                Win32.GetWindowDisplayAffinity(hwnd, out var affinity);
                check("display affinity survives SetInteractive(true)",
                    affinity == Win32.WDA_EXCLUDEFROMCAPTURE);
                overlay.SetExcludedFromCapture(false);
            }
            catch (Exception ex)
            {
                error($"overlay: {ex.Message}");
            }
            finally
            {
                try { overlay?.Close(); } catch { /* already gone */ }
                done.SetResult();
            }
        });

        await done.Task;
    }

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
