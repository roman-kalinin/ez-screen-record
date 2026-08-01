using Microsoft.UI.Xaml.Media.Imaging;

namespace EzScreenRecord.Capture;

public enum CaptureKind { Screen, Window }

/// <summary>
/// What the user picked to record.
///
/// The id format matches the Electron app's (`screen:N:0` / `window:HWND:0`) so
/// a settings.json written by either version resolves in the other.
/// </summary>
public sealed class CaptureSourceChoice
{
    // Deliberately not `required`: the XAML compiler generates type-info that
    // constructs every type reachable from markup with a parameterless `new`,
    // which a required member makes a compile error (CS9035). Every construction
    // site here is a factory below, so the invariant is kept in practice.
    public string Id { get; init; } = "";
    public string Label { get; init; } = "";
    public CaptureKind Kind { get; init; }

    /// <summary>ddagrab output index. Screens only.</summary>
    public int MonitorIndex { get; init; }

    /// <summary>Target window. Windows only.</summary>
    public IntPtr WindowHandle { get; init; }

    public bool Minimized { get; init; }

    /// <summary>Desktop rect, used for screen thumbnails.</summary>
    public int X { get; init; }
    public int Y { get; init; }
    public int Width { get; init; }
    public int Height { get; init; }

    public static CaptureSourceChoice FromMonitor(ListedMonitor m) => new()
    {
        Id = m.Id,
        Label = m.Label,
        Kind = CaptureKind.Screen,
        MonitorIndex = m.Index,
        Width = m.Width,
        Height = m.Height,
    };

    public static CaptureSourceChoice FromWindow(ListedWindow w) => new()
    {
        Id = w.Id,
        Label = w.Title,
        Kind = CaptureKind.Window,
        WindowHandle = w.Handle,
        Minimized = w.Minimized,
    };

    /// <summary>
    /// Turn a persisted id back into a live source, or null if it no longer
    /// exists. A monitor may have been unplugged and a window closed since the
    /// setting was written.
    /// </summary>
    public static CaptureSourceChoice? Resolve(string id)
    {
        var parts = id.Split(':');
        if (parts.Length < 2) return null;

        if (parts[0] == "screen" && int.TryParse(parts[1], out var index))
        {
            var monitor = MonitorList.Enumerate().FirstOrDefault(m => m.Index == index);
            return monitor is null ? null : FromMonitor(monitor);
        }

        if (parts[0] == "window" && long.TryParse(parts[1], out var handle))
        {
            var window = WindowList.Enumerate().FirstOrDefault(w => w.Handle.ToInt64() == handle);
            return window is null ? null : FromWindow(window);
        }

        return null;
    }

    public Task<BitmapImage?> LoadThumbnailAsync(int maxWidth = 320) => Kind switch
    {
        CaptureKind.Screen => Thumbnails.CaptureScreenAsync(X, Y, Width, Height, maxWidth),
        // A minimized window has no composed surface to capture, so do not try;
        // the picker shows a placeholder instead.
        CaptureKind.Window when !Minimized => Thumbnails.CaptureWindowAsync(WindowHandle, maxWidth),
        _ => Task.FromResult<BitmapImage?>(null),
    };
}
