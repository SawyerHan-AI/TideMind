import path from 'node:path'

/**
 * Electron 只能从 app.asar.unpacked 加载原生扩展。只替换完整的 app.asar
 * 路径段，避免把已经 unpacked 的 production Worker 路径再次改写。
 */
export function resolveSqliteVecLoadablePath(loadablePath: string): string {
  return loadablePath.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  )
}
