using EzScreenRecord.Capture;
using EzScreenRecord.Interop;
using EzScreenRecord.Models;
using EzScreenRecord.Views;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Storage.Pickers;
using DispatcherTimer = Microsoft.UI.Xaml.DispatcherTimer;

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
        BuildStage();
        SetupHotkeys();
        _ = RestoreSourceAsync();

        Closed += (_, _) =>
        {
            _hotkeys?.Dispose();
            _overlay?.Close();
            Settings.Save();
        };
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

    // --- Layout stage -------------------------------------------------------

    private LayoutStageControl? _stage;

    private static readonly (OverlayShape Value, string Label)[] ShapeOptions =
    [
        (OverlayShape.Rounded, "Rounded"),
        (OverlayShape.Circle, "Circle"),
        (OverlayShape.Square, "Square"),
    ];

    private void BuildStage()
    {
        _stage = new LayoutStageControl();
        _stage.SetCamera(Settings.Camera);
        _stage.CameraRectChanged += rect =>
        {
            Settings.Camera.Rect = rect;
            Settings.Save();
        };
        StageHost.Content = _stage;

        CameraToggle.IsChecked = Settings.Camera.Enabled;
        MirrorToggle.IsChecked = Settings.Camera.Mirrored;

        foreach (var (_, label) in ShapeOptions) ShapeBox.Items.Add(label);
        ShapeBox.SelectedIndex = Array.FindIndex(ShapeOptions, o => o.Value == Settings.Camera.Shape);
    }

    private void OnToggleCamera(object sender, RoutedEventArgs e)
    {
        Settings.Camera.Enabled = CameraToggle.IsChecked == true;
        _stage?.SetCamera(Settings.Camera);
        Settings.Save();
    }

    private void OnToggleMirror(object sender, RoutedEventArgs e)
    {
        Settings.Camera.Mirrored = MirrorToggle.IsChecked == true;
        Settings.Save();
    }

    private void OnShapeChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_loaded || ShapeBox.SelectedIndex < 0) return;
        Settings.Camera.Shape = ShapeOptions[ShapeBox.SelectedIndex].Value;
        _stage?.SetCamera(Settings.Camera);
        Settings.Save();
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

        // A still of the source behind the overlays, so the layout is arranged
        // against what will actually be recorded rather than a black rectangle.
        // Larger than the row thumbnail because the stage is much bigger.
        _stage?.SetBackground(await choice.LoadThumbnailAsync(640));

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

    // --- Recording ----------------------------------------------------------

    private readonly Recorder _recorder = new();
    private DispatcherTimer? _elapsedTimer;

    private async void OnToggleRecord(object sender, RoutedEventArgs e)
    {
        if (_recorder.IsRecording)
        {
            await StopRecordingAsync();
            return;
        }

        await StartRecordingAsync();
    }

    private async Task StartRecordingAsync()
    {
        if (_source is null)
        {
            ShowStatus("Pick something to record first.", InfoBarSeverity.Warning);
            return;
        }

        // A window source cannot be handed to ddagrab, which captures whole
        // outputs. Recording the display the window sits on is the honest
        // fallback; silently recording the wrong thing would be worse.
        if (_source.Kind == CaptureKind.Window)
        {
            ShowStatus(
                "Window capture is not wired up yet — recording the primary display instead.",
                InfoBarSeverity.Informational);
        }

        var dir = Settings.Recording.OutputDir ?? AppSettings.DefaultOutputDir;
        var name = $"Recording {DateTime.Now:yyyy-MM-dd HH-mm-ss}.mp4";

        // Only composite the camera when it is enabled, a device is chosen, and
        // the user has NOT asked for the on-screen bubble.
        //
        // ShowOnScreen is the default and matters for frame rate, not looks:
        // ffmpeg's libplacebo blend is framesync'd, so compositing here paces
        // the whole graph off the webcam. A 30fps camera (15fps in dim light)
        // pulled 60fps takes down to ~21 unique fps and 120fps takes to ~13.
        // The bubble instead rides along as an ordinary desktop window that the
        // screen capture picks up, and the screen is never held back.
        var camera = Settings.Camera is { Enabled: true, ShowOnScreen: false, DeviceName: not null }
            ? new CameraCompositeOptions
            {
                DeviceName = Settings.Camera.DeviceName,
                Rect = Settings.Camera.Rect,
                CornerRounding = Settings.Camera.Shape switch
                {
                    OverlayShape.Circle => 0.5,
                    OverlayShape.Rounded => 0.15,
                    _ => 0.0,
                },
                Mirrored = Settings.Camera.Mirrored,
            }
            : null;

        var images = Settings.Images
            .Where(i => i.Visible && File.Exists(i.FilePath))
            .Select(i => new ImageCompositeOptions
            {
                FilePath = i.FilePath,
                Rect = i.Rect,
                Opacity = i.Opacity,
            })
            .ToList();

        var options = new RecordOptions
        {
            OutputPath = Path.Combine(dir, name),
            Fps = Settings.Recording.Fps,
            DisplayIndex = _source.Kind == CaptureKind.Screen ? _source.MonitorIndex : 0,
            Height = Settings.ResolutionHeight,
            Quality = Settings.Recording.Quality,
            MicDeviceName = Settings.Recording.MicEnabled ? Settings.Recording.MicDeviceName : null,
            Camera = camera,
            Images = images,
        };

        RecordButton.IsEnabled = false;
        try
        {
            await _recorder.StartAsync(options);
        }
        catch (Exception ex)
        {
            ShowStatus(ex.Message, InfoBarSeverity.Error);
            return;
        }
        finally
        {
            RecordButton.IsEnabled = true;
        }

        SetRecordingUi(true);
        StatusBar.IsOpen = false;
        ShowToolbar();

        _elapsedTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _elapsedTimer.Tick += (_, _) =>
        {
            var t = _recorder.Elapsed;
            ElapsedLabel.Text = $"{(int)t.TotalMinutes:00}:{t.Seconds:00}";
        };
        _elapsedTimer.Start();
    }

    private async Task StopRecordingAsync()
    {
        _elapsedTimer?.Stop();
        _elapsedTimer = null;

        RecordButton.IsEnabled = false;
        RecordLabel.Text = "Saving…";
        try
        {
            var path = await _recorder.StopAsync();
            ShowStatus($"Saved to {path}", InfoBarSeverity.Success);
        }
        catch (Exception ex)
        {
            ShowStatus(ex.Message, InfoBarSeverity.Error);
        }
        finally
        {
            RecordButton.IsEnabled = true;
            SetRecordingUi(false);
            ElapsedLabel.Text = "";
            HideToolbar();
        }
    }

    // --- Recording toolbar --------------------------------------------------

    private ToolbarWindow? _toolbar;

    private void ShowToolbar()
    {
        if (_toolbar is not null) return;

        _toolbar = new ToolbarWindow(Settings);
        _toolbar.StopRequested += () => DispatcherQueue.TryEnqueue(async () => await StopRecordingAsync());
        _toolbar.UndoRequested += () => _overlay?.Undo();
        _toolbar.ClearRequested += () => _overlay?.ClearAll();
        _toolbar.ToolPicked += _ =>
        {
            // Picking a tool arms the overlay, so the button does what it looks
            // like it does rather than silently setting a preference.
            if (_overlay is null) ToggleDrawing();
        };
        _toolbar.Activate();

        // Report a failed exclusion rather than letting the toolbar quietly
        // appear in the finished video.
        if (Settings.Recording.HideToolbarFromCapture && !_toolbar.ApplyCaptureExclusion())
        {
            ShowStatus("The toolbar could not be hidden from the recording.",
                InfoBarSeverity.Warning);
        }
    }

    private void HideToolbar()
    {
        _toolbar?.Close();
        _toolbar = null;
    }

    private void SetRecordingUi(bool recording)
    {
        RecordLabel.Text = recording ? "Stop recording" : "Start recording";
        // Segoe Fluent Icons: Stop (E71A) while recording, Record (E7C8) idle.
        RecordIcon.Glyph = recording ? Glyphs.Stop : Glyphs.Record;
    }

    // --- Hotkeys and the drawing overlay ------------------------------------

    private HotkeyManager? _hotkeys;
    private OverlayWindow? _overlay;

    private void SetupHotkeys()
    {
        _hotkeys = new HotkeyManager();
        _hotkeys.Triggered += OnHotkey;

        if (_hotkeys.Failed.Count > 0)
        {
            ShowStatus(
                $"Another app already owns {string.Join(", ", _hotkeys.Failed)} — " +
                "those shortcuts will not work.",
                InfoBarSeverity.Warning);
        }
    }

    private void OnHotkey(HotkeyAction action)
    {
        // WM_HOTKEY arrives on the message-only window's thread, which is this
        // one, but the enqueue keeps UI work off the message pump either way.
        DispatcherQueue.TryEnqueue(() =>
        {
            switch (action)
            {
                case HotkeyAction.ToggleRecord:
                    OnToggleRecord(this, new RoutedEventArgs());
                    break;

                case HotkeyAction.TogglePause:
                    // ffmpeg has no pause: the process would have to be
                    // suspended and the timestamps stitched afterwards. Left
                    // unimplemented rather than silently doing nothing.
                    ShowStatus("Pause is not implemented yet.", InfoBarSeverity.Informational);
                    break;

                case HotkeyAction.ToggleDraw:
                    ToggleDrawing();
                    break;

                case HotkeyAction.ClearDraw:
                    _overlay?.ClearAll();
                    break;
            }
        });
    }

    private void ToggleDrawing()
    {
        if (_overlay is null)
        {
            _overlay = new OverlayWindow(Settings);
            _overlay.Dismissed += () => ToggleDrawing();
            _overlay.Activate();
            _overlay.SetInteractive(true);
            ShowStatus("Drawing on — F8 to exit, Ctrl+Shift+X to clear.",
                InfoBarSeverity.Informational);
            return;
        }

        // Second press exits drawing entirely rather than merely making the
        // overlay click-through: leaving an invisible armed window over the
        // desktop is confusing, and the strokes should go with it.
        _overlay.Close();
        _overlay = null;
        StatusBar.IsOpen = false;
    }

    internal void ShowStatus(string message, InfoBarSeverity severity)
    {
        StatusBar.Message = message;
        StatusBar.Severity = severity;
        StatusBar.IsOpen = true;
    }
}
