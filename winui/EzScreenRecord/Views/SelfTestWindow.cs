using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace EzScreenRecord.Views;

/// <summary>
/// A visible test runner.
///
/// Every check in this app reports here, on screen, as it happens. A headless
/// self-test that only writes a temp file is indistinguishable from a hung or
/// stale process while it runs -- you cannot tell whether work is happening,
/// finished, or dead. Results still go to a file afterwards for scripting, but
/// the window is the primary channel, not the fallback.
/// </summary>
public sealed class SelfTestWindow : Window
{
    private readonly StackPanel _log;
    private readonly ScrollViewer _scroller;
    private readonly TextBlock _summary;
    private readonly ProgressBar _progress;
    private readonly List<string> _plain = [];

    private int _passed;
    private int _failed;

    public SelfTestWindow(string title)
    {
        Title = title;

        _log = new StackPanel { Spacing = 2, Padding = new Thickness(16) };

        _scroller = new ScrollViewer
        {
            Content = _log,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        };

        _progress = new ProgressBar { IsIndeterminate = true, Height = 3 };

        _summary = new TextBlock
        {
            Padding = new Thickness(16, 10, 16, 12),
            FontSize = 15,
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
            Text = "Running…",
        };

        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        Grid.SetRow(_progress, 0);
        Grid.SetRow(_scroller, 1);
        Grid.SetRow(_summary, 2);
        root.Children.Add(_progress);
        root.Children.Add(_scroller);
        root.Children.Add(_summary);

        Content = root;

        if (Microsoft.UI.Composition.SystemBackdrops.MicaController.IsSupported())
            SystemBackdrop = new MicaBackdrop();

        AppWindow.Resize(new Windows.Graphics.SizeInt32(940, 720));
    }

    /// <summary>A section heading.</summary>
    public void Section(string text)
    {
        _plain.Add("");
        _plain.Add($"--- {text} ---");
        Add(new TextBlock
        {
            Text = text,
            FontSize = 15,
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
            Margin = new Thickness(0, 14, 0, 4),
        });
    }

    /// <summary>Plain detail line, neither pass nor fail.</summary>
    public void Info(string text)
    {
        _plain.Add($"    {text}");
        Add(new TextBlock
        {
            Text = text,
            FontFamily = new FontFamily("Consolas"),
            FontSize = 12.5,
            Opacity = 0.75,
            Margin = new Thickness(14, 0, 0, 0),
            TextWrapping = TextWrapping.Wrap,
        });
    }

    /// <summary>A check with a verdict. Counts toward the summary.</summary>
    public void Check(string name, bool ok)
    {
        if (ok) _passed++; else _failed++;
        _plain.Add($"  [{(ok ? "PASS" : "FAIL")}] {name}");

        var row = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 8,
            Margin = new Thickness(0, 1, 0, 1),
        };

        row.Children.Add(new FontIcon
        {
            // Segoe Fluent: Accept / Cancel.
            Glyph = ok ? Glyphs.Accept : Glyphs.Cancel,
            FontSize = 13,
            Foreground = new SolidColorBrush(ok
                ? Color.FromArgb(255, 76, 194, 108)
                : Color.FromArgb(255, 235, 84, 84)),
            VerticalAlignment = VerticalAlignment.Center,
        });

        row.Children.Add(new TextBlock
        {
            Text = name,
            FontSize = 13.5,
            TextWrapping = TextWrapping.Wrap,
            VerticalAlignment = VerticalAlignment.Center,
        });

        Add(row);
    }

    /// <summary>Something went wrong outside a specific check.</summary>
    public void Error(string text)
    {
        _failed++;
        _plain.Add($"  FATAL: {text}");
        Add(new TextBlock
        {
            Text = text,
            FontFamily = new FontFamily("Consolas"),
            FontSize = 12,
            Foreground = new SolidColorBrush(Color.FromArgb(255, 235, 84, 84)),
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(14, 4, 0, 4),
        });
    }

    private void Add(UIElement element)
    {
        _log.Children.Add(element);
        // Keep the newest line in view; a long run should scroll itself rather
        // than making the user chase it.
        _scroller.UpdateLayout();
        _scroller.ChangeView(null, _scroller.ScrollableHeight, null, true);
    }

    /// <summary>Finish: stop the progress bar and show the verdict.</summary>
    public void Done(string? reportPath = null)
    {
        _progress.IsIndeterminate = false;
        _progress.Value = 100;

        var ok = _failed == 0;
        _summary.Text = ok
            ? $"All {_passed} checks passed."
            : $"{_failed} of {_passed + _failed} checks FAILED.";
        _summary.Foreground = new SolidColorBrush(ok
            ? Color.FromArgb(255, 76, 194, 108)
            : Color.FromArgb(255, 235, 84, 84));

        _plain.Add("");
        _plain.Add(_summary.Text);

        if (reportPath is not null)
        {
            try { File.WriteAllLines(reportPath, _plain); } catch { /* best effort */ }
        }
    }

    public int Failed => _failed;
}
