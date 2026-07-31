#pragma once

#include <d3d11.h>
#include <wrl/client.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace ez {

using Microsoft::WRL::ComPtr;

struct EncoderConfig {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t fps = 60;
  /** Constant-quality target, the NVENC analogue of x264's CRF. */
  uint32_t cq = 16;
  /**
   * Keep full chroma. NVENC takes the BGRA texture directly and converts on
   * the GPU, but ONLY emits 4:4:4 when chromaFormatIDC is set to 3 — left at
   * its default the output is silently 4:2:0.
   */
  bool chroma444 = true;
};

/**
 * NVENC encoder fed straight from D3D11 textures.
 *
 * No hwdownload: the frame never leaves the GPU, which is the whole reason
 * this path exists. The encoder is deliberately driven synchronously —
 * ffmpeg does the same — because with no B-frames the latency is one frame
 * and it avoids an event-handling thread.
 */
class NvencEncoder {
 public:
  /** Called with each finished Annex-B access unit, on the encode thread. */
  using PacketCallback = std::function<void(const uint8_t* data, size_t size, bool keyframe)>;

  NvencEncoder();
  ~NvencEncoder();

  bool Open(ID3D11Device* device, const EncoderConfig& config, std::string* error);
  /** Submit one frame. `texture` must belong to the same device passed to Open. */
  bool Encode(ID3D11Texture2D* texture, uint32_t subresource, int64_t frameIndex,
              std::string* error);
  /** Drain the encoder and emit any buffered packets. */
  void Flush();
  void Close();

  void SetPacketCallback(PacketCallback cb) { onPacket_ = std::move(cb); }

  /** True when the driver exposes NVENC and it advertises 4:4:4. */
  static bool IsAvailable();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  PacketCallback onPacket_;
};

}  // namespace ez
