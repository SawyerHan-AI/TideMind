import { claudeConfigRootEnvironment } from '../../client/electron/agent-integration/claude-config-environment'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyClaudeAuthentication, classifyCodexAuthentication, probeAgentAuthentication,
  type AgentAuthenticationOptions } from '../../client/electron/agent-integration/agent-authentication'
import { CODEX_AUTHENTICATION_METADATA_LIMITS } from '../../client/electron/agent-integration/agent-authentication-rpc'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const subscribedClaude = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }
const subscribedCodex = { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true }
const officialConfig = { config: { model_provider: 'openai' } }
const printJson = (value: unknown) => 'process.stdout.write(' + JSON.stringify(JSON.stringify(value)) + ');'

function fixture(kind: 'claude' | 'codex', script: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-authentication-')))
  roots.push(root)
  const executable = path.join(root, 'fixture-cli')
  fs.writeFileSync(executable, '#!' + process.execPath + '\n' + script + '\n', { mode: 0o700 })
  const homeDir = path.join(root, 'home'), configRoot = path.join(root, 'selected-profile')
  fs.mkdirSync(homeDir); fs.mkdirSync(configRoot)
  const options: AgentAuthenticationOptions = {
    target: { installationId: 'fixture-installation', hostVariant: kind === 'claude' ? 'claude-code-native' : 'codex-cli',
      executable, homeDir, configRoot }, dataDir: path.join(root, 'data'),
    sourceEnv: {}, attest: vi.fn(async () => true), timeoutMs: 3000, codexSystemConfigPaths: [],
  }
  return { root, options }
}

function rpcScript(account: unknown, configuration: unknown, configUnsupported = false) {
  return [
    "const fs = require('node:fs'), path = require('node:path');",
    "if (process.argv[2] !== 'app-server' || !process.env.CODEX_HOME || process.env.NODE_OPTIONS) process.exit(7);",
    "const log = path.join(process.env.CODEX_HOME, 'requests.jsonl'); let text = '';",
    "process.stdin.on('data', chunk => { text += chunk; let end;",
    "while ((end = text.indexOf('\\n')) >= 0) {",
    "const message = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);",
    "fs.appendFileSync(log, JSON.stringify(message) + '\\n');",
    "if (message.method === 'initialized') continue;",
    "if (message.method === 'account/read' && message.params.refreshToken !== false) process.exit(8);",
    "if (!['initialize','config/read','account/read'].includes(message.method)) process.exit(9);",
    "const value = message.method === 'initialize' ? {} : message.method === 'config/read' ? " + JSON.stringify(configuration) + ' : ' + JSON.stringify(account) + ';',
    "const response = message.method === 'config/read' && " + configUnsupported + ' ? {id:message.id,error:{code:-32601}} : {id:message.id,result:value};',
    "process.stdout.write(JSON.stringify(response) + '\\n'); }});",
    "process.stdin.on('end', () => process.exit(0));",
  ].join('\n')
}

describe('Claude default configuration namespace', () => {
  it('does not create a different global registry merely by explicitly setting the default root', async () => {
    const f = fixture('claude', "if (process.env.CLAUDE_CONFIG_DIR !== undefined) process.exit(6);" + printJson(subscribedClaude))
    f.options.target.configRoot = path.join(f.options.target.homeDir, '.claude')
    fs.mkdirSync(f.options.target.configRoot)
    expect(claudeConfigRootEnvironment(f.options.target.homeDir, f.options.target.configRoot, {})).toEqual({})
    expect(await probeAgentAuthentication(f.options)).toMatchObject({ status: 'authenticated' })
    expect(claudeConfigRootEnvironment(f.options.target.homeDir, f.options.target.configRoot,
      { CLAUDE_CONFIG_DIR: f.options.target.configRoot })).toEqual({ CLAUDE_CONFIG_DIR: f.options.target.configRoot })
  })
  it('preserves default semantics through a symlink while keeping an intentional custom root explicit', () => {
    const f = fixture('claude', printJson(subscribedClaude))
    fs.symlinkSync(f.options.target.configRoot, path.join(f.options.target.homeDir, '.claude'))
    expect(claudeConfigRootEnvironment(f.options.target.homeDir, f.options.target.configRoot, {})).toEqual({})
    const other = path.join(f.root, 'other-profile');fs.mkdirSync(other)
    expect(claudeConfigRootEnvironment(f.options.target.homeDir, other, {})).toEqual({ CLAUDE_CONFIG_DIR: other })
  })
})

describe('A-side authentication and billing are independent', () => {
  it('keeps auth-status raw tier semantics separate from SDK display labels and opaque OAuth tokens', () => {
    expect(classifyClaudeAuthentication({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }))
      .toMatchObject({ status: 'authenticated', billing: 'confirmed_subscription' })
    expect(classifyClaudeAuthentication({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'Claude Max' }))
      .toMatchObject({ status: 'authenticated', billing: 'unknown' })
    expect(classifyClaudeAuthentication({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty', subscriptionType: 'max' }))
      .toMatchObject({ status: 'authenticated', billing: 'unknown' })
  })
  it('accepts lawful Claude API authentication without granting subscription diagnostics', () => {
    expect(classifyClaudeAuthentication({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }))
      .toMatchObject({ status: 'authenticated', billing: 'metered' })
    expect(classifyClaudeAuthentication(subscribedClaude)).toMatchObject({ status: 'authenticated', billing: 'confirmed_subscription' })
    expect(classifyClaudeAuthentication({ ...subscribedClaude, authMethod: 'oauth_token' })).toMatchObject({ status: 'authenticated', billing: 'unknown' })
    expect(classifyClaudeAuthentication({ ...subscribedClaude, subscriptionType: 'new-unrecognized-plan' })).toMatchObject({ status: 'authenticated', billing: 'unknown' })
    expect(classifyClaudeAuthentication({ loggedIn: false })).toMatchObject({ status: 'explicitly_unauthenticated' })
    expect(classifyClaudeAuthentication({ error: 'not enough data' })).toMatchObject({ status: 'unavailable' })
  })

  it('requires an effective official Codex provider as well as subscription account', () => {
    expect(classifyCodexAuthentication(subscribedCodex, officialConfig)).toMatchObject({ billing: 'confirmed_subscription' })
    for (const config of [null, { config: {} }, { config: { model_provider: 'custom' } },
      { config: { model_provider: 'openai', profile: 'selected-custom-profile' } },
      { config: { model_provider: 'openai', model_providers: { openai: { base_url: 'https://fixture.invalid' } } } },
      { config: { model_provider: 'openai', openai_base_url: 'https://fixture.invalid' } },
      { config: { model_provider: 'openai', chatgpt_base_url: 'https://fixture.invalid' } }]) {
      expect(classifyCodexAuthentication(subscribedCodex, config)).toMatchObject({ status: 'authenticated', billing: 'unknown' })
    }
    expect(classifyCodexAuthentication({ account: { type: 'apiKey' } }, officialConfig)).toMatchObject({ status: 'authenticated', billing: 'metered' })
    expect(classifyCodexAuthentication({ account: null, requiresOpenaiAuth: false }, { config: { model_provider: 'local' } }))
      .toMatchObject({ status: 'unavailable', billing: 'unknown' })
    expect(classifyCodexAuthentication({ account: null, requiresOpenaiAuth: true }, officialConfig)).toMatchObject({ status: 'explicitly_unauthenticated' })
    expect(classifyCodexAuthentication({}, officialConfig)).toMatchObject({ status: 'unavailable' })
  })
})

describe('A-side exact target probes against fake native processes', () => {
  it.each(['openai_base_url', 'chatgpt_base_url'])('does not spawn app-server for an explicit %s override', async key => {
    const f = fixture('codex', rpcScript(subscribedCodex, officialConfig))
    fs.writeFileSync(path.join(f.options.target.configRoot, 'config.toml'), `${key} = "https://fixture.invalid"\n`)
    await expect(probeAgentAuthentication(f.options)).resolves.toEqual({
      status: 'unavailable', billing: 'unknown', reason: 'billing_settings_override',
    })
    expect(fs.existsSync(path.join(f.options.target.configRoot, 'requests.jsonl'))).toBe(false)
  })

  it('blocks app-server for a standard system layer or a named profile route without selecting a profile', async () => {
    const system = fixture('codex', rpcScript(subscribedCodex, officialConfig))
    const requirements = path.join(system.root, 'requirements.toml')
    fs.writeFileSync(requirements, 'chatgpt_base_url = "https://fixture.invalid"\n')
    system.options.codexSystemConfigPaths = [requirements]
    const user = fixture('codex', rpcScript(subscribedCodex, officialConfig))
    fs.writeFileSync(path.join(user.options.target.configRoot, 'config.toml'),
      '[profiles.synthetic]\nopenai_base_url = "https://fixture.invalid"\n')
    for (const f of [system, user]) {
      await expect(probeAgentAuthentication(f.options)).resolves.toMatchObject({ status: 'unavailable', reason: 'billing_settings_override' })
      expect(fs.existsSync(path.join(f.options.target.configRoot, 'requests.jsonl'))).toBe(false)
    }
  })

  it('does not send an explicit account request after seeing an effective routing override', async () => {
    const f = fixture('codex', rpcScript(subscribedCodex, { config: { model_provider: 'openai', chatgpt_base_url: 'https://fixture.invalid' } }))
    await expect(probeAgentAuthentication(f.options)).resolves.toEqual({
      status: 'unavailable', billing: 'unknown', reason: 'billing_settings_override',
    })
    const requests = fs.readFileSync(path.join(f.options.target.configRoot, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'config/read'])
  })

  it('does not spawn without an affirmative current A-side attestation', async () => {
    const f = fixture('claude', "require('node:fs').writeFileSync(require('node:path').join(__dirname,'spawned'),'yes')")
    f.options.attest = vi.fn(async () => false)
    expect(await probeAgentAuthentication(f.options)).toMatchObject({ status: 'unavailable', reason: 'source_attestation_failed' })
    expect(fs.existsSync(path.join(f.root, 'spawned'))).toBe(false)
    expect(await probeAgentAuthentication({ ...f.options, attest: undefined as unknown as AgentAuthenticationOptions['attest'] }))
      .toMatchObject({ reason: 'source_attestation_required' })
  })

  it('uses selected Claude root, excludes unsafe environment and preserves legitimate API mode', async () => {
    const f = fixture('claude', [
      "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['auth','status','--json'])) process.exit(5);",
      "if (!process.env.CLAUDE_CONFIG_DIR.endsWith('selected-profile') || !process.env.HOME.endsWith('home') || process.env.NODE_OPTIONS) process.exit(6);",
      "if (process.env.ANTHROPIC_API_KEY !== 'synthetic-key') process.exit(7);",
      printJson({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }),
    ].join('\n'))
    f.options.sourceEnv = { CLAUDE_CONFIG_DIR: '/wrong-profile', NODE_OPTIONS: '--not-a-real-node-option', ANTHROPIC_API_KEY: 'synthetic-key' }
    expect(await probeAgentAuthentication(f.options)).toMatchObject({ status: 'authenticated', billing: 'metered' })
    expect(f.options.attest).toHaveBeenCalledWith(f.options.target, expect.any(AbortSignal))
    expect(fs.readdirSync(path.join(f.options.dataDir, 'runtime', 'llm-cli'))).toEqual([])
  })

  it('does not equate a failed process with logged out; accepts only explicit host evidence', async () => {
    const failed = fixture('claude', 'process.exit(1)')
    expect(await probeAgentAuthentication(failed.options)).toMatchObject({ status: 'unavailable' })
    const loggedOut = fixture('claude', printJson({ loggedIn: false }) + 'process.exitCode=1')
    expect(await probeAgentAuthentication(loggedOut.options)).toMatchObject({ status: 'explicitly_unauthenticated' })
  })

  it('requests Codex account and effective config without requesting a model or token refresh', async () => {
    const f = fixture('codex', rpcScript(subscribedCodex, officialConfig))
    expect(await probeAgentAuthentication(f.options)).toMatchObject({ status: 'authenticated', billing: 'confirmed_subscription' })
    const requests = fs.readFileSync(path.join(f.options.target.configRoot, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'config/read', 'account/read'])
    expect(requests.at(-1).params).toEqual({ refreshToken: false })
  })

  it('accepts normal Codex configuration provenance above 64KiB without relaxing account classification', async () => {
    const configuration = { ...officialConfig, origins: Object.fromEntries(Array.from({ length: 400 }, (_, index) => [
      `projects.fixture-${index}`, { source: '/synthetic/project/' + 'p'.repeat(96), version: 'a'.repeat(128) },
    ])) }
    expect(Buffer.byteLength(JSON.stringify(configuration))).toBeGreaterThan(64 * 1024)
    const f = fixture('codex', "process.stderr.write('synthetic warning\\n'.repeat(1000));\n" + rpcScript(subscribedCodex, configuration))
    expect(await probeAgentAuthentication(f.options)).toMatchObject({ status: 'authenticated', billing: 'confirmed_subscription' })
    const requests = fs.readFileSync(path.join(f.options.target.configRoot, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'config/read', 'account/read'])
    expect(requests.at(-1).params).toEqual({ refreshToken: false })
    const overridden = fixture('codex', rpcScript(subscribedCodex, { ...configuration, config: { model_provider: 'custom' } }))
    expect(await probeAgentAuthentication(overridden.options)).toMatchObject({ status: 'authenticated', billing: 'unknown' })
  })

  it('keeps a separate bounded stderr budget for Codex metadata', async () => {
    const f = fixture('codex', `process.stderr.write(Buffer.alloc(${CODEX_AUTHENTICATION_METADATA_LIMITS.stderrBytes + 1}, 83)); setInterval(() => {}, 1000)`)
    expect(await probeAgentAuthentication(f.options)).toMatchObject({ status: 'unavailable', reason: 'auth_output_limit' })
    expect(fs.readdirSync(path.join(f.options.dataDir, 'runtime', 'llm-cli'))).toEqual([])
  })

  it('keeps billing unknown if effective provider cannot be queried or environment may override it', async () => {
    const old = fixture('codex', rpcScript(subscribedCodex, null, true))
    expect(await probeAgentAuthentication(old.options)).toMatchObject({ status: 'authenticated', billing: 'unknown' })
    const overridden = fixture('codex', rpcScript(subscribedCodex, officialConfig))
    overridden.options.sourceEnv = { OPENAI_BASE_URL: 'https://fixture.invalid' }
    expect(await probeAgentAuthentication(overridden.options)).toMatchObject({ status: 'authenticated', billing: 'unknown' })
    const claude = fixture('claude', printJson(subscribedClaude))
    claude.options.sourceEnv = { ANTHROPIC_AUTH_TOKEN: 'synthetic-token' }
    expect(await probeAgentAuthentication(claude.options)).toMatchObject({ status: 'authenticated', billing: 'unknown' })
  })

  it('checks Claude target settings routing without reading credential files or returning secrets', async () => {
    const f = fixture('claude', printJson(subscribedClaude))
    const settingsFile = path.join(f.options.target.configRoot, 'settings.json')
    // A directory makes an accidental credential-file read fail; only settings
    // belongs to this check. The fake host supplies the official auth observation.
    fs.mkdirSync(path.join(f.options.target.configRoot, '.credentials.json'))
    fs.writeFileSync(settingsFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://fixture.invalid', ANTHROPIC_AUTH_TOKEN: 'synthetic-private' } }))
    const observation = await probeAgentAuthentication(f.options)
    expect(observation).toMatchObject({ status: 'authenticated', billing: 'unknown', reason: 'billing_settings_override' })
    expect(JSON.stringify(observation)).not.toContain('synthetic-private')
    fs.writeFileSync(settingsFile, JSON.stringify({ apiKeyHelper: 'not-executed-by-this-probe' }))
    expect(await probeAgentAuthentication(f.options)).toMatchObject({ billing: 'unknown', reason: 'billing_settings_override' })
    fs.writeFileSync(settingsFile, '{invalid')
    expect(await probeAgentAuthentication(f.options)).toMatchObject({ billing: 'unknown', reason: 'billing_settings_unconfirmed' })
    fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', env: { UNRELATED_FIXTURE_SETTING: 'true' } }))
    expect(await probeAgentAuthentication(f.options)).toMatchObject({ billing: 'confirmed_subscription' })
  })

  it('bounds a slow attestor and never spawns when it completes late', async () => {
    const f = fixture('claude', "require('node:fs').writeFileSync(require('node:path').join(__dirname,'spawned'),'yes')")
    let release!: (value: boolean) => void
    f.options.attest = () => new Promise(resolve => { release = resolve })
    f.options.timeoutMs = 20
    expect(await probeAgentAuthentication(f.options)).toMatchObject({ status: 'unavailable', reason: 'auth_timeout' })
    release(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fs.existsSync(path.join(f.root, 'spawned'))).toBe(false)
  })

  it.each(['claude', 'codex'] as const)('cancels a live %s process without claiming authentication failure', async kind => {
    const f = fixture(kind, 'setInterval(() => {}, 1000)')
    const controller = new AbortController()
    const pending = probeAgentAuthentication({ ...f.options, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    expect(await pending).toMatchObject({ status: 'cancelled', billing: 'unknown' })
    expect(fs.readdirSync(path.join(f.options.dataDir, 'runtime', 'llm-cli'))).toEqual([])
  })

  it.each(['claude', 'codex'] as const)('bounds %s output without including raw data in the result', async kind => {
    const repeat = kind === 'codex' ? Math.ceil((CODEX_AUTHENTICATION_METADATA_LIMITS.stdoutBytes + 1) / 'SENSITIVE_FIXTURE'.length) : 10000
    const f = fixture(kind, `process.stdout.write('SENSITIVE_FIXTURE'.repeat(${repeat})); setInterval(() => {},1000)`)
    const observation = await probeAgentAuthentication(f.options)
    expect(observation).toMatchObject({ status: 'unavailable', reason: 'auth_output_limit' })
    expect(JSON.stringify(observation)).not.toContain('SENSITIVE_FIXTURE')
  })

  it('does not probe other hosts or pre-cancelled requests', async () => {
    const f = fixture('claude', 'process.exit(9)')
    expect(await probeAgentAuthentication({ ...f.options, target: { ...f.options.target, hostVariant: 'cursor-desktop' } })).toMatchObject({ status: 'unsupported' })
    const controller = new AbortController(); controller.abort()
    expect(await probeAgentAuthentication({ ...f.options, signal: controller.signal })).toMatchObject({ status: 'cancelled' })
    expect(f.options.attest).not.toHaveBeenCalled()
  })
})
