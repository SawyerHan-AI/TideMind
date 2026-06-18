/**
 * 写入 / 更新 ~/.tidemind/bin/tm-node 和 ~/.tidemind/runtime-path。
 *
 * tm-node 是一个 shell 脚本，作为 plugin 配置和真实 Node 运行时之间的稳定间接层。
 * 职责：从 runtime-path 文件读当前 Electron 路径，以 ELECTRON_RUN_AS_NODE=1 的方式
 * exec 它。多层 fallback 保证即使 Tide Mind 没启动过、被移动、被卸载，shim 也能
 * 尽力找到一个能跑的 Node。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  getShimDir,
  getShimPath,
  getRuntimePathFile,
  getCurrentRuntimePath,
  getStandardInstallPath,
} from './runtime-paths'

// ----------------------------------------------------------
// shim 脚本内容
// ----------------------------------------------------------

const SHIM_CONTENT = `#!/bin/sh
# Tide Mind tm-node shim
# 本文件由 Tide Mind 启动时自动生成，请勿手动编辑。
# 作用：为外部 Agent（Claude Code / Codex / Cursor / Windsurf / OpenClaw / Cowork）
#      提供一个稳定的 Node 运行时入口，屏蔽 Electron 路径变化和 PATH 缺失问题。

set -e

RUNTIME_PATH_FILE="$HOME/.tidemind/runtime-path"
STANDARD_INSTALL="${getStandardInstallPath()}"

# 第 1 层：读取 Tide Mind 最近一次启动时写下的 execPath
if [ -f "$RUNTIME_PATH_FILE" ]; then
  RUNTIME="$(cat "$RUNTIME_PATH_FILE" 2>/dev/null)"
  if [ -n "$RUNTIME" ] && [ -x "$RUNTIME" ]; then
    exec env ELECTRON_RUN_AS_NODE=1 "$RUNTIME" "$@"
  fi
fi

# 第 2 层：标准安装路径（/Applications/Tide Mind.app）
if [ -x "$STANDARD_INSTALL" ]; then
  exec env ELECTRON_RUN_AS_NODE=1 "$STANDARD_INSTALL" "$@"
fi

# 第 3 层：登录 shell 解析系统 node（走用户的 rc 文件）
SYS_NODE="$(/bin/zsh -lc 'command -v node' 2>/dev/null || /bin/bash -lc 'command -v node' 2>/dev/null || true)"
if [ -n "$SYS_NODE" ] && [ -x "$SYS_NODE" ]; then
  exec "$SYS_NODE" "$@"
fi

# 第 4 层：硬编码常见位置
for CAND in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$CAND" ]; then
    exec "$CAND" "$@"
  fi
done

# 第 5 层：nvm 最新版本（按文件名排序取最后一个）
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -n 1)"
  if [ -n "$LATEST_NVM" ] && [ -x "$HOME/.nvm/versions/node/$LATEST_NVM/bin/node" ]; then
    exec "$HOME/.nvm/versions/node/$LATEST_NVM/bin/node" "$@"
  fi
fi

# 全部失败
echo "[tm-node] 无法找到可用的 Node 运行时。请启动 Tide Mind 以刷新 runtime-path，或确认 /Applications/Tide Mind.app 存在。" >&2
exit 127
`

// ----------------------------------------------------------
// 公开 API
// ----------------------------------------------------------

export interface WriteShimResult {
  shimPath: string
  runtimePathFile: string
  runtimePath: string
  shimUpdated: boolean
  runtimePathUpdated: boolean
}

/**
 * 在 Electron ready 之后调用。幂等：每次都对比内容，只在需要时写。
 * 同时保证 chmod +x。
 */
export function writeShimAndRuntimePath(): WriteShimResult {
  const shimDir = getShimDir()
  const shimPath = getShimPath()
  const runtimePathFile = getRuntimePathFile()
  const runtimePath = getCurrentRuntimePath()

  fs.mkdirSync(shimDir, { recursive: true })
  fs.mkdirSync(path.dirname(runtimePathFile), { recursive: true })

  // --- shim 脚本 ---
  let shimUpdated = false
  let currentShim = ''
  if (fs.existsSync(shimPath)) {
    try { currentShim = fs.readFileSync(shimPath, 'utf-8') } catch { /* 忽略 */ }
  }
  if (currentShim !== SHIM_CONTENT) {
    fs.writeFileSync(shimPath, SHIM_CONTENT, { mode: 0o755 })
    shimUpdated = true
  }
  // writeFileSync 的 mode 选项仅在**创建新文件**时生效:对已存在文件 truncate 重写
  // 不改 mode。若 shim 此前丢了可执行位(备份工具/杀软)且本次内容又变化,只走上面
  // 的 write 分支会留下不可执行的 shim → 所有外部 Agent 的 MCP/hook EACCES。
  // 无条件 chmod 兜底:内容变与不变都确保可执行位还在(与 credentials.ts 同模式)。
  try { fs.chmodSync(shimPath, 0o755) } catch { /* 忽略 */ }

  // --- runtime-path 文件 ---
  let runtimePathUpdated = false
  let currentRuntime = ''
  if (fs.existsSync(runtimePathFile)) {
    try { currentRuntime = fs.readFileSync(runtimePathFile, 'utf-8').trim() } catch { /* 忽略 */ }
  }
  if (currentRuntime !== runtimePath) {
    fs.writeFileSync(runtimePathFile, runtimePath + '\n')
    runtimePathUpdated = true
  }

  return {
    shimPath,
    runtimePathFile,
    runtimePath,
    shimUpdated,
    runtimePathUpdated,
  }
}
