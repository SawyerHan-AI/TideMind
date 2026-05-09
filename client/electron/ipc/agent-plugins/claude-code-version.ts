import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Patch number derivation for Claude Code plugin.json.
 *
 * Claude Code 在 ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
 * 下按 plugin.json#version 缓存插件文件。如果 version 不变,源端 hooks.json
 * 改了路径,缓存里依旧是旧路径——SessionStart 钩子就跑错文件,
 * MODULE_VERSION 不匹配后 prepare() 抛错,context 加载失败 (2026-05-09 实例)。
 *
 * 修复:让 patch 号由实际会被 Claude Code 缓存的那几份文件的内容决定。
 * 内容一变,version 串就变,缓存目录名跟着变,Claude Code 就会重缓存。
 */

const BASE_VERSION = '1.0'

const VERSIONED_FILES = [
  'hooks/hooks.json',
  '.mcp.json',
  'skills/tidemind/SKILL.md',
] as const

/**
 * 6 hex 位 → 0..16777215。哈希空间足够大,绝不会让两个不同内容碰巧落到同一 patch。
 * 选 6 位是为了让生成的 version 字符串短而稳定,目录名肉眼可读。
 */
const PATCH_HEX_LEN = 6

/**
 * 从插件目录里 hooks.json / .mcp.json / SKILL.md 的内容算出一个稳定的
 * patch 号。文件不存在时把 `<missing>` 也喂进哈希——这样从「文件存在」到
 * 「文件被外部删除再重写」也会触发 version 变化。
 */
export function computePluginPatchVersion(pluginDir: string): string {
  const hash = createHash('sha256')
  for (const rel of VERSIONED_FILES) {
    const filePath = path.join(pluginDir, rel)
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch {
      content = '<missing>'
    }
    // rel 也喂进去:防止两个文件内容互换还能撞同一哈希(理论上不会,
    // 但既然不要钱就稳一手)。
    hash.update(rel)
    hash.update('\n')
    hash.update(content)
    hash.update('\n--\n')
  }
  const patch = parseInt(hash.digest('hex').slice(0, PATCH_HEX_LEN), 16)
  return `${BASE_VERSION}.${patch}`
}
