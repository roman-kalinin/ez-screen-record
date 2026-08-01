using EzScreenRecord.Capture;
using EzScreenRecord.Interop;
using EzScreenRecord.Models;
using EzScreenRecord.Views;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Storage.Pickers;
using DispatcherTimer = Microsoft.UI.Xaml.DispatcherTimer;

namespace EzScreenRecord;

public enum RecordingState { Idle, Countdown, Recording, Paused, Saving }

public sealed partial class MainWindow : Window
{
    private AppSettings Settings => App.Settings;
    private CaptureSourceChoice? _source;

    private RecordingState _state = RecordingState.Idle;
    private bool Busy => _state is RecordingState.Countdown or RecordingState.Recording
        or RecordingState.Paused or RecordingState.Saving;

    public MainWindow()
    {
        InitializeComponent();

        Title = "Ez Screen Record";

        if (Microsoft.UI.Composition.SystemBackdrops.MicaController.IsSupported())
        {
            SystemBackdrop = new MicaBackdrop
            {
                Kind = Microsoft.UI.Composition.SystemBackdrops.MicaKind.Base,
            };
        }

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);

        PinIcon.Glyph = Glyphs.Pin;
        MinimizeIcon.Glyph = Glyphs.Minimize;
        CloseIcon.Glyph = Glyphs.Close;

        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico"));
        SizeToPreview();

        BuildStage();
        BuildControlBar();
        SetupHotkeys();
        _ = RestoreSourceAsync();

        Closed += (_, _) =>
        {
            _hotkeys?.Dispose();
            _overlay?.Dispose();
            _paletteWindow?.Close();
            _toolbar?.Close();
            _stage?.StopPreviews();
            Settings.Save();
        };
    }

    /// <summary>
    /// Size the window around a 16:9 preview rather than to a fixed box, so the
    /// stage is never letterboxed and there is no dead band under it.
    /// </summary>
    private void SizeToPreview()
    {
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary);
        var work = area.WorkArea;

        var width = Math.Min(880, work.Width - 80);
        var height = (int)Math.Round(width * 0.5625) + 150;

        AppWindow.Resize(new Windows.Graphics.SizeInt32(width, height));
        AppWindow.Move(new Windows.Graphics.PointInt32(
            work.X + (work.Width - width) / 2,
            work.Y + (work.Height - height) / 2));
    }

    // --- Stage --------------------------------------------------------------

    private LayoutStageControl? _stage;

    private void BuildStage()
    {
        _stage = new LayoutStageControl();
        _stage.SetCamera(Settings.Camera);
        _stage.CameraRectChanged += rect =>
        {
            Settings.Camera.Rect = rect;
            Settings.Save();
        };
        _stage.CameraShapeChanged += () => Settings.Save();
        StageHost.Content = _stage;
    }

    // --- Control bar --------------------------------------------------------

    private PillControl? _micPill;
    private PillControl? _camPill;
    private Button? _drawButton;
    private Button? _recordButton;
    private Button? _pauseButton;

    private void BuildControlBar()
    {
        // Left group: mic, camera, source, add image, draw, settings, help.
        _micPill = new PillControl("Microphone", Glyphs.Mic, Glyphs.MicOff);
        _micPill.SetDevices(AudioDevices.ListMicrophones(), Settings.Recording.MicDeviceName);
        _micPill.SetEnabled(Settings.Recording.MicEnabled);
        _micPill.Toggled += on =>
        {
            Settings.Recording.MicEnabled = on;
            Settings.Save();
        };
        _micPill.DeviceSelected += name =>
        {
            Settings.Recording.MicDeviceName = name;
            Settings.Recording.MicEnabled = true;
            _micPill!.SetEnabled(true);
            Settings.Save();
        };
        LeftControls.Children.Add(_micPill);

        _camPill = new PillControl("Camera", Glyphs.Video, Glyphs.VideoOff);
        _camPill.SetDevices(AudioDevices.ListCameras(), Settings.Camera.DeviceName);
        _camPill.SetEnabled(Settings.Camera.Enabled);
        _camPill.Toggled += on =>
        {
            Settings.Camera.Enabled = on;
            _stage?.SetCamera(Settings.Camera);
            Settings.Save();
        };
        _camPill.DeviceSelected += name =>
        {
            Settings.Camera.DeviceName = name;
            Settings.Camera.Enabled = true;
            _camPill!.SetEnabled(true);
            _stage?.SetCamera(Settings.Camera);
            Settings.Save();
        };
        LeftControls.Children.Add(_camPill);

        LeftControls.Children.Add(RoundButton(Glyphs.Desktop, "Choose what to record",
            (_, _) => OnChooseSource()));

        LeftControls.Children.Add(RoundButton(Glyphs.ImageAdd, "Add image overlay",
            async (_, _) => await OnAddImageAsync()));

        // Only meaningful during a take, matching Electron: drawing over a
        // desktop nobody is recording has no purpose.
        _drawButton = RoundButton(Glyphs.Ink, "Draw on screen (F8)", (_, _) => ToggleDrawing());
        _drawButton.Visibility = Visibility.Collapsed;
        LeftControls.Children.Add(_drawButton);

        LeftControls.Children.Add(SettingsButton());
        LeftControls.Children.Add(ShortcutsButton());

        // Right group: pause (while recording) then the red transport button.
        _pauseButton = RoundButton(Glyphs.Pause, "Pause", (_, _) => TogglePause());
        _pauseButton.Visibility = Visibility.Collapsed;
        Transport.Children.Add(_pauseButton);

        _recordButton = new Button
        {
            Width = 58,
            Height = 40,
            CornerRadius = new CornerRadius(20),
            Padding = new Thickness(0),
            BorderThickness = new Thickness(0),
            Background = new SolidColorBrush(Microsoft.UI.ColorHelper.FromArgb(255, 196, 43, 28)),
            Foreground = new SolidColorBrush(Microsoft.UI.Colors.White),
            Content = new FontIcon { Glyph = Glyphs.Record, FontSize = 22 },
        };
        ToolTipService.SetToolTip(_recordButton, "Start recording (F9)");
        AutomationProperties.SetName(_recordButton, "Record");
        _recordButton.Click += async (_, _) => await ToggleRecordAsync();
        Transport.Children.Add(_recordButton);
    }

    private static Button RoundButton(string glyph, string tooltip, RoutedEventHandler onClick)
    {
        var button = new Button
        {
            Style = (Style)Application.Current.Resources["RoundButtonStyle"],
            Content = new FontIcon { Glyph = glyph, FontSize = 20 },
        };
        ToolTipService.SetToolTip(button, tooltip);

        // An icon-only button has no accessible name, so screen readers (and
        // UI-automation tests) see nothing at all. The tooltip is the name.
        AutomationProperties.SetName(button, tooltip);

        button.Click += onClick;
        return button;
    }

    // --- Title-bar chrome ---------------------------------------------------

    private bool _pinned;

    private void OnTogglePin(object sender, RoutedEventArgs e)
    {
        _pinned = !_pinned;
        ((OverlappedPresenter)AppWindow.Presenter).IsAlwaysOnTop = _pinned;
        ToolTipService.SetToolTip(PinButton, _pinned ? "Unpin from top" : "Keep on top");
        PinIcon.Foreground = _pinned
            ? (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"]
            : (Brush)Application.Current.Resources["TextFillColorPrimaryBrush"];
    }

    private void OnMinimize(object sender, RoutedEventArgs e)
        => ((OverlappedPresenter)AppWindow.Presenter).Minimize();

    private async void OnClose(object sender, RoutedEventArgs e)
    {
        // Quitting mid-take would discard the recording silently.
        if (Busy)
        {
            var dialog = new ContentDialog
            {
                XamlRoot = Content.XamlRoot,
                Title = "Recording in progress",
                Content = "A recording is still running.\n\n" +
                          "Quitting now discards it. Stop the recording first to save it.",
                PrimaryButtonText = "Discard and quit",
                CloseButtonText = "Keep recording",
                DefaultButton = ContentDialogButton.Close,
            };
            if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        }

        Close();
    }
}
