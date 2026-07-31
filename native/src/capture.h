#pragma once

#include <d3d11.h>
#include <wrl/client.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace ez {

using Microsoft::WRL::ComPtr;

/**
 * A frame published by a capture source.
 *
 * Sources never touch the GPU beyond producing this texture — they publish and
 * return. The render thread is the only thread that composites, which is what
 * keeps a slow source (a 30fps webcam) from ever stalling a fast one.
 */
struct Frame {
  ComPtr<ID3D11Texture2D> texture;
  // Slice within a texture array. Media Foundation hands back the SAME texture
  // pointer every sample with a different index, so ignoring this renders
  // stale frames intermittently.
  uint32_t subresource = 0;
  int64_t timestampQpc = 0;
  uint32_t width = 0;
  uint32_t height = 0;
};

/**
 * Latest-wins slot: a producer publishes, the compositor takes whatever is
 * newest and never waits. This is the whole reason the native path holds frame
 * rate where the ffmpeg filtergraph could not — libplacebo's multi-input blend
 * BLOCKS until every input has a queued frame and pins the output clock to the
 * slowest one, so a 30fps webcam dragged 120fps captures down to ~13fps.
 *
 * shared_ptr rather than a raw swap so the compositor can hold a frame while
 * the producer is already publishing the next.
 */
class LatestSlot {
 public:
  void Publish(std::shared_ptr<Frame> frame) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      latest_ = std::move(frame);
      ++generation_;
    }
    changed_.notify_all();
  }

  std::shared_ptr<Frame> Acquire() {
    std::lock_guard<std::mutex> lock(mutex_);
    return latest_;
  }

  /**
   * Wait for a frame newer than `since`, or until the deadline passes.
   *
   * Sampling purely on a timer loses frames: when two arrive between ticks the
   * first is overwritten before it is ever encoded, which cost ~35% of the
   * frames WGC actually delivered (103.5 captured vs 66.6 unique in the file).
   * Waking on arrival instead keeps them, while the deadline still bounds the
   * wait so a static screen — where WGC delivers nothing at all — continues to
   * emit frames on cadence.
   *
   * Returns the frame, and updates `since` to the generation it came from.
   */
  std::shared_ptr<Frame> WaitForNewer(uint64_t* since,
                                      std::chrono::steady_clock::time_point deadline) {
    std::unique_lock<std::mutex> lock(mutex_);
    changed_.wait_until(lock, deadline, [&] { return generation_ != *since; });
    *since = generation_;
    return latest_;
  }

  uint64_t Generation() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return generation_;
  }

 private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::shared_ptr<Frame> latest_;
  uint64_t generation_ = 0;
};

/**
 * Windows Graphics Capture source for a single monitor.
 *
 * WGC rather than Desktop Duplication: DDA is bound to the DWM compositor rate
 * and measured only ~57 unique fps on this machine at 1440p even with the
 * display running at 165Hz. WGC works cross-GPU and, once MinUpdateInterval is
 * set, delivers at the display's real rate.
 */
class ScreenCapture {
 public:
  ScreenCapture();
  ~ScreenCapture();

  /** `monitorIndex` is an index into EnumDisplayMonitors order. */
  bool Start(ID3D11Device* device, int monitorIndex, uint32_t targetFps,
             bool captureCursor, std::string* error);
  void Stop();

  LatestSlot& Slot() { return slot_; }
  uint32_t Width() const { return width_; }
  uint32_t Height() const { return height_; }

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  LatestSlot slot_;
  std::atomic<uint32_t> width_{0};
  std::atomic<uint32_t> height_{0};
};

/** True when this OS exposes GraphicsCaptureSession.MinUpdateInterval. */
bool HasMinUpdateInterval();

/** True when Windows Graphics Capture is available at all. */
bool IsWgcSupported();

}  // namespace ez
