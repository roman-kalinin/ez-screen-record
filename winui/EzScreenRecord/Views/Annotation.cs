using EzScreenRecord.Models;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Geometry;
using Windows.Foundation;
using Windows.UI;

namespace EzScreenRecord.Views;

/// <summary>One drawn mark.</summary>
public sealed class Stroke
{
    public DrawTool Tool { get; init; }
    public Color Color { get; init; }
    public float Width { get; init; }
    public List<Point> Points { get; } = [];
}

/// <summary>
/// Stroke rendering, ported from overlay.tsx.
///
/// Split out from the window so the drawing itself can be exercised without a
/// desktop-wide layered window in the way.
/// </summary>
public static class Annotation
{
    /// <summary>
    /// Draw one stroke. Geometry matches the Canvas2D original exactly, so a
    /// recording made with either version looks the same.
    /// </summary>
    public static void Draw(CanvasDrawingSession ds, Stroke s)
    {
        if (s.Points.Count == 0) return;

        var color = s.Color;
        var width = s.Width;

        // The highlighter is a wide, translucent pen rather than a distinct
        // tool: 4x the width at 35% alpha, exactly as in the original.
        if (s.Tool == DrawTool.Highlighter)
        {
            color = Color.FromArgb((byte)(255 * 0.35), color.R, color.G, color.B);
            width = s.Width * 4;
        }

        var style = new CanvasStrokeStyle
        {
            StartCap = CanvasCapStyle.Round,
            EndCap = CanvasCapStyle.Round,
            LineJoin = CanvasLineJoin.Round,
        };

        var first = s.Points[0];
        var last = s.Points[^1];

        switch (s.Tool)
        {
            case DrawTool.Pen:
            case DrawTool.Highlighter:
            {
                using var builder = new CanvasPathBuilder(ds);
                builder.BeginFigure((float)first.X, (float)first.Y);

                // Quadratic smoothing through midpoints removes the polyline
                // look that a plain LineTo chain produces at these sample rates.
                for (var i = 1; i < s.Points.Count - 1; i++)
                {
                    var mid = new Point(
                        (s.Points[i].X + s.Points[i + 1].X) / 2,
                        (s.Points[i].Y + s.Points[i + 1].Y) / 2);
                    builder.AddQuadraticBezier(
                        new System.Numerics.Vector2((float)s.Points[i].X, (float)s.Points[i].Y),
                        new System.Numerics.Vector2((float)mid.X, (float)mid.Y));
                }

                builder.AddLine((float)last.X, (float)last.Y);
                builder.EndFigure(CanvasFigureLoop.Open);

                using var geometry = CanvasGeometry.CreatePath(builder);
                ds.DrawGeometry(geometry, color, width, style);
                break;
            }

            case DrawTool.Rect:
                ds.DrawRectangle(
                    (float)Math.Min(first.X, last.X),
                    (float)Math.Min(first.Y, last.Y),
                    (float)Math.Abs(last.X - first.X),
                    (float)Math.Abs(last.Y - first.Y),
                    color, width, style);
                break;

            case DrawTool.Ellipse:
                ds.DrawEllipse(
                    (float)((first.X + last.X) / 2),
                    (float)((first.Y + last.Y) / 2),
                    (float)(Math.Abs(last.X - first.X) / 2),
                    (float)(Math.Abs(last.Y - first.Y) / 2),
                    color, width, style);
                break;

            case DrawTool.Arrow:
            {
                var head = Math.Max(12, width * 3.5);
                var angle = Math.Atan2(last.Y - first.Y, last.X - first.X);

                // Shorten the shaft so it does not poke through the arrowhead.
                var endX = last.X - Math.Cos(angle) * head * 0.6;
                var endY = last.Y - Math.Sin(angle) * head * 0.6;

                ds.DrawLine(
                    new System.Numerics.Vector2((float)first.X, (float)first.Y),
                    new System.Numerics.Vector2((float)endX, (float)endY),
                    color, width, style);

                using var head1 = new CanvasPathBuilder(ds);
                head1.BeginFigure((float)last.X, (float)last.Y);
                head1.AddLine(
                    (float)(last.X - head * Math.Cos(angle - Math.PI / 6)),
                    (float)(last.Y - head * Math.Sin(angle - Math.PI / 6)));
                head1.AddLine(
                    (float)(last.X - head * Math.Cos(angle + Math.PI / 6)),
                    (float)(last.Y - head * Math.Sin(angle + Math.PI / 6)));
                head1.EndFigure(CanvasFigureLoop.Closed);

                using var headGeometry = CanvasGeometry.CreatePath(head1);
                ds.FillGeometry(headGeometry, color);
                break;
            }

            case DrawTool.Eraser:
                // Handled by removing strokes on hit, not by drawing.
                break;
        }
    }

    /// <summary>
    /// Does a stroke pass within <paramref name="radius"/> of a point?
    /// Used by the eraser, which removes whole strokes rather than painting
    /// over them -- painting would leave holes in the transparent overlay.
    /// </summary>
    public static bool HitTest(Stroke stroke, Point p, double radius)
    {
        foreach (var point in stroke.Points)
        {
            var dx = point.X - p.X;
            var dy = point.Y - p.Y;
            if (dx * dx + dy * dy <= radius * radius) return true;
        }
        return false;
    }

    /// <summary>Parse a "#rrggbb" colour, falling back to red.</summary>
    public static Color ParseColor(string hex)
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
}
