using EzScreenRecord.Interop;
using EzScreenRecord.Models;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;
using Windows.Graphics;
using Windows.UI;

namespace EzScreenRecord.Views;

/// <summary>
/// The small always-on-top bar shown while recording: stop, pause, draw tools.
///
/// It is kept OUT of the capture by default -- the recorder's own chrome has no
/// place in a tutorial. That is a setting rather than always-on because Windows
/// applies display affinity to EVERY capture on the machine, so an excluded
/// toolbar also vanishes from a Zoom or Teams share while recording.
/// </summary>
public sealed class ToolbarWindow : Window
{
    private readonly AppSettings _settings;
    private readonly StackPanel _tools;

    private bool _dragging;
    private Point _dragStart;
    private PointInt32 _windowStart;

    public event Action? StopRequested;
    public event Action<DrawTool>? ToolPicked;
    public event Action? UndoRequested;
    public event Action? ClearRequested;

    public ToolbarWindow(AppSettings settings)
    {
        _settings = settings;
        Title = "Recording";

        _tools = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 4,
            Padding = new Thickness(8),
        };

        AddButton(Glyphs.Stop, "Stop recording (F9)", () => StopRequested?.Invoke());
        AddSeparator();
        AddToolButton(Glyphs.Pen, "Pen (P)", DrawTool.Pen);
        AddToolButton(Glyphs.Highlighter, "Highlighter (H)", DrawTool.Highlighter);
        AddToolButton(Glyphs.Arrow, "Arrow (A)", DrawTool.Arrow);
        AddToolButton(Glyphs.Rectangle, "Rectangle (R)", DrawTool.Rect);
        AddToolButton(Glyphs.Ellipse, "Ellipse (O)", DrawTool.Ellipse);
        AddToolButton(Glyphs.Eraser, "Eraser (E)", DrawTool.Eraser);
        AddSeparator();
        AddButton(Glyphs.Undo, "Undo (Ctrl+Z)", () => UndoRequested?.Invoke());
        AddButton(Glyphs.Delete, "Clear all (Del)", () => ClearRequested?.Invoke());

        var root = new Border
        {
            Child = _tools,
            CornerRadius = new CornerRadius(8),
            Background = new SolidColorBrush(Color.FromArgb(230, 32, 32, 32)),
        };
        root.PointerPressed += OnPointerPressed;
        root.PointerMoved += OnPointerMoved;
        root.PointerReleased += OnPointerReleased;

        Content = root;

        ExtendsContentIntoTitleBar = true;

        var presenter = (OverlappedPresenter)AppWindow.Presenter;
        presenter.SetBorderAndTitleBar(false, false);
        presenter.IsResizable = false;
        presenter.IsMaximizable = false;
        presenter.IsMinimizable = false;
        presenter.IsAlwaysOnTop = true;

        AppWindow.IsShownInSwitchers = false;

        PositionAtTopCenter();
        ApplyCaptureExclusion();
    }

    private IntPtr Hwnd => WinRT.Interop.WindowNative.GetWindowHandle(this);

    private void AddButton(string glyph, string tooltip, Action onClick)
    {
        var button = new Button
        {
            Content = new FontIcon { Glyph = glyph, FontSize = 14 },
            Padding = new Thickness(8, 6, 8, 6),
        };
        ToolTipService.SetToolTip(button, tooltip);
        button.Click += (_, _) => onClick();
        _tools.Children.Add(button);
    }

    private void AddToolButton(string glyph, string tooltip, DrawTool tool)
    {
        var button = new ToggleButton
        {
            Content = new FontIcon { Glyph = glyph, FontSize = 14 },
            Padding = new Thickness(8, 6, 8, 6),
            IsChecked = _settings.Draw.Tool == tool,
            Tag = tool,
        };
        ToolTipService.SetToolTip(button, tooltip);
        button.Click += (s, _) =>
        {
            _settings.Draw.Tool = tool;
            // Radio behaviour: exactly one tool is active at a time.
            foreach (var child in _tools.Children)
                if (child is ToggleButton other && other.Tag is DrawTool)
                    other.IsChecked = ReferenceEquals(other, s);

            ToolPicked?.Invoke(tool);
            _settings.Save();
        };
        _tools.Children.Add(button);
    }

    private void AddSeparator() => _tools.Children.Add(new Border
    {
        Width = 1,
        Margin = new Thickness(4, 6, 4, 6),
        Background = new SolidColorBrush(Color.FromArgb(60, 255, 255, 255)),
    });

    private void PositionAtTopCenter()
    {
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary);
        var work = area.WorkArea;
        var size = AppWindow.Size;

        AppWindow.Move(new PointInt32(
            work.X + (work.Width - size.Width) / 2,
            work.Y + 24));
    }

    /// <summary>
    /// Apply the hide-from-capture setting, and report whether it stuck.
    ///
    /// WDA_EXCLUDEFROMCAPTURE silently requires WS_EX_LAYERED, and returns TRUE
    /// even when the prerequisite is missing, so the affinity is read back
    /// rather than assumed.
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

    // --- Dragging -----------------------------------------------------------

    private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
    {
        // Buttons handle their own clicks; only bare chrome starts a drag.
        if (e.OriginalSource is FrameworkElement { Parent: ButtonBase }) return;

        _dragging = true;
        _dragStart = e.GetCurrentPoint(null).Position;
        _windowStart = AppWindow.Position;
        ((UIElement)sender).CapturePointer(e.Pointer);
    }

    private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
    {
        if (!_dragging) return;
        var p = e.GetCurrentPoint(null).Position;
        AppWindow.Move(new PointInt32(
            _windowStart.X + (int)(p.X - _dragStart.X),
            _windowStart.Y + (int)(p.Y - _dragStart.Y)));
    }

    private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
    {
        _dragging = false;
        ((UIElement)sender).ReleasePointerCaptures();
    }
}
