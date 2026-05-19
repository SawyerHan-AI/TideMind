import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  syncPluginVersion,
  mirrorPluginToClaudeCache,
} from '../../client/electron/runtime/plugin-self-heal'
import { computePluginPatchVersion } from '../../client/electron/ipc/agent-plugins/claude-code-version'

/**
 * 这些测试覆盖 2026-05-09 SessionStart 加载失败的两层兜底:
 *   1. syncPluginVersion: 让 plugin.json 的 version 跟实际内容哈希同步,
 *      即便用户从未触发 wizard 重新生成,Tide Mind 启动 self-heal 也会
 *      把陈旧的 1.0.0 推到 1.0.<hash>,使 Claude Code 缓存条目失效。
 *   2. mirrorPluginToClaudeCache: 即便 Claude Code 不立即响应 version 变更,
 *      源端最新的 hooks.json 也已被原样镜像进所有现存 cache version 目录,
 *      让"读到任何 cache 条目"都拿到正确路径。
 */

const AGENT_ID = 'eb_smoketest'
const PLUGIN_DIR_NAME = `claude-code-${AGENT_ID}`
const PLUGIN_NAME = `tidemind-${AGENT_ID}`

function makeResult() {
  return { scanned: 0, patched: 0, errors: [] as { file: string; error: string }[] }
}

function makePluginDir(root: string, files: Record<string, string>): string {
  const pluginDir = path.join(root, PLUGIN_DIR_NAME)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(pluginDir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return pluginDir
}

function defaultPluginFiles(version: string = '1.0.0', hookCommand: string = '/old/hook') {
  return {
    '.claude-plugin/plugin.json': JSON.stringify({
      name: PLUGIN_NAME,
      version,
      description: 'test',
      author: { name: 'TideMind' },
    }, null, 2),
    'hooks/hooks.json': JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: hookCommand, timeout: 15000 }] },
        ],
      },
    }, null, 2),
    '.mcp.json': JSON.stringify({ mcpServers: { tidemind: { command: '/x', args: ['/y'] } } }, null, 2),
    'skills/tidemind/SKILL.md': '# skill',
  }
}

describe('syncPluginVersion', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-version-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rewrites plugin.json#version to a content-derived patch number when stale', () => {
    const pluginDir = makePluginDir(tmpDir, defaultPluginFiles('1.0.0'))
    const result = makeResult()

    syncPluginVersion(pluginDir, result)

    const cfg = JSON.parse(fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf-8'))
    expect(cfg.version).toBe(computePluginPatchVersion(pluginDir))
    expect(cfg.version).not.toBe('1.0.0')
    expect(result.patched).toBe(1)
  })

  it('is a no-op when plugin.json#version already matches the content hash', () => {
    const pluginDir = makePluginDir(tmpDir, defaultPluginFiles('1.0.0'))
    const expected = computePluginPatchVersion(pluginDir)
    // 模拟"已经被 sync 过"的稳态。
    const cfgPath = path.join(pluginDir, '.claude-plugin', 'plugin.json')
    fs.writeFileSync(cfgPath, JSON.stringify({
      name: PLUGIN_NAME,
      version: expected,
      description: 'test',
      author: { name: 'TideMind' },
    }, null, 2))
    const before = fs.readFileSync(cfgPath, 'utf-8')

    const result = makeResult()
    syncPluginVersion(pluginDir, result)

    expect(fs.readFileSync(cfgPath, 'utf-8')).toBe(before)
    expect(result.patched).toBe(0)
  })

  it('skips silently when plugin.json is missing', () => {
    const pluginDir = path.join(tmpDir, 'no-plugin-json')
    fs.mkdirSync(pluginDir, { recursive: true })
    const result = makeResult()
    expect(() => syncPluginVersion(pluginDir, result)).not.toThrow()
    expect(result.scanned).toBe(0)
    expect(result.patched).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('skips silently when plugin.json is malformed', () => {
    const pluginDir = path.join(tmpDir, 'bad-plugin-json')
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true })
    fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), '{ broken')
    const result = makeResult()
    expect(() => syncPluginVersion(pluginDir, result)).not.toThrow()
    expect(result.patched).toBe(0)
  })
})

describe('mirrorPluginToClaudeCache', () => {
  let tmpDir: string
  let pluginsRoot: string
  let homeDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-cache-mirror-'))
    pluginsRoot = path.join(tmpDir, 'plugins')
    homeDir = path.join(tmpDir, 'home')
    fs.mkdirSync(pluginsRoot, { recursive: true })
    fs.mkdirSync(homeDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function setupCacheVersion(version: string, files: Record<string, string>) {
    const cacheDir = path.join(homeDir, '.claude', 'plugins', 'cache', 'tidemind-local', PLUGIN_NAME, version)
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(cacheDir, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
    }
    return cacheDir
  }

  it('overwrites hooks.json in stale cache version dir with source content', () => {
    makePluginDir(pluginsRoot, defaultPluginFiles('1.0.0', '"/Applications/Tide Mind.app/.../hook.cjs" --new'))
    // 模拟用户机器上的旧缓存:hooks.json 引用旧 dev 路径。
    const cacheDir = setupCacheVersion('1.0.0', {
      'hooks/hooks.json': JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: '/Users/x/dev/hook.cjs --old' }] }],
        },
      }),
    })

    const result = makeResult()
    mirrorPluginToClaudeCache(pluginsRoot, PLUGIN_DIR_NAME, result, homeDir)

    const cacheHooks = fs.readFileSync(path.join(cacheDir, 'hooks/hooks.json'), 'utf-8')
    const sourceHooks = fs.readFileSync(path.join(pluginsRoot, PLUGIN_DIR_NAME, 'hooks/hooks.json'), 'utf-8')
    expect(cacheHooks).toBe(sourceHooks)
    expect(result.patched).toBe(1)
  })

  it('does NOT mirror plugin.json (avoids dirname/version mismatch)', () => {
    makePluginDir(pluginsRoot, defaultPluginFiles('1.0.999'))
    const cacheDir = setupCacheVersion('1.0.0', {
      '.claude-plugin/plugin.json': JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0' }),
      'hooks/hooks.json': JSON.stringify({ hooks: {} }),
    })

    const result = makeResult()
    mirrorPluginToClaudeCache(pluginsRoot, PLUGIN_DIR_NAME, result, homeDir)

    const cachePj = JSON.parse(fs.readFileSync(path.join(cacheDir, '.claude-plugin/plugin.json'), 'utf-8'))
    expect(cachePj.version).toBe('1.0.0') // 没动
  })

  it('mirrors into all version dirs (legacy + current)', () => {
    makePluginDir(pluginsRoot, defaultPluginFiles('1.0.123'))
    const a = setupCacheVersion('1.0.0', {
      'hooks/hooks.json': '{"hooks":{"old":1}}',
    })
    const b = setupCacheVersion('1.0.5', {
      'hooks/hooks.json': '{"hooks":{"older":1}}',
    })

    const result = makeResult()
    mirrorPluginToClaudeCache(pluginsRoot, PLUGIN_DIR_NAME, result, homeDir)

    const sourceHooks = fs.readFileSync(path.join(pluginsRoot, PLUGIN_DIR_NAME, 'hooks/hooks.json'), 'utf-8')
    expect(fs.readFileSync(path.join(a, 'hooks/hooks.json'), 'utf-8')).toBe(sourceHooks)
    expect(fs.readFileSync(path.join(b, 'hooks/hooks.json'), 'utf-8')).toBe(sourceHooks)
    expect(result.patched).toBe(2)
  })

  it('is a no-op when cache and source are already identical', () => {
    makePluginDir(pluginsRoot, defaultPluginFiles('1.0.123'))
    const sourceHooks = fs.readFileSync(path.join(pluginsRoot, PLUGIN_DIR_NAME, 'hooks/hooks.json'), 'utf-8')
    setupCacheVersion('1.0.0', { 'hooks/hooks.json': sourceHooks })

    const result = makeResult()
    mirrorPluginToClaudeCache(pluginsRoot, PLUGIN_DIR_NAME, result, homeDir)

    expect(result.patched).toBe(0)
  })

  it('skips when source plugin.json is missing or malformed', () => {
    fs.mkdirSync(path.join(pluginsRoot, PLUGIN_DIR_NAME, '.claude-plugin'), { recursive: true })
    fs.writeFileSync(path.join(pluginsRoot, PLUGIN_DIR_NAME, '.claude-plugin', 'plugin.json'), 'not json')
    setupCacheVersion('1.0.0', { 'hooks/hooks.json': '{"hooks":{}}' })

    const result = makeResult()
    expect(() => mirrorPluginToClaudeCache(pluginsRoot, PLUGIN_DIR_NAME, result, homeDir)).not.toThrow()
    expect(result.patched).toBe(0)
  })

  it('skips when no Claude Code cache dir exists', () => {
    makePluginDir(pluginsRoot, defaultPluginFiles())
    const result = makeResult()
    expect(() => mirrorPluginToClaudeCache(pluginsRoot, PLUGIN_DIR_NAME, result, homeDir)).not.toThrow()
    expect(result.patched).toBe(0)
  })

  it('also walks legacy marketplace cache (external-brain-local)', () => {
    makePluginDir(pluginsRoot, defaultPluginFiles('1.0.123'))
    // 老用户从 External Brain 升级过来,缓存 marketplace key 仍是旧名。
    const legacy = path.join(homeDir, '.claude', 'plugins', 'cache', 'external-brain-local', PLUGIN_NAME, '1.0.0')
    fs.mkdirSync(path.join(legacy, 'hooks'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'hooks', 'hooks.json'), '{"hooks":{"legacy":1}}')

    const result = makeResult()
    mirrorPluginToClaudeCache(pluginsRoot, PLUGIN_DIR_NAME, result, homeDir)

    const sourceHooks = fs.readFileSync(path.join(pluginsRoot, PLUGIN_DIR_NAME, 'hooks/hooks.json'), 'utf-8')
    expect(fs.readFileSync(path.join(legacy, 'hooks', 'hooks.json'), 'utf-8')).toBe(sourceHooks)
    expect(result.patched).toBe(1)
  })
})

import { healClaudeCodeSkillFile } from '../../client/electron/runtime/plugin-self-heal'

describe('healClaudeCodeSkillFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-skill-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rewrites legacy SKILL.md frontmatter that lacks when_to_use', () => {
    const oldFrontmatter = [
      '---',
      'description: "外部记忆系统"',
      '---',
      '',
      '# Body of skill',
      'do something',
    ].join('\n')
    const pluginDir = makePluginDir(tmpDir, {
      ...defaultPluginFiles(),
      'skills/tidemind/SKILL.md': oldFrontmatter,
    })
    const result = makeResult()

    healClaudeCodeSkillFile(pluginDir, result)

    const updated = fs.readFileSync(path.join(pluginDir, 'skills/tidemind/SKILL.md'), 'utf-8')
    expect(updated).toMatch(/when_to_use:/)
    expect(updated).toMatch(/allowed-tools:/)
    // 原 body 保留
    expect(updated).toContain('# Body of skill')
    expect(updated).toContain('do something')
    // pluginName 取自 plugin.json
    expect(updated).toMatch(new RegExp(`mcp__${PLUGIN_NAME}__brain_recall`))
    expect(result.patched).toBe(1)
  })

  it('preserves existing description value when rewriting', () => {
    const oldFrontmatter = [
      '---',
      'description: "Custom user description"',
      '---',
      '',
      'body',
    ].join('\n')
    const pluginDir = makePluginDir(tmpDir, {
      ...defaultPluginFiles(),
      'skills/tidemind/SKILL.md': oldFrontmatter,
    })

    healClaudeCodeSkillFile(pluginDir, makeResult())

    const updated = fs.readFileSync(path.join(pluginDir, 'skills/tidemind/SKILL.md'), 'utf-8')
    expect(updated).toContain('description: "Custom user description"')
  })

  it('no-op when SKILL.md already has when_to_use', () => {
    const goodFrontmatter = [
      '---',
      'description: "x"',
      'when_to_use: |',
      '  abc',
      'allowed-tools:',
      '  - mcp__x__y',
      '---',
      '',
      'body',
    ].join('\n')
    const pluginDir = makePluginDir(tmpDir, {
      ...defaultPluginFiles(),
      'skills/tidemind/SKILL.md': goodFrontmatter,
    })
    const result = makeResult()

    healClaudeCodeSkillFile(pluginDir, result)

    const after = fs.readFileSync(path.join(pluginDir, 'skills/tidemind/SKILL.md'), 'utf-8')
    expect(after).toBe(goodFrontmatter)
    expect(result.patched).toBe(0)
  })

  it('skips files without frontmatter', () => {
    const pluginDir = makePluginDir(tmpDir, {
      ...defaultPluginFiles(),
      'skills/tidemind/SKILL.md': '# just a markdown\nno frontmatter',
    })
    const result = makeResult()

    healClaudeCodeSkillFile(pluginDir, result)

    expect(result.patched).toBe(0)
  })

  it('skips when SKILL.md does not exist', () => {
    // Create a plugin dir without SKILL.md
    const pluginDir = path.join(tmpDir, 'claude-code-noskill')
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true })
    const result = makeResult()

    healClaudeCodeSkillFile(pluginDir, result)

    expect(result.scanned).toBe(0)
    expect(result.patched).toBe(0)
  })
})
