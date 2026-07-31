#include <napi.h>

#include <d3d11.h>
#include <wrl/client.h>

#include <fstream>
#include <string>
#include <vector>

#include "capture.h"
#include "encoder.h"

using Microsoft::WRL::ComPtr;

namespace {

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), ez::IsWgcSupported());
}

Napi::Value HasMinUpdateInterval(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), ez::HasMinUpdateInterval());
}

Napi::Value HasNvenc(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), ez::NvencEncoder::IsAvailable());
}

/**
 * Encode a solid-colour test pattern straight from a D3D11 texture.
 * Proves the NVENC session opens, accepts BGRA and emits 4:4:4 Annex-B before
 * any of the capture/composite machinery is wired up.
 */
Napi::Value SelfTest(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string outPath = info[0].As<Napi::String>().Utf8Value();
  const uint32_t frames = info.Length() > 1 ? info[1].As<Napi::Number>().Uint32Value() : 60;

  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  D3D_FEATURE_LEVEL level;
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                 D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                 D3D11_SDK_VERSION, &device, &level, &context);
  if (FAILED(hr)) {
    Napi::Error::New(env, "D3D11CreateDevice failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const uint32_t w = 2560, h = 1440;
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = w; desc.Height = h; desc.MipLevels = 1; desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  ComPtr<ID3D11Texture2D> tex;
  if (FAILED(device->CreateTexture2D(&desc, nullptr, &tex))) {
    Napi::Error::New(env, "CreateTexture2D failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  ComPtr<ID3D11RenderTargetView> rtv;
  device->CreateRenderTargetView(tex.Get(), nullptr, &rtv);

  ez::EncoderConfig cfg;
  cfg.width = w; cfg.height = h; cfg.fps = 120; cfg.cq = 16; cfg.chroma444 = true;

  ez::NvencEncoder enc;
  std::string err;
  if (!enc.Open(device.Get(), cfg, &err)) {
    Napi::Error::New(env, err).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::ofstream out(outPath, std::ios::binary);
  size_t total = 0;
  enc.SetPacketCallback([&](const uint8_t* d, size_t n, bool) {
    out.write(reinterpret_cast<const char*>(d), n);
    total += n;
  });

  for (uint32_t i = 0; i < frames; ++i) {
    // A moving gradient so every frame differs; mpdecimate must see them all.
    const float t = static_cast<float>(i) / frames;
    const FLOAT color[4] = {0.15f + 0.5f * t, 0.35f, 0.75f - 0.4f * t, 1.0f};
    context->ClearRenderTargetView(rtv.Get(), color);
    context->Flush();
    if (!enc.Encode(tex.Get(), 0, i, &err)) {
      Napi::Error::New(env, err).ThrowAsJavaScriptException();
      return env.Undefined();
    }
  }
  enc.Flush();
  enc.Close();
  out.close();

  return Napi::Number::New(env, static_cast<double>(total));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("hasMinUpdateInterval", Napi::Function::New(env, HasMinUpdateInterval));
  exports.Set("hasNvenc", Napi::Function::New(env, HasNvenc));
  exports.Set("selfTest", Napi::Function::New(env, SelfTest));
  return exports;
}

}  // namespace

NODE_API_MODULE(ezcapture, Init)
