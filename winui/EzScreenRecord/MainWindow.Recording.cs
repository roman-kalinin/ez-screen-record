using EzScreenRecord.Capture;
using EzScreenRecord.Interop;
using EzScreenRecord.Models;
using EzScreenRecord.Views;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using DispatcherTimer = Microsoft.UI.Xaml.DispatcherTimer;

namespace EzScreenRecord;

/// <summary>The recording lifecycle, the source picker and the hotkeys.</summary>
public sealed partial class MainWindow
{
    private readonly Recorder _recorder = new();
    private DispatcherTimer? _elapsedTimer;
    private CancellationTokenSource? _countdownCts;

    // --- Source -------------------------------------------------------------

    private async Task RestoreSourceAsync()
    {
        var savedId = Settings.Recording.ScreenSourceId;

        if (!string.IsNullOrEmpty(savedId))
        {
            var restored = CaptureSourceChoice.Resolve(savedId);
            if (restored is not null)
            {
                await ApplySourceAsync(restored);
                return;
            }
            Toast("That source is gone", "Falling back to the primary display.", ToastKind.Info);
        }

        // Default to the primary display so the app is usable without visiting
        // the picker first.
        var primary = MonitorList.Enumerate().FirstOrDefault(m => m.Primary)
                      ?? MonitorList.Enumerate().FirstOrDefault();
        if (primary is not null)
            await ApplySourceAsync(CaptureSourceChoice.FromMonitor(primary));
    }

    private async Task ApplySourceAsync(CaptureSourceChoice choice)
    {
        _source = choice;
        Settings.Recording.ScreenSourceId = choice.Id;
        Settings.Save();

        if (_stage is not null) await _stage.SetSourceAsync(choice);
    }

    private async void OnChooseSource()
    {
        var dialog = new SourceDialog(_source) { XamlRoot = Content.XamlRoot };
        await dialog.ShowAsync();
        if (dialog.Selected is not null) await ApplySourceAsync(dialog.Selected);
    }

    private async Task OnAddImageAsync()
    {
        var picker = new Windows.Storage.Pickers.FileOpenPicker();
        foreach (var ext in new[] { ".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp" })
            picker.FileTypeFilter.Add(ext);
        WinRT.Interop.InitializeWithWindow.Initialize(
            picker, WinRT.Interop.WindowNative.GetWindowHandle(this));

        var files = await picker.PickMultipleFilesAsync();
        if (files is null || files.Count == 0) return;

        foreach (var file in files)
        {
            Settings.Images.Add(new ImageOverlay
            {
                Name = file.Name,
                FilePath = file.Path,
                Rect = new Models.Rect(0.04, 0.06, 0.22, 0.22),
            });
        }

        // Settings cap at 12 images; trim here so the UI matches what persists.
        while (Settings.Images.Count > 12) Settings.Images.RemoveAt(0);

        Settings.Save();
        RefreshImageList();
    }

    /// <summary>
    /// One row per image overlay: thumbnail, name, a visibility switch and a
    /// remove button. Only rendered when there are images, matching Electron —
    /// an empty list is just noise above the stage.
    /// </summary>
    private void RefreshImageList()
    {
        ImageList.Items.Clear();

        if (Settings.Images.Count == 0)
        {
            ImageList.Visibility = Visibility.Collapsed;
            _stage?.SetImages(Settings.Images);
            return;
        }

        foreach (var image in Settings.Images.ToList())
        {
            var row = new Grid
            {
                ColumnSpacing = 8,
                Padding = new Thickness(6),
                Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"],
                CornerRadius = new CornerRadius(4),
                Margin = new Thickness(0, 0, 0, 6),
            };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            var thumb = new Image
            {
                Width = 40,
                Height = 28,
                Stretch = Stretch.UniformToFill,
            };
            try
            {
                thumb.Source = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(
                    new Uri(image.FilePath));
            }
            catch
            {
                // The file moved or was deleted; the row still lets it be removed.
            }
            row.Children.Add(thumb);

            var name = new TextBlock
            {
                Text = image.Name,
                VerticalAlignment = VerticalAlignment.Center,
                TextTrimming = TextTrimming.CharacterEllipsis,
            };
            ToolTipService.SetToolTip(name, image.FilePath);
            Grid.SetColumn(name, 1);
            row.Children.Add(name);

            var visible = new ToggleSwitch
            {
                IsOn = image.Visible,
                OnContent = null,
                OffContent = null,
                VerticalAlignment = VerticalAlignment.Center,
            };
            ToolTipService.SetToolTip(visible, "Visible");
            visible.Toggled += (_, _) =>
            {
                image.Visible = visible.IsOn;
                Settings.Save();
                _stage?.SetImages(Settings.Images);
            };
            Grid.SetColumn(visible, 2);
            row.Children.Add(visible);

            var remove = new Button
            {
                Content = new FontIcon { Glyph = Glyphs.Delete, FontSize = 14 },
                VerticalAlignment = VerticalAlignment.Center,
            };
            ToolTipService.SetToolTip(remove, "Remove");
            AutomationProperties.SetName(remove, $"Remove {image.Name}");
            remove.Click += (_, _) =>
            {
                Settings.Images.Remove(image);
                Settings.Save();
                RefreshImageList();
            };
            Grid.SetColumn(remove, 3);
            row.Children.Add(remove);

            ImageList.Items.Add(row);
        }

        ImageList.Visibility = Visibility.Visible;
        _stage?.SetImages(Settings.Images);
    }

    // --- Recording ----------------------------------------------------------

    private async Task ToggleRecordAsync()
    {
        switch (_state)
        {
            case RecordingState.Countdown:
                // The countdown is cancellable; stopping during it aborts the
                // take rather than starting and immediately ending one.
                _countdownCts?.Cancel();
                return;

            case RecordingState.Recording:
            case RecordingState.Paused:
                await StopRecordingAsync();
                return;

            case RecordingState.Saving:
                return;

            default:
                await StartRecordingAsync();
                return;
        }
    }

    private async Task StartRecordingAsync()
    {
        if (_source is null)
        {
            Toast("Pick a source first", "Choose a screen or window to record.", ToastKind.Info);
            return;
        }

        var countdown = Settings.Recording.CountdownSeconds;
        if (countdown > 0)
        {
            SetState(RecordingState.Countdown);
            _countdownCts = new CancellationTokenSource();
            try
            {
                for (var i = countdown; i > 0; i--)
                {
                    CountdownText.Text = i.ToString();
                    CountdownScrim.Visibility = Visibility.Visible;
                    await Task.Delay(1000, _countdownCts.Token);
                }
            }
            catch (OperationCanceledException)
            {
                CountdownScrim.Visibility = Visibility.Collapsed;
                SetState(RecordingState.Idle);
                return;
            }
            finally
            {
                CountdownScrim.Visibility = Visibility.Collapsed;
                _countdownCts?.Dispose();
                _countdownCts = null;
            }
        }

        var dir = Settings.Recording.OutputDir ?? AppSettings.DefaultOutputDir;
        var name = $"recording_{DateTime.Now:yyyy-MM-dd_HH-mm-ss}.mp4";

        // The bubble is the default camera path: compositing through
        // libplacebo's framesync'd blend paces the whole graph off the webcam.
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

        var options = new RecordOptions
        {
            OutputPath = Path.Combine(dir, name),
            Fps = Settings.Recording.Fps,
            DisplayIndex = _source.Kind == CaptureKind.Screen ? _source.MonitorIndex : 0,
            Height = Settings.ResolutionHeight,
            Quality = Settings.Recording.Quality,
            MicDeviceName = Settings.Recording.MicEnabled ? Settings.Recording.MicDeviceName : null,
            Camera = camera,
            Images = Settings.Images
                .Where(i => i.Visible && File.Exists(i.FilePath))
                .Select(i => new ImageCompositeOptions
                {
                    FilePath = i.FilePath,
                    Rect = i.Rect,
                    Opacity = i.Opacity,
                })
                .ToList(),
        };

        // Show the toolbar BEFORE ffmpeg starts: otherwise the first frames of
        // the recording contain the toolbar animating in at 00:00.
        ShowToolbar();

        // The preview holds the camera and screen; ffmpeg needs them free.
        _stage?.StopPreviews();

        try
        {
            await _recorder.StartAsync(options);
        }
        catch (Exception ex)
        {
            HideToolbar();
            _ = _stage?.StartPreviewsAsync();
            Toast("Could not start recording", ex.Message, ToastKind.Error);
            SetState(RecordingState.Idle);
            return;
        }

        SetState(RecordingState.Recording);

        _elapsedTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        _elapsedTimer.Tick += (_, _) =>
        {
            var t = _recorder.Elapsed;
            var text = t.TotalHours >= 1
                ? $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}"
                : $"{t.Minutes:00}:{t.Seconds:00}";
            ElapsedLabel.Text = text;
            _toolbar?.SetElapsed(text);
        };
        _elapsedTimer.Start();
    }

    private async Task StopRecordingAsync()
    {
        _elapsedTimer?.Stop();
        _elapsedTimer = null;
        SetState(RecordingState.Saving);

        try
        {
            var path = await _recorder.StopAsync();
            Toast("Recording saved", Path.GetFileName(path), ToastKind.Success,
                "Show in folder", () => RevealFile(path));
        }
        catch (Exception ex)
        {
            Toast("Could not save recording", ex.Message, ToastKind.Error);
        }
        finally
        {
            HideToolbar();
            CloseOverlay();
            SetState(RecordingState.Idle);
            ElapsedLabel.Text = "00:00";
            _ = _stage?.StartPreviewsAsync();
        }
    }

    private void TogglePause()
        => Toast("Pause is not implemented yet",
            "ffmpeg has no pause; it needs process suspension and timestamp stitching.",
            ToastKind.Info);

    /// <summary>Drive every state-dependent piece of chrome from one place.</summary>
    private void SetState(RecordingState state)
    {
        _state = state;

        var recording = state is RecordingState.Recording or RecordingState.Paused;

        RecDot.Visibility = recording ? Visibility.Visible : Visibility.Collapsed;
        if (recording) RecPulse.Begin(); else RecPulse.Stop();

        ElapsedLabel.Visibility = recording ? Visibility.Visible : Visibility.Collapsed;
        if (_pauseButton is not null)
            _pauseButton.Visibility = recording ? Visibility.Visible : Visibility.Collapsed;

        // Drawing is only offered during a take, matching Electron.
        if (_drawButton is not null)
            _drawButton.Visibility = recording ? Visibility.Visible : Visibility.Collapsed;

        if (_recordButton is not null)
        {
            _recordButton.IsEnabled = state != RecordingState.Saving;
            ((FontIcon)_recordButton.Content).Glyph = recording || state == RecordingState.Countdown
                ? Glyphs.Stop
                : Glyphs.Record;
            ToolTipService.SetToolTip(_recordButton,
                recording ? "Stop recording (F9)" : "Start recording (F9)");
        }
    }

    // --- Toolbar ------------------------------------------------------------

    private ToolbarWindow? _toolbar;

    private void ShowToolbar()
    {
        if (_toolbar is not null) return;

        _toolbar = new ToolbarWindow(Settings);
        _toolbar.StopRequested += () => DispatcherQueue.TryEnqueue(async () => await StopRecordingAsync());
        _toolbar.PauseRequested += () => DispatcherQueue.TryEnqueue(TogglePause);
        _toolbar.DrawRequested += () => DispatcherQueue.TryEnqueue(ToggleDrawing);
        _toolbar.SourceRequested += () => DispatcherQueue.TryEnqueue(OnChooseSource);
        _toolbar.Activate();

        if (Settings.Recording.HideToolbarFromCapture && !_toolbar.ApplyCaptureExclusion())
            Toast("The toolbar could not be hidden from the recording", null, ToastKind.Error);
    }

    private void HideToolbar()
    {
        _toolbar?.Close();
        _toolbar = null;
    }

    // --- Drawing overlay ----------------------------------------------------

    // The drawing surface is a pure Win32 layered window; the palette is a
    // separate small XAML window above it. See Interop/LayeredOverlay.cs for
    // why WinUI cannot host the surface itself.
    private LayeredOverlay? _overlay;
    private PaletteWindow? _paletteWindow;

    private void ToggleDrawing()
    {
        if (_overlay is not null)
        {
            CloseOverlay();
            return;
        }

        _overlay = new LayeredOverlay { Draw = Settings.Draw };
        _overlay.Dismissed += () => DispatcherQueue.TryEnqueue(CloseOverlay);
        // Drawing means taking the mouse; click-through goes back on when the
        // overlay closes.
        _overlay.SetClickThrough(false);

        _paletteWindow = new PaletteWindow(Settings);
        _paletteWindow.ClearRequested += () => _overlay?.ClearAll();
        _paletteWindow.DoneRequested += () => DispatcherQueue.TryEnqueue(CloseOverlay);
        // The palette writes straight into Settings.Draw, which the overlay
        // holds by reference, so a tool or colour change takes effect at once.
        _paletteWindow.Changed += () => { if (_overlay is not null) _overlay.Draw = Settings.Draw; };
        _paletteWindow.Activate();

        // Raise the palette above the overlay. Both are topmost and the overlay
        // covers the whole desktop, so without this the palette is behind it
        // and cannot be clicked.
        _paletteWindow.BringToFront();

        // The palette is chrome, not content: keep it out of the video for the
        // same reason as the toolbar.
        if (Settings.Recording.HideToolbarFromCapture)
            _paletteWindow.SetExcludedFromCapture(true);

        _toolbar?.SetDrawActive(true);
    }

    private void CloseOverlay()
    {
        if (_overlay is null && _paletteWindow is null) return;

        _overlay?.Dispose();
        _overlay = null;

        _paletteWindow?.Close();
        _paletteWindow = null;

        _toolbar?.SetDrawActive(false);
    }

    // --- Hotkeys ------------------------------------------------------------

    private HotkeyManager? _hotkeys;

    private void SetupHotkeys()
    {
        _hotkeys = new HotkeyManager();
        _hotkeys.Triggered += action => DispatcherQueue.TryEnqueue(async () =>
        {
            switch (action)
            {
                case HotkeyAction.ToggleRecord: await ToggleRecordAsync(); break;
                case HotkeyAction.TogglePause: TogglePause(); break;
                case HotkeyAction.ToggleDraw: ToggleDrawing(); break;
                case HotkeyAction.ClearDraw: _overlay?.ClearAll(); break;
            }
        });

        if (_hotkeys.Failed.Count > 0)
        {
            Toast("Some shortcuts are unavailable",
                $"In use by another app: {string.Join(", ", _hotkeys.Failed)}",
                ToastKind.Info);
        }
    }
}
