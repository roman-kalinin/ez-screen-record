using EzScreenRecord.Interop;
using EzScreenRecord.Models;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;
using Windows.Graphics;
using Windows.UI;

namespace EzScreenRecord.Views;

/// <summary>
/// The drawing surface: a transparent, click-through, always-on-top window over
/// the whole desktop.
///
/// It is a REAL window rather than something composited into the recording, and
/// that is the entire design. The screen capture picks it up on its own, so
/// strokes stay perfectly in sync with the video, and the user is drawing on
/// the actual apps being demonstrated rather than on a preview.
///
/// Click-through is the interesting part. The window must be invisible to the
/// mouse whenever the user is not actively drawing, or it would swallow every
/// click meant for the app underneath. WS_EX_TRANSPARENT does that, and is
/// toggled rather than set once.
///
/// IMPORTANT -- the trap that cost the Electron version real time: display
/// affinity (used to keep the toolbar out of the capture) silently depends on
/// WS_EX_LAYERED. Anything that clears that style drops the affinity with no
/// error at all. Here we own the styles directly, so every change goes through
/// SetClickThrough/SetExcludedFromCapture below and re-asserts what it needs.
/// </summary>
public sealed class OverlayWindow : Window
{
    private readonly AppSettings _settings;
    private readonly CanvasControl _canvas;

    private readonly List<Stroke> _strokes = [];
    private Stroke? _current;
    private bool _interactive;

    /// <summary>Raised when the overlay wants to be dismissed (Esc).</summary>
    public event Action? Dismissed;

    public OverlayWindow(AppSettings settings)
    {
        _settings = settings;
        Title = "Ez Screen Record — drawing";

        _canvas = new CanvasControl { ClearColor = Colors.Transparent };
        _canvas.Draw += OnDraw;
        _canvas.PointerPressed += OnPointerPressed;
        _canvas.PointerMoved += OnPointerMoved;
        _canvas.PointerReleased += OnPointerReleased;

        Content = _canvas;

        // Transparent background all the way down. Any opaque brush in this
        // chain produces a black rectangle over the desktop instead of an
        // invisible overlay.
        if (Content is FrameworkElement root)
            root.RequestedTheme = ElementTheme.Dark;

        ExtendsContentIntoTitleBar = true;

        var presenter = (OverlappedPresenter)AppWindow.Presenter;
        presenter.SetBorderAndTitleBar(false, false);
        presenter.IsResizable = false;
        presenter.IsMaximizable = false;
        presenter.IsMinimizable = false;
        presenter.IsAlwaysOnTop = true;

        AppWindow.IsShownInSwitchers = false;

        CoverAllDisplays();
        ApplyBaseStyles();
        SetInteractive(false);
    }

    private IntPtr Hwnd => WinRT.Interop.WindowNative.GetWindowHandle(this);

    /// <summary>
    /// Span the entire virtual desktop, so drawing works across every monitor
    /// rather than only the primary one.
    /// </summary>
    private void CoverAllDisplays()
    {
        var displays = DisplayArea.FindAll();
        if (displays.Count == 0) return;

        // Indexed loop rather than LINQ: DisplayArea.FindAll returns a WinRT
        // IVectorView projection that LINQ cannot enumerate -- Min/Max throw
        // InvalidCastException("No such interface supported") from deep inside
        // the projection rather than anywhere that names the real problem.
        var left = int.MaxValue;
        var top = int.MaxValue;
        var right = int.MinValue;
        var bottom = int.MinValue;

        for (var i = 0; i < displays.Count; i++)
        {
            var b = displays[i].OuterBounds;
            left = Math.Min(left, b.X);
            top = Math.Min(top, b.Y);
            right = Math.Max(right, b.X + b.Width);
            bottom = Math.Max(bottom, b.Y + b.Height);
        }

        AppWindow.MoveAndResize(new RectInt32(left, top, right - left, bottom - top));
    }

    private void ApplyBaseStyles()
    {
        // WS_EX_LAYERED is required for per-pixel alpha AND is the hidden
        // dependency of SetWindowDisplayAffinity. WS_EX_TOOLWINDOW keeps the
        // overlay out of Alt-Tab. WS_EX_NOACTIVATE stops it stealing focus from
        // the app being demonstrated -- which matters because the whole point is
        // to draw over someone else's UI while they keep using it.
        Win32.AddExStyle(Hwnd,
            Win32.WS_EX_LAYERED | Win32.WS_EX_TOOLWINDOW | Win32.WS_EX_NOACTIVATE);

        Win32.SetWindowPos(Hwnd, Win32.HWND_TOPMOST, 0, 0, 0, 0,
            Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
    }

    /// <summary>
    /// Toggle whether the overlay receives mouse input.
    ///
    /// Click-through is the default: the overlay sits over the desktop the whole
    /// time the drawing mode is armed, and must not intercept clicks meant for
    /// the app underneath.
    /// </summary>
    public void SetInteractive(bool interactive)
    {
        _interactive = interactive;

        if (interactive)
            Win32.RemoveExStyle(Hwnd, Win32.WS_EX_TRANSPARENT);
        else
            Win32.AddExStyle(Hwnd, Win32.WS_EX_TRANSPARENT);

        // Re-assert WS_EX_LAYERED. Removing WS_EX_TRANSPARENT above rewrites the
        // whole ex-style word, and losing LAYERED here would silently drop any
        // display affinity set on this window.
        Win32.AddExStyle(Hwnd, Win32.WS_EX_LAYERED);
    }

    public bool IsInteractive => _interactive;

    /// <summary>
    /// Keep this window out of every screen capture on the machine, or allow it
    /// to be recorded.
    ///
    /// The overlay itself is normally NOT excluded -- being captured is the
    /// point. This exists because the same mechanism backs the toolbar's
    /// hide-from-capture setting, and because verifying it here is how the
    /// WS_EX_LAYERED dependency was pinned down.
    /// </summary>
    public bool SetExcludedFromCapture(bool excluded)
    {
        Win32.AddExStyle(Hwnd, Win32.WS_EX_LAYERED);
        Win32.SetWindowDisplayAffinity(
            Hwnd, excluded ? Win32.WDA_EXCLUDEFROMCAPTURE : Win32.WDA_NONE);

        // Read it back. The call returns TRUE even when the style prerequisite
        // is missing, so the only trustworthy check is what stuck.
        Win32.GetWindowDisplayAffinity(Hwnd, out var actual);
        return actual == (excluded ? Win32.WDA_EXCLUDEFROMCAPTURE : Win32.WDA_NONE);
    }

    // --- Drawing ------------------------------------------------------------

    private void OnDraw(CanvasControl sender, CanvasDrawEventArgs args)
    {
        foreach (var stroke in _strokes) Annotation.Draw(args.DrawingSession, stroke);
        if (_current is not null) Annotation.Draw(args.DrawingSession, _current);
    }

    private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
    {
        if (!_interactive) return;
        var p = e.GetCurrentPoint(_canvas).Position;

        if (_settings.Draw.Tool == DrawTool.Eraser)
        {
            EraseAt(p);
            return;
        }

        _current = new Stroke
        {
            Tool = _settings.Draw.Tool,
            Color = Annotation.ParseColor(_settings.Draw.Color),
            Width = (float)_settings.Draw.Width,
        };
        _current.Points.Add(p);
        _canvas.CapturePointer(e.Pointer);
    }

    private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
    {
        if (!_interactive) return;
        var p = e.GetCurrentPoint(_canvas).Position;

        if (_settings.Draw.Tool == DrawTool.Eraser
            && e.GetCurrentPoint(_canvas).Properties.IsLeftButtonPressed)
        {
            EraseAt(p);
            return;
        }

        if (_current is null) return;

        // Shapes are defined by two corners, so only the last point moves;
        // freehand tools accumulate every sample.
        if (_current.Tool is DrawTool.Pen or DrawTool.Highlighter)
        {
            _current.Points.Add(p);
        }
        else if (_current.Points.Count > 1)
        {
            _current.Points[^1] = p;
        }
        else
        {
            _current.Points.Add(p);
        }

        // CanvasControl coalesces to one paint per frame internally, so this is
        // safe to call at pointer rate (often 2-4x the display refresh).
        _canvas.Invalidate();
    }

    private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
    {
        if (_current is not null)
        {
            _strokes.Add(_current);
            _current = null;
            _canvas.Invalidate();
        }
        _canvas.ReleasePointerCaptures();
    }

    /// <summary>
    /// Remove whole strokes under the cursor rather than painting over them:
    /// there is no background to paint with on a transparent overlay, so an
    /// alpha eraser would punch holes through to the desktop.
    /// </summary>
    private void EraseAt(Point p)
    {
        var radius = Math.Max(12, _settings.Draw.Width * 3);
        var removed = _strokes.RemoveAll(s => Annotation.HitTest(s, p, radius));
        if (removed > 0) _canvas.Invalidate();
    }

    public void Undo()
    {
        if (_strokes.Count == 0) return;
        _strokes.RemoveAt(_strokes.Count - 1);
        _canvas.Invalidate();
    }

    public void ClearAll()
    {
        if (_strokes.Count == 0 && _current is null) return;
        _strokes.Clear();
        _current = null;
        _canvas.Invalidate();
    }

    public void Dismiss() => Dismissed?.Invoke();
}
