using System.Runtime.InteropServices;
using System.Text;

namespace EzScreenRecord.Interop;

/// <summary>
/// The Win32 surface the app actually needs.
///
/// Electron hid most of this behind BrowserWindow options; WinUI does not, so
/// window styles, click-through, always-on-top and capture exclusion are all
/// managed here directly. That is more code but strictly more control -- and
/// several of the behaviours below have no WinUI equivalent at all.
/// </summary>
internal static partial class Win32
{
    // --- Window styles ------------------------------------------------------

    internal const int GWL_EXSTYLE = -20;
    internal const int GWL_STYLE = -16;

    internal const int WS_EX_LAYERED = 0x00080000;
    internal const int WS_EX_TRANSPARENT = 0x00000020;
    internal const int WS_EX_TOOLWINDOW = 0x00000080;
    internal const int WS_EX_APPWINDOW = 0x00040000;
    internal const int WS_EX_NOACTIVATE = 0x08000000;
    internal const int WS_EX_TOPMOST = 0x00000008;

    internal const int WS_POPUP = unchecked((int)0x80000000);
    internal const int WS_VISIBLE = 0x10000000;

    // --- ShowWindow ---------------------------------------------------------

    internal const int SW_HIDE = 0;
    internal const int SW_SHOWNOACTIVATE = 4;
    internal const int SW_RESTORE = 9;

    // --- SetWindowPos -------------------------------------------------------

    internal static readonly IntPtr HWND_TOPMOST = new(-1);
    internal static readonly IntPtr HWND_NOTOPMOST = new(-2);

    internal const uint SWP_NOSIZE = 0x0001;
    internal const uint SWP_NOMOVE = 0x0002;
    internal const uint SWP_NOACTIVATE = 0x0010;
    internal const uint SWP_SHOWWINDOW = 0x0040;
    internal const uint SWP_NOZORDER = 0x0004;

    // --- DWM ----------------------------------------------------------------

    /// <summary>DWMWA_CLOAK -- hide a window while DWM keeps composing it.</summary>
    internal const int DWMWA_CLOAK = 13;

    /// <summary>DWMWA_CLOAKED -- read back whether a window is cloaked.</summary>
    internal const int DWMWA_CLOAKED = 14;

    // --- Display affinity ---------------------------------------------------

    /// <summary>Window is captured normally.</summary>
    internal const uint WDA_NONE = 0x00000000;

    /// <summary>
    /// Window is excluded from all screen capture. This is exactly what
    /// Electron's setContentProtection(true) calls underneath.
    /// </summary>
    internal const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;

    // --- Hotkey modifiers ---------------------------------------------------

    internal const uint MOD_ALT = 0x0001;
    internal const uint MOD_CONTROL = 0x0002;
    internal const uint MOD_SHIFT = 0x0004;
    internal const uint MOD_WIN = 0x0008;
    internal const uint MOD_NOREPEAT = 0x4000;

    internal const int WM_HOTKEY = 0x0312;

    // --- P/Invoke -----------------------------------------------------------

    internal delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool IsWindowVisible(IntPtr hWnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool IsIconic(IntPtr hWnd);

    [LibraryImport("user32.dll")]
    internal static partial int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")]
    internal static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    internal static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    internal static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool ShowWindow(IntPtr hWnd, int cmdShow);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetLayeredWindowAttributes(
        IntPtr hWnd, uint colorKey, byte alpha, uint flags);

    /// <summary>
    /// Keep a window out of every screen capture on the machine.
    ///
    /// IMPORTANT: this silently depends on the window having WS_EX_LAYERED.
    /// Clearing that style -- which is what happens when click-through is turned
    /// off naively -- drops the affinity without any error, and the window
    /// reappears in the recording. Always re-assert after changing ex-styles and
    /// verify with <see cref="GetWindowDisplayAffinity"/>.
    /// </summary>
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetWindowDisplayAffinity(IntPtr hWnd, out uint affinity);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool UnregisterHotKey(IntPtr hWnd, int id);

    [LibraryImport("dwmapi.dll")]
    internal static partial int DwmSetWindowAttribute(
        IntPtr hWnd, int attribute, in int value, int size);

    [LibraryImport("dwmapi.dll")]
    internal static partial int DwmGetWindowAttribute(
        IntPtr hWnd, int attribute, out int value, int size);

    [LibraryImport("user32.dll")]
    internal static partial uint GetDpiForWindow(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    internal struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;

        public readonly int Width => Right - Left;
        public readonly int Height => Bottom - Top;
    }

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GetWindowRect(IntPtr hWnd, out RECT rect);

    // --- Helpers ------------------------------------------------------------

    // Style bits are masked through uint before widening, deliberately. A style
    // constant with the high bit set (WS_POPUP is 0x80000000) is a NEGATIVE int,
    // and sign-extending it to long would set every one of the upper 32 bits --
    // silently corrupting the whole style word rather than setting one flag.

    /// <summary>Add ex-style bits without disturbing the rest.</summary>
    internal static void AddExStyle(IntPtr hWnd, int bits)
    {
        var cur = (long)GetWindowLongPtr(hWnd, GWL_EXSTYLE);
        SetWindowLongPtr(hWnd, GWL_EXSTYLE, new IntPtr(cur | (uint)bits));
    }

    /// <summary>Remove ex-style bits without disturbing the rest.</summary>
    internal static void RemoveExStyle(IntPtr hWnd, int bits)
    {
        var cur = (long)GetWindowLongPtr(hWnd, GWL_EXSTYLE);
        SetWindowLongPtr(hWnd, GWL_EXSTYLE, new IntPtr(cur & ~(long)(uint)bits));
    }

    internal static bool HasExStyle(IntPtr hWnd, int bits)
        => ((long)GetWindowLongPtr(hWnd, GWL_EXSTYLE) & (uint)bits) != 0;
}
