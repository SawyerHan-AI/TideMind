/**
 * 云端接口返回 401 的统一上报点。
 *
 * 客户端判断凭据是否有效原先只看本机记录的到期时间；云端主动撤销（重置密码、刷新令牌
 * 重放检测、另一处登出了同一会话）时，本机最长 1 小时感知不到。各处带令牌的请求在收到
 * 401 时调用 noteUnauthorized，由凭据模块决定是否强制刷新。
 *
 * 单独成模块是为了让调用方不依赖凭据模块的具体实现（也便于测试替身）。
 */
export type UnauthorizedResult = 'refreshed' | 'signed_out' | 'unchanged'

let handler: (() => Promise<UnauthorizedResult>) | null = null

export function setUnauthorizedHandler(next: (() => Promise<UnauthorizedResult>) | null): void {
  handler = next
}

/** 只有 401 才上报；403、5xx 不代表凭据失效。不等待结果。 */
export function noteUnauthorized(status: number): void {
  if (status !== 401 || !handler) return
  void handler().catch(() => undefined)
}

/** 需要等待结果的调用方（同步通道重连）用这个。 */
export async function reportUnauthorizedAndWait(): Promise<UnauthorizedResult> {
  if (!handler) return 'unchanged'
  try { return await handler() } catch { return 'unchanged' }
}
