using EzScreenRecord.Interop;
using EzScreenRecord.Models;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;
using Windows.Graphics;
using Windows.UI;

namespace EzScreenRecord.Views;

/// <summary>
/// The floating recording bar, in the Zoom/Meet share-bar idiom.
///
/// The window is sized to the BAR, not to the display. Electron spans the whole
/// screen with a transparent click-through window so dropdowns can escape the
/// bar's bounds; WinUI windows are opaque and cannot do that (see
/// Interop/LayeredOverlay.cs for the measurements), so a full-screen host is a
/// full-screen black sheet over the desktop. That is precisely what made the
/// screen go black the moment a recording started.
///
/// Nothing important is lost: WinUI renders flyouts in their own top-level
/// popup windows, so the short device menus this bar opens are not clipped.
///
/// The bar is always dark regardless of the system theme — it sits over the
/// user's own content, and a light strip there is glaring.
/// </summary>
public sealed class ToolbarWindow : Window
{
    private readonly AppSettings _settings;
    private readonly Canvas _root;
    private readonly Border _bar;
    private readonly TextBlock _timer;
    private readonly Button _drawButton;

    private bool _dragging;

    public event Action? StopRequested;
    public event Action? PauseRequested;
    public event Action? DrawRequested;
    public event Action? SourceRequested;

    public ToolbarWindow(AppSettings settings)
    {
        _settings = settings;
        Title = "Ez Screen Record — toolbar";

        var content = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 10,
            VerticalAlignment = VerticalAlignment.Center,
            Padding = new Thickness(6, 8, 10, 8),
        };

        // Drag grip. The window is the bar, so this moves the window.
        var grip = new Border
        {
            Width = 18,
            Height = 32,
            Background = new SolidColorBrush(Colors.Transparent),
            Child = new FontIcon
            {
                Glyph = Glyphs.Grip,
                FontSize = 18,
                Foreground = new SolidColorBrush(Color.FromArgb(115, 255, 255, 255)),
            },
        };
        ToolTipService.SetToolTip(grip, "Drag to move");
        grip.PointerPressed += OnGripPressed;
        grip.PointerMoved += OnGripMoved;
        grip.PointerReleased += OnGripReleased;
        content.Children.Add(grip);

        content.Children.Add(new Microsoft.UI.Xaml.Shapes.Ellipse
        {
            Width = 10,
            Height = 10,
            Fill = new SolidColorBrush(Color.FromArgb(255, 255, 59, 48)),
            VerticalAlignment = VerticalAlignment.Center,
        });

        var mic = new PillControl("Microphone", Glyphs.Mic, Glyphs.MicOff);
        mic.SetDevices(Capture.AudioDevices.ListMicrophones(), settings.Recording.MicDeviceName);
        mic.SetEnabled(settings.Recording.MicEnabled);
        mic.Toggled += on => { settings.Recording.MicEnabled = on; settings.Save(); };
        mic.DeviceSelected += name => { settings.Recording.MicDeviceName = name; settings.Save(); };
        content.Children.Add(mic);

        var cam = new PillControl("Camera", Glyphs.Video, Glyphs.VideoOff);
        cam.SetDevices(Capture.AudioDevices.ListCameras(), settings.Camera.DeviceName);
        cam.SetEnabled(settings.Camera.Enabled);
        cam.Toggled += on => { settings.Camera.Enabled = on; settings.Save(); };
        cam.DeviceSelected += name => { settings.Camera.DeviceName = name; settings.Save(); };
        content.Children.Add(cam);

        content.Children.Add(Round(Glyphs.Desktop, "Change source", () => SourceRequested?.Invoke()));

        _drawButton = Round(Glyphs.Ink, "Draw on screen (F8)", () => DrawRequested?.Invoke());
        content.Children.Add(_drawButton);

        content.Children.Add(new Border
        {
            Width = 1,
            Height = 26,
            Background = new SolidColorBrush(Color.FromArgb(41, 255, 255, 255)),
        });

        _timer = new TextBlock
        {
            Text = "00:00",
            FontSize = 18,
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
            Foreground = new SolidColorBrush(Colors.White),
            MinWidth = 58,
            TextAlignment = TextAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        content.Children.Add(_timer);

        content.Children.Add(Round(Glyphs.Pause, "Pause", () => PauseRequested?.Invoke()));

        var stop = new Button
        {
            Width = 58,
            Height = 40,
            CornerRadius = new CornerRadius(20),
            Padding = new Thickness(0),
            BorderThickness = new Thickness(0),
            Background = new SolidColorBrush(Color.FromArgb(255, 196, 43, 28)),
            Foreground = new SolidColorBrush(Colors.White),
            Content = new FontIcon { Glyph = Glyphs.Stop, FontSize = 22 },
        };
        ToolTipService.SetToolTip(stop, "Stop recording (F9)");
        stop.Click += (_, _) => StopRequested?.Invoke();
        content.Children.Add(stop);

        // SQUARE corners and no border, deliberately.
        //
        // The window behind this is opaque -- WinUI cannot be transparent -- so
        // rounding the pill only revealed the window's black backdrop in the
        // corners, and the 1px light border read as a hard outline around that
        // black rectangle. Since the window is sized exactly to the bar, the
        // bar's own fill IS the visible shape; rounding is applied to the
        // WINDOW instead, via DWM, so the corners are genuinely round rather
        // than drawn round over black.
        _bar = new Border
        {
            Child = content,
            Background = new SolidColorBrush(Color.FromArgb(255, 28, 28, 32)),
            RequestedTheme = ElementTheme.Dark,
        };

        // The window is SIZED TO THE BAR, not to the display.
        //
        // Electron makes this a full-screen transparent click-through window so
        // dropdowns can escape the bar's bounds. WinUI cannot: its windows are
        // opaque (see Interop/LayeredOverlay.cs for the measurements), so a
        // full-screen host is a full-screen BLACK SHEET over the desktop --
        // which is exactly what "black screen while recording" was.
        //
        // Sizing to the bar gives up nothing important here: the flyouts this
        // bar opens are short device menus, and WinUI renders them in their own
        // top-level popup windows rather than clipped inside the parent.
        _root = new Canvas();
        _root.Children.Add(_bar);
        Content = _root;

        ExtendsContentIntoTitleBar = true;

        var presenter = (OverlappedPresenter)AppWindow.Presenter;
        presenter.SetBorderAndTitleBar(false, false);
        presenter.IsResizable = false;
        presenter.IsMaximizable = false;
        presenter.IsMinimizable = false;
        presenter.IsAlwaysOnTop = true;

        AppWindow.IsShownInSwitchers = false;

        ApplyBaseStyles();

        _bar.SizeChanged += (_, _) => PositionBar();
        _root.Loaded += (_, _) => PositionBar();
    }

    private IntPtr Hwnd => WinRT.Interop.WindowNative.GetWindowHandle(this);

    private Button Round(string glyph, string tooltip, Action onClick)
    {
        var button = new Button
        {
            Width = 40,
            Height = 40,
            CornerRadius = new CornerRadius(20),
            Padding = new Thickness(0),
            BorderThickness = new Thickness(0),
            Background = new SolidColorBrush(Color.FromArgb(26, 255, 255, 255)),
            Foreground = new SolidColorBrush(Colors.White),
            Content = new FontIcon { Glyph = glyph, FontSize = 20 },
        };
        ToolTipService.SetToolTip(button, tooltip);
        button.Click += (_, _) => onClick();
        return button;
    }

    /// <summary>
    /// Size the window to the bar and park it top-centre, like Zoom's share bar.
    ///
    /// Called once the bar has measured itself; until then its ActualWidth is
    /// zero and the window would collapse.
    /// </summary>
    private void PositionBar()
    {
        if (_bar.ActualWidth <= 0) return;

        var scale = _root.XamlRoot?.RasterizationScale ?? 1.0;
        var width = (int)Math.Ceiling(_bar.ActualWidth * scale);
        var height = (int)Math.Ceiling(_bar.ActualHeight * scale);

        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary);
        var work = area.WorkArea;

        AppWindow.MoveAndResize(new RectInt32(
            work.X + (work.Width - width) / 2,
            work.Y + 14,
            width,
            height));

        Canvas.SetLeft(_bar, 0);
        Canvas.SetTop(_bar, 0);
    }

    private void ApplyBaseStyles()
    {
        // Layered so the bar can be excluded from capture; toolwindow to stay
        // out of Alt-Tab; noactivate so it never steals focus from the app
        // being demonstrated.
        Win32.AddExStyle(Hwnd,
            Win32.WS_EX_LAYERED | Win32.WS_EX_TOOLWINDOW | Win32.WS_EX_NOACTIVATE);
        Win32.SetWindowPos(Hwnd, Win32.HWND_TOPMOST, 0, 0, 0, 0,
            Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);

        // Round the WINDOW, so the corners are actually round instead of the
        // bar being drawn round over an opaque black window. DWMWCP_ROUND is
        // the same treatment Windows 11 gives ordinary windows, so the bar
        // matches the rest of the system.
        var round = 2; // DWMWCP_ROUND
        Win32.DwmSetWindowAttributeInt(Hwnd, Win32.DWMWA_WINDOW_CORNER_PREFERENCE,
            ref round, sizeof(int));
    }

    public void SetElapsed(string text) => _timer.Text = text;

    public void SetDrawActive(bool active)
        => _drawButton.Background = new SolidColorBrush(active
            ? Color.FromArgb(255, 10, 132, 255)
            : Color.FromArgb(26, 255, 255, 255));

    /// <summary>
    /// Apply the hide-from-capture setting, and report whether it stuck.
    /// SetWindowDisplayAffinity returns TRUE even when its WS_EX_LAYERED
    /// prerequisite is missing, so the affinity is read back rather than
    /// assumed.
    /// </summary>
    public bool ApplyCaptureExclusion()
    {
        var hide = _settings.Recording.HideToolbarFromCapture;
        Win32.AddExStyle(Hwnd, Win32.WS_EX_LAYERED);
        Win32.SetWindowDisplayAffinity(
            Hwnd, hide ? Win32.WDA_EXCLUDEFROMCAPTURE : Win32.WDA_NONE);
        Win32.GetWindowDisplayAffinity(Hwnd, out var actual);
        return actual == (hide ? Win32.WDA_EXCLUDEFROMCAPTURE : Win32.WDA_NONE);
    }

    // --- Dragging the bar within the window ---------------------------------

    // The window IS the bar now, so dragging moves the window. Screen
    // coordinates, because window-relative ones shift as the window moves.

    private POINT _dragOrigin;
    private PointInt32 _windowStart;

    private void OnGripPressed(object sender, PointerRoutedEventArgs e)
    {
        _dragging = true;
        GetCursorPos(out _dragOrigin);
        _windowStart = AppWindow.Position;
        ((UIElement)sender).CapturePointer(e.Pointer);
    }

    private void OnGripMoved(object sender, PointerRoutedEventArgs e)
    {
        if (!_dragging) return;
        GetCursorPos(out var cursor);

        // Clamp fully on-screen: this bar is the only way to stop a take.
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary);
        var work = area.WorkArea;
        var size = AppWindow.Size;

        var x = Math.Clamp(_windowStart.X + (cursor.X - _dragOrigin.X),
            work.X, work.X + Math.Max(0, work.Width - size.Width));
        var y = Math.Clamp(_windowStart.Y + (cursor.Y - _dragOrigin.Y),
            work.Y, work.Y + Math.Max(0, work.Height - size.Height));

        AppWindow.Move(new PointInt32(x, y));
    }

    [System.Runtime.InteropServices.StructLayout(
        System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);

    private void OnGripReleased(object sender, PointerRoutedEventArgs e)
    {
        _dragging = false;
        ((UIElement)sender).ReleasePointerCaptures();
    }
}
