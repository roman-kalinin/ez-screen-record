#include "capture.h"

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <vector>

namespace winrt {
using namespace Windows::Foundation;
using namespace Windows::Foundation::Metadata;
using namespace Windows::Graphics;
using namespace Windows::Graphics::Capture;
using namespace Windows::Graphics::DirectX;
using namespace Windows::Graphics::DirectX::Direct3D11;
}  // namespace winrt

namespace ez {
namespace {

/**
 * The documented QI hop from a WinRT surface to the underlying D3D texture.
 * Declared by hand because the ABI header's version is awkward to use from
 * C++/WinRT.
 */
struct __declspec(uuid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")) IDirect3DDxgiInterfaceAccess
    : ::IUnknown {
  virtual HRESULT __stdcall GetInterface(GUID const& id, void** object) = 0;
};

template <typename T>
ComPtr<T> GetDXGIInterface(winrt::IInspectable const& object) {
  auto access = object.as<IDirect3DDxgiInterfaceAccess>();
  ComPtr<T> result;
  if (FAILED(access->GetInterface(__uuidof(T), reinterpret_cast<void**>(result.GetAddressOf())))) {
    return nullptr;
  }
  return result;
}

struct MonitorList {
  std::vector<HMONITOR> handles;
};

BOOL CALLBACK CollectMonitor(HMONITOR monitor, HDC, LPRECT, LPARAM param) {
  reinterpret_cast<MonitorList*>(param)->handles.push_back(monitor);
  return TRUE;
}

}  // namespace

bool IsWgcSupported() {
  try {
    return winrt::ApiInformation::IsTypePresent(
        L"Windows.Graphics.Capture.GraphicsCaptureSession");
  } catch (...) {
    return false;
  }
}

bool HasMinUpdateInterval() {
  try {
    // Shipped in Windows 11 build 26100. Without it WGC is hard-capped near
    // 60fps no matter what the display can do.
    return winrt::ApiInformation::IsPropertyPresent(
        L"Windows.Graphics.Capture.GraphicsCaptureSession", L"MinUpdateInterval");
  } catch (...) {
    return false;
  }
}

struct ScreenCapture::Impl {
  winrt::IDirect3DDevice winrtDevice{nullptr};
  winrt::GraphicsCaptureItem item{nullptr};
  winrt::Direct3D11CaptureFramePool pool{nullptr};
  winrt::GraphicsCaptureSession session{nullptr};
  winrt::Direct3D11CaptureFramePool::FrameArrived_revoker frameArrived;

  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  // The pool hands out a rotating set of surfaces and recycles them the moment
  // Close() is called, so each frame is copied into a texture we own before it
  // is published. Without this the compositor can read a surface the pool has
  // already handed back out.
  ComPtr<ID3D11Texture2D> staging;
  std::mutex contextMutex;
  uint32_t width = 0;
  uint32_t height = 0;
};

ScreenCapture::ScreenCapture() : impl_(std::make_unique<Impl>()) {}

ScreenCapture::~ScreenCapture() { Stop(); }

bool ScreenCapture::Start(ID3D11Device* device, int monitorIndex, uint32_t targetFps,
                          bool captureCursor, std::string* error) {
  auto fail = [&](const char* message) {
    if (error) *error = message;
    return false;
  };

  if (!IsWgcSupported()) {
    return fail("Windows Graphics Capture is not available on this system.");
  }

  try {
    impl_->device = device;
    device->GetImmediateContext(impl_->context.GetAddressOf());

    // Free-threaded is required here: this runs on a worker thread with no
    // DispatcherQueue and no message pump, which the non-free-threaded pool
    // demands.
    ComPtr<IDXGIDevice> dxgiDevice;
    if (FAILED(device->QueryInterface(IID_PPV_ARGS(&dxgiDevice)))) {
      return fail("The D3D11 device does not expose IDXGIDevice.");
    }

    winrt::com_ptr<::IInspectable> inspectable;
    if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), inspectable.put()))) {
      return fail("Could not create a WinRT D3D device.");
    }
    impl_->winrtDevice = inspectable.as<winrt::IDirect3DDevice>();

    MonitorList monitors;
    EnumDisplayMonitors(nullptr, nullptr, CollectMonitor,
                        reinterpret_cast<LPARAM>(&monitors));
    if (monitors.handles.empty()) return fail("No displays were found.");
    if (monitorIndex < 0 || monitorIndex >= static_cast<int>(monitors.handles.size())) {
      monitorIndex = 0;
    }
    HMONITOR target = monitors.handles[monitorIndex];

    MONITORINFO info{};
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(target, &info)) return fail("Could not read the display's bounds.");
    impl_->width = static_cast<uint32_t>(info.rcMonitor.right - info.rcMonitor.left);
    impl_->height = static_cast<uint32_t>(info.rcMonitor.bottom - info.rcMonitor.top);
    width_ = impl_->width;
    height_ = impl_->height;

    // The interop factory works on 1903+; the GraphicsCaptureItem static
    // requires 22000+, so the interop route is deliberately preferred.
    auto factory = winrt::get_activation_factory<winrt::GraphicsCaptureItem,
                                                 IGraphicsCaptureItemInterop>();
    winrt::GraphicsCaptureItem item{nullptr};
    HRESULT hr = factory->CreateForMonitor(
        target, winrt::guid_of<ABI::Windows::Graphics::Capture::IGraphicsCaptureItem>(),
        winrt::put_abi(item));
    if (FAILED(hr) || !item) {
      return fail(hr == E_ACCESSDENIED
                      ? "Screen capture was denied. Check Windows privacy settings for screen "
                        "recording."
                      : "Could not open the display for capture.");
    }
    impl_->item = item;

    D3D11_TEXTURE2D_DESC stagingDesc{};
    stagingDesc.Width = impl_->width;
    stagingDesc.Height = impl_->height;
    stagingDesc.MipLevels = 1;
    stagingDesc.ArraySize = 1;
    stagingDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    stagingDesc.SampleDesc.Count = 1;
    stagingDesc.Usage = D3D11_USAGE_DEFAULT;
    stagingDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    if (FAILED(device->CreateTexture2D(&stagingDesc, nullptr,
                                       impl_->staging.GetAddressOf()))) {
      return fail("Could not allocate the capture texture.");
    }

    impl_->pool = winrt::Direct3D11CaptureFramePool::CreateFreeThreaded(
        impl_->winrtDevice, winrt::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        // Two buffers is enough with latest-wins semantics and keeps latency
        // low; more only adds delay between a pixel changing and it landing.
        2, {static_cast<int32_t>(impl_->width), static_cast<int32_t>(impl_->height)});

    impl_->session = impl_->pool.CreateCaptureSession(impl_->item);

    try {
      impl_->session.IsCursorCaptureEnabled(captureCursor);
    } catch (...) {
      // 1903+ only; the cursor simply stays at its default otherwise.
    }

    // Hide the yellow capture border where the OS allows it. Requires both an
    // API check and user consent, so failure here is non-fatal.
    try {
      if (winrt::ApiInformation::IsPropertyPresent(
              L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired")) {
        impl_->session.IsBorderRequired(false);
      }
    } catch (...) {
    }

    if (HasMinUpdateInterval() && targetFps > 0) {
      // Two traps here, both measured by others and both silent:
      //  - anything under 1000us disables the override entirely (999us drops
      //    back to ~50fps), so the interval is clamped at 1ms;
      //  - asking for exactly 1/target undershoots badly (1/60 yields ~45fps),
      //    so the request is deliberately 1.5x faster than the target and the
      //    real cadence is enforced by the compositor's own timer.
      using namespace std::chrono;
      auto interval = duration_cast<winrt::TimeSpan>(
          duration<double>(1.0 / (static_cast<double>(targetFps) * 1.5)));
      if (interval < microseconds(1000)) interval = microseconds(1000);
      try {
        impl_->session.MinUpdateInterval(interval);
      } catch (...) {
        // Not fatal — capture still runs, just at the default cap.
      }
    }

    impl_->frameArrived = impl_->pool.FrameArrived(
        winrt::auto_revoke,
        [this](winrt::Direct3D11CaptureFramePool const& pool, winrt::IInspectable const&) {
          auto frame = pool.TryGetNextFrame();
          if (!frame) return;

          auto surface = GetDXGIInterface<ID3D11Texture2D>(frame.Surface());
          if (!surface) return;

          auto published = std::make_shared<Frame>();
          {
            // ID3D11DeviceContext is not thread-safe and the compositor uses
            // the same immediate context, so every use is serialised.
            std::lock_guard<std::mutex> lock(impl_->contextMutex);
            impl_->context->CopyResource(impl_->staging.Get(), surface.Get());
          }
          published->texture = impl_->staging;
          published->subresource = 0;
          published->width = impl_->width;
          published->height = impl_->height;
          published->timestampQpc = frame.SystemRelativeTime().count();

          slot_.Publish(std::move(published));
        });

    impl_->session.StartCapture();
    return true;
  } catch (winrt::hresult_error const& e) {
    if (error) {
      *error = e.code() == E_ACCESSDENIED
                   ? "Screen capture was denied by Windows."
                   : "Screen capture failed to start.";
    }
    return false;
  } catch (...) {
    return fail("Screen capture failed to start.");
  }
}

void ScreenCapture::Stop() {
  if (!impl_) return;
  try {
    impl_->frameArrived.revoke();
    if (impl_->session) {
      impl_->session.Close();
      impl_->session = nullptr;
    }
    if (impl_->pool) {
      impl_->pool.Close();
      impl_->pool = nullptr;
    }
  } catch (...) {
    // Teardown races with the OS recycling surfaces; nothing actionable.
  }
  impl_->item = nullptr;
  impl_->winrtDevice = nullptr;
}

}  // namespace ez
