using System.Runtime.InteropServices;

namespace EzScreenRecord.Capture;

/// <summary>
/// A display, in the terms ffmpeg's ddagrab filter needs.
/// </summary>
/// <param name="Index">
/// The ddagrab output index. This is an index into the adapter's outputs in
/// DXGI order, which is what `ddagrab=output=N` expects -- deliberately NOT the
/// EnumDisplayMonitors order, which can differ and would silently capture the
/// wrong screen.
/// </param>
public sealed record ListedMonitor(
    int Index,
    string Name,
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
/// Uses DXGI rather than EnumDisplayMonitors so the index handed to ddagrab is
/// the same one DXGI reports. Getting this wrong captures a different screen
/// than the one the user picked, with no error to explain it.
/// </summary>
public static class MonitorList
{
    public static List<ListedMonitor> Enumerate()
    {
        var monitors = new List<ListedMonitor>();

        if (CreateDXGIFactory1(typeof(IDXGIFactory1).GUID, out var factoryObj) != 0
            || factoryObj is not IDXGIFactory1 factory)
        {
            return monitors;
        }

        try
        {
            // Adapter 0 only. Multi-GPU machines expose the same displays through
            // whichever adapter drives them, and ddagrab's `output` index is
            // relative to the adapter it opens -- which is also adapter 0 unless
            // told otherwise.
            if (factory.EnumAdapters1(0, out var adapter) != 0) return monitors;

            try
            {
                uint i = 0;
                while (adapter.EnumOutputs(i, out var output) == 0)
                {
                    try
                    {
                        output.GetDesc(out var desc);
                        var rect = desc.DesktopCoordinates;

                        monitors.Add(new ListedMonitor(
                            Index: (int)i,
                            Name: desc.DeviceName.TrimEnd('\0'),
                            Width: rect.Right - rect.Left,
                            Height: rect.Bottom - rect.Top,
                            // The primary display is the one whose top-left is
                            // the desktop origin.
                            Primary: rect.Left == 0 && rect.Top == 0));
                    }
                    finally
                    {
                        Marshal.ReleaseComObject(output);
                    }
                    i++;
                }
            }
            finally
            {
                Marshal.ReleaseComObject(adapter);
            }
        }
        finally
        {
            Marshal.ReleaseComObject(factory);
        }

        return monitors;
    }

    // --- DXGI interop -------------------------------------------------------

    [DllImport("dxgi.dll")]
    private static extern int CreateDXGIFactory1(Guid riid, out object factory);

    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDXGIFactory1
    {
        // IDXGIObject
        void SetPrivateData();
        void SetPrivateDataInterface();
        void GetPrivateData();
        void GetParent();
        // IDXGIFactory
        int EnumAdapters(uint index, out IDXGIAdapter1 adapter);
        void MakeWindowAssociation();
        void GetWindowAssociation();
        void CreateSwapChain();
        void CreateSoftwareAdapter();
        // IDXGIFactory1
        int EnumAdapters1(uint index, out IDXGIAdapter1 adapter);
        [PreserveSig] int IsCurrent();
    }

    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDXGIAdapter1
    {
        // IDXGIObject
        void SetPrivateData();
        void SetPrivateDataInterface();
        void GetPrivateData();
        void GetParent();
        // IDXGIAdapter
        [PreserveSig] int EnumOutputs(uint index, out IDXGIOutput output);
        void GetDesc();
        void CheckInterfaceSupport();
        // IDXGIAdapter1
        void GetDesc1();
    }

    [ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDXGIOutput
    {
        // IDXGIObject
        void SetPrivateData();
        void SetPrivateDataInterface();
        void GetPrivateData();
        void GetParent();
        // IDXGIOutput
        void GetDesc(out DXGI_OUTPUT_DESC desc);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DXGI_OUTPUT_DESC
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string DeviceName;
        public Interop.Win32.RECT DesktopCoordinates;
        [MarshalAs(UnmanagedType.Bool)] public bool AttachedToDesktop;
        public uint Rotation;
        public IntPtr Monitor;
    }
}
