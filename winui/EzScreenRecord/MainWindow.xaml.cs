using EzScreenRecord.Capture;
using EzScreenRecord.Models;
using EzScreenRecord.Views;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Storage.Pickers;

namespace EzScreenRecord;

public sealed partial class MainWindow : Window
{
    private AppSettings Settings => App.Settings;
    private CaptureSourceChoice? _source;
    private bool _loaded;

    public MainWindow()
    {
        InitializeComponent();

        Title = "Ez Screen Record";

        // Mica. Unlike Electron, where the backdrop needed transparent:false
        // plus a fully-transparent ARGB backgroundColor and broke on maximize,
        // WinUI exposes it directly and it survives window state changes.
        if (Microsoft.UI.Composition.SystemBackdrops.MicaController.IsSupported())
        {
            SystemBackdrop = new MicaBackdrop
            {
                Kind = Microsoft.UI.Composition.SystemBackdrops.MicaKind.Base,
            };
        }

        // Draw our own title bar into the caption area.
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);

        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico"));
        AppWindow.Resize(new Windows.Graphics.SizeInt32(980, 760));

        PopulateOptions();
        _ = RestoreSourceAsync();

        Closed += (_, _) => Settings.Save();
    }

    // --- Options ------------------------------------------------------------

    private static readonly int[] FpsOptions = [24, 30, 60, 120];

    private static readonly (ResolutionPreset Value, string Label)[] ResolutionOptions =
    [
        (ResolutionPreset.Source, "Same as source"),
        (ResolutionPreset.P2160, "4K · 2160p"),
        (ResolutionPreset.P1440, "QHD · 1440p"),
        (ResolutionPreset.P1080, "Full HD · 1080p"),
        (ResolutionPreset.P720, "HD · 720p"),
    ];

    private static readonly (QualityPreset Value, string Label)[] QualityOptions =
    [
        (QualityPreset.High, "Best — visually lossless"),
        (QualityPreset.Balanced, "Balanced"),
        (QualityPreset.Compact, "Smallest file"),
    ];

    private void PopulateOptions()
    {
        foreach (var fps in FpsOptions) FpsBox.Items.Add($"{fps} fps");
        FpsBox.SelectedIndex = Math.Max(0, Array.IndexOf(FpsOptions, Settings.Recording.Fps));

        foreach (var (_, label) in ResolutionOptions) ResolutionBox.Items.Add(label);
        ResolutionBox.SelectedIndex = Array.FindIndex(
            ResolutionOptions, o => o.Value == Settings.Recording.Resolution);

        foreach (var (_, label) in QualityOptions) QualityBox.Items.Add(label);
        QualityBox.SelectedIndex = Array.FindIndex(
            QualityOptions, o => o.Value == Settings.Recording.Quality);

        MicBox.Items.Add("None");
        foreach (var device in AudioDevices.ListMicrophones()) MicBox.Items.Add(device);
        var savedMic = Settings.Recording.MicDeviceName;
        var micIndex = savedMic is null ? 0 : MicBox.Items.IndexOf(savedMic);
        MicBox.SelectedIndex = micIndex >= 0 ? micIndex : 0;

        OutputDirLabel.Text = Settings.Recording.OutputDir ?? AppSettings.DefaultOutputDir;

        _loaded = true;
    }

    // --- Source -------------------------------------------------------------

    private async Task RestoreSourceAsync()
    {
        var savedId = Settings.Recording.ScreenSourceId;
        if (string.IsNullOrEmpty(savedId))
        {
            // Default to the primary display so the app is usable without
            // visiting the picker first.
            var primary = MonitorList.Enumerate().FirstOrDefault(m => m.Primary)
                          ?? MonitorList.Enumerate().FirstOrDefault();
            if (primary is not null) await ApplySourceAsync(CaptureSourceChoice.FromMonitor(primary));
            return;
        }

        // A saved source may no longer exist -- the window was closed, or a
        // monitor was unplugged. Fall back to the primary display rather than
        // starting a take against a source that cannot produce frames.
        var restored = CaptureSourceChoice.Resolve(savedId);
        if (restored is null)
        {
            ShowStatus("The last capture source is gone. Falling back to the primary display.",
                InfoBarSeverity.Warning);
            var primary = MonitorList.Enumerate().FirstOrDefault(m => m.Primary);
            if (primary is not null) await ApplySourceAsync(CaptureSourceChoice.FromMonitor(primary));
            return;
        }

        await ApplySourceAsync(restored);
    }

    private async Task ApplySourceAsync(CaptureSourceChoice choice)
    {
        _source = choice;
        Settings.Recording.ScreenSourceId = choice.Id;
        SourceLabel.Text = choice.Label;
        SourceThumb.Source = await choice.LoadThumbnailAsync(96);
        Settings.Save();
    }

    private async void OnChooseSource(object sender, RoutedEventArgs e)
    {
        var dialog = new SourceDialog { XamlRoot = Content.XamlRoot };
        var result = await dialog.ShowAsync();
        if (result == ContentDialogResult.Primary && dialog.Selected is not null)
        {
            await ApplySourceAsync(dialog.Selected);
        }
    }

    // --- Option handlers ----------------------------------------------------

    private void OnFpsChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded || FpsBox.SelectedIndex < 0) return;
        Settings.Recording.Fps = FpsOptions[FpsBox.SelectedIndex];
        Settings.Save();
    }

    private void OnResolutionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded || ResolutionBox.SelectedIndex < 0) return;
        Settings.Recording.Resolution = ResolutionOptions[ResolutionBox.SelectedIndex].Value;
        Settings.Save();
    }

    private void OnQualityChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded || QualityBox.SelectedIndex < 0) return;
        Settings.Recording.Quality = QualityOptions[QualityBox.SelectedIndex].Value;
        Settings.Save();
    }

    private void OnMicChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded) return;
        Settings.Recording.MicDeviceName = MicBox.SelectedIndex <= 0
            ? null
            : MicBox.SelectedItem as string;
        Settings.Recording.MicEnabled = Settings.Recording.MicDeviceName is not null;
        Settings.Save();
    }

    private async void OnChooseOutputDir(object sender, RoutedEventArgs e)
    {
        var picker = new FolderPicker { SuggestedStartLocation = PickerLocationId.VideosLibrary };
        picker.FileTypeFilter.Add("*");

        // Unpackaged apps must associate the picker with a window handle or it
        // throws -- there is no implicit window to parent it to.
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);

        var folder = await picker.PickSingleFolderAsync();
        if (folder is null) return;

        Settings.Recording.OutputDir = folder.Path;
        OutputDirLabel.Text = folder.Path;
        Settings.Save();
    }

    // --- Recording (wired in Phase 2) ---------------------------------------

    private void OnToggleRecord(object sender, RoutedEventArgs e)
    {
        ShowStatus("Recording is wired up in Phase 2.", InfoBarSeverity.Informational);
    }

    internal void ShowStatus(string message, InfoBarSeverity severity)
    {
        StatusBar.Message = message;
        StatusBar.Severity = severity;
        StatusBar.IsOpen = true;
    }
}
