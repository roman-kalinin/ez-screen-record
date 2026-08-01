using EzScreenRecord.Interop;
using EzScreenRecord.Models;

namespace EzScreenRecord.Views;

/// <summary>
/// Headless checks for the annotation overlay's window behaviour.
///
/// The overlay is the riskiest part of the WinUI port: it needs per-pixel
/// alpha, click-through, always-on-top, and it must NOT be excluded from
/// capture. Every one of those is a Win32 style bit that can be set
/// successfully and then silently dropped by a later call.
///
/// Run with:  EzScreenRecord.exe --overlay-selftest
/// Results go to stdout and the exit code is non-zero on failure, so this can
/// gate a build.
/// </summary>
internal static class OverlaySelfTest
{
    // The app is a WinExe, so it has no console attached and Console.WriteLine
    // goes nowhere when launched normally. Results are mirrored to a file so
    // they can be read regardless of how the process was started.
    private static readonly List<string> Log = [];

    private static string ReportPath => Path.Combine(
        Path.GetTempPath(), "ez-overlay-selftest.txt");

    public static void Run()
    {
        var failures = 0;
        var settings = new AppSettings();

        OverlayWindow overlay;
        IntPtr hwnd;
        try
        {
            Write("constructing OverlayWindow...");
            overlay = new OverlayWindow(settings);
            Write("constructed; activating...");
            overlay.Activate();
            Write("activated.");
            hwnd = WinRT.Interop.WindowNative.GetWindowHandle(overlay);
            Write($"hwnd = 0x{hwnd.ToInt64():x}");
        }
        catch (Exception ex)
        {
            Write($"FATAL during construction: {ex}");
            try { File.WriteAllLines(ReportPath, Log); } catch { /* best effort */ }
            Environment.Exit(2);
            return;
        }

        Check("WS_EX_LAYERED set", Win32.HasExStyle(hwnd, Win32.WS_EX_LAYERED), ref failures);
        Check("WS_EX_TOOLWINDOW set (stays out of Alt-Tab)",
            Win32.HasExStyle(hwnd, Win32.WS_EX_TOOLWINDOW), ref failures);
        Check("WS_EX_NOACTIVATE set (does not steal focus)",
            Win32.HasExStyle(hwnd, Win32.WS_EX_NOACTIVATE), ref failures);

        // Click-through defaults ON: the overlay must not eat clicks meant for
        // the app being demonstrated.
        Check("click-through by default",
            Win32.HasExStyle(hwnd, Win32.WS_EX_TRANSPARENT), ref failures);

        overlay.SetInteractive(true);
        Check("interactive clears WS_EX_TRANSPARENT",
            !Win32.HasExStyle(hwnd, Win32.WS_EX_TRANSPARENT), ref failures);

        // THE trap: toggling interactivity rewrites the ex-style word, and
        // losing WS_EX_LAYERED here silently drops any display affinity.
        Check("WS_EX_LAYERED survives an interactivity toggle",
            Win32.HasExStyle(hwnd, Win32.WS_EX_LAYERED), ref failures);

        overlay.SetInteractive(false);
        Check("click-through restored",
            Win32.HasExStyle(hwnd, Win32.WS_EX_TRANSPARENT), ref failures);
        Check("WS_EX_LAYERED still set after second toggle",
            Win32.HasExStyle(hwnd, Win32.WS_EX_LAYERED), ref failures);

        // Display affinity, verified by reading it back rather than trusting the
        // call's return value.
        Check("display affinity can be set", overlay.SetExcludedFromCapture(true), ref failures);
        Check("display affinity can be cleared", overlay.SetExcludedFromCapture(false), ref failures);

        // And it must survive the same toggle, since that is exactly the
        // sequence that broke it in the Electron version.
        overlay.SetExcludedFromCapture(true);
        overlay.SetInteractive(true);
        Win32.GetWindowDisplayAffinity(hwnd, out var affinity);
        Check("display affinity survives SetInteractive(true)",
            affinity == Win32.WDA_EXCLUDEFROMCAPTURE, ref failures);
        overlay.SetExcludedFromCapture(false);

        Write(failures == 0
            ? "All overlay checks passed."
            : $"{failures} overlay check(s) FAILED.");

        try { File.WriteAllLines(ReportPath, Log); } catch { /* best effort */ }

        Environment.Exit(failures == 0 ? 0 : 1);
    }

    private static void Check(string name, bool ok, ref int failures)
    {
        Write($"  [{(ok ? "PASS" : "FAIL")}] {name}");
        if (!ok) failures++;
    }

    private static void Write(string line)
    {
        Log.Add(line);
        Console.WriteLine(line);
        // Flush every line: a stack-overrun crash (0xC0000409) kills the process
        // without unwinding, so anything buffered until the end is lost exactly
        // when it would be most useful.
        try { File.WriteAllLines(ReportPath, Log); } catch { /* best effort */ }
    }
}
