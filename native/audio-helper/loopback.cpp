// ez-audio-loopback: capture Windows system (desktop) audio to a WAV file.
//
// Why this exists: ffmpeg on Windows has no WASAPI/loopback audio input (its
// only audio indev is dshow, which sees microphones only). The "crisp" ffmpeg
// recording engine therefore cannot capture desktop sound on its own. This
// small helper records the default render endpoint's loopback to a WAV, which
// the app muxes into the finished video afterward.
//
// Control protocol (one command per line on stdin):
//   pause   - stop appending samples without closing the file
//   resume  - continue appending to the same file
//   stop    - finalise the WAV header and exit
// The parent also just closing stdin / terminating the process is treated as
// stop: the WAV is finalised on exit either way.
//
// A single continuous WAV is produced. While paused, NOTHING is written, so the
// file stays exactly as long as the recorded spans -- this is required because
// the app's pause splits the video into segments and drops the paused span, so
// the audio has to drop the same span or everything after a pause plays early.
//
// This is original code. The WASAPI loopback sequence it uses is the standard
// Win32 Core Audio pattern documented by Microsoft (Loopback Recording); no
// third-party (e.g. GPL) source was copied.

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <mmreg.h>
#include <ksmedia.h>
#include <functiondiscoverykeys_devpkey.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

namespace {

// RAII for CoInitialize/CoUninitialize.
struct ComScope {
  bool ok = false;
  ComScope() { ok = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)); }
  ~ComScope() { if (ok) CoUninitialize(); }
};

template <class T>
void SafeRelease(T** p) {
  if (*p) { (*p)->Release(); *p = nullptr; }
}

// Minimal WAV writer. The RIFF/data sizes are back-patched on finalise, so the
// header is only valid once Finalize() has run.
//
// WASAPI hands back 32-bit float samples, but we write 16-bit PCM: the bundled
// slim ffmpeg has no pcm_f32le DECODER (it is built --disable-everything), so a
// float WAV cannot be muxed. 16-bit PCM is universally decodable, half the size,
// and the quality loss is inaudible for desktop audio. Convert on the way out.
class WavWriter {
 public:
  bool Open(const wchar_t* path, const WAVEFORMATEX* fmt) {
    file_ = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file_ == INVALID_HANDLE_VALUE) return false;

    srcFormat_ = *fmt;
    // Detect the incoming sample format: WAVE_FORMAT_EXTENSIBLE wraps a subtype.
    srcIsFloat_ = IsFloatFormat(fmt);
    srcBits_ = fmt->wBitsPerSample;
    channels_ = fmt->nChannels;
    WriteHeaderPlaceholder();
    return true;
  }

  // Takes a buffer of `frames` frames in the device's source format and writes
  // 16-bit PCM. Handles the common cases: 32-bit float and 16/32-bit int.
  void WriteFrames(const BYTE* data, uint32_t frames) {
    if (file_ == INVALID_HANDLE_VALUE || frames == 0) return;
    const uint32_t samples = frames * channels_;
    scratch_.resize(samples);

    if (srcIsFloat_ && srcBits_ == 32) {
      const float* f = reinterpret_cast<const float*>(data);
      for (uint32_t i = 0; i < samples; ++i) scratch_[i] = FloatToS16(f[i]);
    } else if (!srcIsFloat_ && srcBits_ == 16) {
      const int16_t* s = reinterpret_cast<const int16_t*>(data);
      for (uint32_t i = 0; i < samples; ++i) scratch_[i] = s[i];
    } else if (!srcIsFloat_ && srcBits_ == 32) {
      const int32_t* s = reinterpret_cast<const int32_t*>(data);
      for (uint32_t i = 0; i < samples; ++i) scratch_[i] = static_cast<int16_t>(s[i] >> 16);
    } else {
      // Unknown layout: emit silence of the right length so timing is preserved.
      for (uint32_t i = 0; i < samples; ++i) scratch_[i] = 0;
    }

    DWORD wrote = 0;
    WriteFile(file_, scratch_.data(), samples * sizeof(int16_t), &wrote, nullptr);
    data_bytes_ += wrote;
  }

  /** Write `frames` frames of silence (used for AUDCLNT_BUFFERFLAGS_SILENT). */
  void WriteSilence(uint32_t frames) {
    if (file_ == INVALID_HANDLE_VALUE || frames == 0) return;
    const uint32_t samples = frames * channels_;
    scratch_.assign(samples, 0);
    DWORD wrote = 0;
    WriteFile(file_, scratch_.data(), samples * sizeof(int16_t), &wrote, nullptr);
    data_bytes_ += wrote;
  }

  void Finalize() {
    if (file_ == INVALID_HANDLE_VALUE) return;
    // Back-patch RIFF chunk size (offset 4) and data chunk size (offset 40).
    const uint32_t dataChunkPos = 36 + 8;  // after "data" + size field
    const uint32_t riffSize = dataChunkPos + data_bytes_ - 8;
    PatchU32(4, riffSize);
    PatchU32(40, data_bytes_);
    CloseHandle(file_);
    file_ = INVALID_HANDLE_VALUE;
  }

  ~WavWriter() { Finalize(); }

 private:
  void WriteU32(uint32_t v) { DWORD w; WriteFile(file_, &v, 4, &w, nullptr); }
  void WriteU16(uint16_t v) { DWORD w; WriteFile(file_, &v, 2, &w, nullptr); }
  void WriteTag(const char* t) { DWORD w; WriteFile(file_, t, 4, &w, nullptr); }

  void PatchU32(uint32_t offset, uint32_t v) {
    LARGE_INTEGER li; li.QuadPart = offset;
    SetFilePointerEx(file_, li, nullptr, FILE_BEGIN);
    DWORD w; WriteFile(file_, &v, 4, &w, nullptr);
    li.QuadPart = 0;
    SetFilePointerEx(file_, li, nullptr, FILE_END);
  }

  void WriteHeaderPlaceholder() {
    // Canonical 44-byte 16-bit PCM WAV header. Sizes are placeholders (0) until
    // Finalize(). We ALWAYS emit 16-bit integer PCM regardless of the device's
    // native format (see the class comment on why float is unusable here).
    const uint16_t outBits = 16;
    const uint16_t blockAlign = channels_ * (outBits / 8);
    const uint32_t byteRate = srcFormat_.nSamplesPerSec * blockAlign;

    WriteTag("RIFF");
    WriteU32(0);  // riff size, patched later
    WriteTag("WAVE");

    WriteTag("fmt ");
    WriteU32(16);
    WriteU16(WAVE_FORMAT_PCM);
    WriteU16(channels_);
    WriteU32(srcFormat_.nSamplesPerSec);
    WriteU32(byteRate);
    WriteU16(blockAlign);
    WriteU16(outBits);

    WriteTag("data");
    WriteU32(0);  // data size, patched later
  }

  static bool IsFloatFormat(const WAVEFORMATEX* fmt) {
    if (fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return true;
    if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
      const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt);
      return ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    }
    return false;
  }

  static int16_t FloatToS16(float v) {
    if (v > 1.0f) v = 1.0f;
    else if (v < -1.0f) v = -1.0f;
    // -32768..32767; scale slightly under 32768 to avoid wrapping +1.0.
    return static_cast<int16_t>(v * 32767.0f);
  }

  HANDLE file_ = INVALID_HANDLE_VALUE;
  WAVEFORMATEX srcFormat_{};
  bool srcIsFloat_ = false;
  uint16_t srcBits_ = 0;
  uint16_t channels_ = 2;
  std::vector<int16_t> scratch_;
  uint32_t data_bytes_ = 0;
};

std::atomic<bool> g_paused{false};
std::atomic<bool> g_stop{false};

// Reads control commands from stdin on its own thread so the capture loop is
// never blocked waiting for input.
void StdinThread() {
  char line[256];
  while (fgets(line, sizeof(line), stdin)) {
    std::string cmd(line);
    while (!cmd.empty() && (cmd.back() == '\n' || cmd.back() == '\r')) cmd.pop_back();
    if (cmd == "pause") g_paused = true;
    else if (cmd == "resume") g_paused = false;
    else if (cmd == "stop") { g_stop = true; break; }
  }
  // stdin closed by the parent counts as stop.
  g_stop = true;
}

int Fail(const char* msg, HRESULT hr = S_OK) {
  if (hr != S_OK) fprintf(stderr, "ez-audio-loopback: %s (hr=0x%08lx)\n", msg, hr);
  else fprintf(stderr, "ez-audio-loopback: %s\n", msg);
  return 1;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return Fail("usage: ez-audio-loopback <output.wav>");
  const wchar_t* outPath = argv[1];

  ComScope com;
  if (!com.ok) return Fail("CoInitializeEx failed");

  IMMDeviceEnumerator* enumerator = nullptr;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
  if (FAILED(hr)) return Fail("CoCreateInstance(MMDeviceEnumerator)", hr);

  // Loopback taps the RENDER endpoint (what is being played), not a mic.
  IMMDevice* device = nullptr;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (FAILED(hr)) { SafeRelease(&enumerator); return Fail("no default render device", hr); }

  IAudioClient* client = nullptr;
  hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client);
  if (FAILED(hr)) { SafeRelease(&device); SafeRelease(&enumerator); return Fail("Activate(IAudioClient)", hr); }

  WAVEFORMATEX* mixFormat = nullptr;
  hr = client->GetMixFormat(&mixFormat);
  if (FAILED(hr)) return Fail("GetMixFormat", hr);

  // Event-driven shared-mode loopback. A 200ms buffer is plenty; loopback
  // ignores the requested period and follows the render engine's own timing.
  const REFERENCE_TIME bufDuration = 2000000;  // 200ms in 100ns units
  HANDLE audioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                          bufDuration, 0, mixFormat, nullptr);
  if (FAILED(hr)) return Fail("IAudioClient::Initialize", hr);
  client->SetEventHandle(audioEvent);

  IAudioCaptureClient* capture = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
  if (FAILED(hr)) return Fail("GetService(IAudioCaptureClient)", hr);

  WavWriter wav;
  if (!wav.Open(outPath, mixFormat)) return Fail("could not open output WAV");

  std::thread stdinThread(StdinThread);

  hr = client->Start();
  if (FAILED(hr)) { g_stop = true; }

  // Signal readiness so the parent knows capture is live before it starts ffmpeg.
  printf("ready\n");
  fflush(stdout);

  while (!g_stop) {
    // Wake on either a new packet or a short timeout, so pause/stop are responsive
    // even when the render endpoint goes idle.
    WaitForSingleObject(audioEvent, 100);

    UINT32 packetFrames = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&packetFrames)) && packetFrames > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;

      if (!g_paused) {
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
          // The engine hands back a silent packet (nothing playing). Write real
          // zeros so the WAV keeps advancing with wall-clock instead of skipping
          // the gap, which would pull later audio early.
          wav.WriteSilence(frames);
        } else {
          wav.WriteFrames(data, frames);
        }
      }
      // While paused we still drain the buffer (or it overflows), we just do not
      // write it -- that is what drops the paused span from the file.

      capture->ReleaseBuffer(frames);
    }
  }

  client->Stop();
  wav.Finalize();

  SafeRelease(&capture);
  if (mixFormat) CoTaskMemFree(mixFormat);
  SafeRelease(&client);
  SafeRelease(&device);
  SafeRelease(&enumerator);
  CloseHandle(audioEvent);

  if (stdinThread.joinable()) stdinThread.detach();  // it may be blocked on fgets
  return 0;
}
