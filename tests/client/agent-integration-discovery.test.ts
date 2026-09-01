import path from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  P0_DISCOVERY_CATALOG_IDS,
  P0_DISCOVERY_PROBES,
  CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
  discoverLocalP0Agents,
  MAX_CLI_EXECUTABLE_PROOF_BYTES,
  toDiscoverInstallationInput,
  type DiscoveryDependencies,
  type DiscoveryPathStat,
  type VersionCommandResult,
} from '../../client/electron/agent-integration/discovery'

const HOME = '/Users/fixture'
const USER_ID = 'usr_01JDISCOVERYFIXTURE'

class FakeDiscoveryFs {
  readonly entries = new Map<string, DiscoveryPathStat>()
  readonly realpaths = new Map<string, string>()
  readonly textFiles = new Map<string, string>()
  readonly signatures = new Map<string, { valid: boolean; identifier?: string; teamIdentifier?: string }>()
  readonly calls: string[] = []
  readonly fileSizes = new Map<string, number>()
  readonly fileInodes = new Map<string, string>()
  readonly fileModes = new Map<string, number>()

  addDirectory(targetPath: string, realpath = targetPath): void {
    this.entries.set(targetPath, { kind: targetPath === realpath ? 'directory' : 'symbolic_link' })
    this.realpaths.set(targetPath, realpath)
    this.entries.set(realpath, { kind: 'directory' })
    this.realpaths.set(realpath, realpath)
  }

  addFile(targetPath: string, realpath = targetPath, size = 1_024, mode = 0o755): void {
    this.entries.set(targetPath, { kind: targetPath === realpath ? 'file' : 'symbolic_link' })
    this.realpaths.set(targetPath, realpath)
    this.entries.set(realpath, { kind: 'file' })
    this.realpaths.set(realpath, realpath)
    this.fileSizes.set(realpath, size)
    this.fileInodes.set(realpath, realpath)
    this.fileModes.set(realpath, mode)
  }

  addApp(
    bundleName: string,
    input: {
      bundleId: string
      version?: string
      executable?: string
      root?: string
      signature?: { valid: boolean; identifier?: string; teamIdentifier?: string }
    },
  ): void {
    const appPath = path.posix.join(input.root ?? '/Applications', bundleName)
    this.addDirectory(appPath)
    const executable = input.executable ?? bundleName.replace(/\.app$/u, '')
    const infoPath = path.posix.join(appPath, 'Contents', 'Info.plist')
    const infoPlist = [
      '<plist><dict>',
      `<key>CFBundleIdentifier</key><string>${input.bundleId}</string>`,
      `<key>CFBundleShortVersionString</key><string>${input.version ?? '1.2.3'}</string>`,
      `<key>CFBundleExecutable</key><string>${executable}</string>`,
      '</dict></plist>',
    ].join('')
    this.addFile(infoPath, infoPath, Buffer.byteLength(infoPlist), 0o644)
    this.textFiles.set(infoPath, infoPlist)
    this.addFile(path.posix.join(appPath, 'Contents', 'MacOS', executable))
    if (input.signature) this.signatures.set(appPath, input.signature)
  }

  async lstat(targetPath: string): Promise<DiscoveryPathStat | undefined> {
    this.calls.push(`lstat:${targetPath}`)
    return this.entries.get(targetPath)
  }

  async realpath(targetPath: string): Promise<string> {
    this.calls.push(`realpath:${targetPath}`)
    const resolved = this.realpaths.get(targetPath)
    if (!resolved) throw Object.assign(new Error('missing fixture path'), { code: 'ENOENT' })
    return resolved
  }

  async readTextFile(targetPath: string, maxBytes: number): Promise<string> {
    this.calls.push(`readTextFile:${targetPath}:${maxBytes}`)
    const content = this.textFiles.get(targetPath)
    if (content === undefined) throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' })
    return content.slice(0, maxBytes)
  }

  async readStableFileMetadata(targetPath: string) {
    this.calls.push(`readStableFileMetadata:${targetPath}`)
    const size = this.fileSizes.get(targetPath)
    if (size === undefined) throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' })
    const mode = this.fileModes.get(targetPath) ?? 0o755
    return {
      size,
      mode,
      device: '1',
      inode: this.fileInodes.get(targetPath) ?? targetPath,
      executable: (mode & 0o111) !== 0,
    }
  }

  async readStableFileSnapshot(targetPath: string, maxBytes: number) {
    this.calls.push(`readStableFileSnapshot:${targetPath}:${maxBytes}`)
    const content = Buffer.from(this.textFiles.get(targetPath) ?? '')
    if (content.length > maxBytes) throw new Error('fixture snapshot too large')
    const mode = this.fileModes.get(targetPath) ?? 0o644
    const inode = this.fileInodes.get(targetPath) ?? targetPath
    const sha256 = createHash('sha256').update(content).digest('hex')
    const fingerprint = createHash('sha256').update(JSON.stringify({
      device: '1', inode, size: content.length, mode, sha256,
    })).digest('hex')
    return {
      content,
      size: content.length,
      mode,
      device: '1',
      inode,
      linkCount: '1',
      mtimeNs: '1000000',
      ctimeNs: '1000000',
      sha256,
      fingerprint,
      executable: (mode & 0o111) !== 0,
    }
  }
}

interface FakeRuntime {
  fs: FakeDiscoveryFs
  commands: Map<string, string>
  versions: Map<string, VersionCommandResult>
  calls: string[]
  dependencies: DiscoveryDependencies
}

function fakeRuntime(): FakeRuntime {
  const fs = new FakeDiscoveryFs()
  const commands = new Map<string, string>()
  const versions = new Map<string, VersionCommandResult>()
  const calls: string[] = []
  const dependencies: DiscoveryDependencies = {
    fs: {
      lstat: targetPath => fs.lstat(targetPath),
      realpath: targetPath => fs.realpath(targetPath),
      readTextFile: (targetPath, maxBytes) => fs.readTextFile(targetPath, maxBytes),
      readStableFileMetadata: targetPath => fs.readStableFileMetadata(targetPath),
      readStableFileSnapshot: (targetPath, maxBytes) => fs.readStableFileSnapshot(targetPath, maxBytes),
    },
    async which(command) {
      calls.push(`which:${command}`)
      return commands.get(command)
    },
    async execVersion(executable, args, options) {
      calls.push(`execVersion:${executable}:${args.join(',')}:${options.timeoutMs}`)
      return versions.get(executable) ?? { exitCode: 0, stdout: '1.2.3', stderr: '' }
    },
    async inspectAppSignature(appBundleRealpath) {
      return fs.signatures.get(appBundleRealpath) ?? { valid: false }
    },
  }
  return { fs, commands, versions, calls, dependencies }
}

function addCommand(
  runtime: FakeRuntime,
  command: string,
  options: { realpath?: string; output?: string; verifiedPackageProvenance?: string } = {},
): string {
  const commandPath = `/fixture/bin/${command}`
  const realpath = options.realpath ?? commandPath
  runtime.commands.set(command, commandPath)
  runtime.fs.addFile(commandPath, realpath)
  runtime.versions.set(realpath, {
    exitCode: 0,
    stdout: options.output ?? `${command} 1.2.3`,
    stderr: '',
    ...(options.verifiedPackageProvenance
      ? { verifiedPackageProvenance: options.verifiedPackageProvenance }
      : {}),
  })
  return realpath
}

function context(overrides: Partial<Parameters<typeof discoverLocalP0Agents>[0]> = {}) {
  return {
    homeDir: HOME,
    osUserIdentity: USER_ID,
    operationTimeoutMs: 100,
    ...overrides,
  }
}

describe('P0 local Agent discovery', () => {
  it('has one exact, bounded probe for every reviewed P0.1/P0.2 surface', () => {
    expect(P0_DISCOVERY_PROBES.flatMap(probe => probe.kind === 'cli'
      ? [probe.catalogId, ...(probe.detectOnlyFallbackCatalogId ? [probe.detectOnlyFallbackCatalogId] : [])]
      : [probe.catalogId]).sort()).toEqual(
      [...P0_DISCOVERY_CATALOG_IDS].sort(),
    )
    expect(new Set(P0_DISCOVERY_PROBES.map(probe => probe.catalogId)).size).toBe(18)
  })

  it('discovers all P0 surfaces with stable canonical identity and provenance', async () => {
    const runtime = fakeRuntime()
    for (const command of [
      'codex', 'gemini', 'openclaw', 'qwen', 'zcode', 'opencode', 'opencode2',
    ]) {
      addCommand(runtime, command)
    }
    addCommand(runtime, 'claude', {
      verifiedPackageProvenance: 'npm_metadata:@anthropic-ai/claude-code',
    })
    addCommand(runtime, 'kimi', {
      verifiedPackageProvenance: 'npm_metadata:@moonshot-ai/kimi-code',
    })
    addCommand(runtime, 'pi', {
      realpath: '/fixture/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
      output: 'pi 0.52.1',
      verifiedPackageProvenance: 'npm_metadata:@mariozechner/pi-coding-agent',
    })
    addCommand(runtime, 'omp', {
      realpath: '/fixture/lib/node_modules/@oh-my-pi/pi-coding-agent/bin/omp.js',
      output: 'Oh My Pi 0.9.0',
      verifiedPackageProvenance: 'npm_metadata:@oh-my-pi/pi-coding-agent',
    })
    runtime.fs.addApp('Claude.app', {
      bundleId: 'com.anthropic.claudefordesktop',
      version: '1.0.10',
      signature: {
        valid: true,
        identifier: 'com.anthropic.claudefordesktop',
        teamIdentifier: 'Q6L2SF6YDW',
      },
    })
    runtime.fs.addApp('Codex.app', { bundleId: 'com.openai.codex', version: '0.1.2' })
    runtime.fs.addApp('Cursor.app', {
      bundleId: 'com.todesktop.230313mzl4w4u92',
      version: '2.3.4',
      signature: {
        valid: true,
        identifier: 'com.todesktop.230313mzl4w4u92',
        teamIdentifier: 'VDXQ22DGB9',
      },
    })
    runtime.fs.addApp('Windsurf.app', { bundleId: 'com.codeium.windsurf', version: '1.9.1' })
    runtime.fs.addApp('QwenWork.app', { bundleId: 'com.alibaba.qwenwork', version: '3.2.1' })
    runtime.fs.addApp('ZCode.app', {
      bundleId: 'dev.zcode.app',
      version: '3.9.1',
      signature: { valid: true, identifier: 'dev.zcode.app', teamIdentifier: '8A5X4JJ39T' },
    })
    runtime.fs.addDirectory(`${HOME}/.qwenworkcn`)

    const first = await discoverLocalP0Agents(context(), runtime.dependencies)
    const second = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect([
      ...first.installations.map(item => item.catalogId),
      ...first.unresolved.flatMap(item => item.catalogIds),
    ].sort()).toEqual(P0_DISCOVERY_CATALOG_IDS.filter(id =>
      id !== 'claude-code-native' && id !== 'kimi-code-native').sort())
    expect(first.installations.map(item => item.catalogId)).not.toContain('claude-cowork-local')
    expect(first).toEqual(second)
    expect(first.diagnostics).toEqual([])
    expect(first.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ catalogIds: ['claude-cowork-local'], reason: 'surface_identity_unproven' }),
    ]))
    expect(first.installations).toEqual(expect.arrayContaining([
      expect.objectContaining({ catalogId: 'codex-desktop' }),
      expect.objectContaining({ catalogId: 'windsurf-desktop' }),
      expect.objectContaining({ catalogId: 'qwenwork-desktop' }),
    ]))
    expect(first.installations.every(item => item.provenance.length >= 3)).toBe(true)
    expect(first.installations.every(item => item.identity.installKey.includes(item.catalogId))).toBe(true)
    expect(first.installations.find(item => item.catalogId === 'pi-official-cli')?.identity.distribution)
      .toMatchObject({
        distributionId: 'pi-official:@mariozechner/pi-coding-agent',
        packageProvenance: 'npm_metadata:@mariozechner/pi-coding-agent',
        capabilityFingerprint: 'pi-official-extension-api',
      })
    expect(first.installations.find(item => item.catalogId === 'omp-cli')?.identity.distribution)
      .toMatchObject({
        distributionId: 'omp:oh-my-pi',
        packageProvenance: 'npm_metadata:@oh-my-pi/pi-coding-agent',
        capabilityFingerprint: 'omp-native-profile',
      })
  })

  it('splits unproven Claude and Kimi native channels into persistent detect-only variants', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'claude', {
      realpath: '/fixture/.local/share/claude/versions/2.1.246',
      output: '2.1.246',
    })
    addCommand(runtime, 'kimi', {
      realpath: '/fixture/.kimi-code/bin/kimi',
      output: '1.20.0',
    })

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        catalogId: 'claude-code-native',
        identity: expect.objectContaining({ distribution: expect.objectContaining({
          distributionId: 'cli:claude-code-native',
          packageProvenance: undefined,
        }) }),
      }),
      expect.objectContaining({
        catalogId: 'kimi-code-native',
        identity: expect.objectContaining({ distribution: expect.objectContaining({
          distributionId: 'cli:kimi-code-native',
          packageProvenance: undefined,
        }) }),
      }),
    ]))
    expect(report.installations.map(item => item.catalogId)).not.toContain('claude-code-cli')
    expect(report.installations.map(item => item.catalogId)).not.toContain('kimi-code-cli')
  })

  it('only performs exact PATH, app bundle, config-root and Info.plist reads', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'codex')
    runtime.fs.addApp('Cursor.app', { bundleId: 'com.todesktop.230313mzl4w4u92' })

    await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(runtime.calls.every(call =>
      call.startsWith('which:') || /:--version:100$/u.test(call),
    )).toBe(true)
    expect(runtime.fs.calls.some(call => call.includes('Library/Keychains'))).toBe(false)
    expect(runtime.fs.calls.some(call => call.includes('/.ssh'))).toBe(false)
    expect(runtime.fs.calls.filter(call => call.startsWith('readTextFile:'))).toEqual([])
    expect(runtime.fs.calls.filter(call => call.startsWith('readStableFileSnapshot:/Applications/Cursor.app/Contents/Info.plist:262144')))
      .toHaveLength(4)
    expect(runtime.calls.filter(call => call.startsWith('execVersion:'))).toEqual([
      'execVersion:/fixture/bin/codex:--version:100',
    ])
  })

  it('does not treat a residual ZCode config directory as an installed CLI', async () => {
    const runtime = fakeRuntime()
    runtime.fs.addDirectory(`${HOME}/.zcode/cli`)

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'zcode-cli' }))
    expect(report.unresolved).not.toContainEqual(expect.objectContaining({ catalogIds: ['zcode-cli'] }))
    expect(runtime.calls).toContain('which:zcode')
  })

  it('fails closed for an unrelated pi command while preserving the evidence for diagnosis', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'pi', { realpath: '/usr/local/lib/acme-math/bin/pi', output: 'pi 3.14.0' })

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations.map(item => item.catalogId)).not.toContain('pi-official-cli')
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['pi-official-cli'],
      reason: 'distribution_identity_unproven',
    }))
  })

  it('does not infer strong identity from an official-looking node_modules path without metadata proof', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'pi', {
      realpath: '/tmp/fake/node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
      output: 'pi 0.52.1',
    })

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'pi-official-cli' }))
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['pi-official-cli'],
      reason: 'distribution_identity_unproven',
    }))
  })

  it('persists only verified package metadata, never a path-derived channel label', async () => {
    const proven = fakeRuntime()
    addCommand(proven, 'qwen', {
      realpath: '/tmp/node_modules/@qwen-code/qwen-code/dist/cli.js',
      verifiedPackageProvenance: 'npm_metadata:@qwen-code/qwen-code',
    })
    const provenReport = await discoverLocalP0Agents(context(), proven.dependencies)
    const provenQwen = provenReport.installations.find(item => item.catalogId === 'qwen-code-cli')!
    expect(toDiscoverInstallationInput(provenQwen, {
      id: 'installation_qwen_proven',
      lastDetectedAt: '2026-08-26T00:00:00.000Z',
    }).metadata).toMatchObject({
      distribution: { packageProvenance: 'npm_metadata:@qwen-code/qwen-code' },
    })

    const unproven = fakeRuntime()
    addCommand(unproven, 'qwen', {
      realpath: '/tmp/Cellar/qwen-code/1.2.3/bin/qwen',
      output: 'qwen 1.2.3',
    })
    const unprovenReport = await discoverLocalP0Agents(context(), unproven.dependencies)
    const unprovenQwen = unprovenReport.installations.find(item => item.catalogId === 'qwen-code-cli')!
    expect(unprovenQwen.identity.distribution.packageProvenance).toBeUndefined()
    expect(toDiscoverInstallationInput(unprovenQwen, {
      id: 'installation_qwen_unproven',
      lastDetectedAt: '2026-08-26T00:00:00.000Z',
    }).metadata).not.toMatchObject({
      distribution: expect.objectContaining({ packageProvenance: expect.any(String) }),
    })
  })

  it('recognizes both official Pi npm scopes without weakening package provenance', async () => {
    for (const packageName of [
      '@mariozechner/pi-coding-agent',
      '@earendil-works/pi-coding-agent',
    ]) {
      const runtime = fakeRuntime()
      addCommand(runtime, 'pi', {
        realpath: `/fixture/lib/node_modules/${packageName}/dist/cli.js`,
        output: 'pi 0.52.1',
        verifiedPackageProvenance: `npm_metadata:${packageName}`,
      })

      const report = await discoverLocalP0Agents(context(), runtime.dependencies)
      const pi = report.installations.find(item => item.catalogId === 'pi-official-cli')

      expect(pi?.identity.distribution).toMatchObject({
        distributionId: `pi-official:${packageName}`,
        packageProvenance: `npm_metadata:${packageName}`,
        capabilityFingerprint: 'pi-official-extension-api',
      })
      expect(report.unresolved).not.toContainEqual(expect.objectContaining({
        catalogIds: ['pi-official-cli'],
      }))
    }
  })

  it('keeps official Pi and OMP separate even when their config roots look related', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'pi', {
      realpath: '/fixture/node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
      verifiedPackageProvenance: 'npm_metadata:@mariozechner/pi-coding-agent',
    })
    addCommand(runtime, 'omp', {
      realpath: '/fixture/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js',
      output: 'Oh-My-Pi v1.4.0',
      verifiedPackageProvenance: 'npm_metadata:@oh-my-pi/pi-coding-agent',
    })

    const report = await discoverLocalP0Agents(context({
      environment: { PI_CODING_AGENT_DIR: `${HOME}/.pi/agent`, PI_CONFIG_DIR: '.pi' },
    }), runtime.dependencies)

    const pi = report.installations.find(item => item.catalogId === 'pi-official-cli')
    const omp = report.installations.find(item => item.catalogId === 'omp-cli')
    expect(pi?.identity.canonicalConfigRoot).toBe(omp?.identity.canonicalConfigRoot)
    expect(pi?.identity.installKey).not.toBe(omp?.identity.installKey)
    expect(pi?.identity.productFamilyId).not.toBe(omp?.identity.productFamilyId)
  })

  it('follows OMP default overrides and isolates named profiles using the official environment contract', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'omp', {
      realpath: '/fixture/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js',
      verifiedPackageProvenance: 'npm_metadata:@oh-my-pi/pi-coding-agent',
    })

    const overridden = await discoverLocalP0Agents(context({
      environment: {
        PI_CONFIG_DIR: '.config/omp',
        PI_CODING_AGENT_DIR: `${HOME}/custom-omp-agent`,
      },
    }), runtime.dependencies)
    expect(overridden.installations.find(item => item.catalogId === 'omp-cli')?.configRoot)
      .toBe(`${HOME}/custom-omp-agent`)

    const profiled = await discoverLocalP0Agents(context({
      environment: {
        PI_CONFIG_DIR: '.config/omp',
        PI_CODING_AGENT_DIR: `${HOME}/default-decoy`,
        OMP_PROFILE: 'work',
        PI_PROFILE: 'ignored',
      },
    }), runtime.dependencies)
    const profile = profiled.installations.find(item => item.catalogId === 'omp-cli')
    expect(profile?.configRoot).toBe(`${HOME}/.config/omp/profiles/work/agent`)
    expect(profile?.identity.explicitProfile).toBe('work')

    const legacyProfile = await discoverLocalP0Agents(context({
      environment: { PI_PROFILE: 'legacy' },
    }), runtime.dependencies)
    expect(legacyProfile.installations.find(item => item.catalogId === 'omp-cli')?.configRoot)
      .toBe(`${HOME}/.omp/profiles/legacy/agent`)

    const explicitDefault = await discoverLocalP0Agents(context({
      environment: {
        OMP_PROFILE: '',
        PI_PROFILE: 'must-not-leak',
        PI_CODING_AGENT_DIR: `${HOME}/explicit-default`,
      },
    }), runtime.dependencies)
    const defaultProfile = explicitDefault.installations.find(item => item.catalogId === 'omp-cli')
    expect(defaultProfile?.configRoot).toBe(`${HOME}/explicit-default`)
    expect(defaultProfile?.identity.explicitProfile).toBe('default')
  })

  it('fails closed for path-like OMP profiles and unsafe config-directory overrides', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'omp', {
      realpath: '/fixture/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js',
      verifiedPackageProvenance: 'npm_metadata:@oh-my-pi/pi-coding-agent',
    })

    for (const environment of [
      { OMP_PROFILE: '../work' },
      { PI_PROFILE: 'Work' },
      { PI_CONFIG_DIR: '../outside' },
      { PI_CODING_AGENT_DIR: 'relative/agent' },
    ]) {
      const report = await discoverLocalP0Agents(context({ environment }), runtime.dependencies)
      expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'omp-cli' }))
      expect(report.unresolved).toContainEqual(expect.objectContaining({
        catalogIds: ['omp-cli'],
        reason: 'invalid_environment_override',
      }))
    }
  })

  it('keeps OpenCode exact config and resource overrides independent when both are set', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'opencode', { output: 'opencode 1.8.0' })
    addCommand(runtime, 'opencode2', { output: 'opencode2 2.0.0-beta.2' })
    runtime.fs.addDirectory(`${HOME}/shared`)
    runtime.fs.addDirectory(`${HOME}/opencode-resources`, `${HOME}/canonical-resources`)

    const report = await discoverLocalP0Agents(context({
      environment: {
        OPENCODE_CONFIG: `${HOME}/shared/opencode.jsonc`,
        OPENCODE_CONFIG_DIR: `${HOME}/opencode-resources`,
      },
    }), runtime.dependencies)
    const v1 = report.installations.find(item => item.catalogId === 'opencode-v1-cli')
    const v2 = report.installations.find(item => item.catalogId === 'opencode-v2-beta-cli')

    expect(v1?.configRoot).toBe(`${HOME}/shared`)
    expect(v2?.configRoot).toBe(`${HOME}/shared`)
    expect(v1?.identity.componentConfigFiles).toEqual({
      memory_tools: `${HOME}/shared/opencode.jsonc`,
    })
    expect(v2?.identity.componentConfigFiles).toEqual({
      memory_tools: `${HOME}/shared/opencode.jsonc`,
    })
    expect(v1?.resourceRoots).toEqual({ opencode_resources: `${HOME}/canonical-resources` })
    expect(v2?.resourceRoots).toEqual({ opencode_resources: `${HOME}/canonical-resources` })
    expect(v1?.evidence).toContainEqual({
      kind: 'resource_root',
      source: `${HOME}/opencode-resources`,
      value: `${HOME}/canonical-resources`,
    })
    expect(toDiscoverInstallationInput(v1!, {
      id: 'installation_opencode_v1',
      lastDetectedAt: '2026-08-26T00:00:00.000Z',
    }).metadata).toMatchObject({
      componentConfigFiles: { memory_tools: `${HOME}/shared/opencode.jsonc` },
      resourceRoots: { opencode_resources: `${HOME}/canonical-resources` },
    })
    expect(v1?.identity.installKey).not.toBe(v2?.identity.installKey)
    expect(v1?.identity.distribution.capabilityFingerprint).toContain('opencode-v1-cli')
    expect(v2?.identity.distribution.capabilityFingerprint).toContain('opencode-v2-beta-cli')
  })

  it('records content-free CLI eligibility at the inclusive proof boundary', async () => {
    const atLimit = fakeRuntime()
    const atLimitExecutable = addCommand(atLimit, 'opencode', {
      output: 'opencode 1.8.0',
      verifiedPackageProvenance: 'npm_metadata:opencode-ai',
    })
    atLimit.fs.fileSizes.set(atLimitExecutable, MAX_CLI_EXECUTABLE_PROOF_BYTES)

    const eligibleReport = await discoverLocalP0Agents(context(), atLimit.dependencies)
    const eligible = eligibleReport.installations.find(item => item.catalogId === 'opencode-v1-cli')
    expect(eligible?.managementEligibility).toEqual({
      schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
      eligible: true,
      executableSizeBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
      proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
    })
    expect(toDiscoverInstallationInput(eligible!, {
      id: 'opencode-at-limit',
      lastDetectedAt: '2026-08-26T00:00:00.000Z',
    }).metadata).toMatchObject({
      managementEligibility: {
        schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
        eligible: true,
        executableSizeBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
        proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
      },
    })
    expect(atLimit.fs.calls).toContain(`readStableFileMetadata:${atLimitExecutable}`)
    expect(atLimit.fs.calls.some(call => call.startsWith(`readTextFile:${atLimitExecutable}:`))).toBe(false)

    const overLimit = fakeRuntime()
    const overLimitExecutable = addCommand(overLimit, 'opencode', {
      output: 'opencode 1.8.0',
      verifiedPackageProvenance: 'npm_metadata:opencode-ai',
    })
    overLimit.fs.fileSizes.set(overLimitExecutable, MAX_CLI_EXECUTABLE_PROOF_BYTES + 1)
    const ineligibleReport = await discoverLocalP0Agents(context(), overLimit.dependencies)
    const ineligible = ineligibleReport.installations.find(item => item.catalogId === 'opencode-v1-cli')
    expect(ineligible?.managementEligibility).toEqual({
      schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
      eligible: false,
      reason: 'executable_proof_too_large',
      executableSizeBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES + 1,
      proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
    })
    expect(overLimit.fs.calls).toContain(`readStableFileMetadata:${overLimitExecutable}`)
    expect(overLimit.fs.calls.some(call => call.startsWith(`readTextFile:${overLimitExecutable}:`))).toBe(false)
  })

  it('fails CLI management eligibility closed when the executable changes during passive version inspection', async () => {
    const runtime = fakeRuntime()
    const executable = addCommand(runtime, 'opencode', {
      output: 'opencode 1.8.0',
      verifiedPackageProvenance: 'npm_metadata:opencode-ai',
    })
    let releaseVersion!: () => void
    let versionStarted!: () => void
    const started = new Promise<void>(resolve => { versionStarted = resolve })
    const release = new Promise<void>(resolve => { releaseVersion = resolve })
    runtime.dependencies.execVersion = async () => {
      versionStarted()
      await release
      return runtime.versions.get(executable)!
    }

    const pending = discoverLocalP0Agents(context(), runtime.dependencies)
    await started
    runtime.fs.fileInodes.set(executable, `${executable}:replacement`)
    releaseVersion()
    const report = await pending
    const installation = report.installations.find(item => item.catalogId === 'opencode-v1-cli')

    expect(installation?.managementEligibility).toEqual({
      schemaVersion: CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
      eligible: false,
      reason: 'executable_metadata_unavailable',
      executableSizeBytes: 1_024,
      proofLimitBytes: MAX_CLI_EXECUTABLE_PROOF_BYTES,
    })
    expect(report.diagnostics).toContain('opencode-v1-cli:executable_metadata_changed:opencode')
    expect(runtime.fs.calls.filter(call => call === `readStableFileMetadata:${executable}`)).toHaveLength(2)
    expect(runtime.fs.calls.some(call => call.startsWith(`readTextFile:${executable}:`))).toBe(false)
  })

  it('does not reinterpret OPENCODE_CONFIG_DIR as the MCP config root', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'opencode', { output: 'opencode 1.8.0' })
    runtime.fs.addDirectory(`${HOME}/resources`)

    const report = await discoverLocalP0Agents(context({
      environment: { OPENCODE_CONFIG_DIR: `${HOME}/resources` },
    }), runtime.dependencies)
    const installation = report.installations.find(item => item.catalogId === 'opencode-v1-cli')

    expect(installation?.configRoot).toBe(`${HOME}/.config/opencode`)
    expect(installation?.identity.componentConfigFiles).toBeUndefined()
    expect(installation?.resourceRoots).toEqual({ opencode_resources: `${HOME}/resources` })
  })

  it('requires the official ZCode Desktop bundle signature and keeps the legacy CLI separate', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'zcode')
    runtime.fs.addApp('ZCode.app', {
      bundleId: 'dev.zcode.app',
      signature: { valid: true, identifier: 'dev.zcode.app', teamIdentifier: 'UNTRUSTED' },
    })

    const rejected = await discoverLocalP0Agents(context(), runtime.dependencies)
    expect(rejected.installations.map(item => item.catalogId)).toContain('zcode-cli')
    expect(rejected.installations.map(item => item.catalogId)).not.toContain('zcode-desktop')
    expect(rejected.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['zcode-desktop'],
      reason: 'distribution_identity_unproven',
    }))

    runtime.fs.signatures.set('/Applications/ZCode.app', {
      valid: true,
      identifier: 'dev.zcode.app',
      teamIdentifier: '8A5X4JJ39T',
    })
    const accepted = await discoverLocalP0Agents(context(), runtime.dependencies)
    const desktop = accepted.installations.find(item => item.catalogId === 'zcode-desktop')
    expect(desktop?.identity.distribution).toMatchObject({
      distributionId: 'dev.zcode.app',
      packageProvenance: 'signed_app:dev.zcode.app:8A5X4JJ39T',
    })
  })

  it.each([
    'missing_plist_key',
    'missing_target',
    'symbolic_link',
    'directory',
    'escaping_name',
  ] as const)('keeps a signed Desktop visible but unresolved when its main executable is %s', async scenario => {
    const runtime = fakeRuntime()
    const appPath = '/Applications/ZCode.app'
    const infoPath = `${appPath}/Contents/Info.plist`
    const executablePath = `${appPath}/Contents/MacOS/ZCode`
    runtime.fs.addApp('ZCode.app', {
      bundleId: 'dev.zcode.app',
      executable: 'ZCode',
      signature: { valid: true, identifier: 'dev.zcode.app', teamIdentifier: '8A5X4JJ39T' },
    })
    if (scenario === 'missing_plist_key') {
      runtime.fs.textFiles.set(infoPath, [
        '<plist><dict>',
        '<key>CFBundleIdentifier</key><string>dev.zcode.app</string>',
        '<key>CFBundleShortVersionString</key><string>1.2.3</string>',
        '</dict></plist>',
      ].join(''))
    } else if (scenario === 'missing_target') {
      runtime.fs.entries.delete(executablePath)
      runtime.fs.realpaths.delete(executablePath)
      runtime.fs.fileSizes.delete(executablePath)
    } else if (scenario === 'symbolic_link') {
      const external = '/fixture/external/ZCode'
      runtime.fs.addFile(external)
      runtime.fs.entries.set(executablePath, { kind: 'symbolic_link' })
      runtime.fs.realpaths.set(executablePath, external)
    } else if (scenario === 'directory') {
      runtime.fs.entries.set(executablePath, { kind: 'directory' })
    } else {
      runtime.fs.textFiles.set(infoPath, [
        '<plist><dict>',
        '<key>CFBundleIdentifier</key><string>dev.zcode.app</string>',
        '<key>CFBundleExecutable</key><string>../../../../external/ZCode</string>',
        '</dict></plist>',
      ].join(''))
    }

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'zcode-desktop' }))
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['zcode-desktop'],
      reason: 'surface_identity_unproven',
      summary: expect.stringContaining('CFBundleExecutable'),
    }))
  })

  it.each([
    'old_to_new_main',
    'file_to_same_directory_symlink',
    'whole_app_same_team_replacement',
  ] as const)('rejects a signed Desktop surface that changes across codesign: %s', async scenario => {
    const runtime = fakeRuntime()
    const appPath = '/Applications/ZCode.app'
    const infoPath = `${appPath}/Contents/Info.plist`
    const oldExecutable = `${appPath}/Contents/MacOS/Old`
    runtime.fs.addApp('ZCode.app', {
      bundleId: 'dev.zcode.app',
      executable: 'Old',
      signature: { valid: true, identifier: 'dev.zcode.app', teamIdentifier: '8A5X4JJ39T' },
    })
    runtime.dependencies.inspectAppSignature = async (_targetPath, options) => {
      if (scenario === 'old_to_new_main') {
        const nextPlist = [
          '<plist><dict>',
          '<key>CFBundleIdentifier</key><string>dev.zcode.app</string>',
          '<key>CFBundleExecutable</key><string>New</string>',
          '</dict></plist>',
        ].join('')
        runtime.fs.textFiles.set(infoPath, nextPlist)
        runtime.fs.addFile(`${appPath}/Contents/MacOS/New`)
      } else if (scenario === 'file_to_same_directory_symlink') {
        const sibling = `${appPath}/Contents/MacOS/SignedHelper`
        runtime.fs.addFile(sibling)
        runtime.fs.entries.set(oldExecutable, { kind: 'symbolic_link' })
        runtime.fs.realpaths.set(oldExecutable, sibling)
      } else {
        runtime.fs.fileInodes.set(infoPath, 'replacement-info-inode')
        runtime.fs.fileInodes.set(oldExecutable, 'replacement-executable-inode')
      }
      await options.beforeFinalVerification?.()
      return {
        valid: true,
        identifier: 'dev.zcode.app',
        teamIdentifier: '8A5X4JJ39T',
        verificationBoundary: 'strict_final',
      }
    }

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'zcode-desktop' }))
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['zcode-desktop'],
      reason: 'surface_identity_unproven',
    }))
  })

  it('keeps a signed Desktop with a non-executable CFBundleExecutable unresolved during fresh scan', async () => {
    const runtime = fakeRuntime()
    const executablePath = '/Applications/ZCode.app/Contents/MacOS/ZCode'
    runtime.fs.addApp('ZCode.app', {
      bundleId: 'dev.zcode.app',
      executable: 'ZCode',
      signature: { valid: true, identifier: 'dev.zcode.app', teamIdentifier: '8A5X4JJ39T' },
    })
    runtime.fs.fileModes.set(executablePath, 0o644)

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'zcode-desktop' }))
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['zcode-desktop'],
      reason: 'surface_identity_unproven',
    }))
    expect(report.diagnostics).toContain('zcode-desktop:bundle_surface:desktop_bundle_executable_mode_invalid')
  })

  it('rejects a user-writable Cursor bundle with a forged bundle ID and unapproved signing Team', async () => {
    const runtime = fakeRuntime()
    const appPath = `${HOME}/Applications/Cursor.app`
    runtime.fs.addApp('Cursor.app', {
      root: `${HOME}/Applications`,
      bundleId: 'com.todesktop.230313mzl4w4u92',
      signature: {
        valid: true,
        identifier: 'com.todesktop.230313mzl4w4u92',
        teamIdentifier: 'ATTACKERTEAM',
      },
    })

    const rejected = await discoverLocalP0Agents(context(), runtime.dependencies)
    expect(rejected.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'cursor-desktop' }))
    expect(rejected.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['cursor-desktop'],
      reason: 'distribution_identity_unproven',
    }))

    runtime.fs.signatures.set(appPath, {
      valid: true,
      identifier: 'com.todesktop.230313mzl4w4u92',
      teamIdentifier: 'VDXQ22DGB9',
    })
    const accepted = await discoverLocalP0Agents(context(), runtime.dependencies)
    expect(accepted.installations.find(item => item.catalogId === 'cursor-desktop')?.identity.distribution)
      .toMatchObject({
        distributionId: 'com.todesktop.230313mzl4w4u92',
        packageProvenance: 'signed_app:com.todesktop.230313mzl4w4u92:VDXQ22DGB9',
      })
  })

  it('does not infer real Cowork from the legacy Claude Desktop bundle or config', async () => {
    const runtime = fakeRuntime()
    runtime.fs.addApp('Claude.app', {
      bundleId: 'com.anthropic.claudefordesktop',
      signature: {
        valid: true,
        identifier: 'com.anthropic.claudefordesktop',
        teamIdentifier: 'Q6L2SF6YDW',
      },
    })
    runtime.fs.addDirectory(path.posix.join(HOME, 'Library', 'Application Support', 'Claude'))

    const legacyOnly = await discoverLocalP0Agents(context(), runtime.dependencies)
    expect(legacyOnly.installations.map(item => item.catalogId)).toContain('claude-desktop-legacy')
    expect(legacyOnly.installations.map(item => item.catalogId)).not.toContain('claude-cowork-local')
    expect(legacyOnly.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['claude-cowork-local'],
      reason: 'surface_identity_unproven',
    }))

    // Even a Cowork-looking directory is not host-loaded Plugin/Connector
    // evidence. The detector remains fail-closed until an official registry
    // contract exists.
    runtime.fs.addDirectory(path.posix.join(HOME, '.claude', 'cowork'))
    const stillUnproven = await discoverLocalP0Agents(context(), runtime.dependencies)
    expect(stillUnproven.installations.map(item => item.catalogId)).not.toContain('claude-cowork-local')
  })

  it('respects explicit config roots and records executable/config symlink realpaths', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'qwen', {
      realpath: '/opt/qwen/lib/node_modules/@qwen-code/qwen-code/dist/cli.js',
      output: 'Qwen Code v0.8.1',
    })
    runtime.fs.addDirectory(`${HOME}/qwen-link`, `${HOME}/profiles/qwen-default`)

    const report = await discoverLocalP0Agents(context({
      environment: { QWEN_HOME: '~/qwen-link' },
    }), runtime.dependencies)
    const qwen = report.installations.find(item => item.catalogId === 'qwen-code-cli')

    expect(qwen).toMatchObject({
      configRoot: `${HOME}/profiles/qwen-default`,
      executablePath: '/opt/qwen/lib/node_modules/@qwen-code/qwen-code/dist/cli.js',
      detectedVersion: '0.8.1',
      versionDetectionMethod: 'cli_version',
    })
    expect(qwen?.evidence).toContainEqual({
      kind: 'config_root',
      source: `${HOME}/qwen-link`,
      value: `${HOME}/profiles/qwen-default`,
    })
  })

  it('persists QwenWork as bundle-ID-bound detect-only until an authoritative signing Team is frozen', async () => {
    const runtime = fakeRuntime()
    runtime.fs.addApp('QwenWork.app', { bundleId: 'com.alibaba.qwenwork' })
    runtime.fs.addDirectory(`${HOME}/.qwenworkcn`)
    runtime.fs.addDirectory(`${HOME}/.qwenwork`)

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)
    const qwenWork = report.installations.find(item => item.catalogId === 'qwenwork-desktop')
    expect(qwenWork).toMatchObject({
      configRoot: `${HOME}/.qwenwork`,
      componentConfigRoots: {
        instruction: `${HOME}/.qwenworkcn`,
        lifecycle: `${HOME}/.qwenwork`,
      },
      identity: {
        distribution: {
          distributionId: 'com.alibaba.qwenwork',
          packageProvenance: 'app_bundle:com.alibaba.qwenwork',
        },
      },
    })
    expect(report.unresolved).not.toContainEqual(expect.objectContaining({
      catalogIds: ['qwenwork-desktop'],
    }))
  })

  it('fails closed on a relative environment override', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'kimi')

    const report = await discoverLocalP0Agents(context({
      environment: { KIMI_CODE_HOME: 'relative/kimi' },
    }), runtime.dependencies)

    expect(report.installations.map(item => item.catalogId)).not.toContain('kimi-code-cli')
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['kimi-code-cli', 'kimi-code-native'],
      reason: 'invalid_environment_override',
    }))
  })

  it('deduplicates CLI aliases only when they resolve to the same physical executable', async () => {
    const runtime = fakeRuntime()
    const sharedRealpath = '/fixture/node_modules/kimi-code/dist/cli.js'
    addCommand(runtime, 'kimi', {
      realpath: sharedRealpath,
      output: 'kimi 0.30.0',
      verifiedPackageProvenance: 'npm_metadata:@moonshot-ai/kimi-code',
    })
    addCommand(runtime, 'kimi-code', {
      realpath: sharedRealpath,
      output: 'kimi-code 0.30.0',
      verifiedPackageProvenance: 'npm_metadata:@moonshot-ai/kimi-code',
    })

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)
    const kimi = report.installations.filter(item => item.catalogId === 'kimi-code-cli')

    expect(kimi).toHaveLength(1)
    expect(kimi[0].identity.distribution.distributionId).toBe('cli:kimi-code-cli')
    expect(report.unresolved).toEqual([])
  })

  it('fails closed when stable and beta app bundles share one unowned scope', async () => {
    const runtime = fakeRuntime()
    const signature = {
      valid: true,
      identifier: 'com.todesktop.230313mzl4w4u92',
      teamIdentifier: 'VDXQ22DGB9',
    }
    runtime.fs.addApp('Cursor.app', {
      bundleId: 'com.todesktop.230313mzl4w4u92', version: '2.0.0', signature,
    })
    runtime.fs.addApp('Cursor Beta.app', {
      bundleId: 'com.todesktop.230313mzl4w4u92', version: '2.1.0-beta.1', signature,
    })

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations.map(item => item.catalogId)).not.toContain('cursor-desktop')
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['cursor-desktop'],
      reason: 'multiple_installations_ambiguous',
    }))
  })

  it('keeps an unproven bundle-name diagnostic but creates no Installation', async () => {
    const runtime = fakeRuntime()
    runtime.fs.addDirectory('/Applications/Codex.app')

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'codex-desktop' }))
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['codex-desktop'],
      reason: 'surface_identity_unproven',
    }))
    expect(report.diagnostics).toContain('codex-desktop:bundle_surface:desktop_bundle_info_plist_not_regular')
  })

  it('bounds a hung PATH probe and returns a stable diagnostic instead of hanging the scan', async () => {
    const runtime = fakeRuntime()
    runtime.dependencies.which = async command => {
      if (command !== 'zcode') return undefined
      return await new Promise<string>(() => {})
    }

    const report = await discoverLocalP0Agents(context({ operationTimeoutMs: 10 }), runtime.dependencies)

    expect(report.installations).toEqual([])
    expect(report.diagnostics).toContain('zcode-cli:which:zcode:timeout')
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['zcode-cli'],
      reason: 'probe_inaccessible',
    }))
  })

  it('preserves prior app state when a bundle location cannot be inspected', async () => {
    const runtime = fakeRuntime()
    const lstat = runtime.fs.lstat.bind(runtime.fs)
    runtime.dependencies.fs.lstat = async targetPath => {
      if (targetPath === '/Applications/Cursor.app') {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return lstat(targetPath)
    }

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({
      catalogId: 'cursor-desktop',
    }))
    expect(report.diagnostics).toContain('cursor-desktop:app_bundle:Cursor.app:EACCES')
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['cursor-desktop'],
      reason: 'probe_inaccessible',
    }))
  })

  it('does not refresh a CLI Installation as discovered when its config root is inaccessible', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'codex')
    const lstat = runtime.fs.lstat.bind(runtime.fs)
    runtime.dependencies.fs.lstat = async targetPath => {
      if (targetPath === `${HOME}/.codex`) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return lstat(targetPath)
    }

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'codex-cli' }))
    expect(report.diagnostics).toContain('codex-cli:config_root:EACCES')
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['codex-cli'],
      reason: 'probe_inaccessible',
    }))
  })

  it('does not refresh an app Installation as discovered when its config root probe times out', async () => {
    const runtime = fakeRuntime()
    runtime.fs.addApp('Cursor.app', {
      bundleId: 'com.todesktop.230313mzl4w4u92',
      signature: {
        valid: true,
        identifier: 'com.todesktop.230313mzl4w4u92',
        teamIdentifier: 'VDXQ22DGB9',
      },
    })
    const lstat = runtime.fs.lstat.bind(runtime.fs)
    runtime.dependencies.fs.lstat = async targetPath => {
      if (targetPath === `${HOME}/.cursor`) {
        return await new Promise<DiscoveryPathStat>(() => {})
      }
      return lstat(targetPath)
    }

    const report = await discoverLocalP0Agents(context({ operationTimeoutMs: 10 }), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'cursor-desktop' }))
    expect(report.diagnostics).toContain('cursor-desktop:config_root:timeout')
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['cursor-desktop'],
      reason: 'probe_inaccessible',
    }))
  })

  it('maps a confirmed observation to the repository without inventing time or IDs', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'codex', { output: 'codex-cli 0.121.0' })
    const report = await discoverLocalP0Agents(context(), runtime.dependencies)
    const codex = report.installations.find(item => item.catalogId === 'codex-cli')!

    expect(toDiscoverInstallationInput(codex, {
      id: 'installation_fixture',
      lastDetectedAt: '2026-08-25T12:00:00.000Z',
    })).toMatchObject({
      id: 'installation_fixture',
      family: 'codex',
      hostVariant: 'codex-cli',
      runtimeRealm: 'local_macos',
      installKey: codex.identity.installKey,
      distributionId: 'cli:codex-cli',
      configRoot: `${HOME}/.codex`,
      executablePath: '/fixture/bin/codex',
      detectedVersion: '0.121.0',
      versionDetectionMethod: 'cli_version',
      supportedCapability: 4,
      lastDetectedAt: '2026-08-25T12:00:00.000Z',
      metadata: { discoverySchemaVersion: 1, explicitProfile: 'default' },
    })
  })
})
