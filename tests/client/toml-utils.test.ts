import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { appendTomlMcpSection, removeTomlMcpSection, ensureTomlFeatureFlag } from '../../client/electron/ipc/toml-utils'

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
