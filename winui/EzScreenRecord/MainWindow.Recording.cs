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

    private SystemAudioCapture? _systemAudio;
    private string? _systemAudioPath;

    /// <summary>
    /// Handle an ffmpeg death mid-take.
    ///
    /// Subscribed once, from the window's constructor. Without it the app stays
    /// in Recording forever after a crash: the timer keeps climbing, the
    /// toolbar keeps showing a rising clock, nothing is being written, and Stop
    /// then throws "No recording is running." The recorder already builds a
    /// readable explanation from ffmpeg's stderr -- nothing was listening for
    /// it.
    /// </summary>
    private void WireRecorderFailure() => _recorder.Failed += reason =>
        DispatcherQueue.TryEnqueue(async () =>
        {
            // A clean stop also raises this if ffmpeg exits non-zero; only act
            // while a take is supposed to be running.
            if (_state is not (RecordingState.Recording or RecordingState.Paused)) return;

            _elapsedTimer?.Stop();
            _elapsedTimer = null;

            HideToolbar();
            HideCameraBubble();
            CloseOverlay();
            // Restore notifications after an unexpected ffmpeg death.
            DoNotDisturb.Disable();
            // Otherwise the loopback graph outlives the take and keeps writing.
            await StopSystemAudioAsync();
            SetState(RecordingState.Idle);
            ElapsedLabel.Text = "00:00";
            await (_stage?.StartPreviewsAsync() ?? Task.CompletedTask);

            Toast("Recording stopped unexpectedly", reason, ToastKind.Error);
        });

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

        if (dialog.Selected is not null)
        {
            await ApplySourceAsync(dialog.Selected);
            return;
        }

        // "Clear selection" must actually clear it. Testing only Selected made
        // that button indistinguishable from Cancel, since clearing sets
        // Selected to null too.
        if (dialog.Cleared)
        {
            _source = null;
            Settings.Recording.ScreenSourceId = null;
            Settings.Save();
            _stage?.ClearSource();
        }
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

        // Cap at 12 images. Add only up to the remaining slots rather than
        // appending everything and then trimming — trimming from the front
        // silently deleted the user's oldest, already-placed overlays whenever
        // a new drop pushed the count over the cap.
        const int maxImages = 12;
        var free = maxImages - Settings.Images.Count;
        var toAdd = files.Take(Math.Max(0, free)).ToList();

        foreach (var file in toAdd)
        {
            Settings.Images.Add(new ImageOverlay
            {
                Name = file.Name,
                FilePath = file.Path,
                Rect = new Models.Rect(0.04, 0.06, 0.22, 0.22),
            });
        }

        if (toAdd.Count < files.Count)
        {
            Toast($"Image limit reached ({maxImages})",
                $"Added {toAdd.Count} of {files.Count}; remove some to add more.",
                ToastKind.Info);
        }

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

        // Any drawing overlay from before the take must go.
        //
        // It covers the whole desktop and, while interactive, is filled with an
        // alpha-1 base layer so it can be hit-tested -- which reads as a dark
        // sheet over everything. Leaving it up meant pressing record produced a
        // dark screen with only the toolbar on it. Drawing is re-armed with F8
        // once the take is running.
        CloseOverlay();

        // Show the on-screen camera bubble when that path is selected.
        //
        // This is the DEFAULT (ShowOnScreen is true), and it was never wired
        // up: the ffmpeg composite above is skipped whenever ShowOnScreen is
        // set, and nothing created the bubble, so the camera reached the
        // recording by neither route and simply did not appear.
        if (camera is null && Settings.Camera is { Enabled: true, ShowOnScreen: true })
            ShowCameraBubble();

        // Desktop audio, captured by us and muxed in afterwards: ffmpeg has no
        // WASAPI input on Windows, only dshow, which sees microphones alone.
        _systemAudioPath = null;
        if (Settings.Recording.SystemAudioEnabled)
        {
            _systemAudio = new SystemAudioCapture();
            var wav = Path.Combine(Path.GetTempPath(),
                $"ez-sysaudio-{Guid.NewGuid():N}.wav");

            if (await _systemAudio.StartAsync(wav)) _systemAudioPath = wav;
            else
            {
                Toast("System audio unavailable", _systemAudio.LastError, ToastKind.Info);
                _systemAudio = null;
            }
        }

        // Show the toolbar BEFORE ffmpeg starts: otherwise the first frames of
        // the recording contain the toolbar animating in at 00:00.
        ShowToolbar();

        // The preview holds the camera and screen; ffmpeg needs them free.
        _stage?.StopPreviews();

        // Silence notifications the instant before capture begins, so banners are
        // already gone from the first frame. Best-effort; never blocks the take.
        if (Settings.Recording.DoNotDisturbWhileRecording) DoNotDisturb.Enable();

        try
        {
            await _recorder.StartAsync(options);
        }
        catch (Exception ex)
        {
            HideToolbar();
            HideCameraBubble();
            // Capture never started — put notifications back.
            DoNotDisturb.Disable();

            // The audio graph was started before ffmpeg. Left running it
            // captures the desktop for the rest of the app's lifetime, writing
            // to a temp WAV that grows unbounded, and the next take overwrites
            // the field and leaks the graph and its file handle for good.
            await StopSystemAudioAsync();

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

    /// <summary>
    /// Tear down desktop-audio capture and bin its WAV. For the abandon paths
    /// (failed start, mid-take ffmpeg death) where there is no video to mux
    /// into -- the successful path stops it inline so it can use the file.
    /// </summary>
    private async Task StopSystemAudioAsync()
    {
        if (_systemAudio is null) return;

        var capture = _systemAudio;
        _systemAudio = null;
        _systemAudioPath = null;

        try
        {
            var wav = await capture.StopAsync();
            if (wav is not null) { try { File.Delete(wav); } catch { /* best effort */ } }
        }
        catch { /* tearing down anyway */ }
    }

    private async Task StopRecordingAsync()
    {
        // Reachable from the hotkey, the record button and the toolbar's stop
        // button, none of which disable while the save runs. A second entry
        // re-enters StopAsync with no process left, throws "No recording is
        // running" over the successful save, and can race the audio mux onto a
        // file the first pass already replaced.
        if (_state is not (RecordingState.Recording or RecordingState.Paused)) return;

        // A pause mid-flight has already detached ffmpeg but not yet flipped
        // the state; stopping now would tear down half-finished segments.
        if (_pauseInFlight) return;

        _elapsedTimer?.Stop();
        _elapsedTimer = null;
        SetState(RecordingState.Saving);

        try
        {
            var path = await _recorder.StopAsync();

            // A failed join means only the pre-pause footage is in the saved
            // file and the rest is sitting beside it as .partN.mp4. Reporting
            // a plain "Recording saved" would hide that entirely.
            if (_recorder.LastJoinError is { } joinError)
            {
                Toast("Only part of the take was saved",
                    $"The paused segments could not be joined ({joinError}). " +
                    "The remaining pieces are in the same folder as .part files.",
                    ToastKind.Error);
            }

            // Fold in the desktop audio, if it was captured. Done after the
            // take rather than as a live ffmpeg input so a stall in our audio
            // path can never affect video timing.
            if (_systemAudio is not null)
            {
                var wav = await _systemAudio.StopAsync();
                _systemAudio = null;

                if (wav is not null && File.Exists(wav))
                {
                    path = await Recorder.MuxSystemAudioAsync(path, wav);
                    try { File.Delete(wav); } catch { /* best effort */ }

                    // Say so rather than silently saving without desktop audio,
                    // which looks identical to never having captured it.
                    if (Recorder.LastMuxError is { } muxError)
                        Toast("System audio could not be merged", muxError, ToastKind.Error);
                }
            }

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
            HideCameraBubble();
            CloseOverlay();
            // Restore notifications (no-op unless DND was actually engaged).
            DoNotDisturb.Disable();
            SetState(RecordingState.Idle);
            ElapsedLabel.Text = "00:00";
            _ = _stage?.StartPreviewsAsync();
        }
    }


    /// <summary>
    /// Guards the whole pause/resume transition.
    ///
    /// Ending a segment waits for ffmpeg to drain, which takes up to 15s on a
    /// slow disk. Throughout that wait the state is still Recording, so a Stop
    /// (hotkey or toolbar) would enter StopAsync against a recorder whose
    /// process has already been detached, throw "No recording is running", drop
    /// the UI to Idle -- and then the pause would finish and set it back to
    /// Paused, leaving recording chrome on screen with no ffmpeg behind it and
    /// no way out but restarting the app.
    /// </summary>
    private bool _pauseInFlight;

    /// <summary>Toggle pause/resume, guarding against re-entry mid-transition.</summary>
    private async void TogglePause()
    {
        if (_state is not (RecordingState.Recording or RecordingState.Paused)) return;
        if (_pauseInFlight) return;

        _pauseInFlight = true;
        try
        {
            if (_recorder.IsPaused)
            {
                if (!await _recorder.ResumeAsync())
                {
                    Toast("Could not resume", null, ToastKind.Error);
                    return;
                }
                // Desktop audio has to skip the same span the video does,
                // or everything after the pause plays early by its duration.
                _systemAudio?.Resume();
                SetState(RecordingState.Recording);
            }
            else
            {
                if (!await _recorder.PauseAsync())
                {
                    Toast("Could not pause", null, ToastKind.Error);
                    return;
                }
                _systemAudio?.Pause();
                SetState(RecordingState.Paused);
            }
        }
        finally
        {
            _pauseInFlight = false;
        }

        _toolbar?.SetPaused(_recorder.IsPaused);

        if (_pauseButton is not null)
        {
            ((FontIcon)_pauseButton.Content).Glyph =
                _recorder.IsPaused ? Glyphs.Play : Glyphs.Pause;
            ToolTipService.SetToolTip(_pauseButton,
                _recorder.IsPaused ? "Resume (F10)" : "Pause (F10)");
        }
    }

    private void SetState(RecordingState state)
    {
        _state = state;

        var recording = state is RecordingState.Recording or RecordingState.Paused;

        RecDot.Visibility = recording ? Visibility.Visible : Visibility.Collapsed;
        if (recording) RecPulse.Begin(); else RecPulse.Stop();

        ElapsedLabel.Visibility = recording ? Visibility.Visible : Visibility.Collapsed;

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

    // --- On-screen camera bubble --------------------------------------------

    private CameraBubbleWindow? _bubble;

    /// <summary>
    /// Show the webcam as a real desktop window the screen capture picks up.
    /// This is the default camera path for frame-rate reasons -- see
    /// <see cref="Views.CameraBubbleWindow"/> for the full rationale.
    /// </summary>
    private async void ShowCameraBubble()
    {
        if (_bubble is not null) return;

        // The stage preview holds the camera; one process cannot open it twice.
        _stage?.StopPreviews();

        _bubble = new CameraBubbleWindow(Settings);

        // Dragging or resizing the bubble is the live edit path during a take;
        // mirror it back into the preview so the two never disagree.
        _bubble.GeometryChanged += () => _stage?.SetCamera(Settings.Camera);

        _bubble.Activate();
        await _bubble.StartPreviewAsync();
    }

    private void HideCameraBubble()
    {
        if (_bubble is null) return;
        _bubble.Cleanup();
        _bubble.Close();
        _bubble = null;
    }

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

        // The toolbar replaces the main window for the duration of the take,
        // as in Electron: the control panel has no place on screen while you
        // are recording, and it would otherwise sit in the middle of whatever
        // is being demonstrated.
        AppWindow.Hide();
    }

    private void HideToolbar()
    {
        _toolbar?.Close();
        _toolbar = null;

        // Bring the control panel back; it was hidden for the take.
        AppWindow.Show();
        Win32.SetForegroundWindow(WinRT.Interop.WindowNative.GetWindowHandle(this));
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
