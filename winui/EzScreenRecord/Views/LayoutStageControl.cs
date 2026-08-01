using EzScreenRecord.Models;
using Microsoft.UI;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
using Windows.UI;

// Our normalised overlay rect, not Windows.Foundation.Rect (which is in pixels
// and comes in via the Windows.Foundation import above).
using Rect = EzScreenRecord.Models.Rect;

namespace EzScreenRecord.Views;

/// <summary>
/// A live 16:9 preview of the final frame, with draggable/resizable overlays.
///
/// Built from XAML primitives on a Canvas rather than Win2D: the overlays are a
/// handful of rectangles with hit-testing and pointer capture, which the XAML
/// input system already does well. Win2D earns its place in the annotation
/// overlay (Phase 4), where strokes are drawn per-frame at high rates; here it
/// would mean reimplementing hit-testing and focus for no gain.
///
/// All positions are normalised (0..1) against the frame, so what is arranged
/// here lands identically on a capture of any resolution.
/// </summary>
public sealed class LayoutStageControl : UserControl
{
    private const double AnchorSize = 14;

    private Canvas? _canvas;
    private Border? _cameraBox;
    private readonly List<Rectangle> _anchors = [];

    private CameraOverlay _camera = new();

    /// <summary>Raised when the user finishes a drag, so settings can persist.</summary>
    public event Action<Rect>? CameraRectChanged;

    // --- Drag state ---------------------------------------------------------

    private enum DragKind { None, Move, Resize }

    private DragKind _dragKind = DragKind.None;
    private Corner _dragCorner;
    private Point _dragStart;
    private Rect _dragOrigin = new();
    private UIElement? _captured;

    public LayoutStageControl()
    {
        Build();
    }

    public void SetCamera(CameraOverlay camera)
    {
        _camera = camera;
        Layout();
    }

    /// <summary>Show a still of the capture source behind the overlays.</summary>
    public void SetBackground(BitmapImage? image)
    {
        if (_canvas is null) return;
        _canvas.Background = image is null
            ? new SolidColorBrush(Colors.Black)
            : new ImageBrush { ImageSource = image, Stretch = Stretch.UniformToFill };
    }

    private void Build()
    {
        _canvas = new Canvas
        {
            Background = new SolidColorBrush(Colors.Black),
        };

        // The camera bubble. Its own Border is clipped to give the bubble its
        // shape; the selection frame and anchors are SIBLINGS rather than
        // children, because a clipped circle swallows handles drawn inside it.
        _cameraBox = new Border
        {
            BorderBrush = new SolidColorBrush(Colors.White),
            BorderThickness = new Thickness(2),
            Background = new SolidColorBrush(Color.FromArgb(40, 255, 255, 255)),
            Child = new TextBlock
            {
                Text = "Camera",
                Foreground = new SolidColorBrush(Colors.White),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                FontSize = 12,
            },
        };
        _cameraBox.PointerPressed += (s, e) => BeginDrag(e, DragKind.Move, default, (UIElement)s);
        _canvas.Children.Add(_cameraBox);

        foreach (var corner in (Corner[])Enum.GetValues(typeof(Corner)))
        {
            var anchor = new Rectangle
            {
                Width = AnchorSize,
                Height = AnchorSize,
                Fill = new SolidColorBrush(Colors.White),
                Stroke = new SolidColorBrush(Color.FromArgb(160, 0, 0, 0)),
                StrokeThickness = 1,
                RadiusX = 3,
                RadiusY = 3,
                Tag = corner,
            };
            anchor.PointerPressed += (s, e) =>
            {
                var el = (FrameworkElement)s;
                BeginDrag(e, DragKind.Resize, (Corner)el.Tag!, el);
            };
            _anchors.Add(anchor);
            _canvas.Children.Add(anchor);
        }

        _canvas.SizeChanged += (_, _) => Layout();
        PointerMoved += OnPointerMoved;
        PointerReleased += OnPointerReleased;
        PointerCaptureLost += OnPointerReleased;

        Content = _canvas;
    }

    private void Layout()
    {
        if (_canvas is null || _cameraBox is null) return;
        var w = _canvas.ActualWidth;
        var h = _canvas.ActualHeight;
        if (w <= 0 || h <= 0) return;

        var visible = _camera.Enabled;
        _cameraBox.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        foreach (var a in _anchors)
            a.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        if (!visible) return;

        var r = _camera.Rect;
        var px = r.X * w;
        var py = r.Y * h;
        var pw = Math.Max(1, r.W * w);
        var ph = Math.Max(1, r.H * h);

        _cameraBox.Width = pw;
        _cameraBox.Height = ph;
        // A circle is a fully-rounded rectangle; matching the recorder's
        // corner_rounding keeps the preview honest about the output.
        _cameraBox.CornerRadius = _camera.Shape switch
        {
            OverlayShape.Circle => new CornerRadius(Math.Min(pw, ph) / 2),
            OverlayShape.Rounded => new CornerRadius(Math.Min(pw, ph) * 0.12),
            _ => new CornerRadius(0),
        };
        Canvas.SetLeft(_cameraBox, px);
        Canvas.SetTop(_cameraBox, py);

        for (var i = 0; i < _anchors.Count; i++)
        {
            var (ax, ay) = (Corner)_anchors[i].Tag! switch
            {
                Corner.NW => (px, py),
                Corner.NE => (px + pw, py),
                Corner.SW => (px, py + ph),
                _ => (px + pw, py + ph),
            };
            Canvas.SetLeft(_anchors[i], ax - AnchorSize / 2);
            Canvas.SetTop(_anchors[i], ay - AnchorSize / 2);
        }
    }

    private void BeginDrag(PointerRoutedEventArgs e, DragKind kind, Corner corner, UIElement source)
    {
        _dragKind = kind;
        _dragCorner = corner;
        _dragStart = e.GetCurrentPoint(this).Position;
        _dragOrigin = _camera.Rect.Clone();
        _captured = source;
        CapturePointer(e.Pointer);
        e.Handled = true;
    }

    private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
    {
        if (_dragKind == DragKind.None || _canvas is null) return;
        var w = _canvas.ActualWidth;
        var h = _canvas.ActualHeight;
        if (w <= 0 || h <= 0) return;

        var p = e.GetCurrentPoint(this).Position;
        // Deltas are normalised by the stage size, so a drag maps 1:1 onto the
        // frame regardless of how large the preview is drawn.
        var dx = (p.X - _dragStart.X) / w;
        var dy = (p.Y - _dragStart.Y) / h;

        _camera.Rect = _dragKind == DragKind.Move
            ? LayoutGeometry.Move(_dragOrigin, dx, dy)
            : LayoutGeometry.Resize(_dragOrigin, _dragCorner, dx, dy);

        Layout();
        e.Handled = true;
    }

    private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
    {
        if (_dragKind == DragKind.None) return;
        _dragKind = DragKind.None;
        _captured = null;
        ReleasePointerCaptures();
        CameraRectChanged?.Invoke(_camera.Rect);
        e.Handled = true;
    }
}
