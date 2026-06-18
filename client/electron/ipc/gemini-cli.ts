import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseSemver, meetsMinVersion, type SemVer } from './_semver'
import { cliEnv } from './agent-plugins/paths'

const execFileAsync = promisify(execFile)

export type GeminiVersion = SemVer

/**
 * Gemini CLI 0.26+（2026-01-28）默认开启 hooks，是「会话启动自动注入用户画像」
 * 这条核心路径的最低版本要求。低于该版本只能走纯 MCP 降级路径。
 */
export const GEMINI_MIN_VERSION: GeminiVersion = { major: 0, minor: 26, patch: 0 }

// 凭证隔离:统一走 paths.ts 的白名单 cliEnv,不再 `...process.env` 全量透传——
// 主进程可能携带 ANTHROPIC_API_KEY / OAuth 令牌等敏感凭证,无控透传会让凭证
// 流向不受控的外部 gemini 进程(与 claude CLI 同一安全不变量)。

/**
 * 从 `gemini --version` 输出中解析版本号。封装 _semver，保持
 * 「调 gemini-cli.parseGeminiVersion 而不是直接 parseSemver」的语义清晰度。
 */
export function parseGeminiVersion(output: string): GeminiVersion | null {
  return parseSemver(output)
}

/** 调 `gemini --version` 并解析。执行失败或输出异常返回 null。 */
export async function detectGeminiVersion(geminiPath = 'gemini'): Promise<GeminiVersion | null> {
  try {
    const { stdout } = await execFileAsync(geminiPath, ['--version'], { timeout: 5000, env: cliEnv() })
    return parseGeminiVersion(stdout)
  } catch {
    return null
  }
}

export { meetsMinVersion }

/**
 * `gemini extensions install --path=<absolutePath>`
 *
 * Gemini CLI 安装是「拷贝目录到 ~/.gemini/extensions/」 + 写注册表。重名时
 * 不同版本表现可能不同（覆盖 / 报错），统一用 codex-cli 已验证的 dup-retry 模式：
 * 第一次失败且 stderr 含 already/exists/installed 时先 uninstall 再重试一次。
 */
export async function geminiExtensionInstall(opts: {
  geminiPath?: string
  extName: string
  stagingPath: string
}): Promise<void> {
  const geminiPath = opts.geminiPath ?? 'gemini'
  // --path=<value> 用 = 拼一起：避免被解析成两个独立 arg；同时确保是绝对路径
  const fullArgs = ['extensions', 'install', `--path=${opts.stagingPath}`]

  try {
    await execFileAsync(geminiPath, fullArgs, { timeout: 20000, env: cliEnv() })
    return
  } catch (err: any) {
    const stderr = String(err?.stderr ?? err?.message ?? '')
    const looksLikeDup = /already|exists|installed/i.test(stderr)
    if (!looksLikeDup) throw err
  }

  // 重名兜底：先 uninstall 再 install
  try {
    await execFileAsync(geminiPath, ['extensions', 'uninstall', opts.extName], { timeout: 15000, env: cliEnv() })
  } catch {
    // uninstall 失败也继续 install——极端情况交给下一次调用失败暴露
  }
  await execFileAsync(geminiPath, fullArgs, { timeout: 20000, env: cliEnv() })
}

/** `gemini extensions uninstall <name>`。不存在视为成功（与 codex mcp remove 一致）。 */
export async function geminiExtensionUninstall(opts: {
  geminiPath?: string
  extName: string
}): Promise<void> {
  const geminiPath = opts.geminiPath ?? 'gemini'
  try {
    await execFileAsync(geminiPath, ['extensions', 'uninstall', opts.extName], { timeout: 15000, env: cliEnv() })
  } catch (err: any) {
    const stderr = String(err?.stderr ?? err?.message ?? '')
    if (/not\s*found|no such|unknown/i.test(stderr)) return
    throw err
  }
}

/**
 * 查询当前已安装的 extension 名字列表。失败（CLI 不存在 / 版本过低）返回 null，
 * 调用方据此决定是否在状态显示中标注「CLI 注册表未知」。
 */
export async function geminiExtensionList(geminiPath = 'gemini'): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(geminiPath, ['extensions', 'list'], { timeout: 5000, env: cliEnv() })
    // 输出格式不稳定（不同版本可能是 table / list / json），保守做法是按行 + 包含匹配。
    // 这里只把 stdout 整体返回为一行，调用方用 includes 检测——比解析更稳。
    return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  } catch {
    return null
  }
}

/**
 * 从 SKILL.md 的 YAML frontmatter（如有）剥离正文。Gemini CLI 不需要 frontmatter，
 * 而 Claude Code 的 SKILL.md 模板可能带 frontmatter。
 */
export function stripFrontmatter(body: string): string {
  if (!body.startsWith('---')) return body
  const fmEnd = body.indexOf('---', 3)
  if (fmEnd === -1) return body
  return body.slice(fmEnd + 3).replace(/^\r?\n/, '')
}
