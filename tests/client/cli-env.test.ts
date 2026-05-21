/**
 * cliEnv() 白名单测试 — 见 client/electron/ipc/agent-plugins/paths.ts。
 *
 * 背景:历史实现是 `{ ...process.env, PATH: ... }`,会把 Electron 主进程里
 * 任何敏感变量(ANTHROPIC_API_KEY / OAUTH 令牌 等)透传到外部 claude CLI。
 * 现在改成白名单透传 + 固定 PATH,本测试守护此契约。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliEnv } from '../../client/electron/ipc/agent-plugins/paths'

describe('cliEnv (paths.ts) — allowlist + fixed PATH', () => {
  const saved = new Map<string, string | undefined>()

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  beforeEach(() => {
    saved.clear()
  })

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    saved.clear()
  })

  it('不透传 ANTHROPIC_API_KEY 等敏感变量', () => {
    setEnv('ANTHROPIC_API_KEY', 'sk-secret-123')
    const env = cliEnv()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('不透传 OAUTH_TOKEN / SUPABASE_KEY 等其它敏感变量', () => {
    setEnv('OAUTH_TOKEN', 'oauth-leak')
    setEnv('SUPABASE_KEY', 'supabase-leak')
    setEnv('GH_TOKEN', 'gh-leak')
    setEnv('NPM_TOKEN', 'npm-leak')
    const env = cliEnv()
    expect(env.OAUTH_TOKEN).toBeUndefined()
    expect(env.SUPABASE_KEY).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.NPM_TOKEN).toBeUndefined()
  })

  it('透传 HOME', () => {
    setEnv('HOME', '/x/home')
    const env = cliEnv()
    expect(env.HOME).toBe('/x/home')
  })

  it('透传 USER / LANG / LC_ALL / TERM / TMPDIR / SHELL / PWD', () => {
    setEnv('USER', 'alice')
    setEnv('LANG', 'en_US.UTF-8')
    setEnv('LC_ALL', 'C')
    setEnv('TERM', 'xterm-256color')
    setEnv('TMPDIR', '/tmp/x')
    setEnv('SHELL', '/bin/zsh')
    setEnv('PWD', '/work')
    const env = cliEnv()
    expect(env.USER).toBe('alice')
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.LC_ALL).toBe('C')
    expect(env.TERM).toBe('xterm-256color')
    expect(env.TMPDIR).toBe('/tmp/x')
    expect(env.SHELL).toBe('/bin/zsh')
    expect(env.PWD).toBe('/work')
  })

  it('PATH 固定为系统标准路径，不追加用户 PATH', () => {
    setEnv('PATH', '/evil/path:/another/evil')
    const env = cliEnv()
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
    expect(env.PATH).not.toContain('/evil/path')
    expect(env.PATH).not.toContain('/another/evil')
  })

  it('未设置 HOME 等变量时,返回的 env 也不含该 key (而不是 undefined 值)', () => {
    setEnv('HOME', undefined)
    const env = cliEnv()
    expect('HOME' in env).toBe(false)
  })

  it('白名单之外的变量不会被透传(回归保护)', () => {
    setEnv('ELECTRON_NODE_BINDING_FOO', 'should-not-leak')
    setEnv('NODE_OPTIONS', '--inspect=9229')
    setEnv('NODE_ENV', 'production')
    const env = cliEnv()
    expect(env.ELECTRON_NODE_BINDING_FOO).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.NODE_ENV).toBeUndefined()
  })
})
