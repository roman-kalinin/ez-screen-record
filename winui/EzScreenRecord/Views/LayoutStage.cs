using EzScreenRecord.Models;

namespace EzScreenRecord.Views;

/// <summary>Which corner a resize is anchored from.</summary>
public enum Corner { NW, NE, SW, SE }

/// <summary>
/// Geometry for the layout preview, ported from LayoutStage.tsx.
///
/// Everything is in normalised (0..1) coordinates so a layout arranged against
/// a 1080p preview still lands correctly on a 1440p capture. Kept free of any
/// XAML dependency so it can be unit-tested and reused by the on-screen camera
/// bubble, which must resize identically to the preview.
/// </summary>
public static class LayoutGeometry
{
    /// <summary>Smallest an overlay may be shrunk to, as a fraction of the frame.</summary>
    public const double MinSize = 0.05;

    /// <summary>
    /// Resize <paramref name="orig"/> by dragging one corner.
    ///
    /// The corner opposite the one being dragged stays pinned, so the box grows
    /// and shrinks the way the grabbed anchor is moving. Each axis clamps to the
    /// frame edge FIRST and to MinSize second: the other order lets the minimum
    /// defeat the maximum near an edge, and the overlay collapses past its floor.
    /// </summary>
    public static Rect Resize(Rect orig, Corner corner, double dx, double dy)
    {
        var west = corner is Corner.NW or Corner.SW;
        var north = corner is Corner.NW or Corner.NE;

        // Fixed edges: the opposite corner never moves.
        var right = orig.X + orig.W;
        var bottom = orig.Y + orig.H;

        var x = orig.X;
        var y = orig.Y;
        var w = orig.W;
        var h = orig.H;

        if (west)
        {
            x = Math.Min(Math.Max(orig.X + dx, 0), right - MinSize);
            w = right - x;
        }
        else
        {
            w = Math.Max(MinSize, Math.Min(orig.W + dx, 1 - orig.X));
        }

        if (north)
        {
            y = Math.Min(Math.Max(orig.Y + dy, 0), bottom - MinSize);
            h = bottom - y;
        }
        else
        {
            h = Math.Max(MinSize, Math.Min(orig.H + dy, 1 - orig.Y));
        }

        return new Rect(x, y, w, h);
    }

    /// <summary>
    /// Move <paramref name="orig"/> by a delta, keeping it inside the frame.
    ///
    /// The size never changes: an overlay dragged past an edge stops there
    /// rather than being squashed against it.
    /// </summary>
    public static Rect Move(Rect orig, double dx, double dy) => new(
        Math.Min(Math.Max(orig.X + dx, 0), 1 - orig.W),
        Math.Min(Math.Max(orig.Y + dy, 0), 1 - orig.H),
        orig.W,
        orig.H);
}
