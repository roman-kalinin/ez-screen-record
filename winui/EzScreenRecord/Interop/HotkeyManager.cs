using System.Runtime.InteropServices;

namespace EzScreenRecord.Interop;

public enum HotkeyAction { ToggleRecord, TogglePause, ToggleDraw, ClearDraw }

/// <summary>
/// System-wide hotkeys.
///
/// These have to work while ANOTHER app is focused -- that is the whole point
/// during a demo -- so they are registered with RegisterHotKey rather than
/// handled as key events on our own windows. Electron's globalShortcut is the
/// same call underneath.
///
/// RegisterHotKey delivers WM_HOTKEY to a specific window, so this creates its
/// own hidden message-only window rather than subclassing a XAML one: WinUI's
/// windows do not expose their WndProc, and subclassing them is fragile across
/// runtime updates.
/// </summary>
public sealed class HotkeyManager : IDisposable
{
    private const int WM_DESTROY = 0x0002;

    // Virtual key codes.
    private const uint VK_F8 = 0x77;
    private const uint VK_F9 = 0x78;
    private const uint VK_F10 = 0x79;
    private const uint VK_X = 0x58;

    private readonly Dictionary<int, HotkeyAction> _actions = [];
    private readonly WndProc _wndProc;
    private IntPtr _hwnd;
    private bool _disposed;

    /// <summary>Raised on the thread that created the manager.</summary>
    public event Action<HotkeyAction>? Triggered;

    /// <summary>Accelerators that could not be registered, for reporting.</summary>
    public List<string> Failed { get; } = [];

    public HotkeyManager()
    {
        // Keep the delegate alive for the window's lifetime; letting the GC
        // collect it leaves Windows calling into freed memory.
        _wndProc = WindowProc;
        CreateMessageWindow();
        RegisterAll();
    }

    private void CreateMessageWindow()
    {
        // Unique per instance. A window class name can only be registered once
        // per module, so a fixed name makes RegisterClass fail for every
        // manager after the first -- CreateWindowEx then returns NULL, every
        // RegisterHotKey against that null handle fails, and the app reports
        // "another app already owns these keys" when nothing of the sort is
        // true.
        var className = $"EzScreenRecordHotkeyWindow_{Guid.NewGuid():N}";

        var wc = new WNDCLASS
        {
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProc),
            hInstance = GetModuleHandle(null),
            lpszClassName = className,
        };

        if (RegisterClass(ref wc) == 0)
        {
            LastError = $"RegisterClass failed ({Marshal.GetLastWin32Error()})";
            return;
        }

        // HWND_MESSAGE: a message-only window. It is never visible, never
        // appears in the taskbar, and costs nothing to keep around.
        _hwnd = CreateWindowEx(
            0, className, "", 0, 0, 0, 0, 0,
            new IntPtr(-3), IntPtr.Zero, wc.hInstance, IntPtr.Zero);

        if (_hwnd == IntPtr.Zero)
            LastError = $"CreateWindowEx failed ({Marshal.GetLastWin32Error()})";
    }

    /// <summary>Why setup failed, if it did. Null on success.</summary>
    public string? LastError { get; private set; }

    private void RegisterAll()
    {
        // MOD_NOREPEAT: holding a key must not fire repeatedly -- holding F9
        // would otherwise start and stop the recording dozens of times.
        Register(1, HotkeyAction.ToggleRecord, Win32.MOD_NOREPEAT, VK_F9, "F9");
        Register(2, HotkeyAction.TogglePause, Win32.MOD_NOREPEAT, VK_F10, "F10");
        Register(3, HotkeyAction.ToggleDraw, Win32.MOD_NOREPEAT, VK_F8, "F8");
        Register(4, HotkeyAction.ClearDraw,
            Win32.MOD_CONTROL | Win32.MOD_SHIFT | Win32.MOD_NOREPEAT, VK_X, "Ctrl+Shift+X");
    }

    private void Register(int id, HotkeyAction action, uint modifiers, uint vk, string label)
    {
        // No message window means no hotkeys at all. Report the real reason
        // rather than blaming a key conflict.
        if (_hwnd == IntPtr.Zero)
        {
            Failed.Add(label);
            return;
        }

        if (Win32.RegisterHotKey(_hwnd, id, modifiers, vk))
        {
            _actions[id] = action;
        }
        else
        {
            // Another app already owns the combination. Worth surfacing rather
            // than leaving the user to wonder why a documented key does nothing.
            Failed.Add(label);
        }
    }

    private IntPtr WindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == Win32.WM_HOTKEY && _actions.TryGetValue(wParam.ToInt32(), out var action))
        {
            Triggered?.Invoke(action);
            return IntPtr.Zero;
        }

        return DefWindowProc(hwnd, msg, wParam, lParam);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        foreach (var id in _actions.Keys) Win32.UnregisterHotKey(_hwnd, id);
        _actions.Clear();

        if (_hwnd != IntPtr.Zero)
        {
            DestroyWindow(_hwnd);
            _hwnd = IntPtr.Zero;
        }
    }

    // --- Interop ------------------------------------------------------------

    private delegate IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASS
    {
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "RegisterClassW",
        SetLastError = true)]
    private static extern ushort RegisterClass(ref WNDCLASS wndClass);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateWindowExW",
        SetLastError = true)]
    private static extern IntPtr CreateWindowEx(
        int exStyle, string className, string windowName, int style,
        int x, int y, int width, int height,
        IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "DefWindowProcW")]
    private static extern IntPtr DefWindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool DestroyWindow(IntPtr hwnd);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetModuleHandleW")]
    private static extern IntPtr GetModuleHandle(string? moduleName);
}
