using System.Runtime.InteropServices;
using EzScreenRecord.Interop;

namespace EzScreenRecord.Capture;

/// <summary>
/// A display, in the terms ffmpeg's ddagrab filter needs.
/// </summary>
/// <param name="Index">
/// The ddagrab output index. ddagrab enumerates DXGI outputs on adapter 0 in
/// order, and Windows reports adapters/monitors in that same order through
/// EnumDisplayDevices, so the Nth non-mirroring attached display here is
/// ddagrab's output N.
/// </param>
public sealed record ListedMonitor(
    int Index,
    string Name,
    int X,
    int Y,
    int Width,
    int Height,
    bool Primary)
{
    public string Id => $"screen:{Index}:0";

    public string Label => Primary
        ? $"{Name} (Primary) — {Width}×{Height}"
        : $"{Name} — {Width}×{Height}";
}

/// <summary>
/// Enumerating displays for the source picker.
///
/// Uses EnumDisplayMonitors rather than hand-written DXGI COM interop. An
/// earlier version declared CreateDXGIFactory1 as `out object`, which the CLR
/// marshals as a VARIANT rather than a COM interface pointer -- it threw
/// InvalidOleVariantTypeException on the very first call, so the picker never
/// listed anything. Writing correct DXGI interop by hand is possible but buys
/// nothing here: the monitor order is the same, and this API cannot fail that
/// way.
/// </summary>
public static class MonitorList
{
    public static List<ListedMonitor> Enumerate()
    {
        var monitors = new List<ListedMonitor>();

        MonitorEnumProc callback = (hMonitor, _, _, _) =>
        {
            var info = new MONITORINFOEX
            {
                cbSize = Marshal.SizeOf<MONITORINFOEX>(),
            };

            if (GetMonitorInfo(hMonitor, ref info))
            {
                var r = info.rcMonitor;
                monitors.Add(new ListedMonitor(
                    // Filled in below: EnumDisplayMonitors' callback order is
                    // not guaranteed to be the DXGI order, so the list is
                    // sorted first and indices assigned afterwards.
                    Index: 0,
                    Name: FriendlyName(info.szDevice),
                    X: r.Left,
                    Y: r.Top,
                    Width: r.Right - r.Left,
                    Height: r.Bottom - r.Top,
                    Primary: (info.dwFlags & MONITORINFOF_PRIMARY) != 0));
            }

            return true;
        };

        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
        GC.KeepAlive(callback);

        // Primary first, then left-to-right, top-to-bottom. This matches how
        // DXGI orders outputs in practice, which is what ddagrab's output_idx
        // means -- and getting it wrong captures a different screen than the
        // user picked, with no error to explain it.
        var ordered = monitors
            .OrderByDescending(m => m.Primary)
            .ThenBy(m => m.X)
            .ThenBy(m => m.Y)
            .ToList();

        return ordered
            .Select((m, i) => m with { Index = i })
            .ToList();
    }

    /// <summary>
    /// Turn a device path like <c>\\.\DISPLAY1</c> into something readable.
    /// The full monitor model name needs the far heavier
    /// QueryDisplayConfig/DisplayConfigGetDeviceInfo path; "Display 1" is
    /// clearer than the raw device path and enough to tell screens apart.
    /// </summary>
    private static string FriendlyName(string device)
    {
        var trimmed = device.TrimEnd('\0');
        var digits = new string(trimmed.Where(char.IsDigit).ToArray());
        return digits.Length > 0 ? $"Display {digits}" : trimmed;
    }

    // --- Interop ------------------------------------------------------------

    private const int MONITORINFOF_PRIMARY = 0x00000001;
    private const int CCHDEVICENAME = 32;

    private delegate bool MonitorEnumProc(
        IntPtr hMonitor, IntPtr hdc, IntPtr lprcClip, IntPtr dwData);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(
        IntPtr hdc, IntPtr lprcClip, MonitorEnumProc callback, IntPtr dwData);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetMonitorInfoW")]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MONITORINFOEX
    {
        public int cbSize;
        public Win32.RECT rcMonitor;
        public Win32.RECT rcWork;
        public int dwFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCHDEVICENAME)]
        public string szDevice;
    }
}
