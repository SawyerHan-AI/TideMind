import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface CodexVersion {
  major: number
  minor: number
  patch: number
}

/** Codex 0.121+ 提供 `codex mcp add/remove` CLI、原生 Skills 机制等 */
export const CODEX_V2_MIN_VERSION: CodexVersion = { major: 0, minor: 121, patch: 0 }

const CLI_ENV_PATH_SUFFIX = ':/opt/homebrew/bin:/usr/local/bin'

function cliEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${process.env.PATH ?? ''}${CLI_ENV_PATH_SUFFIX}` }
}

/**
 * 从 `codex --version` 输出中解析版本号。
 * 兼容 `codex 0.121.4`、`codex version 0.121.4`、`0.121.4` 等形式。
 */
export function parseCodexVersion(output: string): CodexVersion | null {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

/** a < b: -1, a == b: 0, a > b: 1 */
export function compareSemver(a: CodexVersion, b: CodexVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

export function meetsMinVersion(actual: CodexVersion | null, min: CodexVersion): boolean {
  if (!actual) return false
  return compareSemver(actual, min) >= 0
}

/** 调用 `codex --version` 并解析。执行失败或输出异常返回 null。 */
export async function detectCodexVersion(codexPath = 'codex'): Promise<CodexVersion | null> {
  try {
    const { stdout } = await execFileAsync(codexPath, ['--version'], { timeout: 5000, env: cliEnv() })
    return parseCodexVersion(stdout)
  } catch {
    return null
  }
}

/**
 * `codex mcp add <name> --env K=V ... -- <command> [args...]`
 *
 * 重名策略：第一次 add 若 stderr 含 "exists"/"already"，先 remove 再重试一次。
 * 其他错误透传。
 */
export async function codexMcpAdd(opts: {
  codexPath?: string
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>
}): Promise<void> {
  const codexPath = opts.codexPath ?? 'codex'
  const envArgs: string[] = []
  for (const [k, v] of Object.entries(opts.env)) {
    envArgs.push('--env', `${k}=${v}`)
  }
  const fullArgs = ['mcp', 'add', opts.serverName, ...envArgs, '--', opts.command, ...opts.args]

  try {
    await execFileAsync(codexPath, fullArgs, { timeout: 15000, env: cliEnv() })
    return
  } catch (err: any) {
    const stderr = String(err?.stderr ?? err?.message ?? '')
    const looksLikeDup = /already|exists|duplicate/i.test(stderr)
    if (!looksLikeDup) throw err
  }

  // 重名兜底：先 remove 再 add
  try {
    await execFileAsync(codexPath, ['mcp', 'remove', opts.serverName], { timeout: 10000, env: cliEnv() })
  } catch {
    // remove 失败也继续 add，极端情况交给下一次调用失败暴露
  }
  await execFileAsync(codexPath, fullArgs, { timeout: 15000, env: cliEnv() })
}

/** `codex mcp remove <name>`。不存在视为成功。 */
export async function codexMcpRemove(opts: {
  codexPath?: string
  serverName: string
}): Promise<void> {
  const codexPath = opts.codexPath ?? 'codex'
  try {
    await execFileAsync(codexPath, ['mcp', 'remove', opts.serverName], { timeout: 10000, env: cliEnv() })
  } catch (err: any) {
    const stderr = String(err?.stderr ?? err?.message ?? '')
    if (/not\s*found|no such|unknown/i.test(stderr)) return
    throw err
  }
}

/**
 * 生成带 YAML frontmatter 的 SKILL.md 内容。
 * body 开头已有 frontmatter 时剥离后重新包一层，避免嵌套。
 */
export function wrapSkillWithFrontmatter(body: string, name: string, description: string): string {
  let rest = body
  if (rest.startsWith('---')) {
    const fmEnd = rest.indexOf('---', 3)
    if (fmEnd !== -1) rest = rest.slice(fmEnd + 3).trimStart()
  }
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
  ].join('\n')
  return frontmatter + rest
}
