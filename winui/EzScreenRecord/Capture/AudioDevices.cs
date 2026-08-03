using System.Diagnostics;
using System.Text.RegularExpressions;

namespace EzScreenRecord.Capture;

/// <summary>
/// Enumerating capture devices by their DirectShow names.
///
/// The names are read from ffmpeg itself rather than from WinRT's
/// DeviceInformation, and that is deliberate: ffmpeg addresses devices as
/// `-i audio=&lt;name&gt;`, and dshow's friendly name is not always identical to
/// the one WinRT reports. Taking the name from any other source produces an
/// "I/O error" at record time with no indication that the name was the problem.
/// </summary>
public static partial class AudioDevices
{
    private static List<string>? _microphones;
    private static List<string>? _cameras;

    public static IReadOnlyList<string> ListMicrophones() => _microphones ??= Enumerate("audio");

    public static IReadOnlyList<string> ListCameras() => _cameras ??= Enumerate("video");

    /// <summary>Drop the cache so a newly plugged device shows up.</summary>
    public static void Refresh()
    {
        _microphones = null;
        _cameras = null;
    }

    /// <summary>
    /// `ffmpeg -list_devices true -f dshow -i dummy` prints the device list to
    /// stderr and then exits with an error -- that is its documented behaviour,
    /// not a failure, so the exit code is ignored.
    /// </summary>
    private static List<string> Enumerate(string kind)
    {
        var devices = new List<string>();

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = FfmpegLocator.FfmpegPath,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add("-hide_banner");
            psi.ArgumentList.Add("-list_devices");
            psi.ArgumentList.Add("true");
            psi.ArgumentList.Add("-f");
            psi.ArgumentList.Add("dshow");
            psi.ArgumentList.Add("-i");
            psi.ArgumentList.Add("dummy");

            using var proc = Process.Start(psi);
            if (proc is null) return devices;

            var stderr = proc.StandardError.ReadToEnd();
            if (!proc.WaitForExit(8000))
            {
                try { proc.Kill(); } catch { /* already gone */ }
                return devices;
            }

            // Lines look like:
            //   [dshow @ ...] "Microphone (Realtek Audio)" (audio)
            // The trailing (audio)/(video) tag is what separates the two lists;
            // matching on the section header instead breaks when a device name
            // itself contains the word "audio".
            // De-duplicate as we go. Windows enumerates one physical device
            // several times -- through Media Foundation and DirectShow, plus
            // "Default - " and "Communications - " aliases, and sometimes with
            // a trailing hardware id. Listing all of them makes the picker
            // noisy and the entries indistinguishable.
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (Match match in DeviceLine().Matches(stderr))
            {
                if (match.Groups[2].Value != kind) continue;

                var name = match.Groups[1].Value;
                if (seen.Add(CanonicalName(name))) devices.Add(name);
            }
        }
        catch
        {
            // No ffmpeg, or it failed to start. An empty list degrades to "no
            // microphone", which is a usable state.
        }

        return devices;
    }

    [GeneratedRegex("\"([^\"]+)\"\\s+\\((audio|video)\\)")]
    private static partial Regex DeviceLine();

    /// <summary>
    /// Reduce a device name to what identifies the physical device.
    ///
    /// Strips the "Default - " / "Communications - " role prefixes and a
    /// trailing hardware id like " (046d:094c)", so the several names Windows
    /// reports for one webcam or microphone collapse to a single entry.
    /// </summary>
    private static string CanonicalName(string name)
    {
        var cleaned = RolePrefix().Replace(name, "");
        cleaned = HardwareId().Replace(cleaned, "");
        return cleaned.Trim();
    }

    [GeneratedRegex(@"^(Default|Communications)\s*-\s*", RegexOptions.IgnoreCase)]
    private static partial Regex RolePrefix();

    [GeneratedRegex(@"\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex HardwareId();
}
