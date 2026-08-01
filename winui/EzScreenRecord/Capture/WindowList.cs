using System.Text;
using EzScreenRecord.Interop;

namespace EzScreenRecord.Capture;

public sealed record ListedWindow(IntPtr Handle, string Title, bool Minimized)
{
    /// <summary>Matches the Electron app's `window:&lt;hwnd&gt;:0` source id form.</summary>
    public string Id => $"window:{Handle.ToInt64()}:0";
}

/// <summary>
/// Enumerating top-level windows, including minimized ones.
///
/// Ported from src/main/window-list.ts, which had to run this same logic as a
/// PowerShell subprocess because Chromium's desktopCapturer drops minimized
/// windows during enumeration (WebRTC filters on
/// `!IsWindowVisible(hwnd) || IsIconic(hwnd)` before any capture backend is
/// consulted). Here we call the Win32 API directly, so the subprocess, the
/// 8-second timeout and the JSON round-trip all disappear.
/// </summary>
public static class WindowList
{
    /// <summary>Enumerate capturable top-level windows, minimized ones included.</summary>
    public static List<ListedWindow> Enumerate()
    {
        var results = new List<ListedWindow>();

        // The delegate must stay alive for the duration of the call; letting the
        // GC collect it mid-enumeration is a classic crash here.
        Win32.EnumWindowsProc callback = (hWnd, _) =>
        {
            if (!Win32.IsWindowVisible(hWnd)) return true;

            var length = Win32.GetWindowTextLengthW(hWnd);
            if (length == 0) return true;

            var sb = new StringBuilder(length + 1);
            Win32.GetWindowText(hWnd, sb, sb.Capacity);
            var title = sb.ToString();
            if (string.IsNullOrWhiteSpace(title)) return true;

            // Tool windows are palettes and popups, not things anyone means to
            // record. WS_EX_APPWINDOW overrides that -- it marks a tool window
            // that deliberately wants to appear in the taskbar.
            var exStyle = (long)Win32.GetWindowLongPtr(hWnd, Win32.GWL_EXSTYLE);
            if ((exStyle & Win32.WS_EX_TOOLWINDOW) != 0 && (exStyle & Win32.WS_EX_APPWINDOW) == 0)
                return true;

            // UWP keeps invisible ghost windows around that would otherwise
            // flood the list -- they are visible to EnumWindows but cloaked to
            // the user.
            Win32.DwmGetWindowAttribute(hWnd, Win32.DWMWA_CLOAKED, out var cloaked, sizeof(int));
            if (cloaked != 0) return true;

            results.Add(new ListedWindow(hWnd, title, Win32.IsIconic(hWnd)));
            return true;
        };

        Win32.EnumWindows(callback, IntPtr.Zero);
        GC.KeepAlive(callback);

        return results;
    }

    /// <summary>
    /// Bring a minimized window back so it can be captured, without the user
    /// watching it fly out of the taskbar.
    ///
    /// A minimized window genuinely cannot be captured -- DWM stops composing it,
    /// so there is no surface and no API choice conjures one. But DWMWA_CLOAK
    /// documents that a cloaked window "is still composed by DWM", so the window
    /// can be restored while cloaked (hiding the animation) and then uncloaked.
    ///
    /// SW_SHOWNOACTIVATE rather than SW_RESTORE keeps focus with whatever the
    /// user is actually doing.
    /// </summary>
    public static async Task<bool> RestoreForCaptureAsync(IntPtr hWnd)
    {
        if (!Win32.IsIconic(hWnd)) return true;

        var on = 1;
        var off = 0;

        Win32.DwmSetWindowAttribute(hWnd, Win32.DWMWA_CLOAK, in on, sizeof(int));
        Win32.ShowWindow(hWnd, Win32.SW_SHOWNOACTIVATE);

        // Give DWM a moment to compose a frame before revealing the window;
        // uncloaking too early shows a blank rectangle.
        await Task.Delay(180).ConfigureAwait(false);

        Win32.DwmSetWindowAttribute(hWnd, Win32.DWMWA_CLOAK, in off, sizeof(int));

        // Some apps decline to repaint while cloaked. A window the user can see
        // beats a black rectangle, so fall back to a plain visible restore.
        if (Win32.IsIconic(hWnd))
            Win32.ShowWindow(hWnd, Win32.SW_RESTORE);

        return !Win32.IsIconic(hWnd);
    }
}
