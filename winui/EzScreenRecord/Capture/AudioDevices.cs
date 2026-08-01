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
            foreach (Match match in DeviceLine().Matches(stderr))
            {
                if (match.Groups[2].Value == kind)
                {
                    var name = match.Groups[1].Value;
                    if (!devices.Contains(name)) devices.Add(name);
                }
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
}
