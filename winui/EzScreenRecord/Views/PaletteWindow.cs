using EzScreenRecord.Interop;
using EzScreenRecord.Models;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Windows.Graphics;

namespace EzScreenRecord.Views;

/// <summary>
/// A small always-on-top window holding the drawing palette.
///
/// Separate from the overlay because the overlay is a pure Win32 layered
/// window with no XAML in it — it cannot host controls. Keeping the palette in
/// its own tiny window also means it is opaque and crisp while the surface it
/// sits over stays fully transparent.
/// </summary>
public sealed class PaletteWindow : Window
{
    private readonly DrawPalette _palette;

    public event Action? ClearRequested;
    public event Action? DoneRequested;
    public event Action? Changed;

    public PaletteWindow(AppSettings settings)
    {
        Title = "Ez Screen Record — tools";

        _palette = new DrawPalette(settings);
        _palette.ClearRequested += () => ClearRequested?.Invoke();
        _palette.DoneRequested += () => DoneRequested?.Invoke();
        _palette.Changed += () => Changed?.Invoke();
        _palette.Moved += MoveTo;

        Content = _palette;

        ExtendsContentIntoTitleBar = true;

        var presenter = (OverlappedPresenter)AppWindow.Presenter;
        presenter.SetBorderAndTitleBar(false, false);
        presenter.IsResizable = false;
        presenter.IsMaximizable = false;
        presenter.IsMinimizable = false;
        presenter.IsAlwaysOnTop = true;

        AppWindow.IsShownInSwitchers = false;

        // Sized to the palette's natural width; 24,24 from the work-area origin
        // matches the Electron overlay's default position.
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary);
        AppWindow.MoveAndResize(new RectInt32(
            area.WorkArea.X + 24, area.WorkArea.Y + 24, 620, 56));

        // Above the overlay, and never stealing focus from the app being
        // demonstrated.
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        Win32.AddExStyle(hwnd, Win32.WS_EX_TOOLWINDOW | Win32.WS_EX_NOACTIVATE);
        Win32.SetWindowPos(hwnd, Win32.HWND_TOPMOST, 0, 0, 0, 0,
            Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
    }

    private void MoveTo(Windows.Foundation.Point p)
        => AppWindow.Move(new PointInt32((int)p.X, (int)p.Y));

    /// <summary>
    /// Raise above the drawing overlay. Both windows are topmost and the
    /// overlay covers the entire desktop, so whichever was made topmost last
    /// wins — the palette has to be re-asserted after the overlay appears or it
    /// sits underneath and cannot be clicked.
    /// </summary>
    public void BringToFront()
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        Win32.SetWindowPos(hwnd, Win32.HWND_TOPMOST, 0, 0, 0, 0,
            Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
    }

    /// <summary>
    /// Keep the palette out of the recording, like the toolbar.
    ///
    /// Deliberately does NOT add WS_EX_LAYERED first. On a WinUI window that
    /// style makes the content stop rendering entirely — the window is present
    /// and correctly positioned but draws nothing. Display affinity works here
    /// without it; only the pure-Win32 overlay needs the layered style, and
    /// that one paints itself with UpdateLayeredWindow.
    /// </summary>
    public void SetExcludedFromCapture(bool excluded)
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        Win32.SetWindowDisplayAffinity(
            hwnd, excluded ? Win32.WDA_EXCLUDEFROMCAPTURE : Win32.WDA_NONE);
    }
}
