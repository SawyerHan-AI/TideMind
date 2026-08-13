/**
 * 统一的路径解析：
 *   - tm-node shim 脚本位置
 *   - runtime-path 标记文件位置
 *   - bundled 脚本（hook-session-start.cjs、mcp-server.cjs）位置
 *
 * 所有 plugin-generator 生成的配置里用的路径都必须走这里，避免硬编码。
 * Dev 和 packaged 两种模式下这些路径应当完全一致（除了脚本根目录）。
 */

import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'

/**
 * tm-node shim 所在目录。plugin 配置里的 command 一律指向这里的 tm-node。
 * 这是稳定的间接层——即使 Electron 版本/位置变化，plugin 配置也不需要重写。
 */
export function getShimDir(): string {
  return path.join(os.homedir(), '.tidemind', 'bin')
}

/**
 * shim 脚本本身的绝对路径。
 */
export function getShimPath(): string {
  return path.join(getShimDir(), 'tm-node')
}

/**
 * runtime-path 文件：存当前 Electron 的绝对路径（process.execPath）。
 * shim 启动时读这个文件，然后以 ELECTRON_RUN_AS_NODE=1 的方式 exec 它。
 */
export function getRuntimePathFile(): string {
  return path.join(os.homedir(), '.tidemind', 'runtime-path')
}

/**
 * bundled 脚本目录。
 * Dev 模式：client/out/bin/（electron-vite 的 out 目录）
 * Packaged 模式：.app/Contents/Resources/app.asar.unpacked/out/bin/
 *
 * 注意：packaged 模式必须走 asar.unpacked，因为外部 Agent（Claude Code / Codex）
 * 通过 /bin/sh 启动 hook 时，shell 看不到 asar 内部。asar 内部只有 Electron 自己
 * 的 node_modules 层能透明访问。
 */
export function getBinDir(): string {
  if (app.isPackaged) {
    // process.resourcesPath = .app/Contents/Resources
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'out', 'bin')
  }
  // Dev：__dirname = client/out/main/runtime/（electron-vite build 后）
  //                或 client/electron/runtime/（tsc/ts-node 直接执行时）
  // 用 app.getAppPath() 更稳妥——它在 dev 下指向 client/，在 packaged 下指向 app.asar
  return path.join(app.getAppPath(), 'out', 'bin')
}

export function getHookScriptPath(): string {
  return path.join(getBinDir(), 'hook-session-start.cjs')
}

export function getPreCompactHookScriptPath(): string {
  return path.join(getBinDir(), 'hook-pre-compact.cjs')
}

export function getPostCompactHookScriptPath(): string {
  return path.join(getBinDir(), 'hook-post-compact.cjs')
}

export function getMcpServerScriptPath(): string {
  return path.join(getBinDir(), 'mcp-server.cjs')
}

/**
 * structure-holes 计算 worker 的 .cjs 路径(v0.2.74 CRITICAL #1)。
 * 主线程用 new Worker(此路径) 起 worker_threads,把 O(E²/V) 同步 SQL 移出主线程。
 * 跟 mcp-server.cjs 一样在 out/bin/(packaged 走 asar.unpacked)。
 */
export function getStructureHolesWorkerPath(): string {
  return path.join(getBinDir(), 'structure-holes-worker.cjs')
}

export function getMetabolismWorkerPath(): string {
  return path.join(getBinDir(), 'metabolism-worker.cjs')
}

/**
 * 当前 Electron 二进制的绝对路径。
 * - Dev：指向 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
 * - Packaged：指向 /Applications/Tide Mind.app/Contents/MacOS/Tide Mind
 * shim 和自愈逻辑用这个值写入 runtime-path 文件。
 */
export function getCurrentRuntimePath(): string {
  return process.execPath
}

/**
 * Tide Mind 安装到 /Applications 时的标准可执行路径。
 * shim 的第二层 fallback 用这个——即使 runtime-path 文件没写成功，
 * 只要用户正常装了 dmg，这条兜底就有效。
 */
export function getStandardInstallPath(): string {
  return '/Applications/Tide Mind.app/Contents/MacOS/Tide Mind'
}
