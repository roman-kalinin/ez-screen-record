#include "encoder.h"

#include <windows.h>

#include <cstring>
#include <mutex>

#include "nvEncodeAPI.h"

namespace ez {
namespace {

/** Number of in-flight bitstream buffers. Four is ample with no B-frames. */
constexpr int kBufferCount = 4;

using NvEncodeAPICreateInstanceProc = NVENCSTATUS(NVENCAPI*)(NV_ENCODE_API_FUNCTION_LIST*);

struct NvencLibrary {
  HMODULE module = nullptr;
  NV_ENCODE_API_FUNCTION_LIST fn{};
  bool loaded = false;

  bool Load() {
    if (loaded) return true;
    // The DLL ships with the display driver; nothing NVIDIA is redistributed.
    module = LoadLibraryW(sizeof(void*) == 8 ? L"nvEncodeAPI64.dll" : L"nvEncodeAPI.dll");
    if (!module) return false;

    auto create = reinterpret_cast<NvEncodeAPICreateInstanceProc>(
        GetProcAddress(module, "NvEncodeAPICreateInstance"));
    if (!create) return false;

    fn = {};
    fn.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    if (create(&fn) != NV_ENC_SUCCESS) return false;

    loaded = true;
    return true;
  }
};

NvencLibrary& Library() {
  static NvencLibrary library;
  static std::once_flag once;
  std::call_once(once, [] { library.Load(); });
  return library;
}

}  // namespace

struct NvencEncoder::Impl {
  void* session = nullptr;
  EncoderConfig config;
  ComPtr<ID3D11Device> device;

  struct Buffer {
    NV_ENC_OUTPUT_PTR bitstream = nullptr;
  };
  Buffer buffers[kBufferCount];
  int nextBuffer = 0;

  // Registration is per-texture and must persist; only map/unmap is per frame.
  // The compositor reuses one output texture, so this stays a single entry.
  ID3D11Texture2D* registeredTexture = nullptr;
  NV_ENC_REGISTERED_PTR registeredResource = nullptr;
};

NvencEncoder::NvencEncoder() : impl_(std::make_unique<Impl>()) {}

NvencEncoder::~NvencEncoder() { Close(); }

bool NvencEncoder::IsAvailable() { return Library().Load(); }

bool NvencEncoder::Open(ID3D11Device* device, const EncoderConfig& config,
                        std::string* error) {
  auto fail = [&](const char* message) {
    if (error) *error = message;
    Close();
    return false;
  };

  auto& lib = Library();
  if (!lib.Load()) return fail("NVENC is not available (no NVIDIA driver found).");

  impl_->config = config;
  impl_->device = device;

  NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS sessionParams{};
  sessionParams.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
  sessionParams.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
  sessionParams.device = device;
  sessionParams.apiVersion = NVENCAPI_VERSION;

  if (lib.fn.nvEncOpenEncodeSessionEx(&sessionParams, &impl_->session) != NV_ENC_SUCCESS) {
    impl_->session = nullptr;
    return fail("Could not open an NVENC session. The GPU may be out of encode sessions.");
  }

  // Seed from the preset rather than hand-populating: NV_ENC_CONFIG has fields
  // that must be internally consistent, and building it by hand is the usual
  // source of NV_ENC_ERR_INVALID_PARAM.
  NV_ENC_PRESET_CONFIG presetConfig{};
  presetConfig.version = NV_ENC_PRESET_CONFIG_VER;
  presetConfig.presetCfg.version = NV_ENC_CONFIG_VER;

  const GUID codec = NV_ENC_CODEC_H264_GUID;
  // P4 balances quality against throughput; the encode is on the GPU so this
  // does not compete with the app.
  const GUID preset = NV_ENC_PRESET_P4_GUID;

  if (lib.fn.nvEncGetEncodePresetConfigEx(impl_->session, codec, preset,
                                          NV_ENC_TUNING_INFO_HIGH_QUALITY,
                                          &presetConfig) != NV_ENC_SUCCESS) {
    return fail("Could not read the NVENC preset configuration.");
  }

  NV_ENC_CONFIG encodeConfig{};
  std::memcpy(&encodeConfig, &presetConfig.presetCfg, sizeof(encodeConfig));
  encodeConfig.version = NV_ENC_CONFIG_VER;

  // Constant quality, no bitrate ceiling — a maxrate here would defeat it.
  encodeConfig.rcParams.rateControlMode = NV_ENC_PARAMS_RC_VBR;
  encodeConfig.rcParams.averageBitRate = 0;
  encodeConfig.rcParams.maxBitRate = 0;
  encodeConfig.rcParams.targetQuality = static_cast<uint8_t>(config.cq);
  // Two-second GOP keeps seeking responsive in editors.
  encodeConfig.gopLength = config.fps * 2;
  encodeConfig.frameIntervalP = 1;  // no B-frames: lowest latency

  auto& h264 = encodeConfig.encodeCodecConfig.h264Config;
  h264.idrPeriod = config.fps * 2;
  // Repeat SPS/PPS so the raw Annex-B stream is self-describing when piped to
  // the muxer, and so a mid-stream reader can sync.
  h264.repeatSPSPPS = 1;
  h264.outputAUD = 0;
  h264.sliceMode = 0;
  h264.sliceModeData = 0;

  if (config.chroma444) {
    // Without this the output is silently 4:2:0 even with the 4:4:4 profile.
    h264.chromaFormatIDC = 3;
    h264.separateColourPlaneFlag = 0;
    encodeConfig.profileGUID = NV_ENC_H264_PROFILE_HIGH_444_GUID;
  } else {
    h264.chromaFormatIDC = 1;
    encodeConfig.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
  }

  // NVENC's RGB->YUV is fixed at BT.601 limited range with no override, so the
  // stream is tagged to match. Mistagging is what produces washed-out or
  // over-saturated playback — the same class of bug as the old colour swap.
  auto& vui = h264.h264VUIParameters;
  vui.videoSignalTypePresentFlag = 1;
  vui.videoFullRangeFlag = 0;
  vui.colourDescriptionPresentFlag = 1;
  vui.colourMatrix = NV_ENC_VUI_MATRIX_COEFFS_SMPTE170M;
  vui.colourPrimaries = NV_ENC_VUI_COLOR_PRIMARIES_SMPTE170M;
  vui.transferCharacteristics = NV_ENC_VUI_TRANSFER_CHARACTERISTIC_SMPTE170M;

  NV_ENC_INITIALIZE_PARAMS initParams{};
  initParams.version = NV_ENC_INITIALIZE_PARAMS_VER;
  initParams.encodeGUID = codec;
  initParams.presetGUID = preset;
  initParams.tuningInfo = NV_ENC_TUNING_INFO_HIGH_QUALITY;
  initParams.encodeWidth = config.width;
  initParams.encodeHeight = config.height;
  initParams.darWidth = config.width;
  initParams.darHeight = config.height;
  initParams.maxEncodeWidth = config.width;
  initParams.maxEncodeHeight = config.height;
  initParams.frameRateNum = config.fps;
  initParams.frameRateDen = 1;
  // Synchronous: with no B-frames this costs one frame of latency and avoids
  // an event-driven completion thread.
  initParams.enableEncodeAsync = 0;
  initParams.enablePTD = 1;
  initParams.encodeConfig = &encodeConfig;

  if (lib.fn.nvEncInitializeEncoder(impl_->session, &initParams) != NV_ENC_SUCCESS) {
    return fail("NVENC rejected the encoder configuration.");
  }

  for (int i = 0; i < kBufferCount; ++i) {
    NV_ENC_CREATE_BITSTREAM_BUFFER createBuffer{};
    createBuffer.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
    if (lib.fn.nvEncCreateBitstreamBuffer(impl_->session, &createBuffer) != NV_ENC_SUCCESS) {
      return fail("Could not allocate NVENC output buffers.");
    }
    impl_->buffers[i].bitstream = createBuffer.bitstreamBuffer;
  }

  return true;
}

bool NvencEncoder::Encode(ID3D11Texture2D* texture, uint32_t subresource,
                          int64_t frameIndex, std::string* error) {
  auto fail = [&](const char* message) {
    if (error) *error = message;
    return false;
  };

  if (!impl_->session) return fail("The encoder is not open.");
  auto& lib = Library();

  // Register once per texture; the compositor hands us the same one each frame.
  if (impl_->registeredTexture != texture) {
    if (impl_->registeredResource) {
      lib.fn.nvEncUnregisterResource(impl_->session, impl_->registeredResource);
      impl_->registeredResource = nullptr;
    }

    NV_ENC_REGISTER_RESOURCE registerResource{};
    registerResource.version = NV_ENC_REGISTER_RESOURCE_VER;
    registerResource.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
    registerResource.resourceToRegister = texture;
    registerResource.width = impl_->config.width;
    registerResource.height = impl_->config.height;
    registerResource.pitch = 0;  // D3D11 resources carry their own pitch
    registerResource.subResourceIndex = subresource;
    // NVENC's "ARGB" is word-ordered, i.e. byte-order BGRA — exactly what both
    // WGC and the compositor produce. It converts to YUV on the GPU, so no
    // shader pass is needed.
    registerResource.bufferFormat = NV_ENC_BUFFER_FORMAT_ARGB;
    registerResource.bufferUsage = NV_ENC_INPUT_IMAGE;

    if (lib.fn.nvEncRegisterResource(impl_->session, &registerResource) != NV_ENC_SUCCESS) {
      return fail("NVENC rejected the input texture. It must belong to the same D3D11 device.");
    }
    impl_->registeredResource = registerResource.registeredResource;
    impl_->registeredTexture = texture;
  }

  NV_ENC_MAP_INPUT_RESOURCE mapped{};
  mapped.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
  mapped.registeredResource = impl_->registeredResource;
  if (lib.fn.nvEncMapInputResource(impl_->session, &mapped) != NV_ENC_SUCCESS) {
    return fail("Could not map the input texture for encoding.");
  }

  Impl::Buffer& buffer = impl_->buffers[impl_->nextBuffer];
  impl_->nextBuffer = (impl_->nextBuffer + 1) % kBufferCount;

  NV_ENC_PIC_PARAMS picParams{};
  picParams.version = NV_ENC_PIC_PARAMS_VER;
  picParams.inputBuffer = mapped.mappedResource;
  picParams.bufferFmt = mapped.mappedBufferFmt;
  picParams.inputWidth = impl_->config.width;
  picParams.inputHeight = impl_->config.height;
  picParams.outputBitstream = buffer.bitstream;
  picParams.inputTimeStamp = frameIndex;
  picParams.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;

  NVENCSTATUS status = lib.fn.nvEncEncodePicture(impl_->session, &picParams);
  // NEED_MORE_INPUT is normal pipelining, not a failure.
  const bool ready = status == NV_ENC_SUCCESS;
  if (!ready && status != NV_ENC_ERR_NEED_MORE_INPUT) {
    lib.fn.nvEncUnmapInputResource(impl_->session, mapped.mappedResource);
    return fail("NVENC failed to encode a frame.");
  }

  if (ready && onPacket_) {
    NV_ENC_LOCK_BITSTREAM lock{};
    lock.version = NV_ENC_LOCK_BITSTREAM_VER;
    lock.outputBitstream = buffer.bitstream;
    if (lib.fn.nvEncLockBitstream(impl_->session, &lock) == NV_ENC_SUCCESS) {
      onPacket_(static_cast<const uint8_t*>(lock.bitstreamBufferPtr), lock.bitstreamSizeInBytes,
                lock.pictureType == NV_ENC_PIC_TYPE_IDR ||
                    lock.pictureType == NV_ENC_PIC_TYPE_I);
      lib.fn.nvEncUnlockBitstream(impl_->session, buffer.bitstream);
    }
  }

  lib.fn.nvEncUnmapInputResource(impl_->session, mapped.mappedResource);
  return true;
}

void NvencEncoder::Flush() {
  if (!impl_->session) return;
  auto& lib = Library();

  // Signal end of stream so the encoder releases anything still in flight.
  //
  // Deliberately NOT followed by a sweep that locks every bitstream buffer.
  // This runs synchronously with enablePTD and no B-frames, so each packet is
  // already emitted inline by Encode() and no buffer holds pending output.
  // Locking one that has nothing queued blocks forever waiting for a frame
  // that will never arrive — it hung the process for the full 120-frame test
  // before this was removed.
  NV_ENC_PIC_PARAMS picParams{};
  picParams.version = NV_ENC_PIC_PARAMS_VER;
  picParams.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
  lib.fn.nvEncEncodePicture(impl_->session, &picParams);
}

void NvencEncoder::Close() {
  if (!impl_ || !impl_->session) return;
  auto& lib = Library();

  if (impl_->registeredResource) {
    lib.fn.nvEncUnregisterResource(impl_->session, impl_->registeredResource);
    impl_->registeredResource = nullptr;
    impl_->registeredTexture = nullptr;
  }
  for (auto& buffer : impl_->buffers) {
    if (buffer.bitstream) {
      lib.fn.nvEncDestroyBitstreamBuffer(impl_->session, buffer.bitstream);
      buffer.bitstream = nullptr;
    }
  }
  lib.fn.nvEncDestroyEncoder(impl_->session);
  impl_->session = nullptr;
  impl_->device.Reset();
}

}  // namespace ez
