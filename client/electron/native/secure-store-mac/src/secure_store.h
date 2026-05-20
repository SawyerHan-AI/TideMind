// Pure C++ interface to the macOS keychain wrapper.
// binding.cc 把 N-API 调用转成这里的纯 C++ 调用,实现层(secure_store.mm)不需要
// 知道 N-API。这样 mm 文件只负责跟 Security framework 打交道,binding.cc 只负责
// JS ↔ C++ 类型转换,职责清晰。

#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace secure_store {

// 三态结果:
//  - ok=true                    成功
//  - ok=false, not_found=true   item 不存在(get/delete 的常规情况,非错误)
//  - ok=false, unavailable=true entitlement / profile 没配好(降级路径要识别)
//  - ok=false, 都为 false       真的错了
struct Result {
  bool ok = false;
  bool not_found = false;
  bool unavailable = false;
  std::string message;

  static Result Ok() { return Result{true, false, false, ""}; }
  static Result NotFound() { return Result{false, true, false, "not found"}; }
  static Result Unavailable(std::string m) { return Result{false, false, true, std::move(m)}; }
  static Result Error(std::string m) { return Result{false, false, false, std::move(m)}; }
};

Result IsAvailable();

Result Set(const std::string& service,
           const std::string& account,
           const uint8_t* data,
           size_t length);

Result Get(const std::string& service,
           const std::string& account,
           std::vector<uint8_t>* out);

Result Delete(const std::string& service, const std::string& account);

}  // namespace secure_store
