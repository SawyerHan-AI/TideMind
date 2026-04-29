/**
 * Semver 解析和比较工具，给各 CLI 适配器（codex-cli、gemini-cli 等）共用。
 *
 * 故意不引第三方 semver 包：我们只需要 parse/compare/meetsMinVersion 三件事，
 * 第三方包的预发布、范围匹配等能力反而是噪音；同时少一个依赖。
 */

export interface SemVer {
  major: number
  minor: number
  patch: number
}

/**
 * 从 `<cli> --version` 输出中解析三段式版本号。
 * 兼容 `gemini 0.26.1`、`codex version 0.121.4`、纯 `1.2.3` 等形式。
 * 没有匹配到 `\d+.\d+.\d+` 时返回 null。
 */
export function parseSemver(output: string): SemVer | null {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

/** a < b: -1, a == b: 0, a > b: 1 */
export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

export function meetsMinVersion(actual: SemVer | null, min: SemVer): boolean {
  if (!actual) return false
  return compareSemver(actual, min) >= 0
}
