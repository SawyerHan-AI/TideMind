// N-API binding: JS ↔ secure_store::* C++ interface.
//
// 错误约定:
//  - get(): 不存在返回 JS null,真错抛 Error
//  - set()/delete(): 真错抛 Error
//  - isAvailable(): 永远不抛,返回 bool
//  - 所有 "unavailable" (entitlement 没配) 都视作 isAvailable=false。
//    set/get/delete 在 unavailable 时**也抛 Error**,因为调用方理论上应该先
//    检查 isAvailable,不检查就硬调是 bug。

#include <napi.h>
#include "secure_store.h"

namespace {

Napi::Value IsAvailable(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto r = secure_store::IsAvailable();
  return Napi::Boolean::New(env, r.ok);
}

Napi::Value Set(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsBuffer()) {
    Napi::TypeError::New(env, "set(service: string, account: string, value: Buffer)").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string service = info[0].As<Napi::String>().Utf8Value();
  std::string account = info[1].As<Napi::String>().Utf8Value();
  Napi::Buffer<uint8_t> buf = info[2].As<Napi::Buffer<uint8_t>>();

  auto r = secure_store::Set(service, account, buf.Data(), buf.Length());
  if (!r.ok) {
    Napi::Error::New(env, r.message).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Value Get(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "get(service: string, account: string)").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string service = info[0].As<Napi::String>().Utf8Value();
  std::string account = info[1].As<Napi::String>().Utf8Value();

  std::vector<uint8_t> out;
  auto r = secure_store::Get(service, account, &out);
  if (r.not_found) return env.Null();
  if (!r.ok) {
    Napi::Error::New(env, r.message).ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Buffer<uint8_t>::Copy(env, out.data(), out.size());
}

Napi::Value Delete(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "delete(service: string, account: string)").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string service = info[0].As<Napi::String>().Utf8Value();
  std::string account = info[1].As<Napi::String>().Utf8Value();

  auto r = secure_store::Delete(service, account);
  // item 不存在视作成功(幂等 delete)。其他错抛。
  if (!r.ok && !r.not_found) {
    Napi::Error::New(env, r.message).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isAvailable", Napi::Function::New(env, IsAvailable));
  exports.Set("set",         Napi::Function::New(env, Set));
  exports.Set("get",         Napi::Function::New(env, Get));
  exports.Set("delete",      Napi::Function::New(env, Delete));
  return exports;
}

}  // namespace

NODE_API_MODULE(secure_store, Init)
