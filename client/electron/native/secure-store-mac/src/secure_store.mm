// Tide Mind — Data Protection Keychain wrapper
//
// 设计意图(对应 docs/design/keychain-prompt-elimination-2026-05-20.md):
//
// 1. **必须用 modern SecItem* API + kSecUseDataProtectionKeychain: YES。**
//    Electron 的 safeStorage 用 legacy SecKeychain* API → ACL + Designated
//    Requirement,任何 binary 变化都触发"允许/始终允许"弹窗。
//    Data Protection Keychain 按 Team ID + access group 控权,无弹窗。
//
// 2. **不显式传 kSecAttrAccessGroup。** 当 embedded.provisionprofile + entitlement
//    里只有一个 keychain-access-group 时,OS 默认用它,代码不需要知道 Team ID。
//    省去 SecCodeCopySigningInformation 那一套。
//
// 3. **kSecAttrAccessible 选 AfterFirstUnlock**,不是 WhenUnlocked。
//    登录后 keychain 解锁状态对所有 session 可见,适合后台 sync。
//    WhenUnlocked 在屏幕锁定时拿不到,会让我们的后台刷 token 失败。
//
// 4. 任何 SecItem* 调用都必须显式带 kSecUseDataProtectionKeychain,**包括 read**。
//    不带的话 OS 会回到 file-based 路径,弹窗复活。

#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include "secure_store.h"
#include <string>

namespace secure_store {

// 构造 base query dict(class + service + account + access flag)。
// 调用方再按需补 kSecValueData / kSecReturnData。
//
// 失败返回 nil:仅当 service/account 含非 UTF-8 字节时(audit-1 MEDIUM 防御)。
// 当前调用方都传常量,不会触发,但留 defense in depth——未来如果 service/account
// 变成用户输入,nil NSString 进 @{} 字面量会抛 NSInvalidArgumentException
// 在 C++ exceptions disabled 下崩 Electron 主进程。
static NSMutableDictionary* MakeQuery(const std::string& service,
                                      const std::string& account) {
  NSString* nsService = [NSString stringWithUTF8String:service.c_str()];
  NSString* nsAccount = [NSString stringWithUTF8String:account.c_str()];
  if (nsService == nil || nsAccount == nil) return nil;
  return [@{
    (id)kSecClass:                     (id)kSecClassGenericPassword,
    (id)kSecAttrService:               nsService,
    (id)kSecAttrAccount:               nsAccount,
    (id)kSecUseDataProtectionKeychain: @YES,
  } mutableCopy];
}

Result IsAvailable() {
  // 通过一次空查询探测 entitlement 是否生效:
  //  - errSecSuccess / errSecItemNotFound → entitlement OK,Data Protection Keychain 可用
  //  - errSecMissingEntitlement (-34018) → entitlement / profile 没配好,降级
  //  - 其他错误 → 异常状态,降级保守
  NSMutableDictionary* query = MakeQuery("__tidemind_probe__", "__tidemind_probe__");
  if (query == nil) return Result::Unavailable("MakeQuery returned nil (unreachable for constants)");
  query[(id)kSecMatchLimit] = (id)kSecMatchLimitOne;
  query[(id)kSecReturnData] = @NO;
  CFTypeRef ignored = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &ignored);
  if (ignored) CFRelease(ignored);

  if (status == errSecSuccess || status == errSecItemNotFound) {
    return Result::Ok();
  }
  if (status == errSecMissingEntitlement) {
    return Result::Unavailable("missing keychain-access-groups entitlement (profile not embedded?)");
  }
  return Result::Unavailable("SecItemCopyMatching probe failed: OSStatus " + std::to_string(status));
}

Result Set(const std::string& service,
           const std::string& account,
           const uint8_t* data,
           size_t length) {
  NSData* nsData = [NSData dataWithBytes:data length:length];

  // 先尝试 add。已存在时(errSecDuplicateItem)走 update,避免 add+delete 的双调用浪费。
  NSMutableDictionary* addAttrs = MakeQuery(service, account);
  if (addAttrs == nil) return Result::Error("invalid utf-8 in service/account");
  addAttrs[(id)kSecValueData] = nsData;
  addAttrs[(id)kSecAttrAccessible] = (id)kSecAttrAccessibleAfterFirstUnlock;

  OSStatus status = SecItemAdd((__bridge CFDictionaryRef)addAttrs, NULL);
  if (status == errSecSuccess) return Result::Ok();

  if (status == errSecDuplicateItem) {
    // 已存在,改成 update。query 用 service+account 定位,attrs 只设新值
    NSMutableDictionary* query = MakeQuery(service, account);
    if (query == nil) return Result::Error("invalid utf-8 in service/account");
    NSDictionary* updateAttrs = @{
      (id)kSecValueData: nsData,
      (id)kSecAttrAccessible: (id)kSecAttrAccessibleAfterFirstUnlock,
    };
    status = SecItemUpdate((__bridge CFDictionaryRef)query,
                          (__bridge CFDictionaryRef)updateAttrs);
    if (status == errSecSuccess) return Result::Ok();
  }

  if (status == errSecMissingEntitlement) {
    return Result::Unavailable("missing keychain-access-groups entitlement");
  }
  return Result::Error("SecItem set failed: OSStatus " + std::to_string(status));
}

Result Get(const std::string& service,
           const std::string& account,
           std::vector<uint8_t>* out) {
  NSMutableDictionary* query = MakeQuery(service, account);
  if (query == nil) return Result::Error("invalid utf-8 in service/account");
  query[(id)kSecMatchLimit] = (id)kSecMatchLimitOne;
  query[(id)kSecReturnData] = @YES;

  CFTypeRef resultRef = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &resultRef);

  if (status == errSecItemNotFound) {
    // 调用方据此判 null
    if (resultRef) CFRelease(resultRef);
    return Result::NotFound();
  }
  if (status == errSecMissingEntitlement) {
    if (resultRef) CFRelease(resultRef);
    return Result::Unavailable("missing keychain-access-groups entitlement");
  }
  if (status != errSecSuccess) {
    if (resultRef) CFRelease(resultRef);
    return Result::Error("SecItemCopyMatching failed: OSStatus " + std::to_string(status));
  }

  // resultRef 是 CFData(因为 kSecReturnData=YES)。__bridge_transfer 把所有权交给 ARC
  NSData* data = (__bridge_transfer NSData*)resultRef;
  if (!data) return Result::Error("SecItemCopyMatching returned null data");

  const uint8_t* bytes = (const uint8_t*)data.bytes;
  out->assign(bytes, bytes + data.length);
  return Result::Ok();
}

Result Delete(const std::string& service, const std::string& account) {
  NSMutableDictionary* query = MakeQuery(service, account);
  if (query == nil) return Result::Error("invalid utf-8 in service/account");
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);

  if (status == errSecSuccess || status == errSecItemNotFound) {
    return Result::Ok();
  }
  if (status == errSecMissingEntitlement) {
    return Result::Unavailable("missing keychain-access-groups entitlement");
  }
  return Result::Error("SecItemDelete failed: OSStatus " + std::to_string(status));
}

}  // namespace secure_store
