using System.Diagnostics;
using EzScreenRecord.Capture;
using EzScreenRecord.Interop;
using EzScreenRecord.Models;
using EzScreenRecord.Views;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Windows.Storage.Pickers;
using DispatcherTimer = Microsoft.UI.Xaml.DispatcherTimer;
// Our icon constants, not Microsoft.UI.Xaml.Documents.Glyphs (a text element,
// pulled in by the Documents import above for HyperlinkButton).
using Glyphs = EzScreenRecord.Views.Glyphs;

namespace EzScreenRecord;

/// <summary>
/// Everything the control bar triggers: the flyouts, the recording lifecycle,
/// toasts and shell integration. Split from the window's construction so
/// neither file becomes unreadable.
/// </summary>
public sealed partial class MainWindow
{
    // --- Settings flyout ----------------------------------------------------

    private static readonly (QualityPreset Value, string Label)[] QualityOptions =
    [
        (QualityPreset.High, "Best — visually lossless"),
        (QualityPreset.Balanced, "Balanced"),
        (QualityPreset.Compact, "Smallest file"),
    ];

    private static readonly (ResolutionPreset Value, string Label)[] ResolutionOptions =
    [
        (ResolutionPreset.Source, "Same as source"),
        (ResolutionPreset.P2160, "4K · 2160p"),
        (ResolutionPreset.P1440, "QHD · 1440p"),
        (ResolutionPreset.P1080, "Full HD · 1080p"),
        (ResolutionPreset.P720, "HD · 720p"),
    ];

    private static readonly int[] FpsOptions = [24, 30, 60, 120];
    private static readonly int[] CountdownOptions = [0, 3, 5, 10];

    private TextBlock? _outputDirLabel;

    private Button SettingsButton()
    {
        var panel = new StackPanel
        {
            Spacing = 6,
            Padding = new Thickness(12),
            MinWidth = 260,
            MaxWidth = 320,
        };

        panel.Children.Add(Heading("Quality"));
        panel.Children.Add(Combo(
            QualityOptions.Select(o => o.Label),
            Array.FindIndex(QualityOptions, o => o.Value == Settings.Recording.Quality),
            i => { Settings.Recording.Quality = QualityOptions[i].Value; Settings.Save(); }));

        panel.Children.Add(new MenuFlyoutSeparator());

        panel.Children.Add(Heading("Resolution"));
        panel.Children.Add(Combo(
            ResolutionOptions.Select(o => o.Label),
            Array.FindIndex(ResolutionOptions, o => o.Value == Settings.Recording.Resolution),
            i => { Settings.Recording.Resolution = ResolutionOptions[i].Value; Settings.Save(); }));

        panel.Children.Add(Heading("Frame rate"));
        panel.Children.Add(Combo(
            // 120 is flagged: it is achievable but asks a lot of the machine.
            FpsOptions.Select(f => f == 120 ? "120 fps (demanding)" : $"{f} fps"),
            Math.Max(0, Array.IndexOf(FpsOptions, Settings.Recording.Fps)),
            i => { Settings.Recording.Fps = FpsOptions[i]; Settings.Save(); }));

        panel.Children.Add(Heading("Countdown"));
        panel.Children.Add(Combo(
            CountdownOptions.Select(c => c == 0 ? "Off" : $"{c}s"),
            Math.Max(0, Array.IndexOf(CountdownOptions, Settings.Recording.CountdownSeconds)),
            i => { Settings.Recording.CountdownSeconds = CountdownOptions[i]; Settings.Save(); }));

        panel.Children.Add(new MenuFlyoutSeparator());

        var hideToolbar = new ToggleSwitch
        {
            Header = "Hide the toolbar from the recording",
            IsOn = Settings.Recording.HideToolbarFromCapture,
        };
        var hideCaption = Caption(HideToolbarCaption(hideToolbar.IsOn));
        hideToolbar.Toggled += (_, _) =>
        {
            Settings.Recording.HideToolbarFromCapture = hideToolbar.IsOn;
            hideCaption.Text = HideToolbarCaption(hideToolbar.IsOn);
            _toolbar?.ApplyCaptureExclusion();
            Settings.Save();
        };
        panel.Children.Add(hideToolbar);
        panel.Children.Add(hideCaption);

        panel.Children.Add(new MenuFlyoutSeparator());

        var systemAudio = new ToggleSwitch
        {
            Header = "Record system audio",
            IsOn = Settings.Recording.SystemAudioEnabled,
        };
        systemAudio.Toggled += (_, _) =>
        {
            Settings.Recording.SystemAudioEnabled = systemAudio.IsOn;
            Settings.Save();
        };
        panel.Children.Add(systemAudio);
        panel.Children.Add(Caption(
            "Captures what your speakers are playing, mixed with the microphone. " +
            "ffmpeg cannot capture desktop audio on Windows, so the app records it " +
            "separately and merges it when the take ends."));

        panel.Children.Add(new MenuFlyoutSeparator());

        var doNotDisturb = new ToggleSwitch
        {
            Header = "Do not disturb while recording",
            IsOn = Settings.Recording.DoNotDisturbWhileRecording,
        };
        doNotDisturb.Toggled += (_, _) =>
        {
            Settings.Recording.DoNotDisturbWhileRecording = doNotDisturb.IsOn;
            Settings.Save();
        };
        panel.Children.Add(doNotDisturb);
        panel.Children.Add(Caption(
            "Silences Windows notifications while a take is recording and restores " +
            "your previous setting when it stops."));

        panel.Children.Add(new MenuFlyoutSeparator());

        // State what the recorder cannot do, rather than leaving the gap for
        // the user to discover in a finished file.
        panel.Children.Add(Heading("Not yet supported"));
        panel.Children.Add(Caption(
            "Window capture records the display the window sits on. Image overlays " +
            "record at a fixed position."));

        panel.Children.Add(new MenuFlyoutSeparator());

        panel.Children.Add(Heading("Save to"));
        _outputDirLabel = Caption(Settings.Recording.OutputDir ?? AppSettings.DefaultOutputDir);
        _outputDirLabel.TextTrimming = TextTrimming.CharacterEllipsis;
        panel.Children.Add(_outputDirLabel);

        var dirRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };

        var change = new Button { Content = "Change…" };
        change.Click += async (_, _) => await ChooseOutputDirAsync();
        dirRow.Children.Add(change);

        // The missing piece: no way to reach a finished recording from the app.
        var open = new Button
        {
            Content = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 6,
                Children =
                {
                    new FontIcon { Glyph = Glyphs.Folder, FontSize = 14 },
                    new TextBlock { Text = "Open folder" },
                },
            },
        };
        open.Click += (_, _) => OpenOutputFolder();
        dirRow.Children.Add(open);

        panel.Children.Add(dirRow);

        var button = RoundButton(Glyphs.Settings, "Settings", (_, _) => { });
        button.Flyout = new Flyout { Content = panel };
        return button;
    }

    private static string HideToolbarCaption(bool on) => on
        ? "The toolbar stays visible to you but never appears in the video. It is also hidden from Zoom and Teams shares while recording."
        : "The toolbar is recorded along with everything else on screen.";

    private Button ShortcutsButton()
    {
        var grid = new Grid { Padding = new Thickness(12), RowSpacing = 6, ColumnSpacing = 12 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var rows = new (string Key, string Action)[]
        {
            ("F9", "Record / stop"),
            ("F10", "Pause / resume"),
            ("F8", "Draw"),
            ("Ctrl+Shift+X", "Erase all"),
        };

        for (var i = 0; i < rows.Length; i++)
        {
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var chip = new Border
            {
                Background = (Brush)Application.Current.Resources["ControlAltFillColorSecondaryBrush"],
                BorderBrush = (Brush)Application.Current.Resources["ControlStrokeColorDefaultBrush"],
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(4),
                Padding = new Thickness(6, 2, 6, 2),
                Child = new TextBlock
                {
                    Text = rows[i].Key,
                    FontFamily = new FontFamily("Consolas"),
                    FontSize = 11,
                },
            };
            Grid.SetRow(chip, i);
            grid.Children.Add(chip);

            var label = new TextBlock { Text = rows[i].Action, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetRow(label, i);
            Grid.SetColumn(label, 1);
            grid.Children.Add(label);
        }

        var panel = new StackPanel { Spacing = 8, MinWidth = 260 };
        panel.Children.Add(grid);
        panel.Children.Add(new MenuFlyoutSeparator());
        panel.Children.Add(Caption(
            "While drawing — P pen · H highlighter · A arrow · R rect · O ellipse · E eraser · Ctrl+Z undo · Esc done"));

        var button = RoundButton(Glyphs.Question, "Keyboard shortcuts", (_, _) => { });
        button.Flyout = new Flyout { Content = panel };
        return button;
    }

    private static TextBlock Heading(string text) => new()
    {
        Text = text,
        FontSize = 12,
        FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
        Margin = new Thickness(0, 6, 0, 0),
    };

    private static TextBlock Caption(string text) => new()
    {
        Text = text,
        FontSize = 12,
        Opacity = 0.7,
        TextWrapping = TextWrapping.Wrap,
    };

    private static ComboBox Combo(IEnumerable<string> items, int selected, Action<int> onChange)
    {
        var combo = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch };
        foreach (var item in items) combo.Items.Add(item);

        // Attach the handler only AFTER setting the initial index. Wiring it
        // first means the initial assignment fires SelectionChanged and writes
        // that value straight back to settings -- which is how the frame rate
        // silently became 120 on every launch.
        combo.SelectedIndex = Math.Max(0, selected);
        combo.SelectionChanged += (_, _) =>
        {
            if (combo.SelectedIndex >= 0) onChange(combo.SelectedIndex);
        };
        return combo;
    }

    // --- Shell integration --------------------------------------------------

    /// <summary>Open the output directory in Explorer, creating it if needed.</summary>
    private void OpenOutputFolder()
    {
        var dir = Settings.Recording.OutputDir ?? AppSettings.DefaultOutputDir;
        try
        {
            Directory.CreateDirectory(dir);
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{dir}\"") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Toast("Could not open the folder", ex.Message, ToastKind.Error);
        }
    }

    /// <summary>Open Explorer with the finished recording selected.</summary>
    private void RevealFile(string path)
    {
        try
        {
            // /select, needs the path as a separate token; quoting the whole
            // argument makes Explorer open the parent and ignore the selection.
            Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"")
            {
                UseShellExecute = true,
            });
        }
        catch
        {
            OpenOutputFolder();
        }
    }

    private async Task ChooseOutputDirAsync()
    {
        var picker = new FolderPicker { SuggestedStartLocation = PickerLocationId.VideosLibrary };
        picker.FileTypeFilter.Add("*");
        WinRT.Interop.InitializeWithWindow.Initialize(
            picker, WinRT.Interop.WindowNative.GetWindowHandle(this));

        var folder = await picker.PickSingleFolderAsync();
        if (folder is null) return;

        Settings.Recording.OutputDir = folder.Path;
        if (_outputDirLabel is not null) _outputDirLabel.Text = folder.Path;
        Settings.Save();
    }

    // --- Toasts -------------------------------------------------------------

    private enum ToastKind { Info, Success, Error }

    /// <summary>
    /// A dismissable toast. Errors linger longest because they usually need
    /// reading; the saved-recording toast is longest of all because it carries
    /// the "Show in folder" link.
    /// </summary>
    private void Toast(string title, string? body, ToastKind kind,
        string? actionText = null, Action? action = null)
    {
        var bar = new InfoBar
        {
            Title = title,
            Message = body,
            IsOpen = true,
            IsClosable = true,
            Severity = kind switch
            {
                ToastKind.Success => InfoBarSeverity.Success,
                ToastKind.Error => InfoBarSeverity.Error,
                _ => InfoBarSeverity.Informational,
            },
        };

        if (actionText is not null && action is not null)
        {
            var link = new HyperlinkButton { Content = actionText };
            link.Click += (_, _) => action();
            bar.ActionButton = link;
        }

        ToastHost.Children.Add(bar);

        var timeout = actionText is not null ? 10000 : kind == ToastKind.Error ? 8000 : 4000;
        var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(timeout) };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            ToastHost.Children.Remove(bar);
        };
        timer.Start();

        bar.CloseButtonClick += (_, _) =>
        {
            timer.Stop();
            ToastHost.Children.Remove(bar);
        };
    }
}
