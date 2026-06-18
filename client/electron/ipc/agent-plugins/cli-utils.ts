import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseCliName } from '../_schemas.js'

const execFileAsync = promisify(execFile)

export async function checkCli(cli: unknown): Promise<{ available: boolean; path?: string; version?: string }> {
  const parsedCli = parseCliName(cli)
  if (!parsedCli.ok) return { available: false }
  const validCli = parsedCli.data
  const parseVersion = (stdout: string): string | undefined => {
    const m = stdout.match(/(\d+\.\d+\.\d+)/)
    return m ? m[1] : undefined
  }
  try {
    const candidates = [validCli, `/opt/homebrew/bin/${validCli}`, `/usr/local/bin/${validCli}`]
    for (const candidate of candidates) {
      try {
        const { stdout } = await execFileAsync(candidate, ['--version'], { timeout: 5000 })
        return { available: true, path: candidate, version: parseVersion(stdout) }
      } catch { /* continue */ }
    }
    const { stdout } = await execFileAsync('which', [validCli], { timeout: 5000 })
    const cliPath = stdout.trim()
    if (!cliPath) return { available: false }
    let version: string | undefined
    try {
      const { stdout: vOut } = await execFileAsync(cliPath, ['--version'], { timeout: 5000 })
      version = parseVersion(vOut)
    } catch { /* version is optional */ }
    return { available: true, path: cliPath, version }
  } catch {
    return { available: false }
  }
}

/**
 * 解析 CLI 的绝对路径,失败返回 null。
 *
 * 为什么需要: cliEnv() (paths.ts) 出于凭证隔离把 PATH 固定为白名单(系统目录 +
 * ~/.local/bin + nvm),不含 volta/fnm/asdf/pnpm-global 等。若用这些管理器装的
 * codex/gemini 直接用裸名 + cliEnv 执行会 ENOENT。本函数走继承 PATH 的 `which`
 * 拿到绝对路径,调用方把它作为 codexPath/geminiPath 传给执行,从根本上不依赖受限
 * PATH 做命令查找(凭证隔离仍由 cliEnv 的白名单 env 保证)。
 *
 * 与 checkCli 的区别: checkCli 可能返回裸名(第一个 candidate 命中时),裸名再配
 * 受限 PATH 仍会 ENOENT;本函数只返回绝对路径(`which` 解析结果或绝对 candidate)。
 */
export async function resolveCliPath(cli: unknown): Promise<string | null> {
  const parsedCli = parseCliName(cli)
  if (!parsedCli.ok) return null
  const validCli = parsedCli.data
  // 先试 `which`(走继承 PATH,能命中任意安装位置),拿绝对路径
  try {
    const { stdout } = await execFileAsync('which', [validCli], { timeout: 5000 })
    const cliPath = stdout.trim()
    if (cliPath && cliPath.startsWith('/')) return cliPath
  } catch { /* fall through to absolute candidates */ }
  // `which` 不可用(无 PATH 继承等),退回探测两个常见绝对安装位置
  for (const candidate of [`/opt/homebrew/bin/${validCli}`, `/usr/local/bin/${validCli}`]) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 5000 })
      return candidate
    } catch { /* continue */ }
  }
  return null
}
