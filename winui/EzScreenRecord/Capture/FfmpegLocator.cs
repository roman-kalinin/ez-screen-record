using System.Diagnostics;

namespace EzScreenRecord.Capture;

/// <summary>
/// Finding the ffmpeg binary.
///
/// A bundled copy is strongly preferred over whatever is on PATH: the recorder
/// needs ddagrab, libplacebo and nvenc, and a stock system ffmpeg (or the
/// `ffmpeg-static` npm package) ships without them. When those are missing the
/// failure surfaces at record time as an opaque filter error, so the app checks
/// for them up front instead.
/// </summary>
public static class FfmpegLocator
{
    private static string? _resolved;
    private static Dictionary<string, bool>? _features;

    /// <summary>
    /// Bundled binary if present, otherwise bare "ffmpeg" so PATH is tried.
    /// </summary>
    public static string FfmpegPath
    {
        get
        {
            if (_resolved is not null) return _resolved;

            var candidates = new[]
            {
                // Installed layout.
                Path.Combine(AppContext.BaseDirectory, "ffmpeg", "ffmpeg.exe"),
                Path.Combine(AppContext.BaseDirectory, "ffmpeg.exe"),
                // Running from the repo: share the Electron app's binary rather
                // than requiring a second 138MB copy during development.
                Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..",
                    "resources", "ffmpeg", "ffmpeg.exe"),
            };

            foreach (var candidate in candidates)
            {
                var full = Path.GetFullPath(candidate);
                if (File.Exists(full))
                {
                    _resolved = full;
                    return _resolved;
                }
            }

            _resolved = "ffmpeg";
            return _resolved;
        }
    }

    public static bool IsAvailable
    {
        get
        {
            try
            {
                return Run("-hide_banner -version").Contains("ffmpeg version");
            }
            catch
            {
                return false;
            }
        }
    }

    /// <summary>Is a filter compiled into this build?</summary>
    public static bool HasFilter(string name) => Feature($"filter:{name}", "-filters", name);

    /// <summary>Is an encoder compiled into this build?</summary>
    public static bool HasEncoder(string name) => Feature($"encoder:{name}", "-encoders", name);

    /// <summary>
    /// Does this build's NVENC advertise 4:4:4?
    ///
    /// Gated on 4:4:4 specifically because chroma is where screen-content
    /// quality is won or lost -- 4:2:0 discards three quarters of the colour
    /// resolution, which is exactly what smears coloured text on dark
    /// backgrounds. An NVENC that cannot do 4:4:4 is not an upgrade over x264
    /// for this app's "high" preset.
    /// </summary>
    public static bool HasNvenc444()
    {
        _features ??= [];
        if (_features.TryGetValue("nvenc444", out var cached)) return cached;

        var output = Run("-hide_banner -h encoder=h264_nvenc");
        var result = output.Contains("yuv444p");
        _features["nvenc444"] = result;
        return result;
    }

    private static bool Feature(string key, string listArg, string name)
    {
        _features ??= [];
        if (_features.TryGetValue(key, out var cached)) return cached;

        var output = Run($"-hide_banner {listArg}");
        // Word boundary: "h264_nvenc" must not match a search for "nvenc" in a
        // way that also matches "hevc_nvenc" when the caller wanted exactly one.
        var result = System.Text.RegularExpressions.Regex.IsMatch(
            output, $@"\b{System.Text.RegularExpressions.Regex.Escape(name)}\b");
        _features[key] = result;
        return result;
    }

    private static string Run(string args)
    {
        var psi = new ProcessStartInfo
        {
            FileName = FfmpegPath,
            Arguments = args,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var proc = Process.Start(psi);
        if (proc is null) return "";

        // ffmpeg splits its output between stdout and stderr depending on the
        // query; read both rather than guessing which one carries the answer.
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();

        if (!proc.WaitForExit(8000))
        {
            try { proc.Kill(); } catch { /* already gone */ }
        }

        return stdout + stderr;
    }
}
