#include <napi.h>
#include "capture.h"

namespace {

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), ez::IsWgcSupported());
}

Napi::Value HasMinUpdateInterval(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), ez::HasMinUpdateInterval());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("hasMinUpdateInterval", Napi::Function::New(env, HasMinUpdateInterval));
  return exports;
}

}  // namespace

NODE_API_MODULE(ezcapture, Init)
