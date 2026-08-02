using EzScreenRecord.Capture;
using EzScreenRecord.Models;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
using Windows.Media.Capture;
using Windows.UI;

// Our normalised overlay rect, not Windows.Foundation.Rect (which is in pixels).
using Rect = EzScreenRecord.Models.Rect;

namespace EzScreenRecord.Views;

/// <summary>
/// The live 16:9 preview of the final frame.
///
/// Everything is in normalised (0..1) coordinates, so a layout arranged here
/// lands identically on a capture of any resolution. The screen behind it is a
/// live feed rather than a still: a static thumbnail cannot show what is
/// actually about to be recorded.
/// </summary>
public sealed class LayoutStageControl : UserControl
{
    private const double AnchorSize = 14;
    /// <summary>
    /// Preview refresh. Deliberately slow: this runs while the app merely sits
    /// open, and the preview only has to show WHERE things are, not play back
    /// smoothly. Electron throttles its equivalent to 15fps for the same reason.
    /// </summary>
    private static readonly TimeSpan ScreenRefresh = TimeSpan.FromMilliseconds(1000 / 8.0);

    private readonly Grid _root;
    private readonly Image _screen;
    private readonly TextBlock _placeholder;
    private readonly Canvas _canvas;
    private readonly Border _cameraBox;
    private readonly Image _cameraImage;
    private readonly List<Rectangle> _anchors = [];
    private readonly StackPanel _shapeBar;

    private CameraOverlay _camera = new();
    private CaptureSourceChoice? _source;
    private MediaCapture? _capture;
    private DispatcherTimer? _screenTimer;

    public event Action<Rect>? CameraRectChanged;
    public event Action? CameraShapeChanged;

    private enum DragKind { None, Move, Resize }

    private DragKind _dragKind = DragKind.None;
    private Corner _dragCorner;
    private Point _dragStart;
    private Rect _dragOrigin = new();

    public LayoutStageControl()
    {
        _screen = new Image { Stretch = Stretch.UniformToFill };

        _placeholder = new TextBlock
        {
            Text = "Pick a screen or window to see a live preview",
            Foreground = new SolidColorBrush(Color.FromArgb(160, 255, 255, 255)),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            TextAlignment = TextAlignment.Center,
            TextWrapping = TextWrapping.Wrap,
        };

        _cameraImage = new Image
        {
            Stretch = Stretch.UniformToFill,
            Source = _cameraFrames,
            Visibility = Visibility.Collapsed,
        };

        _cameraBox = new Border
        {
            Child = _cameraImage,
            Background = new SolidColorBrush(Color.FromArgb(40, 255, 255, 255)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(220, 10, 132, 255)),
            BorderThickness = new Thickness(1.5),
        };

        // Clip the feed to the box.
        //
        // UniformToFill scales to COVER, so the image is deliberately larger
        // than the box on one axis. A Border does not clip its child unless told
        // to, so without this the video overflowed: resizing moved the selection
        // rectangle while the picture stayed put, which is what made the webcam
        // look broken. The Border's own CornerRadius then shapes the result.
        _cameraBox.SizeChanged += (_, e) => _cameraBox.Clip = new RectangleGeometry
        {
            Rect = new Windows.Foundation.Rect(0, 0, e.NewSize.Width, e.NewSize.Height),
        };
        _cameraBox.PointerPressed += (_, e) => BeginDrag(e, DragKind.Move, default);

        _canvas = new Canvas();
        _canvas.Children.Add(_cameraBox);

        foreach (var corner in (Corner[])Enum.GetValues(typeof(Corner)))
        {
            var anchor = new Rectangle
            {
                Width = AnchorSize,
                Height = AnchorSize,
                Fill = new SolidColorBrush(Colors.White),
                Stroke = new SolidColorBrush(Color.FromArgb(255, 10, 132, 255)),
                StrokeThickness = 2,
                RadiusX = 2,
                RadiusY = 2,
                Tag = corner,
            };
            anchor.PointerPressed += (s, e) =>
                BeginDrag(e, DragKind.Resize, (Corner)((FrameworkElement)s).Tag!);
            _anchors.Add(anchor);
            _canvas.Children.Add(anchor);
        }

        _shapeBar = BuildShapeBar();
        _canvas.Children.Add(_shapeBar);

        _root = new Grid
        {
            Background = new SolidColorBrush(Colors.Black),
            CornerRadius = new CornerRadius(6),
        };
        _root.Children.Add(_screen);
        _root.Children.Add(_placeholder);
        _root.Children.Add(_canvas);
        _root.Children.Add(HintChip());

        _root.SizeChanged += (_, _) => Layout();

        Loaded += async (_, _) =>
        {
            Layout();
            if (_pendingCameraStart)
            {
                _pendingCameraStart = false;
                await StartCameraAsync();
            }
        };

        PointerMoved += OnPointerMoved;
        PointerReleased += OnPointerReleased;
        PointerCaptureLost += OnPointerReleased;

        // 16:9, enforced. The drag coordinate space IS the output frame, so the
        // stage must hold the aspect ratio exactly or every position is wrong.
        var ratio = new Viewbox { Child = _root, Stretch = Stretch.Uniform };
        _root.Width = 640;
        _root.Height = 360;

        Content = ratio;
        Layout();
    }

    private UIElement HintChip() => new Border
    {
        Background = new SolidColorBrush(Color.FromArgb(166, 0, 0, 0)),
        CornerRadius = new CornerRadius(4),
        Padding = new Thickness(8, 3, 8, 3),
        Margin = new Thickness(8),
        HorizontalAlignment = HorizontalAlignment.Left,
        VerticalAlignment = VerticalAlignment.Bottom,
        IsHitTestVisible = false,
        Child = new TextBlock
        {
            Text = "Drag to move · corner handle to resize",
            FontSize = 11,
            Foreground = new SolidColorBrush(Color.FromArgb(220, 255, 255, 255)),
        },
    };

    /// <summary>
    /// The floating shape bar that appears on the camera: rounded / square /
    /// circle / mirror / shadow, exactly as in the Electron preview.
    /// </summary>
    private StackPanel BuildShapeBar()
    {
        var bar = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 2,
            Padding = new Thickness(3),
        };

        void Add(string glyph, string tip, Func<bool> isActive, Action onClick)
        {
            var button = new Button
            {
                Content = new FontIcon { Glyph = glyph, FontSize = 13 },
                Width = 26,
                Height = 26,
                Padding = new Thickness(0),
                CornerRadius = new CornerRadius(4),
                BorderThickness = new Thickness(0),
            };
            ToolTipService.SetToolTip(button, tip);
            button.Click += (_, _) =>
            {
                onClick();
                RefreshShapeBar();
                Layout();
                CameraShapeChanged?.Invoke();
            };
            button.Tag = isActive;
            bar.Children.Add(button);
        }

        Add(Glyphs.Rectangle, "Rounded",
            () => _camera.Shape == OverlayShape.Rounded,
            () => _camera.Shape = OverlayShape.Rounded);
        Add(Glyphs.Square, "Square",
            () => _camera.Shape == OverlayShape.Square,
            () => _camera.Shape = OverlayShape.Square);
        Add(Glyphs.Circle, "Circle",
            () => _camera.Shape == OverlayShape.Circle,
            () => _camera.Shape = OverlayShape.Circle);
        Add(Glyphs.Mirror, "Mirror",
            () => _camera.Mirrored,
            () => _camera.Mirrored = !_camera.Mirrored);
        Add(Glyphs.Shadow, "Drop shadow",
            () => _camera.Shadow,
            () => _camera.Shadow = !_camera.Shadow);

        var host = new StackPanel { Orientation = Orientation.Horizontal };
        var wrapper = new Border
        {
            Child = bar,
            Background = new SolidColorBrush(Color.FromArgb(240, 28, 28, 32)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(36, 255, 255, 255)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
        };
        host.Children.Add(wrapper);
        // Visibility is driven by Layout(), which shows the bar whenever the
        // camera overlay is enabled.
        return host;
    }

    private void RefreshShapeBar()
    {
        var wrapper = (Border)((StackPanel)_shapeBar).Children[0];
        foreach (var child in ((StackPanel)wrapper.Child).Children)
        {
            if (child is Button { Tag: Func<bool> isActive } button)
            {
                button.Background = isActive()
                    ? (Brush)Application.Current.Resources["AccentFillColorDefaultBrush"]
                    : new SolidColorBrush(Colors.Transparent);
            }
        }
    }

    // --- Public API ---------------------------------------------------------

    public void SetCamera(CameraOverlay camera)
    {
        _camera = camera;
        RefreshShapeBar();
        Layout();

        if (!camera.Enabled)
        {
            StopCamera();
            return;
        }

        // Defer until the control is in the visual tree.
        //
        // SetCamera is called from the window's constructor, and a
        // MediaPlayerElement that is not yet loaded silently refuses to attach
        // a source -- so the preview stayed an empty outline until the user
        // toggled the camera off and on again, which happened to run this after
        // Loaded had fired.
        if (IsLoaded) _ = StartCameraAsync();
        else _pendingCameraStart = true;
    }

    private bool _pendingCameraStart;

    public void SetImages(IReadOnlyList<ImageOverlay> images)
    {
        // Image overlays render beneath the camera, matching the recorder's
        // compositing order. Placement UI for them is still to come.
        Layout();
    }

    /// <summary>Drop the capture source and return to the empty state.</summary>
    public void ClearSource()
    {
        _source = null;
        _screenTimer?.Stop();
        _screenTimer = null;
        _screen.Source = null;
        _placeholder.Visibility = Visibility.Visible;
    }

    public async Task SetSourceAsync(CaptureSourceChoice source)
    {
        _source = source;
        _placeholder.Visibility = Visibility.Collapsed;
        await StartPreviewsAsync();
    }

    /// <summary>Start (or restart) the live screen and camera previews.</summary>
    public async Task StartPreviewsAsync()
    {
        StartScreenPreview();
        if (_camera.Enabled) await StartCameraAsync();
    }

    /// <summary>
    /// Release the capture devices. ffmpeg needs exclusive access to the webcam
    /// during a take, and refreshing a screen preview while recording is wasted
    /// GPU time.
    /// </summary>
    public void StopPreviews()
    {
        _screenTimer?.Stop();
        _screenTimer = null;
        StopCamera();
    }

    // --- Live screen preview ------------------------------------------------

    private void StartScreenPreview()
    {
        _screenTimer?.Stop();
        if (_source is null) return;

        _screenTimer = new DispatcherTimer { Interval = ScreenRefresh };
        _screenTimer.Tick += async (_, _) => await RefreshScreenAsync();
        _screenTimer.Start();

        _ = RefreshScreenAsync();
    }

    private bool _refreshing;

    private async Task RefreshScreenAsync()
    {
        // Skip rather than queue: a slow PrintWindow must not build a backlog
        // of frames that are already stale by the time they are drawn.
        if (_refreshing || _source is null) return;
        _refreshing = true;
        try
        {
            var image = await _source.LoadThumbnailAsync(960);
            if (image is not null)
            {
                _screen.Source = image;
                _placeholder.Visibility = Visibility.Collapsed;
            }
        }
        catch
        {
            // A window that closed mid-preview; the next tick will notice.
        }
        finally
        {
            _refreshing = false;
        }
    }

    // --- Live camera preview ------------------------------------------------

    private async Task StartCameraAsync()
    {
        if (_capture is not null) return;

        try
        {
            _capture = new MediaCapture();
            await _capture.InitializeAsync(new MediaCaptureInitializationSettings
            {
                StreamingCaptureMode = StreamingCaptureMode.Video,
                MemoryPreference = MediaCaptureMemoryPreference.Cpu,
            });

            // Explicit iteration: LINQ cannot enumerate WinRT projections.
            Windows.Media.Capture.Frames.MediaFrameSource? source = null;
            foreach (var candidate in _capture.FrameSources)
            {
                source ??= candidate.Value;
                if (candidate.Value.Info.MediaStreamType == MediaStreamType.VideoPreview)
                {
                    source = candidate.Value;
                    break;
                }
            }

            if (source is null)
            {
                LastCameraError = "The camera reported no video frame source.";
                StopCamera();
                return;
            }

            // A MediaFrameReader painting into a SoftwareBitmapSource, rather
            // than MediaPlayerElement + MediaSource.CreateFromMediaFrameSource.
            // The latter is the documented shape but silently renders nothing
            // here: the element stays blank while MediaCapture itself opens the
            // device without error. Reading frames explicitly is dependable and
            // also lets the preview be throttled.
            _frameReader = await _capture.CreateFrameReaderAsync(
                source, Windows.Media.MediaProperties.MediaEncodingSubtypes.Bgra8);
            _frameReader.FrameArrived += OnCameraFrame;
            await _frameReader.StartAsync();
        }
        catch (Exception ex)
        {
            // No camera, or another app holds it exclusively. The box stays as
            // an outline rather than taking the app down -- but the reason is
            // recorded, because a silently empty camera box is impossible to
            // tell apart from one that is merely still starting.
            LastCameraError = ex.Message;
            StopCamera();
        }
    }

    /// <summary>Why the camera preview is not showing, if it is not.</summary>
    public string? LastCameraError { get; private set; }

    private Windows.Media.Capture.Frames.MediaFrameReader? _frameReader;
    private readonly Microsoft.UI.Xaml.Media.Imaging.SoftwareBitmapSource _cameraFrames = new();
    /// <summary>
    /// Earliest tick at which another frame may be handed to the UI thread.
    /// A deadline rather than a busy flag: a flag is never cleared if the UI
    /// thread is inside a modal loop (a window drag, a resize), so every later
    /// frame is dropped and the preview freezes for good.
    /// </summary>
    private long _frameBusyUntil;

    private const int FrameTimeoutMs = 250;

    /// <summary>
    /// Copy the newest camera frame into the preview.
    ///
    /// Frames arrive on a worker thread at the camera's native rate; drawing is
    /// marshalled to the UI thread and DROPPED while a previous frame is still
    /// being handed over. A preview only has to show where the camera sits, so
    /// falling behind is never worth queueing for.
    /// </summary>
    private void OnCameraFrame(
        Windows.Media.Capture.Frames.MediaFrameReader sender, object args)
    {
        var now = Environment.TickCount64;
        if (now < _frameBusyUntil) return;

        using var frame = sender.TryAcquireLatestFrame();
        var bitmap = frame?.VideoMediaFrame?.SoftwareBitmap;
        if (bitmap is null) return;

        // SoftwareBitmapSource requires BGRA8 premultiplied; the camera may
        // hand back something else.
        var converted = bitmap.BitmapPixelFormat == Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8
            && bitmap.BitmapAlphaMode == Windows.Graphics.Imaging.BitmapAlphaMode.Premultiplied
                ? bitmap
                : Windows.Graphics.Imaging.SoftwareBitmap.Convert(
                    bitmap,
                    Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8,
                    Windows.Graphics.Imaging.BitmapAlphaMode.Premultiplied);

        _frameBusyUntil = now + FrameTimeoutMs;
        var queued = DispatcherQueue.TryEnqueue(async () =>
        {
            try
            {
                await _cameraFrames.SetBitmapAsync(converted);
                _cameraImage.Visibility = Visibility.Visible;
            }
            catch
            {
                // The window closed mid-frame.
            }
            finally
            {
                _frameBusyUntil = 0;
            }
        });

        if (!queued) _frameBusyUntil = 0;
    }

    private void StopCamera()
    {
        try { _cameraImage.Visibility = Visibility.Collapsed; } catch { /* already torn down */ }

        // Stop the reader before disposing the capture: a reader still
        // delivering frames from a disposed MediaCapture throws on the frame
        // thread, where nothing can catch it.
        if (_frameReader is not null)
        {
            _frameReader.FrameArrived -= OnCameraFrame;
            try { _frameReader.StopAsync().AsTask().Wait(500); } catch { /* already stopping */ }
            try { _frameReader.Dispose(); } catch { /* already gone */ }
            _frameReader = null;
        }

        try { _capture?.Dispose(); } catch { /* already gone */ }
        _capture = null;
    }

    // --- Layout -------------------------------------------------------------

    private void Layout()
    {
        var w = _root.Width;
        var h = _root.Height;
        if (w <= 0 || h <= 0) return;

        var visible = _camera.Enabled;
        _cameraBox.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        foreach (var a in _anchors)
            a.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        _shapeBar.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        if (!visible) return;

        var r = _camera.Rect;
        var px = r.X * w;
        var py = r.Y * h;
        var pw = Math.Max(1, r.W * w);
        var ph = Math.Max(1, r.H * h);

        _cameraBox.Width = pw;
        _cameraBox.Height = ph;
        _cameraBox.CornerRadius = _camera.Shape switch
        {
            OverlayShape.Circle => new CornerRadius(Math.Min(pw, ph) / 2),
            OverlayShape.Rounded => new CornerRadius(Math.Min(pw, ph) * 0.12),
            _ => new CornerRadius(0),
        };

        // Mirroring is what the recording does, so the preview must match or
        // the layout is a lie.
        //
        // The flip is applied to the BOX, not to the image inside it.
        // UniformToFill makes the image larger than the box on one axis, so
        // RenderTransformOrigin 0.5 on the image is the centre of the oversized
        // image rather than of the visible area -- flipping about that pushed
        // the picture sideways and left it visibly offset from its frame.
        // Flipping the box mirrors exactly what is on screen.
        _cameraImage.RenderTransform = null;
        _cameraBox.RenderTransformOrigin = new Point(0.5, 0.5);
        _cameraBox.RenderTransform = _camera.Mirrored
            ? new ScaleTransform { ScaleX = -1 }
            : null;

        _cameraBox.Shadow = _camera.Shadow ? new ThemeShadow() : null;
        _cameraBox.Translation = _camera.Shadow
            ? new System.Numerics.Vector3(0, 0, 16)
            : new System.Numerics.Vector3(0, 0, 0);

        Canvas.SetLeft(_cameraBox, px);
        Canvas.SetTop(_cameraBox, py);

        foreach (var anchor in _anchors)
        {
            var (ax, ay) = (Corner)anchor.Tag! switch
            {
                Corner.NW => (px, py),
                Corner.NE => (px + pw, py),
                Corner.SW => (px, py + ph),
                _ => (px + pw, py + ph),
            };
            Canvas.SetLeft(anchor, ax - AnchorSize / 2);
            Canvas.SetTop(anchor, ay - AnchorSize / 2);
        }

        // Above the camera, or below it when the camera is near the top edge --
        // otherwise the bar would sit off the stage.
        Canvas.SetLeft(_shapeBar, px);
        Canvas.SetTop(_shapeBar, r.Y < 0.14 ? py + ph + 8 : py - 38);
    }

    // --- Drag / resize ------------------------------------------------------

    private void BeginDrag(PointerRoutedEventArgs e, DragKind kind, Corner corner)
    {
        _dragKind = kind;
        _dragCorner = corner;
        _dragStart = e.GetCurrentPoint(_root).Position;
        _dragOrigin = _camera.Rect.Clone();
        CapturePointer(e.Pointer);
        e.Handled = true;
    }

    private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
    {
        if (_dragKind == DragKind.None) return;
        var w = _root.Width;
        var h = _root.Height;
        if (w <= 0 || h <= 0) return;

        var p = e.GetCurrentPoint(_root).Position;
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
        ReleasePointerCaptures();
        CameraRectChanged?.Invoke(_camera.Rect);
        e.Handled = true;
    }
}
