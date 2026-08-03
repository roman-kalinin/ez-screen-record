using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using EzScreenRecord.Models;
using Point = Windows.Foundation.Point;

namespace EzScreenRecord.Interop;

/// <summary>
/// The annotation overlay, as a pure Win32 layered window.
///
/// WinUI 3 CANNOT do this, and that was measured rather than assumed. A XAML
/// window stayed fully opaque under every documented approach --
/// Colors.Transparent, SystemBackdrop = null, DwmExtendFrameIntoClientArea,
/// SetLayeredWindowAttributes with a colour key (verified applied via
/// GetLayeredWindowAttributes), DwmEnableBlurBehindWindow, and a Composition
/// colour brush with alpha 0 through ICompositionSupportsSystemBackdrop.
/// Sampling the live screen with GetPixel returned a single flat colour every
/// time, INCLUDING with the Win2D canvas removed entirely. WinUI composites
/// through DirectComposition and the window never sees the alpha of its own
/// content.
///
/// UpdateLayeredWindow does work: it takes a 32-bit premultiplied ARGB bitmap
/// and composites it per pixel, so transparent areas genuinely show the desktop
/// while strokes stay opaque. That is the whole reason this class exists in
/// Win32 rather than XAML.
/// </summary>
public sealed class LayeredOverlay : IDisposable
{
    private const string ClassName = "EzScreenRecordOverlay";

    private readonly WndProcDelegate _wndProc;
    private readonly List<Stroke> _strokes = [];
    private Stroke? _current;

    /// <summary>
    /// Guards <see cref="_strokes"/>, which two threads touch: the overlay's
    /// own message pump iterates it to repaint, while Undo and Clear arrive
    /// from the UI thread (the palette buttons and the hotkeys).
    ///
    /// Without this, clearing mid-stroke throws "Collection was modified"
    /// inside the pump's foreach. Nothing catches on that thread, so the
    /// exception takes the whole process down -- during a recording, which
    /// loses the take.
    /// </summary>
    private readonly Lock _strokesLock = new();

    private IntPtr _hwnd;
    private string? _className;
    private bool _interactive;
    private bool _disposed;

    private int _x, _y, _width, _height;

    /// <summary>Current tool settings, read live so the palette can change them.</summary>
    public DrawSettings Draw { get; set; } = new();

    /// <summary>Raised when the user finishes with the overlay (Esc).</summary>
    public event Action? Dismissed;

    public IntPtr Handle => _hwnd;

    private Thread? _thread;
    private uint _threadId;
    private readonly ManualResetEventSlim _ready = new(false);

    /// <summary>
    /// Create the overlay on its OWN thread, with its own message pump.
    ///
    /// This is not optional. Created on the XAML UI thread, the window belongs
    /// to WinUI's message loop, which dispatches into the DispatcherQueue and
    /// never calls a raw WndProc -- so WM_LBUTTONDOWN and friends are simply
    /// never delivered and nothing can be drawn. The window looks perfectly
    /// healthy from the outside: right position, right styles, visible, and
    /// completely inert.
    /// </summary>
    public LayeredOverlay()
    {
        _wndProc = WindowProc;

        _thread = new Thread(() =>
        {
            _threadId = GetCurrentThreadId();
            try
            {
                CreateWindow();
                Redraw();
            }
            finally
            {
                // Must run even if window creation threw, or every caller
                // blocks on _ready for the full 5s timeout and then proceeds
                // against a null HWND as though everything were fine.
                _ready.Set();
            }

            // Classic pump. Ends when PostQuitMessage runs on Dispose.
            while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                // An escaping exception here is fatal to the process, and this
                // thread has no synchronisation context to marshal it back to
                // anything. Losing an annotation frame is survivable; losing
                // the recording that is running at the time is not.
                try
                {
                    TranslateMessage(ref msg);
                    DispatchMessage(ref msg);
                }
                catch
                {
                    // Drop the message and keep pumping.
                }
            }
        })
        {
            IsBackground = true,
            Name = "EzOverlay",
        };

        // STA: the overlay shares a process with XAML and COM, and a window
        // thread should be single-threaded apartment regardless.
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();

        // Wait for the window to exist so callers can use Handle immediately.
        _ready.Wait(TimeSpan.FromSeconds(5));
    }

    // --- Window creation ----------------------------------------------------

    private void CreateWindow()
    {
        // A unique class name per overlay, because the previous one may still be
        // unregistering when a new overlay is created and RegisterClassEx would
        // fail on the collision. The name is kept so Dispose can unregister it:
        // minting a fresh atom on every F8 and never releasing one exhausts the
        // process's 16,384-atom table, after which CreateWindowEx fails, the
        // handle stays null, and F8 does nothing at all -- silently.
        _className = ClassName + Guid.NewGuid().ToString("N");

        var wc = new WNDCLASSEX
        {
            cbSize = Marshal.SizeOf<WNDCLASSEX>(),
            style = 0,
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProc),
            hInstance = GetModuleHandle(null),
            hCursor = LoadCursor(IntPtr.Zero, IDC_CROSS),
            lpszClassName = _className,
        };

        RegisterClassEx(ref wc);

        // Span the whole virtual desktop so drawing works across every monitor.
        _x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        _y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        _width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        _height = GetSystemMetrics(SM_CYVIRTUALSCREEN);

        _hwnd = CreateWindowEx(
            // LAYERED for per-pixel alpha, TOPMOST to sit over everything,
            // TOOLWINDOW to stay out of Alt-Tab.
            //
            // NOT NOACTIVATE: the overlay has to take focus to receive the tool
            // keys (P/H/A/R/O/E, Ctrl+Z, Del, Esc). It is only up while the
            // user is deliberately drawing, so holding focus is correct here --
            // unlike the toolbar and palette, which must never steal it.
            Win32.WS_EX_LAYERED | Win32.WS_EX_TOPMOST | Win32.WS_EX_TOOLWINDOW,
            wc.lpszClassName, "Ez Screen Record — drawing",
            unchecked((int)0x80000000) /* WS_POPUP */,
            _x, _y, _width, _height,
            IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);

        ShowWindow(_hwnd, 5 /* SW_SHOW */);

        // Force topmost AFTER showing. WS_EX_TOPMOST at creation is not enough
        // on its own -- the window ended up below other topmost windows, so
        // WindowFromPoint returned whatever was underneath and clicks never
        // reached the overlay at all.
        Win32.SetWindowPos(_hwnd, Win32.HWND_TOPMOST, 0, 0, 0, 0,
            Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_SHOWWINDOW);

        SetForegroundWindow(_hwnd);
        SetFocus(_hwnd);

        // Interactive from the start. The overlay is only created when the user
        // asks to draw, so arming it click-through would mean the first stroke
        // silently did nothing.
        SetClickThrough(false);
    }

    /// <summary>
    /// Toggle whether the overlay receives mouse input. Click-through is the
    /// default: the overlay covers the desktop the whole time it is armed and
    /// must not swallow clicks meant for the app underneath.
    /// </summary>
    public void SetClickThrough(bool clickThrough)
    {
        _interactive = !clickThrough;

        if (clickThrough) Win32.AddExStyle(_hwnd, Win32.WS_EX_TRANSPARENT);
        else Win32.RemoveExStyle(_hwnd, Win32.WS_EX_TRANSPARENT);

        // Re-assert LAYERED: changing the ex-style word can drop it, and losing
        // it here would both break the alpha and silently clear any display
        // affinity set on this window.
        Win32.AddExStyle(_hwnd, Win32.WS_EX_LAYERED);

        // Repaint: the base layer's alpha depends on the mode, so the surface
        // has to be pushed again for the hit test to follow.
        RequestRedraw();
    }

    public bool IsInteractive => _interactive;

    // --- Painting -----------------------------------------------------------

    /// <summary>
    /// Repaint the whole surface and push it to the window.
    ///
    /// UpdateLayeredWindow replaces the entire bitmap each time, so there is no
    /// partial-invalidate path; at annotation stroke rates that is fine and it
    /// keeps the alpha exactly right.
    /// </summary>
    /// <summary>
    /// The paint surface, kept between redraws.
    ///
    /// Redraw runs on every WM_MOUSEMOVE -- 100+ times a second on a high
    /// polling-rate mouse. Allocating it each time meant 33 MB per pass on a 4K
    /// desktop and double that across two monitors, straight onto the large
    /// object heap: strokes began smoothly and then lagged further behind the
    /// cursor the longer the overlay stayed open.
    /// </summary>
    private Bitmap? _surface;

    public void Redraw()
    {
        if (_hwnd == IntPtr.Zero || _width <= 0 || _height <= 0) return;

        if (_surface is null || _surface.Width != _width || _surface.Height != _height)
        {
            _surface?.Dispose();
            _surface = new Bitmap(_width, _height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        }

        var bitmap = _surface;
        using (var g = Graphics.FromImage(bitmap))
        {
            // Alpha 1, not 0.
            //
            // A layered window is hit-tested per pixel: WindowFromPoint skips
            // anything with alpha 0, so a genuinely empty surface cannot be
            // clicked at all. Every style read back correctly (topmost, not
            // transparent, layered, full-screen) while clicks still landed on
            // the window underneath, because there was nothing solid to hit.
            //
            // Alpha 1/255 is invisible to the eye but present to the hit test.
            //
            // SourceCopy because the surface is reused between redraws: the
            // default SourceOver would blend this clear over the previous
            // frame's strokes instead of replacing them, so erased and undone
            // strokes would stay on screen forever.
            g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
            g.Clear(_interactive ? Color.FromArgb(1, 0, 0, 0) : Color.Transparent);
            g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceOver;

            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;

            lock (_strokesLock)
            {
                foreach (var stroke in _strokes) DrawStroke(g, stroke);
                if (_current is not null) DrawStroke(g, _current);
            }
        }

        PushBitmap(bitmap);
    }

    /// <summary>
    /// Diagnostics for the self-test and for debugging a silent overlay: how
    /// many times the surface was pushed, and whether the last push succeeded.
    /// A window that is visible with correct styles but never painted looks
    /// identical to a broken one from the outside.
    /// </summary>
    public int PushCount { get; private set; }
    public bool LastPushOk { get; private set; }
    public int LastPushError { get; private set; }

    private void PushBitmap(Bitmap bitmap)
    {
        var screenDc = GetDC(IntPtr.Zero);
        var memDc = CreateCompatibleDC(screenDc);
        var hBitmap = IntPtr.Zero;
        var oldBitmap = IntPtr.Zero;

        try
        {
            // GDI+ hands back a premultiplied-alpha HBITMAP, which is exactly
            // what AC_SRC_ALPHA expects.
            hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
            oldBitmap = SelectObject(memDc, hBitmap);

            var size = new SIZE { cx = _width, cy = _height };
            var source = new POINT { x = 0, y = 0 };
            var dest = new POINT { x = _x, y = _y };

            var blend = new BLENDFUNCTION
            {
                BlendOp = AC_SRC_OVER,
                BlendFlags = 0,
                SourceConstantAlpha = 255,
                AlphaFormat = AC_SRC_ALPHA,
            };

            LastPushOk = UpdateLayeredWindow(_hwnd, screenDc, ref dest, ref size,
                memDc, ref source, 0, ref blend, ULW_ALPHA);
            LastPushError = LastPushOk ? 0 : Marshal.GetLastWin32Error();
            PushCount++;
        }
        finally
        {
            if (oldBitmap != IntPtr.Zero) SelectObject(memDc, oldBitmap);
            if (hBitmap != IntPtr.Zero) DeleteObject(hBitmap);
            DeleteDC(memDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    /// <summary>
    /// Draw one stroke. Geometry matches the Electron canvas implementation, so
    /// a recording looks the same either way.
    /// </summary>
    private static void DrawStroke(Graphics g, Stroke s)
    {
        if (s.Points.Count == 0) return;

        var colour = ParseColor(s.Color);
        var width = s.Width;

        // The highlighter is a wide translucent pen rather than a separate
        // tool: 4x width at 35% alpha.
        if (s.Tool == DrawTool.Highlighter)
        {
            colour = Color.FromArgb((int)(255 * 0.35), colour);
            width = s.Width * 4;
        }

        using var pen = new Pen(colour, (float)width)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
            LineJoin = LineJoin.Round,
        };
        using var brush = new SolidBrush(colour);

        var first = s.Points[0];
        var last = s.Points[^1];

        switch (s.Tool)
        {
            case DrawTool.Pen:
            case DrawTool.Highlighter:
                if (s.Points.Count == 1)
                {
                    g.FillEllipse(brush,
                        (float)(first.X - width / 2), (float)(first.Y - width / 2),
                        (float)width, (float)width);
                }
                else
                {
                    // A cardinal spline smooths the polyline the same way the
                    // canvas version's quadratic midpoint curve does.
                    g.DrawCurve(pen, s.Points.Select(p => new PointF((float)p.X, (float)p.Y)).ToArray(), 0.5f);
                }
                break;

            case DrawTool.Rect:
                g.DrawRectangle(pen,
                    (float)Math.Min(first.X, last.X), (float)Math.Min(first.Y, last.Y),
                    (float)Math.Abs(last.X - first.X), (float)Math.Abs(last.Y - first.Y));
                break;

            case DrawTool.Ellipse:
                g.DrawEllipse(pen,
                    (float)Math.Min(first.X, last.X), (float)Math.Min(first.Y, last.Y),
                    (float)Math.Abs(last.X - first.X), (float)Math.Abs(last.Y - first.Y));
                break;

            case DrawTool.Arrow:
            {
                var head = Math.Max(12, width * 3.5);
                var angle = Math.Atan2(last.Y - first.Y, last.X - first.X);

                // Shorten the shaft so it does not poke through the head.
                var endX = last.X - Math.Cos(angle) * head * 0.6;
                var endY = last.Y - Math.Sin(angle) * head * 0.6;
                g.DrawLine(pen, (float)first.X, (float)first.Y, (float)endX, (float)endY);

                g.FillPolygon(brush,
                [
                    new PointF((float)last.X, (float)last.Y),
                    new PointF(
                        (float)(last.X - head * Math.Cos(angle - Math.PI / 6)),
                        (float)(last.Y - head * Math.Sin(angle - Math.PI / 6))),
                    new PointF(
                        (float)(last.X - head * Math.Cos(angle + Math.PI / 6)),
                        (float)(last.Y - head * Math.Sin(angle + Math.PI / 6))),
                ]);
                break;
            }

            case DrawTool.Eraser:
                // Handled by removing strokes on hit, not by drawing.
                break;
        }
    }

    private static Color ParseColor(string hex)
    {
        try
        {
            var s = hex.TrimStart('#');
            return Color.FromArgb(255,
                Convert.ToByte(s.Substring(0, 2), 16),
                Convert.ToByte(s.Substring(2, 2), 16),
                Convert.ToByte(s.Substring(4, 2), 16));
        }
        catch
        {
            return Color.FromArgb(255, 255, 59, 48);
        }
    }

    // --- Input --------------------------------------------------------------

    /// <summary>Set by the first mouse message, so the self-test can prove the
    /// window is genuinely receiving input rather than merely existing.</summary>
    public bool HasReceivedInput { get; private set; }

    private IntPtr WindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg is WM_LBUTTONDOWN or WM_MOUSEMOVE or WM_LBUTTONUP) HasReceivedInput = true;

        switch (msg)
        {
            case WM_LBUTTONDOWN:
                OnPointerDown(PointFromLParam(lParam));
                SetCapture(hwnd);
                return IntPtr.Zero;

            case WM_MOUSEMOVE:
                if ((wParam.ToInt64() & MK_LBUTTON) != 0) OnPointerMove(PointFromLParam(lParam));
                return IntPtr.Zero;

            case WM_LBUTTONUP:
                OnPointerUp();
                ReleaseCapture();
                return IntPtr.Zero;

            case WM_KEYDOWN:
                if (OnKeyDown((int)wParam.ToInt64())) return IntPtr.Zero;
                break;

            case WM_USER_REDRAW:
                Redraw();
                return IntPtr.Zero;

            case WM_CLOSE:
                DestroyWindow(hwnd);
                return IntPtr.Zero;

            case WM_DESTROY:
                PostQuitMessage(0);
                return IntPtr.Zero;
        }

        return DefWindowProc(hwnd, msg, wParam, lParam);
    }

    private static Windows.Foundation.Point PointFromLParam(IntPtr lParam)
    {
        var value = lParam.ToInt64();
        // Signed: a negative coordinate is valid on a multi-monitor desktop.
        return new Windows.Foundation.Point((short)(value & 0xFFFF), (short)((value >> 16) & 0xFFFF));
    }

    private void OnPointerDown(Windows.Foundation.Point p)
    {
        if (Draw.Tool == DrawTool.Eraser)
        {
            EraseAt(p);
            return;
        }

        _current = new Stroke
        {
            Tool = Draw.Tool,
            Color = Draw.Color,
            Width = Draw.Width,
        };
        _current.Points.Add(p);
        Redraw();
    }

    private void OnPointerMove(Windows.Foundation.Point p)
    {
        if (Draw.Tool == DrawTool.Eraser)
        {
            EraseAt(p);
            return;
        }

        if (_current is null) return;

        // Freehand accumulates every sample; shapes are two corners, so only
        // the last point moves.
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

        Redraw();
    }

    private void OnPointerUp()
    {
        lock (_strokesLock)
        {
            if (_current is null) return;
            _strokes.Add(_current);
            _current = null;
        }
        Redraw();
    }

    private bool OnKeyDown(int vk)
    {
        switch (vk)
        {
            case 0x50: Draw.Tool = DrawTool.Pen; return true;          // P
            case 0x48: Draw.Tool = DrawTool.Highlighter; return true;  // H
            case 0x41: Draw.Tool = DrawTool.Arrow; return true;        // A
            case 0x52: Draw.Tool = DrawTool.Rect; return true;         // R
            case 0x4F: Draw.Tool = DrawTool.Ellipse; return true;      // O
            case 0x45: Draw.Tool = DrawTool.Eraser; return true;       // E

            case 0x5A when (GetKeyState(0x11) & 0x8000) != 0:          // Ctrl+Z
                Undo();
                return true;

            case 0x2E: // Delete
            case 0x08: // Backspace
                ClearAll();
                return true;

            case 0x1B: // Escape
                Dismissed?.Invoke();
                return true;
        }

        return false;
    }

    /// <summary>
    /// Remove whole strokes under the cursor rather than painting over them:
    /// there is no background to paint with on a transparent overlay, so an
    /// alpha eraser would punch holes through to the desktop. 18px radius,
    /// fixed, matching the Electron overlay.
    /// </summary>
    private void EraseAt(Windows.Foundation.Point p)
    {
        const double radius = 18;
        int removed;
        lock (_strokesLock)
        {
            removed = _strokes.RemoveAll(s => s.Points.Any(q =>
            {
                var dx = q.X - p.X;
                var dy = q.Y - p.Y;
                return dx * dx + dy * dy <= radius * radius;
            }));
        }
        if (removed > 0) Redraw();
    }

    public void Undo()
    {
        lock (_strokesLock)
        {
            if (_strokes.Count == 0) return;
            _strokes.RemoveAt(_strokes.Count - 1);
        }
        RequestRedraw();
    }

    public void ClearAll()
    {
        lock (_strokesLock)
        {
            if (_strokes.Count == 0 && _current is null) return;
            _strokes.Clear();
            _current = null;
        }
        RequestRedraw();
    }

    /// <summary>
    /// Repaint from any thread. The palette lives on the UI thread, so its
    /// Clear button would otherwise call UpdateLayeredWindow from the wrong
    /// thread; posting a message hands the work back to the overlay's pump.
    /// </summary>
    private void RequestRedraw()
    {
        if (_hwnd == IntPtr.Zero) return;
        PostMessage(_hwnd, WM_USER_REDRAW, IntPtr.Zero, IntPtr.Zero);
    }

    /// <summary>
    /// Inject a stroke without any input, so the self-test can verify the
    /// paint-and-composite path end to end rather than only the window styles.
    /// </summary>
    public void DebugDrawTestStroke()
    {
        var stroke = new Stroke { Tool = DrawTool.Pen, Color = "#ff3b30", Width = 10 };
        for (var i = 0; i < 40; i++)
            stroke.Points.Add(new Point(DebugStrokeX + i * 10, DebugStrokeY));

        _strokes.Add(stroke);
        RequestRedraw();
    }

    private const int DebugStrokeX = 500;
    private const int DebugStrokeY = 400;

    /// <summary>Are the test stroke's pixels actually on screen?</summary>
    public bool DebugStrokeIsVisible()
    {
        var dc = GetDC(IntPtr.Zero);
        try
        {
            for (var i = 0; i < 40; i++)
            {
                var c = GetPixelNative(dc, DebugStrokeX + i * 10, DebugStrokeY);
                var r = c & 0xFF;
                var g = (c >> 8) & 0xFF;
                if (r > 150 && g < 100) return true;
            }
            return false;
        }
        finally
        {
            ReleaseDC(IntPtr.Zero, dc);
        }
    }

    [DllImport("gdi32.dll", EntryPoint = "GetPixel")]
    private static extern uint GetPixelNative(IntPtr dc, int x, int y);

    /// <summary>Keep the overlay out of every screen capture, or allow it in.</summary>
    public bool SetExcludedFromCapture(bool excluded)
    {
        Win32.AddExStyle(_hwnd, Win32.WS_EX_LAYERED);
        Win32.SetWindowDisplayAffinity(
            _hwnd, excluded ? Win32.WDA_EXCLUDEFROMCAPTURE : Win32.WDA_NONE);
        Win32.GetWindowDisplayAffinity(_hwnd, out var actual);
        return actual == (excluded ? Win32.WDA_EXCLUDEFROMCAPTURE : Win32.WDA_NONE);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        // Tear the window down ON ITS OWN THREAD. DestroyWindow called from
        // another thread is a no-op, which is how a "closed" overlay stayed on
        // screen as an opaque sheet after a recording.
        //
        // WM_CLOSE alone, deliberately: GetMessage hands back WM_QUIT ahead of
        // anything posted to the window, so also posting WM_QUIT here could end
        // the pump before WM_CLOSE was ever dispatched. DestroyWindow then
        // never ran and the overlay stayed on screen for good -- with its
        // owning thread gone, nothing could remove it, and the desktop was
        // covered by a topmost sheet until the app was killed.
        //
        // WM_DESTROY calls PostQuitMessage, so the pump still ends; it just
        // ends after the window is actually destroyed.
        var hwnd = _hwnd;
        if (hwnd != IntPtr.Zero) PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);

        // Fall back to the blunt instrument only if the polite route stalls,
        // so a wedged pump cannot hang the app for good either.
        if (_thread is { } thread && !thread.Join(TimeSpan.FromSeconds(2)))
        {
            if (_threadId != 0) PostThreadMessage(_threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            thread.Join(TimeSpan.FromSeconds(1));
        }
        _thread = null;
        _hwnd = IntPtr.Zero;
        _surface?.Dispose();
        _surface = null;

        // Only valid once the window is destroyed, which the Join above waited
        // for; unregistering while instances remain fails and leaks the atom.
        if (_className is not null)
        {
            UnregisterClass(_className, GetModuleHandle(null));
            _className = null;
        }

        _ready.Dispose();
    }

    // --- Interop ------------------------------------------------------------

    private delegate IntPtr WndProcDelegate(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_LBUTTONUP = 0x0202;
    private const uint WM_MOUSEMOVE = 0x0200;
    private const uint WM_KEYDOWN = 0x0100;
    private const uint WM_CLOSE = 0x0010;
    private const uint WM_DESTROY = 0x0002;
    private const uint WM_QUIT = 0x0012;
    private const uint WM_USER_REDRAW = 0x0400 + 1;
    private const long MK_LBUTTON = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG msg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG msg);

    [DllImport("user32.dll")]
    private static extern void PostQuitMessage(int code);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);

    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint threadId, uint msg, IntPtr w, IntPtr l);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    private const int IDC_CROSS = 32515;

    private const byte AC_SRC_OVER = 0x00;
    private const byte AC_SRC_ALPHA = 0x01;
    private const uint ULW_ALPHA = 0x00000002;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEX
    {
        public int cbSize;
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct SIZE { public int cx; public int cy; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct BLENDFUNCTION
    {
        public byte BlendOp;
        public byte BlendFlags;
        public byte SourceConstantAlpha;
        public byte AlphaFormat;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "RegisterClassExW")]
    private static extern ushort RegisterClassEx(ref WNDCLASSEX wc);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "UnregisterClassW")]
    private static extern bool UnregisterClass(string className, IntPtr instance);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateWindowExW")]
    private static extern IntPtr CreateWindowEx(
        int exStyle, string className, string windowName, int style,
        int x, int y, int width, int height,
        IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "DefWindowProcW")]
    private static extern IntPtr DefWindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern IntPtr LoadCursor(IntPtr hInstance, int cursor);
    [DllImport("user32.dll")] private static extern IntPtr SetCapture(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern short GetKeyState(int vk);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UpdateLayeredWindow(
        IntPtr hwnd, IntPtr dstDc, ref POINT dstPoint, ref SIZE size,
        IntPtr srcDc, ref POINT srcPoint, uint colorKey,
        ref BLENDFUNCTION blend, uint flags);

    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetModuleHandleW")]
    private static extern IntPtr GetModuleHandle(string? name);
}
