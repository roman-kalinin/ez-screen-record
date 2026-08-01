using System.Runtime.InteropServices;
using EzScreenRecord.Interop;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace EzScreenRecord.Capture;

/// <summary>
/// Thumbnails for the source picker.
///
/// These matter more than they look: a window title alone
/// ("C:\WINDOWS\system32\cmd.exe") tells you very little about which window you
/// are actually about to record. The Electron app got these free from
/// desktopCapturer; here they have to be grabbed directly.
///
/// PrintWindow with PW_RENDERFULLCONTENT is used rather than BitBlt from the
/// screen, because it captures a window that is partly covered by another --
/// BitBlt would copy whatever is on top of it.
/// </summary>
public static class Thumbnails
{
    /// <summary>PW_RENDERFULLCONTENT -- required for DWM-composited (i.e. all
    /// modern) windows. Without it most windows come back solid black.</summary>
    private const uint PW_RENDERFULLCONTENT = 0x00000002;

    private const uint SRCCOPY = 0x00CC0020;
    private const int BI_RGB = 0;
    private const uint DIB_RGB_COLORS = 0;

    /// <summary>
    /// Grab a window's contents as a BGRA8 bitmap, downscaled to fit
    /// <paramref name="maxWidth"/>.
    /// Returns null when the window cannot be captured (minimized, gone, or
    /// protected).
    /// </summary>
    public static async Task<BitmapImage?> CaptureWindowAsync(IntPtr hWnd, int maxWidth = 320)
    {
        var pixels = await Task.Run(() => CaptureWindowPixels(hWnd, maxWidth));
        if (pixels is null) return null;

        try
        {
            return await ToBitmapImageAsync(pixels.Value.Data, pixels.Value.Width, pixels.Value.Height);
        }
        catch
        {
            // Almost always "called off the UI thread". Nothing useful to do
            // here beyond declining to show a thumbnail.
            return null;
        }
    }

    /// <summary>Grab an entire monitor by its desktop rectangle.</summary>
    public static async Task<BitmapImage?> CaptureScreenAsync(
        int x, int y, int width, int height, int maxWidth = 320)
    {
        var pixels = await Task.Run(() => CaptureScreenPixels(x, y, width, height, maxWidth));
        if (pixels is null) return null;

        try
        {
            return await ToBitmapImageAsync(pixels.Value.Data, pixels.Value.Width, pixels.Value.Height);
        }
        catch
        {
            return null;
        }
    }

    private readonly record struct Pixels(byte[] Data, int Width, int Height);

    private static Pixels? CaptureWindowPixels(IntPtr hWnd, int maxWidth)
    {
        if (!Win32.GetWindowRect(hWnd, out var rect)) return null;

        var srcW = rect.Width;
        var srcH = rect.Height;
        if (srcW <= 0 || srcH <= 0) return null;

        var screenDc = GetDC(IntPtr.Zero);
        var memDc = CreateCompatibleDC(screenDc);
        var bmp = CreateCompatibleBitmap(screenDc, srcW, srcH);
        var oldBmp = SelectObject(memDc, bmp);

        try
        {
            if (!PrintWindow(hWnd, memDc, PW_RENDERFULLCONTENT)) return null;
            return ReadAndScale(memDc, bmp, srcW, srcH, maxWidth);
        }
        finally
        {
            SelectObject(memDc, oldBmp);
            DeleteObject(bmp);
            DeleteDC(memDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    private static Pixels? CaptureScreenPixels(int x, int y, int width, int height, int maxWidth)
    {
        if (width <= 0 || height <= 0) return null;

        var screenDc = GetDC(IntPtr.Zero);
        var memDc = CreateCompatibleDC(screenDc);
        var bmp = CreateCompatibleBitmap(screenDc, width, height);
        var oldBmp = SelectObject(memDc, bmp);

        try
        {
            if (!BitBlt(memDc, 0, 0, width, height, screenDc, x, y, SRCCOPY)) return null;
            return ReadAndScale(memDc, bmp, width, height, maxWidth);
        }
        finally
        {
            SelectObject(memDc, oldBmp);
            DeleteObject(bmp);
            DeleteDC(memDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    /// <summary>
    /// Pull pixels out of a GDI bitmap and box-filter them down to the target
    /// width. Scaling here rather than in XAML keeps a 4K screenshot from being
    /// held in memory for every card in the picker.
    /// </summary>
    private static Pixels? ReadAndScale(IntPtr memDc, IntPtr bmp, int srcW, int srcH, int maxWidth)
    {
        var header = new BITMAPINFOHEADER
        {
            biSize = Marshal.SizeOf<BITMAPINFOHEADER>(),
            biWidth = srcW,
            // Negative height requests a top-down DIB. Bottom-up is the GDI
            // default and would hand back a vertically mirrored image.
            biHeight = -srcH,
            biPlanes = 1,
            biBitCount = 32,
            biCompression = BI_RGB,
        };

        var src = new byte[srcW * srcH * 4];
        var handle = GCHandle.Alloc(src, GCHandleType.Pinned);
        try
        {
            if (GetDIBits(memDc, bmp, 0, (uint)srcH, handle.AddrOfPinnedObject(),
                    ref header, DIB_RGB_COLORS) == 0)
            {
                return null;
            }
        }
        finally
        {
            handle.Free();
        }

        if (srcW <= maxWidth) return new Pixels(src, srcW, srcH);

        var scale = (double)maxWidth / srcW;
        var dstW = Math.Max(1, (int)(srcW * scale));
        var dstH = Math.Max(1, (int)(srcH * scale));
        var dst = new byte[dstW * dstH * 4];

        // Box filter. Nearest-neighbour on a 4K desktop shrunk to 320px drops
        // most of the detail that makes a thumbnail recognisable in the first
        // place, and text turns into noise.
        var xRatio = (double)srcW / dstW;
        var yRatio = (double)srcH / dstH;

        for (var dy = 0; dy < dstH; dy++)
        {
            var sy0 = (int)(dy * yRatio);
            var sy1 = Math.Min(srcH, (int)((dy + 1) * yRatio));
            if (sy1 <= sy0) sy1 = sy0 + 1;

            for (var dx = 0; dx < dstW; dx++)
            {
                var sx0 = (int)(dx * xRatio);
                var sx1 = Math.Min(srcW, (int)((dx + 1) * xRatio));
                if (sx1 <= sx0) sx1 = sx0 + 1;

                int b = 0, g = 0, r = 0, count = 0;
                for (var sy = sy0; sy < sy1; sy++)
                {
                    var row = sy * srcW * 4;
                    for (var sx = sx0; sx < sx1; sx++)
                    {
                        var i = row + sx * 4;
                        b += src[i];
                        g += src[i + 1];
                        r += src[i + 2];
                        count++;
                    }
                }

                var o = (dy * dstW + dx) * 4;
                dst[o] = (byte)(b / count);
                dst[o + 1] = (byte)(g / count);
                dst[o + 2] = (byte)(r / count);
                // PrintWindow leaves alpha at 0 on many windows, which would
                // render the whole thumbnail invisible. Force it opaque.
                dst[o + 3] = 255;
            }
        }

        return new Pixels(dst, dstW, dstH);
    }

    /// <summary>
    /// Wrap raw BGRA in a XAML image source.
    ///
    /// BitmapImage is a XAML type and must be constructed on a thread with a
    /// DispatcherQueue. Callers on a background thread get a
    /// <see cref="SoftwareBitmapSource"/>-free path only via the raw overload
    /// below; this one throws rather than returning null so a threading mistake
    /// is visible instead of looking like "no thumbnail available".
    /// </summary>
    private static async Task<BitmapImage> ToBitmapImageAsync(byte[] bgra, int width, int height)
    {
        var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
        encoder.SetPixelData(
            BitmapPixelFormat.Bgra8,
            BitmapAlphaMode.Ignore,
            (uint)width,
            (uint)height,
            96, 96,
            bgra);
        await encoder.FlushAsync();
        stream.Seek(0);

        var image = new BitmapImage();
        await image.SetSourceAsync(stream);
        return image;
    }

    /// <summary>
    /// Capture a window's pixels without touching XAML.
    ///
    /// Exists so callers off the UI thread (the self-test, any future headless
    /// use) can verify capture works without needing a DispatcherQueue.
    /// </summary>
    public static bool CanCaptureWindow(IntPtr hWnd, int maxWidth = 320)
        => CaptureWindowPixels(hWnd, maxWidth) is not null;

    /// <summary>Capture a screen region's pixels without touching XAML.</summary>
    public static bool CanCaptureScreen(int x, int y, int width, int height, int maxWidth = 320)
        => CaptureScreenPixels(x, y, width, height, maxWidth) is not null;

    // --- GDI interop --------------------------------------------------------

    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDc);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hDc, uint flags);

    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr hDc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleBitmap(IntPtr hDc, int w, int h);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr hDc, IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr hDc);

    [DllImport("gdi32.dll")]
    private static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h,
        IntPtr src, int sx, int sy, uint rop);

    [DllImport("gdi32.dll")]
    private static extern int GetDIBits(IntPtr hDc, IntPtr bmp, uint start, uint lines,
        IntPtr bits, ref BITMAPINFOHEADER info, uint usage);

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public int biSize;
        public int biWidth;
        public int biHeight;
        public short biPlanes;
        public short biBitCount;
        public int biCompression;
        public int biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public int biClrUsed;
        public int biClrImportant;
    }
}
