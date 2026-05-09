import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computePluginPatchVersion } from '../../client/electron/ipc/agent-plugins/claude-code-version'

/**
 * 这些测试守护一条核心契约:
 *   plugin.json#version 必须在 hooks.json / .mcp.json / SKILL.md 任一发生
 *   变化时跟着变。否则 Claude Code 的 cache 永远停在旧目录,
 *   SessionStart 钩子读到陈旧的脚本路径——2026-05-09 实例就是这么炸的。
 */

function writePluginFiles(pluginDir: string, files: Record<string, string>) {
  fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(pluginDir, 'skills', 'tidemind'), { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(pluginDir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
}

describe('computePluginPatchVersion', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-version-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('produces a stable 1.0.<int> version string from plugin content', () => {
    writePluginFiles(tmpDir, {
      'hooks/hooks.json': '{"hooks":{}}',
      '.mcp.json': '{"mcpServers":{}}',
      'skills/tidemind/SKILL.md': '# skill',
    })
    const v1 = computePluginPatchVersion(tmpDir)
    const v2 = computePluginPatchVersion(tmpDir)
    expect(v1).toBe(v2)
    expect(v1).toMatch(/^1\.0\.\d+$/)
  })

  it('produces a different version when hooks.json content changes', () => {
    writePluginFiles(tmpDir, {
      'hooks/hooks.json': '{"hooks":{"SessionStart":[{"hooks":[{"command":"/old/path"}]}]}}',
      '.mcp.json': '{"mcpServers":{}}',
      'skills/tidemind/SKILL.md': '# skill',
    })
    const before = computePluginPatchVersion(tmpDir)

    fs.writeFileSync(
      path.join(tmpDir, 'hooks', 'hooks.json'),
      '{"hooks":{"SessionStart":[{"hooks":[{"command":"/new/path"}]}]}}',
    )
    const after = computePluginPatchVersion(tmpDir)

    expect(after).not.toBe(before)
  })

  it('produces a different version when .mcp.json changes', () => {
    writePluginFiles(tmpDir, {
      'hooks/hooks.json': '{"hooks":{}}',
      '.mcp.json': '{"mcpServers":{"a":{"command":"/old"}}}',
      'skills/tidemind/SKILL.md': '# skill',
    })
    const before = computePluginPatchVersion(tmpDir)
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '{"mcpServers":{"a":{"command":"/new"}}}')
    const after = computePluginPatchVersion(tmpDir)
    expect(after).not.toBe(before)
  })

  it('produces a different version when SKILL.md changes', () => {
    writePluginFiles(tmpDir, {
      'hooks/hooks.json': '{"hooks":{}}',
      '.mcp.json': '{"mcpServers":{}}',
      'skills/tidemind/SKILL.md': '# skill v1',
    })
    const before = computePluginPatchVersion(tmpDir)
    fs.writeFileSync(path.join(tmpDir, 'skills', 'tidemind', 'SKILL.md'), '# skill v2')
    const after = computePluginPatchVersion(tmpDir)
    expect(after).not.toBe(before)
  })

  it('does not collide between two distinct plugin contents (smoke check on 100 random pairs)', () => {
    // 不是要证明哈希函数无冲突,而是给"内容变了 version 不变"的 bug 路径
    // 设个低成本闸门:几乎所有微小内容变化都应改 patch 号。
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      writePluginFiles(tmpDir, {
        'hooks/hooks.json': `{"hooks":{"sample":${i}}}`,
        '.mcp.json': '{}',
        'skills/tidemind/SKILL.md': `# ${i}`,
      })
      seen.add(computePluginPatchVersion(tmpDir))
    }
    expect(seen.size).toBe(100)
  })

  it('falls back to a sentinel when files are missing rather than crashing', () => {
    // 空目录:三份文件都缺。函数应返回稳定的版本串(全部喂 <missing>)。
    expect(() => computePluginPatchVersion(tmpDir)).not.toThrow()
    expect(computePluginPatchVersion(tmpDir)).toMatch(/^1\.0\.\d+$/)
  })
})
