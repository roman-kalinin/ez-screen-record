using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using EzScreenRecord.Models;

namespace EzScreenRecord.Capture;

public sealed class CameraCompositeOptions
{
    public string DeviceName { get; init; } = "";
    public Rect Rect { get; init; } = new();
    /// <summary>0 = square corners, 0.5 = fully round.</summary>
    public double CornerRounding { get; init; }
    public bool Mirrored { get; init; }
}

public sealed class ImageCompositeOptions
{
    public string FilePath { get; init; } = "";
    public Rect Rect { get; init; } = new();
    public double Opacity { get; init; } = 1.0;
}

/// <summary>
/// A record so pause/resume can re-launch the same take against a new segment
/// path with `with { OutputPath = ... }`.
/// </summary>
public sealed record RecordOptions
{
    public string OutputPath { get; init; } = "";
    public int Fps { get; init; } = 30;
    /// <summary>ddagrab output index.</summary>
    public int DisplayIndex { get; init; }
    /// <summary>Output height; 0 keeps the capture's native size.</summary>
    public int Height { get; init; }
    public QualityPreset Quality { get; init; } = QualityPreset.High;
    public string? MicDeviceName { get; init; }
    public CameraCompositeOptions? Camera { get; init; }
    public IReadOnlyList<ImageCompositeOptions> Images { get; init; } = [];
}

/// <summary>
/// GPU-composited capture, driven by ffmpeg. Ported from
/// src/main/native-recorder.ts, Windows branch only.
///
/// The screen, webcam and image overlays are blended by `libplacebo` -- a
/// Vulkan filter that runs on the graphics card -- and handed straight to the
/// encoder. Nothing is composited on the CPU and no pixels pass through the UI.
///
/// Measured on a 2560x1440 desktop:
///
///   Chromium/MediaRecorder  ~12 Mbps ceiling, 4:2:0 only     36.3 dB PSNR
///   ffmpeg + libplacebo     CRF 16, full 4:4:4, 30fps        46.4 dB PSNR
///
/// Chroma is the important half. 4:2:0 discards three quarters of the colour
/// resolution, which is exactly what smears coloured text on dark backgrounds,
/// and no amount of bitrate recovers it.
///
/// Why not ffmpeg's ordinary `overlay` filter: it blends on the CPU and
/// collapsed to 8.8fps at this resolution, against 29fps with no overlay.
/// libplacebo holds a full 30fps with the webcam composited.
/// </summary>
public sealed class Recorder
{
    private Process? _proc;
    private readonly StringBuilder _stderrTail = new();
    private readonly Lock _tailLock = new();

    public string OutputPath { get; private set; } = "";
    public DateTime StartedAt { get; private set; }

    public bool IsRecording => _proc is { HasExited: false };

    /// <summary>
    /// Recorded duration, excluding time spent paused — so the timer matches
    /// the finished file rather than wall-clock time since Start.
    /// </summary>
    public TimeSpan Elapsed
    {
        get
        {
            if (StartedAt == default) return TimeSpan.Zero;
            var now = IsPaused ? _pausedAt : DateTime.UtcNow;
            return now - StartedAt - _pausedTotal;
        }
    }

    /// <summary>Raised when ffmpeg exits on its own, i.e. a mid-take failure.</summary>
    public event Action<string>? Failed;

    /// <summary>CRF and chroma per preset. Lower CRF = higher quality, bigger files.</summary>
    private static (string Crf, string PixFmt, string Preset) PresetFor(QualityPreset q) => q switch
    {
        // Visually lossless for screen content.
        QualityPreset.High => ("16", "yuv444p", "veryfast"),
        // Full chroma retained -- it is what keeps text crisp -- but smaller.
        QualityPreset.Balanced => ("20", "yuv444p", "veryfast"),
        // 4:2:0 for maximum compatibility and smallest size.
        _ => ("23", "yuv420p", "veryfast"),
    };

    // Pause is implemented by splitting the take into segments, so these track
    // the pieces to concatenate on stop. A take with no pauses has exactly one.
    private readonly List<string> _segments = [];
    private string _currentSegment = "";
    private RecordOptions? _resumeOptions;

    private string NextSegmentPath() => Path.Combine(
        Path.GetDirectoryName(OutputPath)!,
        $"{Path.GetFileNameWithoutExtension(OutputPath)}.part{_segments.Count}.mp4");

    /// <summary>
    /// Bin segment and scratch files left behind by a take that never finished
    /// -- a crash or a kill mid-recording. They sit in the output folder next to
    /// real recordings, are named like them, and nothing else ever removes
    /// them. Anything still being written is skipped: the delete simply fails.
    /// </summary>
    public static void CleanOrphans(string outputDir)
    {
        if (!Directory.Exists(outputDir)) return;

        foreach (var pattern in new[] { "*.part*.mp4", "*.joined.mp4", "*.mixed.mp4" })
        {
            foreach (var path in Directory.EnumerateFiles(outputDir, pattern))
            {
                try { File.Delete(path); } catch { /* in use, or not ours */ }
            }
        }

        foreach (var path in Directory.EnumerateFiles(Path.GetTempPath(), "ez-sysaudio-*.wav"))
        {
            try { File.Delete(path); } catch { /* in use */ }
        }
    }

    public async Task StartAsync(RecordOptions opts)
    {
        if (IsRecording) throw new InvalidOperationException("A recording is already running.");
        if (!FfmpegLocator.IsAvailable)
        {
            throw new InvalidOperationException(
                "ffmpeg was not found. Install a full build (winget install Gyan.FFmpeg) " +
                "or place ffmpeg.exe in the app's ffmpeg folder.");
        }

        Directory.CreateDirectory(Path.GetDirectoryName(opts.OutputPath)!);
        OutputPath = opts.OutputPath;

        _segments.Clear();
        _resumeOptions = opts;
        _currentSegment = opts.OutputPath;

        StartedAt = DateTime.UtcNow;
        IsPaused = false;
        _pausedTotal = TimeSpan.Zero;

        await StartProcessAsync(opts);
    }

    /// <summary>
    /// Launch one ffmpeg segment. Split from StartAsync so resuming after a
    /// pause can reuse it with a different output path.
    /// </summary>
    private async Task StartProcessAsync(RecordOptions opts)
    {
        var args = BuildArguments(opts);

        var psi = new ProcessStartInfo
        {
            FileName = FfmpegLocator.FfmpegPath,
            RedirectStandardInput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in args) psi.ArgumentList.Add(arg);

        lock (_tailLock) _stderrTail.Clear();

        _proc = new Process { StartInfo = psi, EnableRaisingEvents = true };

        // Kill ffmpeg if this process dies without stopping it cleanly -- a
        // crash, a kill from a debugger, or an unhandled exception. Without
        // this the encoder keeps running unattended: one leaked process wrote
        // 9.8 GB over five hours before it was noticed.
        EnsureJobObject();
        _proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            lock (_tailLock)
            {
                _stderrTail.AppendLine(e.Data);
                // Keep only the tail; ffmpeg's stderr is a wall of banners.
                if (_stderrTail.Length > 8000) _stderrTail.Remove(0, _stderrTail.Length - 8000);
            }
        };

        _proc.Start();
        AssignToJob(_proc);
        _proc.BeginErrorReadLine();

        // Surface an immediate failure (bad device, missing filter) rather than
        // letting the caller believe recording is under way. 1.8s is what the
        // Electron version settled on: long enough for ffmpeg to open every
        // input and fail, short enough not to feel like a hang.
        using (var probe = new CancellationTokenSource(1800))
        {
            try { await _proc.WaitForExitAsync(probe.Token); }
            catch (OperationCanceledException) { /* still alive: the good case */ }
        }

        if (_proc.HasExited)
        {
            var reason = ExplainFailure(StderrTail(), _proc.ExitCode);
            _proc = null;
            StartedAt = default;
            throw new InvalidOperationException(reason);
        }

        // From here on, an exit is a mid-take failure worth reporting.
        _proc.Exited += (_, _) =>
        {
            if (_proc is { } p && p.ExitCode != 0)
                Failed?.Invoke(ExplainFailure(StderrTail(), p.ExitCode));
        };
    }

    /// <summary>
    /// Build the ffmpeg command line. Split out so it can be inspected and
    /// tested without spawning anything.
    /// </summary>
    internal static List<string> BuildArguments(RecordOptions opts)
    {
        var (crf, pixFmt, x264Preset) = PresetFor(opts.Quality);
        var useNvenc = FfmpegLocator.HasNvenc444();

        var args = new List<string> { "-y" };

        // Is there anything to GPU-composite? With no camera and no images the
        // whole libplacebo stage is dead weight: it costs a Vulkan round-trip,
        // and it is what swapped red/blue and left a black box around the
        // cursor. A plain hwdownload -> encode path is faster and visually
        // correct.
        var composites = opts.Camera is not null || opts.Images.Count > 0;

        if (composites)
        {
            args.AddRange(["-init_hw_device", "vulkan=vk", "-filter_hw_device", "vk"]);
        }

        // --- Inputs ---------------------------------------------------------
        // [0] the desktop, via Desktop Duplication (D3D11, GPU-resident).
        //
        // `framerate` is a CEILING, not a guarantee, and that is a property of
        // Desktop Duplication rather than a bug to compensate for. DDA only
        // hands over a frame when the desktop actually changes, so the true rate
        // is set by what is on screen. Measured at framerate=120 on a 165Hz
        // display, all frames unique, no drops:
        //
        //   a static text window in front   ~20 fps
        //   an animation behind other UI    ~73 fps
        //   genuinely changing full screen  120+ fps
        //
        // Do NOT "fix" this by scaling the request up (asking for 195 to get
        // 120). Over-requesting only spins the capture loop faster and burns GPU
        // time re-checking for changes that have not happened.
        args.AddRange(["-f", "lavfi", "-i",
            $"ddagrab=output_idx={opts.DisplayIndex}:framerate={opts.Fps}"]);

        var idx = 1;
        var camIdx = -1;
        if (opts.Camera is not null)
        {
            camIdx = idx++;
            // Deliberately no -framerate/-video_size: webcams support a fixed
            // set of modes and dshow fails outright ("Could not set video
            // options") when asked for one they lack. A Logitech Brio tops out
            // at 30fps while the screen may be captured at 60. Letting the
            // camera negotiate its own mode and having the filter graph
            // reconcile the rates works with any device.
            args.AddRange(["-f", "dshow", "-rtbufsize", "512M",
                "-i", $"video={opts.Camera.DeviceName}"]);
        }

        var imageIdxs = new List<int>();
        foreach (var img in opts.Images)
        {
            args.AddRange(["-i", img.FilePath]);
            imageIdxs.Add(idx++);
        }

        var micIdx = -1;
        if (!string.IsNullOrEmpty(opts.MicDeviceName))
        {
            micIdx = idx++;
            // `-audio_buffer_size 50` is worth more than it looks: dshow's
            // default buffer is large enough that each refill blocked the
            // capture path and stalled VIDEO in a regular rhythm -- recordings
            // had a ~300ms freeze roughly every half second, for their whole
            // length.
            //
            // Measured at 1440p120, same machine, same moment, mic the only
            // difference:
            //   no mic                       70fps,  10 drops,  2 stalls
            //   mic, default buffer          38fps, 194 drops, 27 stalls
            //   mic, audio_buffer_size 50    81fps,  14 drops,  2 stalls
            //
            // -thread_queue_size barely helped (27 -> 23), because the queue was
            // never the constraint; the buffer refill was.
            args.AddRange(["-f", "dshow", "-audio_buffer_size", "50", "-rtbufsize", "256M",
                "-i", $"audio={opts.MicDeviceName}"]);
        }

        // --- Filter graph ----------------------------------------------------
        // libplacebo composites at a fixed canvas size, so every layer is
        // positioned against these dimensions.
        var canvasW = opts.Height > 0 ? (int)Math.Round(opts.Height * 16.0 / 9.0) : 2560;
        var canvasH = opts.Height > 0 ? opts.Height : 1440;

        var chains = new List<string>();
        var layers = new List<string>();

        var scaleStep = opts.Height > 0 ? $",scale=-2:{opts.Height}:flags=lanczos" : "";

        // ddagrab hands over a D3D11 texture, so it must come off the GPU before
        // any CPU filter can touch it. BGRA is required exactly --
        // `hwdownload,format=rgba` errors out.
        const string download = "hwdownload,format=bgra";

        if (composites)
        {
            // libplacebo treats the downloaded channels as RGBA, which swaps red
            // and blue: the desktop came out sickly yellow-green and red UI
            // turned blue. Converting BGRA->RGBA before hwupload puts them in
            // the order libplacebo expects.
            //
            // That same step mishandles the alpha of ddagrab's composited
            // hardware cursor and leaves a black box beside it, so it is applied
            // ONLY on the libplacebo path. Screen-only takes skip it and come
            // out clean.
            chains.Add($"[0:v]{download}{scaleStep},format=rgba,hwupload[bg]");
            layers.Add("[bg]");
        }

        // Each overlay needs its OWN libplacebo instance to position it. Putting
        // pos_* on the multi-input instance would transform the base layer too.
        if (opts.Camera is not null && camIdx >= 0)
        {
            var r = opts.Camera.Rect;
            var px = (int)Math.Round(r.X * canvasW);
            var py = (int)Math.Round(r.Y * canvasH);
            var pw = (int)Math.Round(r.W * canvasW);
            var ph = (int)Math.Round(r.H * canvasH);
            var mirror = opts.Camera.Mirrored ? "hflip," : "";

            // NO `fps=` here, deliberately.
            //
            // Resampling the webcam up to the output rate looks harmless but is
            // catastrophic: it makes the camera branch the slow one, and
            // libplacebo's multi-input blend then paces the WHOLE graph off it.
            // Measured at 1440p120 with a 30fps webcam, `fps=120` on this input
            // collapsed the recording to 6.5 genuinely-unique frames per second;
            // removing it gave 65.5 -- a 10x difference, from one filter. The
            // file still reported its nominal 120fps either way, because ddagrab
            // pads the gaps with duplicate frames, which is what made this so
            // hard to see.
            chains.Add(
                $"[{camIdx}:v]{mirror}format=yuva420p,hwupload," +
                $"libplacebo@cam=w={canvasW}:h={canvasH}:fit_mode=none:" +
                $"pos_x={px}:pos_y={py}:pos_w={pw}:pos_h={ph}:" +
                $"corner_rounding={Fmt(opts.Camera.CornerRounding)}:fillcolor=black@0[cam]");
            layers.Add("[cam]");
        }

        for (var i = 0; i < opts.Images.Count; i++)
        {
            var img = opts.Images[i];
            var r = img.Rect;
            var px = (int)Math.Round(r.X * canvasW);
            var py = (int)Math.Round(r.Y * canvasH);
            var pw = (int)Math.Round(r.W * canvasW);
            var ph = (int)Math.Round(r.H * canvasH);

            // Opacity was plumbed through two layers and then ignored here, so
            // a semi-transparent overlay always recorded fully opaque.
            // colorchannelmixer scales the alpha channel.
            //
            // Guarded on the filter being present: it is skipped by
            // --disable-everything unless explicitly enabled, and emitting a
            // filter this ffmpeg lacks would fail the WHOLE take rather than
            // just ignoring the opacity. Skipped at 1.0 so the common case
            // costs nothing either way.
            var fade = img.Opacity < 1.0 && FfmpegLocator.HasFilter("colorchannelmixer")
                ? $"colorchannelmixer=aa={Fmt(Math.Clamp(img.Opacity, 0, 1))},"
                : "";

            chains.Add(
                $"[{imageIdxs[i]}:v]format=yuva420p,{fade}hwupload," +
                $"libplacebo@img{i}=w={canvasW}:h={canvasH}:fit_mode=none:" +
                $"pos_x={px}:pos_y={py}:pos_w={pw}:pos_h={ph}:fillcolor=black@0[img{i}]");
            layers.Add($"[img{i}]");
        }

        if (composites)
        {
            chains.Add(
                $"{string.Concat(layers)}libplacebo=inputs={layers.Count}:" +
                $"w={canvasW}:h={canvasH}:fit_mode=fill:format={pixFmt}[out]");
        }
        else
        {
            // Nothing to composite: straight off the GPU into the encoder. No
            // Vulkan, no rgba round-trip -- correct colours and a clean cursor.
            chains.Add($"[0:v]{download}{scaleStep},format={pixFmt}[out]");
        }

        args.AddRange(["-filter_complex", string.Join(";", chains), "-map", "[out]"]);

        // --- Encode ----------------------------------------------------------
        // Prefer NVENC. x264 at 4:4:4 needs the whole CPU at 1440p120 (measured
        // 143fps on 24 threads, 94fps on 4), and the UI competes for those same
        // threads during a take -- which is what turned 120fps recordings into
        // ~20-30 genuinely-unique frames per second. NVENC encodes on the GPU
        // and hands the CPU back. Quality is unchanged: high444p keeps full
        // 4:4:4 chroma, and CQ is the same rate-control idea as CRF.
        if (useNvenc)
        {
            args.AddRange([
                "-c:v", "h264_nvenc",
                "-profile:v", pixFmt == "yuv420p" ? "high" : "high444p",
                "-preset", "p4",
                "-tune", "hq",
                "-rc", "vbr",
                "-cq", crf,
                // No cap: CQ decides the bitrate. A maxrate here would defeat it.
                "-b:v", "0",
                "-pix_fmt", pixFmt,
                "-g", (opts.Fps * 2).ToString(),
                "-movflags", "+faststart",
            ]);
        }
        else
        {
            // No usable hardware encoder: fall back to x264, but pick a speed
            // preset this CPU can sustain. A preset that cannot keep up does not
            // degrade gracefully -- ddagrab pads the gaps with duplicate frames
            // and the take silently judders while still claiming its nominal
            // frame rate.
            args.AddRange([
                "-c:v", "libx264",
                "-preset", X264PresetFor(canvasW, canvasH, opts.Fps, x264Preset),
                "-crf", crf,
                "-pix_fmt", pixFmt,
                // Two-second GOP: keeps seeking responsive in editors.
                "-g", (opts.Fps * 2).ToString(),
                "-movflags", "+faststart",
            ]);
        }

        if (micIdx >= 0)
        {
            args.AddRange(["-map", $"{micIdx}:a", "-c:a", "aac", "-b:a", "192k"]);
        }

        args.Add(opts.OutputPath);
        return args;
    }

    /// <summary>
    /// Pick an x264 speed preset this machine can actually keep up with.
    ///
    /// Only consulted without a hardware encoder. Measured with 4 threads at
    /// yuv444p `veryfast`: 1080p60 runs 3.3x realtime, but 1440p120 falls to
    /// 0.98x -- below realtime with no headroom, which is what silently turned
    /// high frame-rate takes into duplicated frames.
    ///
    /// Dropping the preset costs compression efficiency (a slightly larger
    /// file), never chroma or resolution.
    /// </summary>
    private static string X264PresetFor(int width, int height, int fps, string basePreset)
    {
        var cores = Math.Max(1, Environment.ProcessorCount);
        // Rough throughput model, calibrated against the measurements above:
        // `veryfast` yuv444p sustains ~2.6M pixels/sec per thread at 1440p.
        var load = (double)width * height * fps / 1_000_000;
        var capacity = cores * 2.6;
        if (load > capacity * 0.9) return "ultrafast";
        if (load > capacity * 0.6) return "superfast";
        return basePreset;
    }

    /// <summary>Invariant-culture number formatting; ffmpeg will not parse "0,5".</summary>
    private static string Fmt(double value)
        => value.ToString(System.Globalization.CultureInfo.InvariantCulture);

    private string StderrTail()
    {
        lock (_tailLock) return _stderrTail.ToString();
    }

    /// <summary>
    /// Stop cleanly. `q` on stdin asks ffmpeg to finalise the container; killing
    /// the process would leave an unplayable file with no moov atom.
    ///
    /// The hard-kill fallback is generous on purpose. Every take used to end
    /// with a 275-558ms stall that swallowed the last 25-67 frames: the encoder
    /// was still draining its queue when the process was torn down. Giving
    /// ffmpeg room to flush is what makes the final second usable.
    /// </summary>
    public async Task<string> StopAsync()
    {
        if (_proc is null && !IsPaused)
            throw new InvalidOperationException("No recording is running.");

        // Paused means the current segment is already closed; there is nothing
        // running to stop, only segments to join.
        if (!IsPaused)
        {
            await StopProcessAsync();
            _segments.Add(_currentSegment);
        }

        IsPaused = false;
        StartedAt = default;

        var result = await JoinSegmentsAsync();
        _segments.Clear();
        _resumeOptions = null;
        return result;
    }

    /// <summary>
    /// End the running ffmpeg cleanly and wait for it to flush.
    ///
    /// `q` on stdin asks it to finalise the container; killing the process would
    /// leave an unplayable file with no moov atom. The hard-kill fallback is
    /// generous on purpose: every take used to end with a 275-558ms stall that
    /// swallowed the last 25-67 frames, because the encoder was still draining
    /// its queue when the process was torn down.
    /// </summary>
    private async Task<bool> StopProcessAsync()
    {
        var proc = _proc;
        if (proc is null) return false;

        // Detach first: this exit is expected, and Failed is for crashes.
        _proc = null;

        try
        {
            await proc.StandardInput.WriteAsync('q');
            await proc.StandardInput.FlushAsync();
            proc.StandardInput.Close();
        }
        catch
        {
            // Broken pipe: ffmpeg already went away.
        }

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try
        {
            await proc.WaitForExitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
        }

        return true;
    }

    /// <summary>
    /// Concatenate the take's segments into the final file.
    ///
    /// One segment is the common case (no pauses) and is already at the right
    /// path, so nothing is done. Several are joined with the concat demuxer and
    /// a stream copy: lossless, and fast enough that the user does not notice.
    /// </summary>
    private async Task<string> JoinSegmentsAsync()
    {
        LastJoinError = null;

        var parts = _segments.Where(File.Exists).ToList();
        if (parts.Count == 0) return OutputPath;

        // No pause: the single segment IS the output file.
        if (parts.Count == 1 && string.Equals(parts[0], OutputPath, StringComparison.OrdinalIgnoreCase))
            return OutputPath;

        var listFile = Path.Combine(Path.GetTempPath(), $"ez-concat-{Guid.NewGuid():N}.txt");
        var joined = Path.Combine(
            Path.GetDirectoryName(OutputPath)!,
            Path.GetFileNameWithoutExtension(OutputPath) + ".joined.mp4");

        try
        {
            // concat's list format needs single quotes doubled, not backslash
            // escapes, and forward slashes are safest on Windows paths.
            await File.WriteAllLinesAsync(listFile,
                parts.Select(p => $"file '{p.Replace("\\", "/").Replace("'", "'\\''")}'"));

            var psi = new ProcessStartInfo
            {
                FileName = FfmpegLocator.FfmpegPath,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
            };
            foreach (var a in new[]
            {
                "-y", "-hide_banner",
                "-f", "concat", "-safe", "0", "-i", listFile,
                "-c", "copy",
                // Every segment is a separate nvenc session with its own
                // SPS/PPS. MP4 keeps only the first segment's `avcC`, so
                // without this the later segments decode to nothing: the
                // container still reports the full duration, but playback
                // stops dead at the first pause. Converting to Annex B puts
                // each segment's parameter sets in-band ahead of its own
                // keyframes, and the mp4 muxer rebuilds a correct avcC.
                "-bsf:v", "h264_mp4toannexb",
                // Segment 2 starts at PTS 0 as well; without this the joined
                // timeline collapses instead of running end to end.
                "-fflags", "+genpts",
                "-movflags", "+faststart", joined,
            })
            {
                psi.ArgumentList.Add(a);
            }

            using var proc = Process.Start(psi);
            if (proc is null)
            {
                LastJoinError = "ffmpeg could not be started to join the paused segments.";
                return parts[0];
            }

            // Read stderr: leaving a redirected pipe unread deadlocks ffmpeg
            // once it fills, which is exactly how the audio mux first failed.
            var stderr = await proc.StandardError.ReadToEndAsync();
            await proc.WaitForExitAsync();

            if (proc.ExitCode != 0 || !File.Exists(joined))
            {
                // Falling back to segment 0 silently discards everything
                // recorded after the first pause while still reporting
                // "Recording saved" -- data loss the user cannot even see.
                LastJoinError = proc.ExitCode != 0
                    ? ExplainFailure(stderr, proc.ExitCode)
                    : "ffmpeg reported success but wrote no joined file.";
                return parts[0];
            }

            // Put the joined file in place BEFORE deleting the segments.
            // Segment 0 is OutputPath itself, so deleting first and moving
            // second leaves a window where a crash, a full disk or an AV
            // scanner holding the handle destroys the take outright. Move
            // first and the worst case is a leftover part file.
            File.Move(joined, OutputPath, overwrite: true);

            foreach (var part in parts)
            {
                if (string.Equals(part, OutputPath, StringComparison.OrdinalIgnoreCase)) continue;
                try { File.Delete(part); } catch { /* best effort */ }
            }

            return OutputPath;
        }
        catch (Exception ex)
        {
            // Keep the first segment rather than losing the take entirely.
            LastJoinError = ex.Message;
            return parts.Count > 0 && File.Exists(parts[0]) ? parts[0] : OutputPath;
        }
        finally
        {
            try { File.Delete(listFile); } catch { /* best effort */ }
        }
    }

    /// <summary>
    /// Why joining the paused segments failed, if it did. When this is set the
    /// saved file holds only the footage up to the first pause, and the rest is
    /// still on disk as .partN.mp4 -- the user has to be told.
    /// </summary>
    public string? LastJoinError { get; private set; }

    /// <summary>Why the last system-audio mux failed, if it did.</summary>
    public static string? LastMuxError { get; private set; }

    /// <summary>
    /// Mix a captured desktop-audio WAV into a finished recording.
    ///
    /// Video and any microphone track are stream-copied, so this is a remux
    /// rather than a re-encode: near-instant and lossless. When the file
    /// already has a mic track the two are mixed with amix; otherwise the WAV
    /// simply becomes the audio track.
    ///
    /// Returns the original path on any failure -- a recording that lacks
    /// desktop audio is far better than no recording at all.
    /// </summary>
    public static async Task<string> MuxSystemAudioAsync(string videoPath, string wavPath)
    {
        LastMuxError = null;

        var merged = Path.Combine(
            Path.GetDirectoryName(videoPath)!,
            Path.GetFileNameWithoutExtension(videoPath) + ".mixed.mp4");

        var hasMic = await HasAudioStreamAsync(videoPath);

        var args = new List<string> { "-y", "-i", videoPath, "-i", wavPath };

        if (hasMic)
        {
            // Mix mic and desktop. `dropout_transition=0` stops amix ducking
            // when one source is briefly silent, which otherwise makes speech
            // swell and fade as the desktop audio comes and goes.
            args.AddRange([
                "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[a]",
                "-map", "0:v", "-map", "[a]",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            ]);
        }
        else
        {
            args.AddRange([
                "-map", "0:v", "-map", "1:a",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            ]);
        }

        // The WAV is started before ffmpeg and stopped after it, so it always
        // runs slightly long; without this the file's duration is the audio's
        // and players show a tail of frozen last frame. The video is copied,
        // so this only ever trims the audio.
        args.AddRange(["-shortest", "-movflags", "+faststart", merged]);

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = FfmpegLocator.FfmpegPath,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);

            using var proc = Process.Start(psi);
            if (proc is null) return videoPath;

            var stderr = await proc.StandardError.ReadToEndAsync();
            await proc.WaitForExitAsync();

            if (proc.ExitCode != 0 || !File.Exists(merged))
            {
                // Keep the reason: a silent fallback to the un-mixed file is
                // indistinguishable from system audio never having been
                // captured, and that ambiguity cost a debugging round.
                LastMuxError = proc.ExitCode != 0
                    ? ExplainFailure(stderr, proc.ExitCode)
                    : "ffmpeg reported success but wrote no file.";
                return videoPath;
            }

            // Replace the original in place so the user gets one file with the
            // name they were told about. Overwrite rather than delete-then-move:
            // if the move fails after a delete, the take is gone for good.
            File.Move(merged, videoPath, overwrite: true);
            return videoPath;
        }
        catch
        {
            try { if (File.Exists(merged)) File.Delete(merged); } catch { /* best effort */ }
            return videoPath;
        }
    }

    private static async Task<bool> HasAudioStreamAsync(string path)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = FfmpegLocator.FfmpegPath,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
            };
            psi.ArgumentList.Add("-hide_banner");
            psi.ArgumentList.Add("-i");
            psi.ArgumentList.Add(path);

            using var proc = Process.Start(psi);
            if (proc is null) return false;

            var stderr = await proc.StandardError.ReadToEndAsync();
            await proc.WaitForExitAsync();
            return stderr.Contains("Audio:", StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    // --- Pause / resume -----------------------------------------------------

    private DateTime _pausedAt;
    private TimeSpan _pausedTotal;

    public bool IsPaused { get; private set; }

    /// <summary>
    /// Pause by ENDING the current segment.
    ///
    /// Suspending ffmpeg's threads was the obvious approach and produces a
    /// visibly frozen image for the pause duration: ddagrab's timestamps come
    /// from lavfi's clock, which keeps running while the process is suspended,
    /// so the gap is filled with duplicates of the last frame rather than
    /// removed. Measured, not assumed -- a paused take played back with a
    /// motionless stretch exactly as long as the pause.
    ///
    /// Closing the segment cleanly and opening a new one on resume is the only
    /// way the paused span genuinely does not exist in the output. The segments
    /// are concatenated on stop, which is a stream copy: lossless and fast.
    /// </summary>
    public async Task<bool> PauseAsync()
    {
        if (_proc is null || IsPaused || _proc.HasExited) return false;

        // Finish the segment properly so it has a moov atom and can be
        // concatenated; killing it would leave an unplayable fragment.
        var finished = await StopProcessAsync();
        if (!finished) return false;

        _segments.Add(_currentSegment);
        _pausedAt = DateTime.UtcNow;
        IsPaused = true;
        return true;
    }

    public async Task<bool> ResumeAsync()
    {
        if (!IsPaused || _resumeOptions is null) return false;

        // A new segment file; the old ones are joined on stop.
        var next = NextSegmentPath();

        try
        {
            await StartProcessAsync(_resumeOptions with { OutputPath = next });
        }
        catch
        {
            // Stay paused and leave the clock untouched. Crediting the pause
            // before knowing the restart worked meant a failed resume followed
            // by a successful one counted the same span twice, and a pause
            // longer than the footage drove Elapsed negative -- the timer then
            // rendered as "-1:-30".
            try { if (File.Exists(next)) File.Delete(next); } catch { /* best effort */ }
            return false;
        }

        _pausedTotal += DateTime.UtcNow - _pausedAt;
        IsPaused = false;
        _currentSegment = next;
        return true;
    }


    public async Task CancelAsync()
    {
        // A paused take has no process -- returning early here meant cancelling
        // while paused did nothing at all: no teardown, no cleanup, and the
        // recorder stayed IsPaused with stale segments that the next take then
        // orphaned on disk.
        if (_proc is null && !IsPaused) return;

        var file = OutputPath;
        var parts = _segments.ToList();

        try { await StopAsync(); } catch { /* best effort */ }

        foreach (var path in parts.Append(file).Append(_currentSegment).Distinct())
        {
            try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }
        }

        _segments.Clear();
        _currentSegment = "";
        _resumeOptions = null;
        IsPaused = false;
    }

    /// <summary>
    /// Turn ffmpeg's output into something a user can act on. Its stderr is a
    /// wall of version banners and stream metadata, and the one useful line is
    /// usually buried hundreds of characters in.
    /// </summary>
    internal static string ExplainFailure(string stderr, int exitCode)
    {
        if (Matches(stderr, "Could not set video options"))
            return "The webcam rejected the requested mode. It may not support this frame rate — try 30 fps, or close any other app using the camera.";

        if (Matches(stderr, "Could not set audio options") || Matches(stderr, @"Error opening input.*audio="))
            return "The microphone could not be opened. Another app may be using it exclusively.";

        if (Matches(stderr, @"I/O error") && Matches(stderr, "video="))
            return "The webcam could not be opened. It may be in use by another app.";

        if (Matches(stderr, "Device or resource busy") || Matches(stderr, "Device in use"))
            return "A capture device is already in use by another application.";

        if (Matches(stderr, "No such (file or )?device") || Matches(stderr, "Cannot find a device"))
            return "A selected device is no longer connected. Re-pick it in the menu.";

        if ((Matches(stderr, "Vulkan") || Matches(stderr, "libplacebo"))
            && Matches(stderr, @"error|failed|not (found|supported)"))
            return "GPU compositing failed to initialise. Updating your graphics driver usually fixes this.";

        if ((Matches(stderr, "ddagrab") || Matches(stderr, "Desktop Duplication"))
            && Matches(stderr, "error|failed"))
            return "Screen capture failed to start. This can happen on a locked screen or during a display change.";

        // Fall back to the last meaningful line rather than the whole banner.
        var lastLine = stderr
            .Split('\n')
            .Select(l => l.Trim())
            .LastOrDefault(l => Matches(l, "error|failed|invalid|unable"));

        return string.IsNullOrWhiteSpace(lastLine)
            ? $"Recording failed (ffmpeg exit code {exitCode})."
            : lastLine;
    }

    private static bool Matches(string haystack, string pattern)
        => System.Text.RegularExpressions.Regex.IsMatch(
            haystack, pattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    // --- Kill-on-exit job object --------------------------------------------
    //
    // A Windows job with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE terminates every
    // member when the last handle to the job closes. Since that handle dies
    // with this process, ffmpeg cannot outlive the app -- however the app ends.
    //
    // The alternative, killing the child from an exit handler, does not cover
    // a hard kill or a crash, which is exactly when a leak happens.

    private static IntPtr _job = IntPtr.Zero;

    private static void EnsureJobObject()
    {
        if (_job != IntPtr.Zero) return;

        _job = CreateJobObject(IntPtr.Zero, null);
        if (_job == IntPtr.Zero) return;

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
            {
                LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        var ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            SetInformationJobObject(_job, JobObjectExtendedLimitInformation, ptr, (uint)size);
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
    }

    private static void AssignToJob(Process process)
    {
        if (_job == IntPtr.Zero) return;
        try { AssignProcessToJobObject(_job, process.Handle); }
        catch { /* the process already exited */ }
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(
        IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
}
