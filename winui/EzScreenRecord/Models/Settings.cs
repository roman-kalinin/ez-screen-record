using System.Text.Json;
using System.Text.Json.Serialization;

namespace EzScreenRecord.Models;

/// <summary>Normalised (0..1) rect against the output frame.</summary>
/// <remarks>
/// Fractions rather than pixels, deliberately: a layout arranged against a
/// 1080p preview then lands correctly on a 1440p capture. Every overlay
/// position in the app is stored this way.
/// </remarks>
public sealed class Rect
{
    public double X { get; set; }
    public double Y { get; set; }
    public double W { get; set; }
    public double H { get; set; }

    public Rect() { }

    public Rect(double x, double y, double w, double h)
    {
        X = x; Y = y; W = w; H = h;
    }

    public Rect Clone() => new(X, Y, W, H);
}

public enum OverlayShape { Rounded, Circle, Square }

public enum QualityPreset { High, Balanced, Compact }

public enum ResolutionPreset { Source, P2160, P1440, P1080, P720 }

public enum DrawTool { Pen, Highlighter, Arrow, Rect, Ellipse, Eraser }

public sealed class CameraOverlay
{
    public bool Enabled { get; set; } = true;
    public string? DeviceName { get; set; }

    /// <summary>
    /// Bottom-right, inset from both edges. A 16:9 camera box in normalised
    /// coords: w 0.22 against h 0.22*(16/9) ≈ 0.39 renders as a true rectangle.
    /// </summary>
    public Rect Rect { get; set; } = new(0.74, 0.55, 0.22, 0.39);

    public OverlayShape Shape { get; set; } = OverlayShape.Rounded;
    public bool Mirrored { get; set; } = true;
    public bool Shadow { get; set; } = true;

    /// <summary>
    /// Show the camera as a real, draggable window on the desktop while
    /// recording, rather than letting ffmpeg composite it internally. ON by
    /// default, and the default matters more than it looks.
    ///
    /// When off, ffmpeg's libplacebo blend is framesync'd, so the webcam's rate
    /// paces the WHOLE recording -- a 30fps camera (15fps in dim light) pulled
    /// 60fps takes down to ~21 unique fps and 120fps takes to ~13. When on, the
    /// bubble is an always-on-top window the desktop capture picks up naturally,
    /// exactly like the annotation overlay, and the screen is never held back.
    /// </summary>
    public bool ShowOnScreen { get; set; } = true;
}

public sealed class ImageOverlay
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");
    public string Name { get; set; } = "";

    /// <summary>Absolute path on disk. Unlike the Electron app this stores a
    /// path rather than a data: URL -- ffmpeg reads the file directly, so
    /// base64-inlining it only bloated settings.json.</summary>
    public string FilePath { get; set; } = "";

    public Rect Rect { get; set; } = new(0.05, 0.05, 0.2, 0.2);
    public double Opacity { get; set; } = 1.0;
    public bool Visible { get; set; } = true;
}

public sealed class DrawSettings
{
    public DrawTool Tool { get; set; } = DrawTool.Pen;
    public string Color { get; set; } = "#ff3b30";
    public double Width { get; set; } = 4;
}

public sealed class RecordingSettings
{
    public string? ScreenSourceId { get; set; }
    public string? MicDeviceName { get; set; }
    public bool MicEnabled { get; set; } = true;

    /// <summary>
    /// Capture desktop audio as well as the microphone.
    ///
    /// ffmpeg's dshow backend enumerates real microphones only and has no WASAPI
    /// loopback, so this is captured out-of-band: SystemAudioCapture records the
    /// loopback to a temp WAV during the take, which is muxed into the output
    /// afterward (see MainWindow.Recording.cs and Recorder.MuxSystemAudioAsync).
    /// </summary>
    public bool SystemAudioEnabled { get; set; }
    public int Fps { get; set; } = 30;
    public ResolutionPreset Resolution { get; set; } = ResolutionPreset.Source;
    public int CountdownSeconds { get; set; } = 3;
    public QualityPreset Quality { get; set; } = QualityPreset.High;
    public string? OutputDir { get; set; }

    /// <summary>
    /// Keep the recording toolbar out of the video. On by default -- the
    /// recorder's own chrome has no place in a tutorial.
    ///
    /// A setting rather than always-on because Windows applies display affinity
    /// to EVERY capture, so the toolbar also vanishes from a Zoom/Teams share
    /// while recording.
    /// </summary>
    public bool HideToolbarFromCapture { get; set; } = true;
}

public sealed class AppSettings
{
    public RecordingSettings Recording { get; set; } = new();
    public CameraOverlay Camera { get; set; } = new();
    public List<ImageOverlay> Images { get; set; } = [];
    public DrawSettings Draw { get; set; } = new();

    // --- Persistence --------------------------------------------------------

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string SettingsDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Ez Screen Record");

    private static string SettingsPath => Path.Combine(SettingsDirectory, "settings.json");

    public static string DefaultOutputDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyVideos),
        "Ez Screen Record");

    public static AppSettings Load()
    {
        if (!File.Exists(SettingsPath)) return new AppSettings();

        string json;
        try { json = File.ReadAllText(SettingsPath); }
        catch { return new AppSettings(); }

        try
        {
            return JsonSerializer.Deserialize<AppSettings>(json, JsonOptions) ?? new AppSettings();
        }
        catch (JsonException)
        {
            // One unparseable value used to discard the entire file: camera
            // position, mic choice, source, everything, silently back to
            // defaults. This file is shared with the Electron build, so a
            // single enum member one version knows and the other does not was
            // enough to trigger it.
            //
            // Retry section by section instead, so a bad value costs only the
            // section it is in.
            return LoadPerSection(json);
        }
        catch
        {
            return new AppSettings();
        }
    }

    /// <summary>
    /// Salvage what parses when the file as a whole does not. Each section is
    /// deserialised on its own and falls back to its defaults independently.
    /// </summary>
    private static AppSettings LoadPerSection(string json)
    {
        var result = new AppSettings();

        JsonElement root;
        try { root = JsonDocument.Parse(json).RootElement; }
        catch { return result; }

        if (root.ValueKind != JsonValueKind.Object) return result;

        static T? Section<T>(JsonElement root, string name) where T : class
        {
            if (!root.TryGetProperty(name, out var element)) return null;
            try { return element.Deserialize<T>(JsonOptions); }
            catch { return null; }
        }

        result.Recording = Section<RecordingSettings>(root, "recording") ?? result.Recording;
        result.Camera = Section<CameraOverlay>(root, "camera") ?? result.Camera;
        result.Draw = Section<DrawSettings>(root, "draw") ?? result.Draw;
        result.Images = Section<List<ImageOverlay>>(root, "images") ?? result.Images;

        return result;
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(SettingsDirectory);

            // Write to a temp file then move: the move is atomic, so an
            // interrupted save can never leave a half-written settings.json that
            // fails to parse and silently resets the user's layout.
            var tmp = SettingsPath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(this, JsonOptions));
            File.Move(tmp, SettingsPath, overwrite: true);
        }
        catch
        {
            // Saving runs on every settings change; a failure here is not worth
            // taking the app down for.
        }
    }

    /// <summary>Output height in pixels, or 0 to keep the capture's native size.</summary>
    /// <remarks>
    /// Derived from <see cref="RecordingSettings.Resolution"/>, so it must not
    /// be persisted: a stale copy in settings.json would silently win over the
    /// preset the user actually picked.
    /// </remarks>
    [JsonIgnore]
    public int ResolutionHeight => Recording.Resolution switch
    {
        ResolutionPreset.P2160 => 2160,
        ResolutionPreset.P1440 => 1440,
        ResolutionPreset.P1080 => 1080,
        ResolutionPreset.P720 => 720,
        _ => 0,
    };
}
