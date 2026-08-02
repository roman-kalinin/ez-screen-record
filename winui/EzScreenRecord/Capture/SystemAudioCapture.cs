using Windows.Media.Audio;
using Windows.Media.Capture;
using Windows.Media.MediaProperties;
using Windows.Media.Render;

namespace EzScreenRecord.Capture;

/// <summary>
/// Desktop (loopback) audio capture, written to a WAV file that ffmpeg mixes in.
///
/// ffmpeg cannot do this itself on Windows: its only audio input backend is
/// dshow, which enumerates real microphones and nothing else -- there is no
/// WASAPI input device in ffmpeg at all (verified against `configure
/// --list-indevs`, which reports only lavfi and dshow). Electron gets loopback
/// free from Chromium's `chromeMediaSource: 'desktop'`; there is no equivalent
/// to lean on here, so the app captures it and hands ffmpeg a file.
///
/// A file rather than a pipe, deliberately: a second live input would have to
/// be kept in sync with the video for the whole take, and any stall in our
/// process would stall the encode. Recording to disk and muxing at the end
/// makes the audio path unable to affect video timing at all -- the same
/// reasoning behind keeping ffmpeg out-of-process.
/// </summary>
public sealed class SystemAudioCapture : IAsyncDisposable
{
    private AudioGraph? _graph;
    private AudioFileOutputNode? _output;

    /// <summary>Where the captured audio was written, or null if not running.</summary>
    public string? OutputPath { get; private set; }

    /// <summary>Why capture is unavailable, if it is.</summary>
    public string? LastError { get; private set; }

    public bool IsCapturing => _graph is not null;

    /// <summary>
    /// Start capturing whatever the default playback device is rendering.
    /// Returns false and sets <see cref="LastError"/> on failure; a missing
    /// loopback device must never stop a recording from starting.
    /// </summary>
    public async Task<bool> StartAsync(string outputPath)
    {
        try
        {
            // Media category so Windows treats this as a capture graph rather
            // than playback, and does not duck other audio.
            var settings = new AudioGraphSettings(AudioRenderCategory.Media)
            {
                QuantumSizeSelectionMode = QuantumSizeSelectionMode.LowestLatency,
            };

            var graphResult = await AudioGraph.CreateAsync(settings);
            if (graphResult.Status != AudioGraphCreationStatus.Success)
            {
                LastError = $"Audio graph unavailable ({graphResult.Status}).";
                return false;
            }
            _graph = graphResult.Graph;

            // The loopback input: everything the default render device plays.
            var inputResult = await _graph.CreateDeviceInputNodeAsync(MediaCategory.Media);
            if (inputResult.Status != AudioDeviceNodeCreationStatus.Success)
            {
                LastError = $"Loopback capture unavailable ({inputResult.Status}).";
                await DisposeAsync();
                return false;
            }

            var profile = MediaEncodingProfile.CreateWav(AudioEncodingQuality.High);
            var file = await Windows.Storage.StorageFile.GetFileFromPathAsync(outputPath)
                .AsTask()
                .ContinueWith(t => t.IsCompletedSuccessfully ? t.Result : null)
                ?? await CreateFileAsync(outputPath);

            var outputResult = await _graph.CreateFileOutputNodeAsync(file, profile);
            if (outputResult.Status != AudioFileNodeCreationStatus.Success)
            {
                LastError = $"Could not write the audio file ({outputResult.Status}).";
                await DisposeAsync();
                return false;
            }

            _output = outputResult.FileOutputNode;
            inputResult.DeviceInputNode.AddOutgoingConnection(_output);

            _graph.Start();
            OutputPath = outputPath;
            return true;
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            await DisposeAsync();
            return false;
        }
    }

    private static async Task<Windows.Storage.StorageFile> CreateFileAsync(string path)
    {
        var folder = await Windows.Storage.StorageFolder.GetFolderFromPathAsync(
            Path.GetDirectoryName(path)!);
        return await folder.CreateFileAsync(
            Path.GetFileName(path),
            Windows.Storage.CreationCollisionOption.ReplaceExisting);
    }

    /// <summary>
    /// Stop and finalise the WAV. Must be awaited before ffmpeg reads the file:
    /// the header is only written on finalisation, so a file read too early is
    /// unusable.
    /// </summary>
    public async Task<string?> StopAsync()
    {
        if (_graph is null) return null;

        try
        {
            _graph.Stop();
            if (_output is not null) await _output.FinalizeAsync();
        }
        catch
        {
            // Already torn down; the partial file is discarded by the caller.
        }

        var path = OutputPath;
        await DisposeAsync();
        return path;
    }

    public ValueTask DisposeAsync()
    {
        try { _output?.Dispose(); } catch { /* already gone */ }
        try { _graph?.Dispose(); } catch { /* already gone */ }
        _output = null;
        _graph = null;
        return ValueTask.CompletedTask;
    }
}
