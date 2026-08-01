using Windows.Foundation;

namespace EzScreenRecord.Models;

/// <summary>
/// One drawn mark on the annotation overlay.
///
/// The colour is a hex string rather than a typed Color so the model does not
/// depend on any one renderer's colour type — strokes are rendered by GDI+ into
/// the layered overlay, and the palette shows the same values in XAML.
/// </summary>
public sealed class Stroke
{
    public DrawTool Tool { get; init; }
    public string Color { get; init; } = "#ff3b30";
    public double Width { get; init; }
    public List<Point> Points { get; } = [];
}
