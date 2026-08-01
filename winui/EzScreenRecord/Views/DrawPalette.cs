using EzScreenRecord.Models;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
using Windows.UI;

namespace EzScreenRecord.Views;

/// <summary>
/// The drawing tool palette: a compact draggable pill, not a panel.
///
/// Sizes are taken from styles/overlay.css because they matter — 32x32 tool
/// buttons, 22x22 circular swatches, an 84px thickness slider, 12px radius,
/// 6x8 padding, 4px gaps. A palette any larger covers the thing being drawn on,
/// which defeats the point of drawing over a live screen.
/// </summary>
public sealed class DrawPalette : UserControl
{
    private static readonly (DrawTool Tool, string Glyph, string Tip)[] Tools =
    [
        (DrawTool.Pen, Glyphs.Pen, "Pen (P)"),
        (DrawTool.Highlighter, Glyphs.Highlighter, "Highlighter (H)"),
        (DrawTool.Arrow, Glyphs.Arrow, "Arrow (A)"),
        (DrawTool.Rect, Glyphs.Rectangle, "Rectangle (R)"),
        (DrawTool.Ellipse, Glyphs.Circle, "Ellipse (O)"),
        (DrawTool.Eraser, Glyphs.Eraser, "Eraser (E)"),
    ];

    private static readonly string[] Colors_ =
        ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#000000"];

    private readonly AppSettings _settings;
    private readonly List<Button> _toolButtons = [];
    private readonly List<Border> _swatches = [];

    public event Action? ClearRequested;
    public event Action? DoneRequested;
    public event Action? Changed;

    /// <summary>Where the palette sits, in window coordinates.</summary>
    public Point Position { get; private set; } = new(24, 24);
    public event Action<Point>? Moved;

    private bool _dragging;
    private Point _dragStart;
    private Point _origin;

    public DrawPalette(AppSettings settings)
    {
        _settings = settings;

        var row = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 4,
            Padding = new Thickness(8, 6, 8, 6),
            VerticalAlignment = VerticalAlignment.Center,
        };

        // Drag handle
        var grip = new Border
        {
            Padding = new Thickness(6, 0, 6, 0),
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            Child = new FontIcon
            {
                Glyph = Glyphs.Grip,
                FontSize = 14,
                Foreground = new SolidColorBrush(Color.FromArgb(102, 255, 255, 255)),
            },
        };
        ToolTipService.SetToolTip(grip, "Drag toolbar");
        grip.PointerPressed += OnGripPressed;
        grip.PointerMoved += OnGripMoved;
        grip.PointerReleased += OnGripReleased;
        row.Children.Add(grip);

        // Tools
        var toolGroup = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2 };
        foreach (var (tool, glyph, tip) in Tools)
        {
            var button = ToolButton(glyph, tip);
            button.Tag = tool;
            button.Click += (_, _) =>
            {
                _settings.Draw.Tool = tool;
                RefreshTools();
                _settings.Save();
                Changed?.Invoke();
            };
            _toolButtons.Add(button);
            toolGroup.Children.Add(button);
        }
        row.Children.Add(toolGroup);
        row.Children.Add(Divider());

        // Colours
        var colourGroup = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
        foreach (var hex in Colors_)
        {
            var swatch = new Border
            {
                Width = 22,
                Height = 22,
                CornerRadius = new CornerRadius(11),
                Background = new SolidColorBrush(Annotation.ParseColor(hex)),
                BorderThickness = new Thickness(2),
                BorderBrush = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                Tag = hex,
            };
            ToolTipService.SetToolTip(swatch, hex);
            swatch.PointerPressed += (s, _) =>
            {
                _settings.Draw.Color = (string)((FrameworkElement)s).Tag!;
                RefreshColors();
                _settings.Save();
                Changed?.Invoke();
            };
            _swatches.Add(swatch);
            colourGroup.Children.Add(swatch);
        }
        row.Children.Add(colourGroup);
        row.Children.Add(Divider());

        // Thickness
        var slider = new Slider
        {
            Minimum = 2,
            Maximum = 24,
            Value = _settings.Draw.Width,
            Width = 84,
            VerticalAlignment = VerticalAlignment.Center,
        };
        ToolTipService.SetToolTip(slider, $"Thickness: {(int)_settings.Draw.Width}px");
        slider.ValueChanged += (_, e) =>
        {
            _settings.Draw.Width = e.NewValue;
            ToolTipService.SetToolTip(slider, $"Thickness: {(int)e.NewValue}px");
            _settings.Save();
            Changed?.Invoke();
        };
        row.Children.Add(slider);
        row.Children.Add(Divider());

        var clear = ToolButton(Glyphs.Delete, "Clear all (Del)");
        clear.Click += (_, _) => ClearRequested?.Invoke();
        row.Children.Add(clear);

        var done = ToolButton(Glyphs.Close, "Done — exit and clear (Esc)");
        done.Click += (_, _) => DoneRequested?.Invoke();
        row.Children.Add(done);

        Content = new Border
        {
            Child = row,
            CornerRadius = new CornerRadius(12),
            Background = new SolidColorBrush(Color.FromArgb(235, 28, 28, 32)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(31, 255, 255, 255)),
            BorderThickness = new Thickness(1),
            RequestedTheme = ElementTheme.Dark,
        };

        RefreshTools();
        RefreshColors();
    }

    private static Button ToolButton(string glyph, string tooltip)
    {
        var button = new Button
        {
            Width = 32,
            Height = 32,
            Padding = new Thickness(0),
            CornerRadius = new CornerRadius(8),
            BorderThickness = new Thickness(0),
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.White),
            Content = new FontIcon { Glyph = glyph, FontSize = 15 },
        };
        ToolTipService.SetToolTip(button, tooltip);
        return button;
    }

    private static Border Divider() => new()
    {
        Width = 1,
        Height = 22,
        Margin = new Thickness(4, 0, 4, 0),
        Background = new SolidColorBrush(Color.FromArgb(38, 255, 255, 255)),
    };

    private void RefreshTools()
    {
        foreach (var button in _toolButtons)
        {
            var active = (DrawTool)button.Tag! == _settings.Draw.Tool;
            button.Background = new SolidColorBrush(active
                ? Color.FromArgb(255, 10, 132, 255)
                : Microsoft.UI.Colors.Transparent);
        }
    }

    private void RefreshColors()
    {
        foreach (var swatch in _swatches)
        {
            var active = string.Equals((string)swatch.Tag!, _settings.Draw.Color,
                StringComparison.OrdinalIgnoreCase);
            swatch.BorderBrush = new SolidColorBrush(active
                ? Microsoft.UI.Colors.White
                : Microsoft.UI.Colors.Transparent);
        }
    }

    // --- Dragging -----------------------------------------------------------

    private void OnGripPressed(object sender, PointerRoutedEventArgs e)
    {
        _dragging = true;
        _dragStart = e.GetCurrentPoint(null).Position;
        _origin = Position;
        ((UIElement)sender).CapturePointer(e.Pointer);
        e.Handled = true;
    }

    private void OnGripMoved(object sender, PointerRoutedEventArgs e)
    {
        if (!_dragging) return;
        var p = e.GetCurrentPoint(null).Position;
        Position = new Point(
            _origin.X + (p.X - _dragStart.X),
            _origin.Y + (p.Y - _dragStart.Y));
        Moved?.Invoke(Position);
        e.Handled = true;
    }

    private void OnGripReleased(object sender, PointerRoutedEventArgs e)
    {
        _dragging = false;
        ((UIElement)sender).ReleasePointerCaptures();
    }
}
