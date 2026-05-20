/**
 * macOS Data Protection Keychain 原生绑定。
 *
 * 永远不要直接 import 这个模块——走 client/electron/cloud/secure-store.ts
 * 抽象层。它处理了:
 *  - 非 macOS 平台 fallback(safeStorage + 文件)
 *  - isAvailable 检查
 *  - 错误降级语义
 */

declare module 'secure-store-mac' {
  /**
   * Probe entitlement + provisioning profile 是否到位。
   *
   * - true:  Data Protection Keychain 可用,后续 set/get/delete 不会有钥匙串弹窗
   * - false: entitlement 没配 / profile 没嵌 / 非 macOS / native binary 加载失败
   *
   * 永不抛异常。调用方必须先 check 这个再调其他方法。
   */
  export function isAvailable(): boolean;

  /**
   * 写入或更新一条 keychain item。
   *
   * 已存在时自动 update,不需要先 delete。
   * 失败抛 Error。entitlement 缺失也抛(调用方应先 check isAvailable())。
   */
  export function set(service: string, account: string, value: Buffer): void;

  /**
   * 读取。不存在返回 null。其他错抛。
   */
  export function get(service: string, account: string): Buffer | null;

  /**
   * 删除。item 不存在视作成功(幂等)。其他错抛。
   */
  function deleteItem(service: string, account: string): void;
  export { deleteItem as delete };
}
