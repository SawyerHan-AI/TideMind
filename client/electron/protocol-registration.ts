/**
 * 是否向系统注册 tidemind:// 协议处理程序。
 *
 * - 界面审计模式不注册（既有行为）。
 * - 未打包的构建在 TIDEMIND_SKIP_PROTOCOL_REGISTRATION=1 时不注册，供隔离环境验收使用。
 * - 打包后的应用不读取该变量，始终注册。
 */
export function shouldRegisterProtocolHandler(options: {
  uiAudit: boolean
  packaged: boolean
  env: Record<string, string | undefined>
}): boolean {
  if (options.uiAudit) return false
  if (!options.packaged && options.env.TIDEMIND_SKIP_PROTOCOL_REGISTRATION === '1') return false
  return true
}
