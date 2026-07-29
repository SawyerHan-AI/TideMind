import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse as parseToml } from 'smol-toml'
import {
  appendTomlMcpSection,
  ensureTomlFeatureFlag,
  ensureTomlHook,
  hasTomlHook,
  removeTomlHook,
  removeTomlMcpSection,
  scanTomlTableHeaders,
} from '../../client/electron/ipc/toml-utils'

describe('appendTomlMcpSection', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toml-test-'))
    configPath = path.join(tmpDir, 'config.toml')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should create config file if not exists', () => {
    appendTomlMcpSection(configPath, 'my-server', {
      command: 'node',
      args: ['/path/to/server.js'],
      env: { API_KEY: 'test-key' },
    })

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).toContain('[mcp_servers.my-server]')
    expect(content).toContain('enabled = true')
    expect(content).toContain('command = "node"')
    expect(content).toContain('args = ["/path/to/server.js"]')
    expect(content).toContain('"API_KEY" = "test-key"')
  })

  it('should append to existing config', () => {
    fs.writeFileSync(configPath, 'model = "o3"\n')

    appendTomlMcpSection(configPath, 'brain', {
      command: 'node',
      args: ['/a.js', '/b.js'],
      env: { X: '1', Y: '2' },
    })

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).toContain('model = "o3"')
    expect(content).toContain('[mcp_servers.brain]')
    expect(content).toContain('args = ["/a.js", "/b.js"]')
    expect(content).toContain('"X" = "1"')
    expect(content).toContain('"Y" = "2"')
  })

  it('should not duplicate existing section', () => {
    appendTomlMcpSection(configPath, 'server-1', {
      command: 'node', args: ['/a.js'], env: { K: 'v1' },
    })
    appendTomlMcpSection(configPath, 'server-1', {
      command: 'python', args: ['/b.py'], env: { K: 'v2' },
    })

    const content = fs.readFileSync(configPath, 'utf-8')
    const matches = content.match(/\[mcp_servers\.server-1\]/g)
    expect(matches).toHaveLength(1)
    // 保留第一次写入的值
    expect(content).toContain('command = "node"')
    expect(content).not.toContain('command = "python"')
  })

  it('should create nested directories if needed', () => {
    const nestedPath = path.join(tmpDir, 'a', 'b', 'config.toml')
    appendTomlMcpSection(nestedPath, 'srv', {
      command: 'node', args: [], env: {},
    })
    expect(fs.existsSync(nestedPath)).toBe(true)
  })
})

describe('removeTomlMcpSection', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toml-test-'))
    configPath = path.join(tmpDir, 'config.toml')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should remove a section', () => {
    fs.writeFileSync(configPath, [
      'model = "o3"',
      '',
      '[mcp_servers.to-remove]',
      'enabled = true',
      'command = "node"',
      '',
      '[mcp_servers.keep-this]',
      'enabled = true',
      'command = "python"',
    ].join('\n'))

    removeTomlMcpSection(configPath, 'to-remove')

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).not.toContain('[mcp_servers.to-remove]')
    expect(content).toContain('[mcp_servers.keep-this]')
    expect(content).toContain('model = "o3"')
    expect(content).toContain('command = "python"')
  })

  it('should handle non-existent file gracefully', () => {
    expect(() => removeTomlMcpSection(configPath, 'nope')).not.toThrow()
  })

  it('should handle non-existent section gracefully', () => {
    fs.writeFileSync(configPath, '[mcp_servers.other]\nenabled = true\n')
    removeTomlMcpSection(configPath, 'nope')
    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).toContain('[mcp_servers.other]')
  })

  it('should remove the last section in the file', () => {
    fs.writeFileSync(configPath, [
      'model = "o3"',
      '',
      '[mcp_servers.only-one]',
      'enabled = true',
      'command = "node"',
      'args = ["/a.js"]',
    ].join('\n'))

    removeTomlMcpSection(configPath, 'only-one')

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).not.toContain('[mcp_servers.only-one]')
    expect(content).toContain('model = "o3"')
  })

  // 回归 0.2.40：旧实现用 `[^\[]*` 匹配段体，会被段内 `args = [...]` 的 `[`
  // 截断，导致 `args` 的值和 `env` 行残留拼到上一段形成 TOML 语法错误。
  it('should fully remove a section whose body contains args = [...]', () => {
    fs.writeFileSync(configPath, [
      'model = "o3"',
      '',
      '[features]',
      'codex_hooks = true',
      'multi_agent = true',
      '',
      '[mcp_servers.tidemind-eb_xxx]',
      'enabled = true',
      'command = "/path/to/shim"',
      'args = ["/path/to/mcp-server.cjs"]',
      'env = { "EB_AGENT_ID" = "eb_xxx" }',
      '',
    ].join('\n'))

    removeTomlMcpSection(configPath, 'tidemind-eb_xxx')

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).not.toContain('[mcp_servers.tidemind-eb_xxx]')
    expect(content).not.toContain('mcp-server.cjs')
    expect(content).not.toContain('EB_AGENT_ID')
    // [features] 段完整保留
    expect(content).toContain('[features]')
    expect(content).toContain('multi_agent = true')
    // multi_agent = true 这行尾部必须干净，不能拼上残留
    expect(content).toMatch(/multi_agent = true\s*$/m)
  })

  it('should be symmetric with appendTomlMcpSection (append then remove restores prior content)', () => {
    const before = [
      'model = "o3"',
      '',
      '[features]',
      'codex_hooks = true',
      '',
    ].join('\n')
    fs.writeFileSync(configPath, before)

    appendTomlMcpSection(configPath, 'tidemind-abc', {
      command: '/path/to/shim',
      args: ['/path/to/server.cjs'],
      env: { EB_AGENT_ID: 'abc' },
    })
    removeTomlMcpSection(configPath, 'tidemind-abc')

    const after = fs.readFileSync(configPath, 'utf-8')
    expect(after).not.toContain('tidemind-abc')
    expect(after).not.toContain('EB_AGENT_ID')
    expect(after).toContain('model = "o3"')
    expect(after).toContain('[features]')
    expect(after).toContain('codex_hooks = true')
  })

  // 段头匹配修复:带尾注释的段头(`[other] # comment`)是合法 TOML,
  // 不识别会让删除边界延伸,把后面的用户配置表一并吞掉。
  it('should treat a following section header with trailing comment as the boundary', () => {
    fs.writeFileSync(configPath, [
      '[mcp_servers.to-remove]',
      'command = "node"',
      '',
      '[mcp_servers.keep-this] # user server',
      'command = "python"',
      '',
    ].join('\n'))

    removeTomlMcpSection(configPath, 'to-remove')

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).not.toContain('[mcp_servers.to-remove]')
    expect(content).toContain('[mcp_servers.keep-this] # user server')
    expect(content).toContain('command = "python"')
    const parsed = parseToml(content) as any
    expect(parsed.mcp_servers['keep-this'].command).toBe('python')
  })

  it.each(['\t# user server', '#user server'])(
    'should preserve a following section whose comment starts with %j',
    (comment) => {
      fs.writeFileSync(configPath, [
        '[mcp_servers.to-remove]',
        'command = "node"',
        '',
        `[mcp_servers.keep-this]${comment}`,
        'command = "python"',
        '',
      ].join('\n'))

      removeTomlMcpSection(configPath, 'to-remove')

      const content = fs.readFileSync(configPath, 'utf-8')
      expect(content).toContain(`[mcp_servers.keep-this]${comment}`)
      expect((parseToml(content) as any).mcp_servers['keep-this'].command).toBe('python')
    },
  )

  it('refuses to remove from malformed TOML and leaves the original unchanged', () => {
    const malformed = [
      '[mcp_servers.to-remove]',
      'command = "node"',
      '[providers.keep',
      'base_url = "https://secret.example"',
      '',
    ].join('\n')
    fs.writeFileSync(configPath, malformed)

    expect(() => removeTomlMcpSection(configPath, 'to-remove')).toThrow(/existing file is not valid TOML/)
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(malformed)
  })
})

describe('ensureTomlFeatureFlag', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toml-test-'))
    configPath = path.join(tmpDir, 'config.toml')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should add [features] section if not present', () => {
    fs.writeFileSync(configPath, 'model = "o3"\n')

    ensureTomlFeatureFlag(configPath, 'codex_hooks')

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).toContain('[features]')
    expect(content).toContain('codex_hooks = true')
  })

  it('should add flag to existing [features] section', () => {
    fs.writeFileSync(configPath, '[features]\nother_flag = true\n')

    ensureTomlFeatureFlag(configPath, 'codex_hooks')

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).toContain('codex_hooks = true')
    expect(content).toContain('other_flag = true')
  })

  it('should not duplicate if flag already present', () => {
    fs.writeFileSync(configPath, '[features]\ncodex_hooks = true\n')

    ensureTomlFeatureFlag(configPath, 'codex_hooks')

    const content = fs.readFileSync(configPath, 'utf-8')
    const matches = content.match(/codex_hooks = true/g)
    expect(matches).toHaveLength(1)
  })

  it('should do nothing if file does not exist', () => {
    expect(() => ensureTomlFeatureFlag(configPath, 'codex_hooks')).not.toThrow()
    expect(fs.existsSync(configPath)).toBe(false)
  })
})

describe('ensureTomlHook', () => {
  let tmpDir: string
  let configPath: string

  const hookCommand = '"/home/u/.tidemind/bin/tm-node" "/out/hook-session-start.cjs" --agent-id "eb_1234abcd" --skill-path "/home/u/.kimi-code/skills/tidemind-eb_1234abcd/SKILL.md" --tool "kimi-code"'
  const hook = {
    event: 'SessionStart',
    matcher: 'startup',
    command: hookCommand,
    timeout: 15,
    dedupeToken: '--agent-id "eb_1234abcd"',
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toml-hook-test-'))
    configPath = path.join(tmpDir, 'config.toml')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates the file and appends a valid [[hooks]] block', () => {
    ensureTomlHook(configPath, hook)

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).toContain('[[hooks]]')
    expect(content).toContain('event = "SessionStart"')
    expect(content).toContain('matcher = "startup"')
    expect(content).toContain('timeout = 15')

    // 引号/反斜杠正确转义,parse 回来与原 command 完全一致
    const parsed = parseToml(content) as any
    expect(parsed.hooks).toHaveLength(1)
    expect(parsed.hooks[0]).toEqual({
      event: 'SessionStart',
      matcher: 'startup',
      command: hookCommand,
      timeout: 15,
    })
  })

  it('appends without disturbing existing user content', () => {
    fs.writeFileSync(configPath, 'model = "k2"\n\n[providers.anthropic]\nbase_url = "https://example.com"\n')

    ensureTomlHook(configPath, hook)

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).toContain('model = "k2"')
    expect(content).toContain('[providers.anthropic]')
    expect(content).toContain('base_url = "https://example.com"')
    const parsed = parseToml(content) as any
    expect(parsed.providers.anthropic.base_url).toBe('https://example.com')
    expect(parsed.hooks).toHaveLength(1)
  })

  it('is idempotent: skips when a [[hooks]] block already contains the dedupeToken', () => {
    ensureTomlHook(configPath, hook)
    // 第二次用不同的 command,但同一个 dedupeToken → 必须跳过
    ensureTomlHook(configPath, { ...hook, command: '"/other/shim" --agent-id "eb_1234abcd" --tool "kimi-code"' })

    const content = fs.readFileSync(configPath, 'utf-8')
    const matches = content.match(/\[\[hooks\]\]/g)
    expect(matches).toHaveLength(1)
    expect(content).not.toContain('/other/shim')
  })

  it('recognizes a valid [[ hooks ]] target block and does not append a duplicate', () => {
    const spaced = [
      '[[ hooks ]]',
      'event = "SessionStart"',
      `command = ${JSON.stringify(hookCommand)}`,
      'timeout = 15',
      '',
    ].join('\n')
    fs.writeFileSync(configPath, spaced)

    expect(hasTomlHook(spaced, hook.dedupeToken)).toBe(true)
    ensureTomlHook(configPath, hook)

    const parsed = parseToml(fs.readFileSync(configPath, 'utf-8')) as any
    expect(parsed.hooks).toHaveLength(1)
  })

  it('creates parent directories if needed', () => {
    const nestedPath = path.join(tmpDir, 'a', 'b', 'config.toml')
    ensureTomlHook(nestedPath, hook)
    expect(fs.existsSync(nestedPath)).toBe(true)
  })

  // 与 readJsonStrict 同原则:畸形 TOML 不得静默覆盖,先备份再抛错。
  it('refuses to overwrite malformed TOML and writes a backup', () => {
    const original = 'model = "k2"\n[broken'
    fs.writeFileSync(configPath, original)

    expect(() => ensureTomlHook(configPath, hook)).toThrow(/Refused to overwrite/)
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(original)
    const baks = fs.readdirSync(tmpDir)
      .filter(n => n.startsWith('config.toml.tidemind-backup-') && n.endsWith('.bak'))
    expect(baks).toHaveLength(1)
    expect(fs.readFileSync(path.join(tmpDir, baks[0]), 'utf-8')).toBe(original)
  })
})

describe('removeTomlHook', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toml-hook-test-'))
    configPath = path.join(tmpDir, 'config.toml')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes only the [[hooks]] block containing the token, preserving everything else', () => {
    const mine = '"/shim" "/hook-session-start.cjs" --agent-id "eb_1234abcd" --tool "kimi-code"'
    const other = '"/shim" "/hook-session-start.cjs" --agent-id "eb_other99" --tool "kimi-code"'
    fs.writeFileSync(configPath, [
      'model = "k2"',
      '',
      '[[hooks]]',
      'event = "SessionStart"',
      'matcher = "startup"',
      `command = ${JSON.stringify(mine)}`,
      'timeout = 15',
      '',
      '[[hooks]]',
      'event = "SessionStart"',
      'matcher = "startup"',
      `command = ${JSON.stringify(other)}`,
      'timeout = 15',
      '',
      '[providers.anthropic]',
      'base_url = "https://example.com"',
      '',
    ].join('\n'))

    removeTomlHook(configPath, '--agent-id "eb_1234abcd"')

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).not.toContain('eb_1234abcd')
    expect(content).toContain('eb_other99')
    expect(content).toContain('model = "k2"')
    expect(content).toContain('[providers.anthropic]')
    // 结果仍是合法 TOML
    const parsed = parseToml(content) as any
    expect(parsed.hooks).toHaveLength(1)
    expect(parsed.hooks[0].command).toBe(other)
  })

  it('does not treat a custom command with the same agent-id text as TideMind-owned', () => {
    const custom = '"/bin/custom" "/tmp/hook-session-start-backup.cjs" --agent-id "eb_1234abcd" --tool "kimi-code"'
    fs.writeFileSync(configPath, [
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(custom)}`,
      'timeout = 30',
      '',
    ].join('\n'))

    expect(hasTomlHook(fs.readFileSync(configPath, 'utf-8'), '--agent-id "eb_1234abcd"')).toBe(false)
    removeTomlHook(configPath, '--agent-id "eb_1234abcd"')
    expect((parseToml(fs.readFileSync(configPath, 'utf-8')) as any).hooks[0].command).toBe(custom)
  })

  it('removes adjacent matching hooks without deleting the following user table', () => {
    const mine = '"/shim" "/hook-session-start.cjs" --agent-id "eb_1234abcd" --tool "kimi-code"'
    fs.writeFileSync(configPath, [
      '[[hooks]]',
      `command = ${JSON.stringify(mine)}`,
      '',
      '[[hooks]]',
      `command = ${JSON.stringify(mine)}`,
      '',
      '[providers.keep]',
      'base_url = "https://example.com"',
      '',
    ].join('\n'))

    removeTomlHook(configPath, '--agent-id "eb_1234abcd"')

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).toContain('[providers.keep]')
    expect((parseToml(content) as any).providers.keep.base_url).toBe('https://example.com')
  })

  it('handles non-existent file gracefully', () => {
    expect(() => removeTomlHook(configPath, '--agent-id "eb_x"')).not.toThrow()
  })

  it('handles missing token gracefully (file unchanged)', () => {
    const original = '[[hooks]]\nevent = "SessionStart"\ncommand = "echo hi"\n'
    fs.writeFileSync(configPath, original)
    removeTomlHook(configPath, '--agent-id "eb_x"')
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(original)
  })

  it('is symmetric with ensureTomlHook (append then remove restores prior content)', () => {
    const before = 'model = "k2"\n'
    fs.writeFileSync(configPath, before)
    const hook = {
      event: 'SessionStart',
      matcher: 'startup',
      command: '"/shim" "/hook-session-start.cjs" --agent-id "eb_1234abcd" --tool "kimi-code"',
      timeout: 15,
      dedupeToken: '--agent-id "eb_1234abcd"',
    }

    ensureTomlHook(configPath, hook)
    removeTomlHook(configPath, hook.dedupeToken)

    const after = fs.readFileSync(configPath, 'utf-8')
    expect(after).not.toContain('[[hooks]]')
    expect(after).not.toContain('eb_1234abcd')
    expect(after).toContain('model = "k2"')
  })

  // isTableHeader 修复:带尾注释的段头(`[other] # comment`)是合法 TOML,
  // 不识别会让块边界延伸到文件尾,把用户其他配置表一并删掉(数据丢失)。
  it('treats a section header with trailing comment as a block boundary', () => {
    const mine = '"/shim" "/hook-session-start.cjs" --agent-id "eb_1234abcd" --tool "kimi-code"'
    const original = [
      '[[hooks]]',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(mine)}`,
      'timeout = 30',
      '',
      '[providers.anthropic] # my provider',
      'base_url = "https://example.com"',
      '',
    ].join('\n')
    fs.writeFileSync(configPath, original)

    removeTomlHook(configPath, '--agent-id "eb_1234abcd"')

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).not.toContain('eb_1234abcd')
    expect(content).toContain('[providers.anthropic] # my provider')
    expect(content).toContain('base_url = "https://example.com"')
    const parsed = parseToml(content) as any
    expect(parsed.providers.anthropic.base_url).toBe('https://example.com')
  })

  // isTableHeader 修复:括号内空格(`[[ hooks ]]`)同样是合法 TOML 段头。
  it('treats [[ hooks ]] with inner spaces as a block boundary', () => {
    const mine = '"/shim" "/hook-session-start.cjs" --agent-id "eb_1234abcd" --tool "kimi-code"'
    const original = [
      '[[hooks]]',
      `command = ${JSON.stringify(mine)}`,
      '',
      '[[ hooks ]]',
      'command = "echo user-hook"',
      '',
    ].join('\n')
    fs.writeFileSync(configPath, original)

    removeTomlHook(configPath, '--agent-id "eb_1234abcd"')

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).not.toContain('eb_1234abcd')
    expect(content).toContain('echo user-hook')
  })

  it('removes a valid [[ hooks ]] target block', () => {
    const mine = '"/shim" "/hook-session-start.cjs" --agent-id "eb_1234abcd" --tool "kimi-code"'
    fs.writeFileSync(configPath, [
      '[[ hooks ]]',
      'event = "UserPromptSubmit"',
      `command = ${JSON.stringify(mine)}`,
      'timeout = 30',
      '',
      '[providers.anthropic]',
      'base_url = "https://example.com"',
      '',
    ].join('\n'))

    removeTomlHook(configPath, '--agent-id "eb_1234abcd"')

    const content = fs.readFileSync(configPath, 'utf-8')
    expect(content).not.toContain('eb_1234abcd')
    expect(content).toContain('[providers.anthropic]')
  })

  it.each(['\t# my provider', '#my provider'])(
    'preserves a following table whose comment starts with %j',
    (comment) => {
      const mine = '"/shim" "/hook-session-start.cjs" --agent-id "eb_1234abcd" --tool "kimi-code"'
      fs.writeFileSync(configPath, [
        '[[hooks]]',
        'event = "UserPromptSubmit"',
        `command = ${JSON.stringify(mine)}`,
        'timeout = 30',
        '',
        `[providers.anthropic]${comment}`,
        'base_url = "https://example.com"',
        '',
      ].join('\n'))

      removeTomlHook(configPath, '--agent-id "eb_1234abcd"')

      const content = fs.readFileSync(configPath, 'utf-8')
      expect(content).toContain(`[providers.anthropic]${comment}`)
      expect((parseToml(content) as any).providers.anthropic.base_url).toBe('https://example.com')
    },
  )

  it('does not treat [x] inside a multiline string as a block boundary', () => {
    const original = [
      '[[hooks]]',
      'command = """',
      '/shim /hook-session-start.cjs --agent-id "eb_1234abcd" --tool kimi-code',
      '[fake-header]',
      '"""',
      '',
    ].join('\n')
    fs.writeFileSync(configPath, original)
    // 原文件本身是合法 TOML(多行 basic string)
    expect(() => parseToml(original)).not.toThrow()

    removeTomlHook(configPath, '--agent-id "eb_1234abcd"')
    expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('eb_1234abcd')
  })
})

describe('scanTomlTableHeaders', () => {
  it('ignores table-looking lines inside multiline strings and arrays', () => {
    const content = [
      'message = """',
      '[fake.basic]',
      '[[ hooks ]]',
      '"""',
      "literal = '''",
      '[fake.literal]',
      "'''",
      'values = [',
      '[1],',
      ']',
      '["real#key"]#comment',
      'value = 1',
      '[[ hooks ]]\t# real hook',
      'command = "echo ok"',
      '',
    ].join('\n')

    expect(scanTomlTableHeaders(content)).toEqual([
      { line: 10, array: false, key: '"real#key"' },
      { line: 12, array: true, key: 'hooks' },
    ])
  })
})
