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
using Windows.Media.Capture;

// Our normalised overlay rect, not Windows.Foundation.Rect.
using Rect = EzScreenRecord.Models.Rect;

namespace EzScreenRecord.Views;

/// <summary>
/// The webcam as a real, draggable window on the desktop.
///
/// This is the DEFAULT camera path, and the reason is frame rate rather than
/// looks. Letting ffmpeg composite the camera puts it through libplacebo's
/// framesync'd blend, which paces the entire graph off the webcam: a 30fps
/// camera (15fps in dim light) pulled 60fps takes down to ~21 unique fps and
/// 120fps takes to ~13. As an ordinary always-on-top window the bubble is
/// simply part of the desktop that ddagrab already captures, so the screen is
/// never held back -- the same trick the annotation overlay uses.
///
/// It also means the bubble can be dragged and resized live, mid-take.
/// </summary>
public sealed class CameraBubbleWindow : Window
{
    private readonly AppSettings _settings;
    private readonly Border _frame;
    private readonly Image _preview;
    private readonly Microsoft.UI.Xaml.Media.Imaging.SoftwareBitmapSource _frames = new();
    private Windows.Media.Capture.Frames.MediaFrameReader? _frameReader;
    private bool _frameBusy;
    private MediaCapture? _capture;

    /// <summary>
    /// Copy the newest camera frame into the bubble. Frames arrive on a worker
    /// thread; drawing is marshalled to the UI thread and dropped while a
    /// previous frame is still in flight, so a busy UI falls behind rather than
    /// queueing.
    /// </summary>
    private void OnFrame(Windows.Media.Capture.Frames.MediaFrameReader sender, object args)
    {
        if (_frameBusy) return;

        using var frame = sender.TryAcquireLatestFrame();
        var bitmap = frame?.VideoMediaFrame?.SoftwareBitmap;
        if (bitmap is null) return;

        // SoftwareBitmapSource requires BGRA8 premultiplied.
        var converted =
            bitmap.BitmapPixelFormat == Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8 &&
            bitmap.BitmapAlphaMode == Windows.Graphics.Imaging.BitmapAlphaMode.Premultiplied
                ? bitmap
                : Windows.Graphics.Imaging.SoftwareBitmap.Convert(
                    bitmap,
                    Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8,
                    Windows.Graphics.Imaging.BitmapAlphaMode.Premultiplied);

        _frameBusy = true;
        var queued = DispatcherQueue.TryEnqueue(async () =>
        {
            try { await _frames.SetBitmapAsync(converted); }
            catch { /* the window closed mid-frame */ }
            finally { _frameBusy = false; }
        });

        if (!queued) _frameBusy = false;
    }

    private bool _dragging;
    private Point _dragStart;
    private PointInt32 _windowStart;

    public CameraBubbleWindow(AppSettings settings)
    {
        _settings = settings;

        Title = "Camera";

        // An Image fed by a MediaFrameReader. See StartPreviewAsync for why
        // MediaPlayerElement is not used.
        _preview = new Image
        {
            Stretch = Stretch.UniformToFill,
            Source = _frames,
        };

        _frame = new Border
        {
            Child = _preview,
            // No border. This bubble is recorded as part of the desktop, so a
            // white ring around the webcam ends up burned into the video. The
            // Electron original draws its selection frame only on hover, never
            // permanently.
            BorderThickness = new Thickness(0),
        };
        _frame.PointerPressed += OnPointerPressed;
        _frame.PointerMoved += OnPointerMoved;
        _frame.PointerReleased += OnPointerReleased;

        Content = _frame;

        ExtendsContentIntoTitleBar = true;

        var presenter = (OverlappedPresenter)AppWindow.Presenter;
        presenter.IsResizable = false;
        presenter.IsMaximizable = false;
        presenter.IsMinimizable = false;
        presenter.SetBorderAndTitleBar(false, false);
        presenter.IsAlwaysOnTop = true;

        AppWindow.IsShownInSwitchers = false;

        // No system frame: this window is recorded as part of the desktop, so
        // any frame Windows draws is burned into the video.
        Win32.MakeBorderless(Hwnd, rounded: false);

        ApplyShape();
        PositionFromSettings();
    }

    private IntPtr Hwnd => WinRT.Interop.WindowNative.GetWindowHandle(this);

    /// <summary>
    /// Place the bubble using the same normalised rect the preview uses, so the
    /// on-screen position matches what was arranged in the layout stage.
    /// </summary>
    public void PositionFromSettings()
    {
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary);
        var work = area.WorkArea;
        var r = _settings.Camera.Rect;

        AppWindow.MoveAndResize(new RectInt32(
            work.X + (int)(r.X * work.Width),
            work.Y + (int)(r.Y * work.Height),
            Math.Max(80, (int)(r.W * work.Width)),
            Math.Max(60, (int)(r.H * work.Height))));
    }

    private void ApplyShape()
    {
        var r = _settings.Camera.Rect;
        var side = Math.Min(r.W, r.H) * 400;
        _frame.CornerRadius = _settings.Camera.Shape switch
        {
            OverlayShape.Circle => new CornerRadius(side / 2),
            OverlayShape.Rounded => new CornerRadius(16),
            _ => new CornerRadius(0),
        };
    }

    public async Task StartPreviewAsync()
    {
        try
        {
            _capture = new MediaCapture();
            await _capture.InitializeAsync(new MediaCaptureInitializationSettings
            {
                StreamingCaptureMode = StreamingCaptureMode.Video,
                // CPU frames: MediaSource.CreateFromMediaFrameSource cannot
                // consume a D3D surface here, and the bubble is small enough
                // that the copy is not worth optimising away.
                MemoryPreference = MediaCaptureMemoryPreference.Cpu,
            });

            // Explicit iteration, not LINQ: WinRT collection projections cannot
            // always be enumerated by LINQ and throw
            // InvalidCastException("No such interface supported") from inside
            // the projection when they cannot.
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

            if (source is null) return;

            // A MediaFrameReader painting into a SoftwareBitmapSource, NOT
            // MediaPlayerElement + MediaSource.CreateFromMediaFrameSource.
            // The latter is the documented shape and silently renders nothing:
            // MediaCapture opens the device without error and the element stays
            // blank, so the bubble appeared in recordings as a black rectangle
            // with a white border and no picture.
            _frameReader = await _capture.CreateFrameReaderAsync(
                source, Windows.Media.MediaProperties.MediaEncodingSubtypes.Bgra8);
            _frameReader.FrameArrived += OnFrame;
            await _frameReader.StartAsync();
        }
        catch
        {
            // No camera, or another app holds it exclusively. The bubble stays
            // up as an empty frame rather than taking the app down; the user can
            // close it or pick a different device.
        }
    }

    /// <summary>
    /// Keep the bubble OUT of the capture, or let it be recorded.
    ///
    /// Normally false: the whole point is that the desktop capture picks the
    /// bubble up. Exposed for parity with the toolbar, which uses the same
    /// mechanism to hide itself.
    /// </summary>
    public void SetExcludedFromCapture(bool excluded)
    {
        // WDA_EXCLUDEFROMCAPTURE silently requires WS_EX_LAYERED. Assert the
        // style first, or the call succeeds and does nothing.
        if (excluded) Win32.AddExStyle(Hwnd, Win32.WS_EX_LAYERED);
        Win32.SetWindowDisplayAffinity(
            Hwnd, excluded ? Win32.WDA_EXCLUDEFROMCAPTURE : Win32.WDA_NONE);
    }

    // --- Dragging -----------------------------------------------------------
    // The window has no title bar to drag, so the whole surface moves it.

    // Screen coordinates, not window-relative ones. GetCurrentPoint(null) is
    // measured against the window being dragged, so each frame moves the
    // reference for the next and the bubble judders after the cursor.

    private POINT _dragOrigin;

    private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
    {
        _dragging = true;
        GetCursorPos(out _dragOrigin);
        _windowStart = AppWindow.Position;
        _frame.CapturePointer(e.Pointer);
    }

    private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
    {
        if (!_dragging) return;
        GetCursorPos(out var cursor);
        AppWindow.Move(new PointInt32(
            _windowStart.X + (cursor.X - _dragOrigin.X),
            _windowStart.Y + (cursor.Y - _dragOrigin.Y)));
    }

    [System.Runtime.InteropServices.StructLayout(
        System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);

    private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
    {
        if (!_dragging) return;
        _dragging = false;
        _frame.ReleasePointerCaptures();
        PersistPosition();
    }

    /// <summary>
    /// Store the bubble's position back as a fraction of the work area, so the
    /// layout stage and a later session agree with where it actually sits.
    /// </summary>
    private void PersistPosition()
    {
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary);
        var work = area.WorkArea;
        if (work.Width <= 0 || work.Height <= 0) return;

        var pos = AppWindow.Position;
        var size = AppWindow.Size;

        _settings.Camera.Rect = new Rect(
            (double)(pos.X - work.X) / work.Width,
            (double)(pos.Y - work.Y) / work.Height,
            (double)size.Width / work.Width,
            (double)size.Height / work.Height);

        _settings.Save();
    }

    public void Cleanup()
    {
        // Stop the reader before disposing the capture: a reader still
        // delivering frames from a disposed MediaCapture throws on the frame
        // thread, where nothing can catch it.
        if (_frameReader is not null)
        {
            _frameReader.FrameArrived -= OnFrame;
            try { _frameReader.StopAsync().AsTask().Wait(500); } catch { /* already stopping */ }
            try { _frameReader.Dispose(); } catch { /* already gone */ }
            _frameReader = null;
        }

        try { _capture?.Dispose(); } catch { /* already gone */ }
        _capture = null;
    }
}
