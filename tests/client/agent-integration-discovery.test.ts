import path from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  P0_DISCOVERY_CATALOG_IDS,
  P0_DISCOVERY_PROBES,
  CLI_MANAGEMENT_ELIGIBILITY_SCHEMA_VERSION,
  discoverClaudeCoworkGuidedCandidate,
  discoverLocalP0Agents,
  MAX_CLI_EXECUTABLE_PROOF_BYTES,
  signedCodePortableArtifactFingerprint,
  toDiscoverInstallationInput,
  type AppCodeSignatureResult,
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
  readonly signatures = new Map<string, AppCodeSignatureResult>()
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

  async readDirectoryNames(targetPath: string, maxEntries: number) {
    this.calls.push(`readDirectoryNames:${targetPath}:${maxEntries}`)
    if (this.entries.get(targetPath)?.kind !== 'directory') return undefined
    const prefix = `${targetPath.replace(/\/$/u, '')}/`
    const names = [...new Set(
      [...this.entries.keys()]
        .filter(candidate => candidate.startsWith(prefix))
        .map(candidate => candidate.slice(prefix.length))
        .filter(relative => relative.length > 0 && !relative.includes('/')),
    )].sort((left, right) => left.localeCompare(right))
    return {
      names: names.slice(0, maxEntries),
      truncated: names.length > maxEntries,
    }
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

  async readStableFileFingerprint(targetPath: string, maxBytes: number) {
    this.calls.push(`readStableFileFingerprint:${targetPath}:${maxBytes}`)
    const size = this.fileSizes.get(targetPath)
    if (size === undefined || size > maxBytes) throw Object.assign(new Error('missing or oversized fixture file'), { code: 'ENOENT' })
    const mode = this.fileModes.get(targetPath) ?? 0o755
    const inode = this.fileInodes.get(targetPath) ?? targetPath
    const sha256 = createHash('sha256').update(JSON.stringify({ targetPath, inode, size })).digest('hex')
    return {
      size,
      mode,
      device: '1',
      inode,
      linkCount: '1',
      mtimeNs: '1000000',
      ctimeNs: '1000000',
      sha256,
      fingerprint: createHash('sha256').update(JSON.stringify({ device: '1', inode, size, mode, sha256 })).digest('hex'),
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
      readDirectoryNames: (targetPath, maxEntries) => fs.readDirectoryNames(targetPath, maxEntries),
      readTextFile: (targetPath, maxBytes) => fs.readTextFile(targetPath, maxBytes),
      readStableFileMetadata: targetPath => fs.readStableFileMetadata(targetPath),
      readStableFileSnapshot: (targetPath, maxBytes) => fs.readStableFileSnapshot(targetPath, maxBytes),
      readStableFileFingerprint: (targetPath, maxBytes) => fs.readStableFileFingerprint(targetPath, maxBytes),
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
    async inspectExecutableArchitecture() {
      return 'arm64'
    },
  }
  return { fs, commands, versions, calls, dependencies }
}

function addCommand(
  runtime: FakeRuntime,
  command: string,
  options: {
    realpath?: string
    output?: string
    verifiedPackageProvenance?: string
    portableArtifactFingerprint?: string
  } = {},
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
    ...(options.portableArtifactFingerprint
      ? { portableArtifactFingerprint: options.portableArtifactFingerprint }
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

function exactSignedCode(identifier: string, teamIdentifier: string): AppCodeSignatureResult {
  return {
    valid: true,
    identifier,
    teamIdentifier,
    cdHash: '28d49821f609d871c2282bdec52116bd91ea5806',
    designatedRequirement: `identifier "${identifier}" and anchor apple generic`,
    verificationBoundary: 'strict_final',
  }
}

describe('P0 local Agent discovery', () => {
  it('uses the same signed-code portable canonical payload as the release receipt', async () => {
    const runtime = fakeRuntime()
    const executable = '/fixture/signed-code'
    runtime.fs.addFile(executable, executable, 1_024, 0o755)
    const proof = await runtime.fs.readStableFileFingerprint(executable, MAX_CLI_EXECUTABLE_PROOF_BYTES)
    const signature = exactSignedCode('dev.zcode.app', '8A5X4JJ39T')
    expect(signedCodePortableArtifactFingerprint({ version: '3.10.2', executable: proof, signature }))
      .toBe(createHash('sha256').update(JSON.stringify({
        schema: 'signed-code-v1',
        version: '3.10.2',
        executable: { sha256: proof.sha256, sizeBytes: proof.size, executable: true },
        identifier: signature.identifier,
        teamIdentifier: signature.teamIdentifier,
        cdHash: signature.cdHash,
        designatedRequirement: signature.designatedRequirement,
      })).digest('hex'))
    expect(signedCodePortableArtifactFingerprint({
      version: '3.10.2',
      executable: proof,
      signature: { ...signature, verificationBoundary: undefined },
    })).toBeUndefined()
  })

  it.each([
    ['claude-desktop-legacy', 'Claude.app', 'com.anthropic.claudefordesktop', 'Q6L2SF6YDW', 'Claude'],
    ['codex-desktop', 'ChatGPT.app', 'com.openai.codex', '2DC432GLL2', 'ChatGPT'],
    ['codex-desktop', 'Codex.app', 'com.openai.codex', '2DC432GLL2', 'Codex'],
    ['cursor-desktop', 'Cursor.app', 'com.todesktop.230313mzl4w4u92', 'VDXQ22DGB9', 'Cursor'],
    ['windsurf-desktop', 'Devin.app', 'com.exafunction.windsurf', '83Z2LHX6XW', 'Devin'],
    ['qwenwork-desktop', 'QwenWorkCN.app', 'cn.qwenwork.desktop.mac', 'XN6U3EV979', 'QwenWorkCN'],
    ['zcode-desktop', 'ZCode.app', 'dev.zcode.app', '8A5X4JJ39T', 'ZCode'],
  ] as const)('emits a release-matchable signed receipt for %s', async (
    catalogId, bundleName, bundleId, teamIdentifier, executable,
  ) => {
    const runtime = fakeRuntime()
    runtime.fs.addApp(bundleName, {
      bundleId,
      version: '1.2.3',
      executable,
      signature: exactSignedCode(bundleId, teamIdentifier),
    })
    if (catalogId === 'qwenwork-desktop') runtime.fs.addDirectory(`${HOME}/.qwenworkcn`)
    if (catalogId === 'windsurf-desktop') runtime.fs.addDirectory(`${HOME}/.config/devin`)
    const report = await discoverLocalP0Agents(context(), runtime.dependencies)
    expect(report.installations.find(item => item.catalogId === catalogId)?.identity.distribution)
      .toMatchObject({ portableArtifactFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) })
  })

  it('fails closed when signed legacy and renamed Codex Desktop bundles coexist', async () => {
    const runtime = fakeRuntime()
    for (const [bundleName, executable] of [
      ['ChatGPT.app', 'ChatGPT'],
      ['Codex.app', 'Codex'],
    ] as const) {
      runtime.fs.addApp(bundleName, {
        bundleId: 'com.openai.codex',
        executable,
        signature: exactSignedCode('com.openai.codex', '2DC432GLL2'),
      })
    }

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'codex-desktop' }))
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['codex-desktop'],
      reason: 'multiple_installations_ambiguous',
    }))
  })

  it.each([
    ['ChatGPT.app', 'com.openai.codex', 'ATTACKERTEAM'],
    ['Codex.app', 'com.attacker.codex', '2DC432GLL2'],
  ] as const)('does not trust the Codex Desktop bundle name without its exact identity: %s', async (
    bundleName, bundleId, teamIdentifier,
  ) => {
    const runtime = fakeRuntime()
    runtime.fs.addApp(bundleName, {
      bundleId,
      executable: bundleName === 'ChatGPT.app' ? 'ChatGPT' : 'Codex',
      signature: exactSignedCode(bundleId, teamIdentifier),
    })

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'codex-desktop' }))
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['codex-desktop'],
      reason: 'distribution_identity_unproven',
    }))
  })

  it('emits the same signed receipt for the explicitly guided Cowork surface', async () => {
    const runtime = fakeRuntime()
    runtime.fs.addApp('Claude.app', {
      bundleId: 'com.anthropic.claudefordesktop',
      version: '1.2.3',
      executable: 'Claude',
      signature: exactSignedCode('com.anthropic.claudefordesktop', 'Q6L2SF6YDW'),
    })
    runtime.fs.addDirectory(path.posix.join(HOME, 'Library', 'Application Support', 'Claude'))
    const report = await discoverClaudeCoworkGuidedCandidate(context(), runtime.dependencies)
    expect(report.installations[0]?.identity.distribution.portableArtifactFingerprint)
      .toMatch(/^[a-f0-9]{64}$/u)
  })

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
      portableArtifactFingerprint: 'a'.repeat(64),
    })
    addCommand(runtime, 'omp', {
      realpath: '/fixture/lib/node_modules/@oh-my-pi/pi-coding-agent/bin/omp.js',
      output: 'Oh My Pi 0.9.0',
      verifiedPackageProvenance: 'npm_metadata:@oh-my-pi/pi-coding-agent',
      portableArtifactFingerprint: 'b'.repeat(64),
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
    runtime.fs.addApp('ChatGPT.app', {
      bundleId: 'com.openai.codex',
      version: '26.825.51511',
      executable: 'ChatGPT',
      signature: {
        valid: true,
        identifier: 'com.openai.codex',
        teamIdentifier: '2DC432GLL2',
      },
    })
    runtime.fs.addApp('Cursor.app', {
      bundleId: 'com.todesktop.230313mzl4w4u92',
      version: '2.3.4',
      signature: {
        valid: true,
        identifier: 'com.todesktop.230313mzl4w4u92',
        teamIdentifier: 'VDXQ22DGB9',
      },
    })
    runtime.fs.addApp('Devin.app', {
      bundleId: 'com.exafunction.windsurf',
      version: '3.8.20',
      executable: 'Devin',
      signature: {
        valid: true,
        identifier: 'com.exafunction.windsurf',
        teamIdentifier: '83Z2LHX6XW',
      },
    })
    runtime.fs.addApp('QwenWorkCN.app', {
      bundleId: 'cn.qwenwork.desktop.mac',
      version: '1.2.0',
      executable: 'QwenWorkCN',
      signature: {
        valid: true,
        identifier: 'cn.qwenwork.desktop.mac',
        teamIdentifier: 'XN6U3EV979',
      },
    })
    runtime.fs.addApp('ZCode.app', {
      bundleId: 'dev.zcode.app',
      version: '3.9.1',
      signature: { valid: true, identifier: 'dev.zcode.app', teamIdentifier: '8A5X4JJ39T' },
    })
    runtime.fs.addDirectory(`${HOME}/.qwenworkcn`)
    runtime.fs.addDirectory(`${HOME}/.config/devin`)

    const first = await discoverLocalP0Agents(context(), runtime.dependencies)
    const second = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect([
      ...first.installations.map(item => item.catalogId),
      ...first.unresolved.flatMap(item => item.catalogIds),
    ].sort()).toEqual(P0_DISCOVERY_CATALOG_IDS.filter(id =>
      id !== 'claude-code-native'
        && id !== 'kimi-code-native'
        && id !== 'claude-cowork-local').sort())
    expect(first.installations.map(item => item.catalogId)).not.toContain('claude-cowork-local')
    expect(first).toEqual(second)
    expect(first.diagnostics).toEqual([])
    expect(first.unresolved).not.toContainEqual(expect.objectContaining({
      catalogIds: ['claude-cowork-local'],
    }))
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
        portableArtifactFingerprint: 'a'.repeat(64),
      })
    expect(first.installations.find(item => item.catalogId === 'omp-cli')?.identity.distribution)
      .toMatchObject({
        distributionId: 'omp:oh-my-pi',
        packageProvenance: 'npm_metadata:@oh-my-pi/pi-coding-agent',
        capabilityFingerprint: 'omp-native-profile',
        portableArtifactFingerprint: 'b'.repeat(64),
      })
  })

  it('splits unproven Claude and Kimi native channels into persistent detect-only variants', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'claude', {
      realpath: '/fixture/.local/share/claude/versions/2.1.246',
      output: '2.1.246',
    })
    addCommand(runtime, 'kimi', {
      realpath: `${HOME}/.kimi-code/bin/kimi`,
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

  it('promotes only the platform-attested Anthropic native executable to signed provenance', async () => {
    const runtime = fakeRuntime()
    const executable = addCommand(runtime, 'claude', {
      realpath: '/fixture/.local/share/claude/versions/2.1.252',
      output: '2.1.252',
    })
    runtime.fs.signatures.set(executable, {
      valid: true,
      identifier: 'com.anthropic.claude-code',
      teamIdentifier: 'Q6L2SF6YDW',
      cdHash: '28d49821f609d871c2282bdec52116bd91ea5806',
      designatedRequirement: 'identifier "com.anthropic.claude-code" and anchor apple generic',
      verificationBoundary: 'strict_final',
    })

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)
    const installation = report.installations.find(item => item.catalogId === 'claude-code-native')
    expect(installation?.identity.distribution).toMatchObject({
      executableRealpath: executable,
      packageProvenance: 'signed_cli:com.anthropic.claude-code:Q6L2SF6YDW',
    })
    expect(installation?.identity.distribution.capabilityFingerprint)
      .toMatch(/^signed-cli-surface-v1:[a-f0-9]{64}$/u)
    expect(report.installations.map(item => item.catalogId)).not.toContain('claude-code-cli')
  })

  it('recognizes signed Kimi without updater metadata but leaves version unaccepted without a frozen receipt', async () => {
    const runtime = fakeRuntime()
    const executable = addCommand(runtime, 'kimi', {
      realpath: `${HOME}/.kimi-code/bin/kimi`,
      output: '1.20.0',
    })
    runtime.fs.signatures.set(executable, {
      valid: true,
      identifier: 'kimi',
      teamIdentifier: '2J9472RW75',
      cdHash: 'bb4cdfad0d4aeb516ba70c5179a7ad23b7d7bbc2',
      designatedRequirement: 'identifier kimi and anchor apple generic',
      verificationBoundary: 'strict_final',
    })

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)
    const installation = report.installations.find(item => item.catalogId === 'kimi-code-native')
    expect(installation?.identity.distribution).toMatchObject({
      executableRealpath: executable,
      packageProvenance: 'signed_cli:kimi:2J9472RW75',
    })
    expect(installation?.identity.distribution.capabilityFingerprint)
      .toMatch(/^signed-cli-kimi-receipt-lookup-v1:[a-f0-9]{64}$/u)
    expect(installation?.detectedVersion).toBeUndefined()
    expect(runtime.calls.some(call => call.startsWith(`execVersion:${executable}:`))).toBe(false)
    expect(report.installations.map(item => item.catalogId)).not.toContain('kimi-code-cli')

    const lookupFingerprint = installation!.identity.distribution.capabilityFingerprint!.split(':')[1]!
    runtime.dependencies.resolveKimiNativeReceipt = surface => (
      surface.architecture === 'arm64' && surface.lookupFingerprint === lookupFingerprint
        ? { version: '0.41.0', portableArtifactFingerprint: 'a'.repeat(64) }
        : null
    )
    const accepted = await discoverLocalP0Agents(context(), runtime.dependencies)
    expect(accepted.installations.find(item => item.catalogId === 'kimi-code-native')).toMatchObject({
      detectedVersion: '0.41.0',
      versionDetectionMethod: 'release_receipt',
      identity: { distribution: { portableArtifactFingerprint: 'a'.repeat(64) } },
    })
  })

  it('never applies the npm Kimi identity to the distinct native updater surface', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'kimi', {
      realpath: `${HOME}/.kimi-code/bin/kimi`,
      output: '0.40.1',
      verifiedPackageProvenance: 'npm_metadata:@moonshot-ai/kimi-code',
    })

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)
    const native = report.installations.find(item => item.catalogId === 'kimi-code-native')
    expect(native?.identity.distribution).toMatchObject({
      distributionId: 'cli:kimi-code-native',
      packageProvenance: undefined,
    })
    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'kimi-code-cli' }))
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

  it('does not let an unproved PATH shadow hide a later official npm candidate', async () => {
    const runtime = fakeRuntime()
    const shadow = '/fixture/shadow/qwen'
    const official = `${HOME}/.nvm/versions/node/v22.18.0/bin/qwen`
    runtime.fs.addFile(shadow)
    runtime.fs.addFile(official)
    runtime.versions.set(shadow, {
      exitCode: 0,
      stdout: 'qwen 9.9.9',
      stderr: '',
    })
    runtime.versions.set(official, {
      exitCode: 0,
      stdout: 'qwen 0.21.13',
      stderr: '',
      verifiedPackageProvenance: 'npm_metadata:@qwen-code/qwen-code',
      packageMetadataFingerprint: 'physical-qwen-proof',
      portableArtifactFingerprint: 'portable-qwen-proof',
    })
    runtime.dependencies.whichAll = async command => command === 'qwen'
      ? [shadow, official]
      : []

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations.filter(item => item.catalogId === 'qwen-code-cli')).toHaveLength(1)
    expect(report.installations.find(item => item.catalogId === 'qwen-code-cli')).toMatchObject({
      executablePath: official,
      detectedVersion: '0.21.13',
      identity: {
        distribution: {
          packageProvenance: 'npm_metadata:@qwen-code/qwen-code',
        },
      },
    })
    expect(report.unresolved).not.toContainEqual(expect.objectContaining({
      catalogIds: ['qwen-code-cli'],
    }))
  })

  it('preserves ambiguity when two distinct candidates both prove official provenance', async () => {
    const runtime = fakeRuntime()
    const first = `${HOME}/.nvm/versions/node/v20.19.0/bin/qwen`
    const second = `${HOME}/.nvm/versions/node/v22.18.0/bin/qwen`
    for (const [candidate, version] of [[first, '0.20.0'], [second, '0.21.13']] as const) {
      runtime.fs.addFile(candidate)
      runtime.versions.set(candidate, {
        exitCode: 0,
        stdout: `qwen ${version}`,
        stderr: '',
        verifiedPackageProvenance: 'npm_metadata:@qwen-code/qwen-code',
        packageMetadataFingerprint: `physical-${version}`,
        portableArtifactFingerprint: `portable-${version}`,
      })
    }
    runtime.dependencies.whichAll = async command => command === 'qwen' ? [first, second] : []

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'qwen-code-cli' }))
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['qwen-code-cli'],
      reason: 'multiple_installations_ambiguous',
    }))
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
      if (packageName.startsWith('@earendil-works/')) {
        expect(pi?.managementEligibility?.eligible).toBe(true)
        expect(pi?.managementEligibility?.reason).toBeUndefined()
      } else {
        expect(pi?.managementEligibility).toMatchObject({
          eligible: false,
          reason: 'distribution_not_managed',
        })
      }
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

  it('enumerates OMP named profile agent roots while keeping the default override independent', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'omp', {
      realpath: '/fixture/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js',
      verifiedPackageProvenance: 'npm_metadata:@oh-my-pi/pi-coding-agent',
    })
    runtime.fs.addDirectory(`${HOME}/.config/omp/profiles`)
    runtime.fs.addDirectory(`${HOME}/.config/omp/profiles/personal`)
    runtime.fs.addDirectory(`${HOME}/.config/omp/profiles/personal/agent`)
    runtime.fs.addDirectory(`${HOME}/.config/omp/profiles/work`)
    runtime.fs.addDirectory(`${HOME}/.config/omp/profiles/work/agent`)
    runtime.fs.addDirectory(`${HOME}/.config/omp/profiles/missing-agent`)
    runtime.fs.addDirectory(`${HOME}/.config/omp/profiles/Work`)
    runtime.fs.addDirectory(`${HOME}/.config/omp/profiles/Work/agent`)
    runtime.fs.addDirectory(
      `${HOME}/.config/omp/profiles/linked`,
      `${HOME}/outside/linked-profile`,
    )
    runtime.fs.addDirectory(`${HOME}/outside/linked-profile/agent`)

    const report = await discoverLocalP0Agents(context({
      environment: {
        PI_CONFIG_DIR: '.config/omp',
        PI_CODING_AGENT_DIR: `${HOME}/custom-default-agent`,
      },
    }), runtime.dependencies)
    const omp = report.installations.filter(item => item.catalogId === 'omp-cli')

    expect(omp.map(item => ({
      profile: item.identity.explicitProfile,
      root: item.identity.canonicalConfigRoot,
    }))).toEqual([
      { profile: 'default', root: `${HOME}/custom-default-agent` },
      { profile: 'personal', root: `${HOME}/.config/omp/profiles/personal/agent` },
      { profile: 'work', root: `${HOME}/.config/omp/profiles/work/agent` },
    ])
    expect(new Set(omp.map(item => item.identity.installKey)).size).toBe(3)
  })

  it('does not enumerate sibling OMP profiles when OMP_PROFILE or PI_PROFILE selects one', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'omp', {
      realpath: '/fixture/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js',
      verifiedPackageProvenance: 'npm_metadata:@oh-my-pi/pi-coding-agent',
    })
    runtime.fs.addDirectory(`${HOME}/.omp/profiles`)
    runtime.fs.addDirectory(`${HOME}/.omp/profiles/personal`)
    runtime.fs.addDirectory(`${HOME}/.omp/profiles/personal/agent`)

    const report = await discoverLocalP0Agents(context({
      environment: { OMP_PROFILE: 'work', PI_PROFILE: 'personal' },
    }), runtime.dependencies)
    const omp = report.installations.filter(item => item.catalogId === 'omp-cli')

    expect(omp).toHaveLength(1)
    expect(omp[0].identity.explicitProfile).toBe('work')
    expect(omp[0].identity.canonicalConfigRoot).toBe(`${HOME}/.omp/profiles/work/agent`)
    expect(runtime.calls).not.toContain(`readDirectoryNames:${HOME}/.omp/profiles:256`)
  })

  it('fails OMP discovery closed when the bounded profile registry is truncated', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'omp', {
      realpath: '/fixture/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js',
      verifiedPackageProvenance: 'npm_metadata:@oh-my-pi/pi-coding-agent',
    })
    runtime.dependencies.fs.readDirectoryNames = async () => ({ names: [], truncated: true })

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)

    expect(report.installations).not.toContainEqual(expect.objectContaining({ catalogId: 'omp-cli' }))
    expect(report.unresolved).toContainEqual(expect.objectContaining({
      catalogIds: ['omp-cli'],
      reason: 'probe_inaccessible',
    }))
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
        XDG_CONFIG_HOME: `${HOME}/ignored-xdg`,
        OPENCODE_CONFIG: `${HOME}/shared/opencode.jsonc`,
        OPENCODE_CONFIG_DIR: `${HOME}/opencode-resources`,
      },
    }), runtime.dependencies)
    const v1 = report.installations.find(item => item.catalogId === 'opencode-v1-cli')
    const v2 = report.installations.find(item => item.catalogId === 'opencode-v2-beta-cli')

    expect(v1?.configRoot).toBe(`${HOME}/shared`)
    expect(v2?.configRoot).toBe(`${HOME}/shared`)
    expect(v1?.identity.componentConfigFiles).toEqual({
      instruction: `${HOME}/.agents/skills/tidemind/SKILL.md`,
      memory_tools: `${HOME}/shared/opencode.jsonc`,
      lifecycle: `${HOME}/canonical-resources/plugins/tidemind-v1.ts`,
    })
    expect(v2?.identity.componentConfigFiles).toEqual({
      instruction: `${HOME}/.agents/skills/tidemind/SKILL.md`,
      memory_tools: `${HOME}/shared/opencode.jsonc`,
      lifecycle: `${HOME}/canonical-resources/plugins/tidemind-v2.ts`,
    })
    expect(v1?.identity.componentConfigRoots).toEqual({
      instruction: `${HOME}/.agents/skills`,
      lifecycle: `${HOME}/canonical-resources`,
    })
    expect(v2?.identity.componentConfigRoots).toEqual({
      instruction: `${HOME}/.agents/skills`,
      lifecycle: `${HOME}/canonical-resources`,
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
      componentConfigFiles: {
        instruction: `${HOME}/.agents/skills/tidemind/SKILL.md`,
        memory_tools: `${HOME}/shared/opencode.jsonc`,
        lifecycle: `${HOME}/canonical-resources/plugins/tidemind-v1.ts`,
      },
      componentConfigRoots: {
        instruction: `${HOME}/.agents/skills`,
        lifecycle: `${HOME}/canonical-resources`,
      },
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

  it.each([
    {
      name: 'default config root',
      environment: {},
      requestedRoot: `${HOME}/.config/opencode`,
      canonicalRoot: `${HOME}/.config/opencode`,
    },
    {
      name: 'XDG config root',
      environment: { XDG_CONFIG_HOME: `${HOME}/xdg-config` },
      requestedRoot: `${HOME}/xdg-config/opencode`,
      canonicalRoot: `${HOME}/canonical-xdg/opencode`,
    },
    {
      name: 'OPENCODE_CONFIG_DIR root',
      environment: { OPENCODE_CONFIG_DIR: `${HOME}/resources` },
      requestedRoot: `${HOME}/resources`,
      canonicalRoot: `${HOME}/canonical-resources`,
    },
  ])('uses the $name for both OpenCode configuration and resources', async ({
    environment,
    requestedRoot,
    canonicalRoot,
  }) => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'opencode', { output: 'opencode 1.8.0' })
    addCommand(runtime, 'opencode2', { output: 'opencode2 2.0.0-beta.2' })
    if (requestedRoot !== canonicalRoot) runtime.fs.addDirectory(requestedRoot, canonicalRoot)

    const report = await discoverLocalP0Agents(context({ environment }), runtime.dependencies)
    for (const [catalogId, pluginFileName] of [
      ['opencode-v1-cli', 'tidemind-v1.ts'],
      ['opencode-v2-beta-cli', 'tidemind-v2.ts'],
    ] as const) {
      const installation = report.installations.find(item => item.catalogId === catalogId)
      expect(installation?.configRoot).toBe(canonicalRoot)
      expect(installation?.identity.componentConfigFiles).toEqual({
        instruction: `${HOME}/.agents/skills/tidemind/SKILL.md`,
        lifecycle: `${canonicalRoot}/plugins/${pluginFileName}`,
      })
      expect(installation?.identity.componentConfigRoots).toEqual({
        instruction: `${HOME}/.agents/skills`,
        lifecycle: canonicalRoot,
      })
      expect(installation?.resourceRoots).toEqual({ opencode_resources: canonicalRoot })
    }
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
    expect(legacyOnly.unresolved).not.toContainEqual(expect.objectContaining({
      catalogIds: ['claude-cowork-local'],
    }))

    // Even a Cowork-looking directory is not host-loaded Plugin/Connector
    // evidence. The detector remains fail-closed until an official registry
    // contract exists.
    runtime.fs.addDirectory(path.posix.join(HOME, '.claude', 'cowork'))
    const stillUnproven = await discoverLocalP0Agents(context(), runtime.dependencies)
    expect(stillUnproven.installations.map(item => item.catalogId)).not.toContain('claude-cowork-local')
  })

  it('returns the signed shared app only through the explicit Cowork guided probe', async () => {
    const runtime = fakeRuntime()
    runtime.fs.addApp('Claude.app', {
      bundleId: 'com.anthropic.claudefordesktop',
      version: '1.2.3',
      signature: {
        valid: true,
        identifier: 'com.anthropic.claudefordesktop',
        teamIdentifier: 'Q6L2SF6YDW',
      },
    })
    runtime.fs.addDirectory(path.posix.join(HOME, 'Library', 'Application Support', 'Claude'))

    const passive = await discoverLocalP0Agents(context(), runtime.dependencies)
    const guided = await discoverClaudeCoworkGuidedCandidate(context(), runtime.dependencies)

    expect(passive.installations.map(item => item.catalogId)).not.toContain('claude-cowork-local')
    expect(guided.installations).toHaveLength(1)
    expect(guided.installations[0]).toMatchObject({
      catalogId: 'claude-cowork-local',
      detectedVersion: '1.2.3',
      identity: {
        distribution: {
          distributionId: 'com.anthropic.claudefordesktop',
          packageProvenance: 'signed_app:com.anthropic.claudefordesktop:Q6L2SF6YDW',
        },
      },
    })
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

  it('keeps Qwen standalone and global npm receipts independently addressable', async () => {
    const standaloneRuntime = fakeRuntime()
    const standalone = addCommand(standaloneRuntime, 'qwen', {
      realpath: `${HOME}/.local/bin/qwen`,
      output: '0.21.13',
      verifiedPackageProvenance: 'npm_metadata:@qwen-code/qwen-code',
      portableArtifactFingerprint: 'a'.repeat(64),
    })
    standaloneRuntime.versions.set(standalone, {
      ...standaloneRuntime.versions.get(standalone)!,
      packageProofNodes: [{
        role: 'qwen_launcher', path: standalone, maxBytes: 4096,
        size: 1, mode: 0o700, device: '1', inode: '1', linkCount: '1',
        mtimeNs: '1', ctimeNs: '1', sha256: 'b'.repeat(64),
        fingerprint: 'c'.repeat(64), executable: true,
      }],
    })
    const standaloneReport = await discoverLocalP0Agents(context(), standaloneRuntime.dependencies)
    expect(standaloneReport.installations.find(item => item.catalogId === 'qwen-code-cli')?.identity.distribution)
      .toMatchObject({
        distributionId: 'cli:qwen-code-cli:standalone',
        portableArtifactFingerprint: 'a'.repeat(64),
      })

    const npmRuntime = fakeRuntime()
    addCommand(npmRuntime, 'qwen', {
      realpath: '/opt/lib/node_modules/@qwen-code/qwen-code/dist/cli.js',
      output: '0.21.13',
      verifiedPackageProvenance: 'npm_metadata:@qwen-code/qwen-code',
      portableArtifactFingerprint: 'd'.repeat(64),
    })
    const npmReport = await discoverLocalP0Agents(context(), npmRuntime.dependencies)
    expect(npmReport.installations.find(item => item.catalogId === 'qwen-code-cli')?.identity.distribution)
      .toMatchObject({
        distributionId: 'cli:qwen-code-cli:npm-global',
        portableArtifactFingerprint: 'd'.repeat(64),
      })
  })

  it.each([
    ['opencode-v1-cli', 'opencode', 'opencode-ai', 'modern', 'darwin-x64'],
    ['opencode-v2-beta-cli', 'opencode2', '@opencode-ai/cli', 'modern', 'darwin-x64'],
    ['opencode-v2-beta-cli', 'opencode2', '@opencode-ai/cli', 'baseline', 'darwin-x64-baseline'],
  ] as const)('derives %s distribution identity from the copied $variant root entry', async (
    catalogId, command, packageName, variant, expectedSuffix,
  ) => {
    const runtime = fakeRuntime()
    const executable = addCommand(runtime, command, {
      realpath: `/opt/lib/node_modules/${packageName}/bin/${command}.js`,
      output: '1.18.29',
      verifiedPackageProvenance: `npm_metadata:${packageName}`,
      portableArtifactFingerprint: 'a'.repeat(64),
    })
    runtime.versions.set(executable, {
      ...runtime.versions.get(executable)!,
      packageProofNodes: [{
        role: 'npm_package_executable', path: executable, maxBytes: 1024,
        size: 5, mode: 0o700, device: '1', inode: '1', linkCount: '1',
        mtimeNs: '1', ctimeNs: '1', sha256: 'c'.repeat(64),
        fingerprint: 'd'.repeat(64), executable: true,
      }],
      npmComposition: {
        entryRule: 'copy_platform_binary_v1',
        components: ['', '-baseline'].map(suffix => {
          const leafName = `${packageName === 'opencode-ai' ? 'opencode' : '@opencode-ai/cli'}-darwin-x64${suffix}`
          const selected = packageName === 'opencode-ai'
            || (variant === 'baseline' ? suffix === '-baseline' : suffix === '')
          return {
            role: 'platform_leaf', installName: leafName, manifestName: leafName,
            version: packageName === 'opencode-ai' ? '1.18.29' : '0.0.0-beta-19157',
            integrity: 'sha512-YQ==', ownedPackageSha256: 'b'.repeat(64),
            ownedEntryCount: 2, ownedTotalBytes: 10, nativeExecutableRelativePath: `bin/${command}`,
            nativeExecutableSha256: (selected ? 'c' : 'e').repeat(64), nativeExecutableSizeBytes: 5,
          }
        }),
      },
    })
    const report = await discoverLocalP0Agents(context(), runtime.dependencies)
    expect(report.installations.find(item => item.catalogId === catalogId)?.identity.distribution.distributionId)
      .toBe(`cli:${catalogId}:${expectedSuffix}`)
  })

  it('binds QwenWorkCN to its official signed bundle and one shared config root', async () => {
    const runtime = fakeRuntime()
    runtime.fs.addApp('QwenWorkCN.app', {
      bundleId: 'cn.qwenwork.desktop.mac',
      version: '1.2.0',
      executable: 'QwenWorkCN',
      signature: {
        valid: true,
        identifier: 'cn.qwenwork.desktop.mac',
        teamIdentifier: 'XN6U3EV979',
      },
    })
    runtime.fs.addDirectory(`${HOME}/.qwenworkcn`)

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)
    const qwenWork = report.installations.find(item => item.catalogId === 'qwenwork-desktop')
    expect(qwenWork).toMatchObject({
      configRoot: `${HOME}/.qwenworkcn`,
      componentConfigRoots: {
        instruction: `${HOME}/.qwenworkcn`,
        lifecycle: `${HOME}/.qwenworkcn`,
      },
      identity: {
        componentConfigRoots: {
          instruction: `${HOME}/.qwenworkcn`,
          lifecycle: `${HOME}/.qwenworkcn`,
        },
        distribution: {
          distributionId: 'cn.qwenwork.desktop.mac',
          packageProvenance: 'signed_app:cn.qwenwork.desktop.mac:XN6U3EV979',
        },
      },
    })
    expect(report.unresolved).not.toContainEqual(expect.objectContaining({
      catalogIds: ['qwenwork-desktop'],
    }))
  })

  it('discovers the official global npm OpenClaw channel without requiring the portable wrapper', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'openclaw', {
      realpath: '/usr/local/lib/node_modules/openclaw/dist/entry.js',
      output: '2026.8.1',
      verifiedPackageProvenance: 'npm_metadata:openclaw',
    })

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)
    const openClaw = report.installations.find(item => item.catalogId === 'openclaw-local')

    expect(openClaw).toMatchObject({
      configRoot: `${HOME}/.openclaw`,
      executablePath: '/usr/local/lib/node_modules/openclaw/dist/entry.js',
      detectedVersion: '2026.8.1',
      identity: { distribution: {
        distributionId: 'cli:openclaw-local:npm-global',
        packageProvenance: 'npm_metadata:openclaw',
      } },
    })
    expect(report.unresolved).not.toContainEqual(expect.objectContaining({
      catalogIds: ['openclaw-local'],
    }))
  })

  it.each([
    { catalogId: 'claude-code-cli', command: 'claude', name: 'CLAUDE_CONFIG_DIR', value: `${HOME}/.claude-work`, expected: `${HOME}/.claude-work` },
    { catalogId: 'codex-cli', command: 'codex', name: 'CODEX_HOME', value: `${HOME}/.codex-work`, expected: `${HOME}/.codex-work` },
    { catalogId: 'gemini-cli', command: 'gemini', name: 'GEMINI_CLI_HOME', value: `${HOME}/gemini-work`, expected: `${HOME}/gemini-work/.gemini` },
  ])('binds the official $name override instead of a different default profile', async ({ catalogId, command, name, value, expected }) => {
    const runtime = fakeRuntime()
    addCommand(runtime, command, {
      output: '1.2.3',
      ...(command === 'claude' ? { verifiedPackageProvenance: 'npm_metadata:@anthropic-ai/claude-code' } : {}),
    })
    const report = await discoverLocalP0Agents(context({ environment: { [name]: value } }), runtime.dependencies)
    expect(report.installations.find(item => item.catalogId === catalogId)?.configRoot).toBe(expected)
    for (const invalid of ['relative/profile', '/', 'bad\0path']) {
      const rejected = await discoverLocalP0Agents(context({ environment: { [name]: invalid } }), runtime.dependencies)
      expect(rejected.installations.some(item => item.catalogId === catalogId)).toBe(false)
      expect(rejected.unresolved.some(item => item.reason === 'invalid_environment_override' && item.catalogIds.includes(catalogId as never))).toBe(true)
    }
  })

  it('binds OpenClaw state and an exact in-domain config filename, rejecting cross-domain overrides', async () => {
    const runtime = fakeRuntime()
    addCommand(runtime, 'openclaw', { output: '2026.8.1' })
    const state = `${HOME}/.openclaw-work`
    const report = await discoverLocalP0Agents(context({ environment: {
      OPENCLAW_HOME: `${HOME}/other-home`, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: `${state}/profile.json`,
    } }), runtime.dependencies)
    expect(report.installations.find(item => item.catalogId === 'openclaw-local')).toMatchObject({
      configRoot: state, componentConfigFiles: { memory_tools: `${state}/profile.json` },
    })
    const rejected = await discoverLocalP0Agents(context({ environment: {
      OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: `${state}/../other.json`,
    } }), runtime.dependencies)
    expect(rejected.installations.some(item => item.catalogId === 'openclaw-local')).toBe(false)
    expect(rejected.unresolved).toContainEqual(expect.objectContaining({ catalogIds: ['openclaw-local'], reason: 'invalid_environment_override' }))
  })

  it('separates OpenClaw portable prefix from its effective home state root', async () => {
    const runtime = fakeRuntime()
    const prefix = `${HOME}/Applications/openclaw-portable`
    const wrapper = `${prefix}/bin/openclaw`
    const stateRoot = `${HOME}/profiles/assistant/.openclaw`
    runtime.commands.set('openclaw', wrapper)
    runtime.fs.addFile(wrapper)
    runtime.fs.addDirectory(prefix)
    runtime.fs.addDirectory(stateRoot)
    runtime.versions.set(wrapper, {
      exitCode: 0,
      stdout: '2026.8.1',
      stderr: '',
      verifiedPackageProvenance: 'npm_metadata:openclaw',
      portableArtifactFingerprint: 'a'.repeat(64),
    })

    const report = await discoverLocalP0Agents(context({
      environment: {
        OPENCLAW_PREFIX: prefix,
        OPENCLAW_HOME: `${HOME}/profiles/assistant`,
      },
    }), runtime.dependencies)
    const openClaw = report.installations.find(item => item.catalogId === 'openclaw-local')

    expect(openClaw).toMatchObject({
      configRoot: stateRoot,
      executablePath: wrapper,
      resourceRoots: { openclaw_prefix: prefix },
      identity: { distribution: { portableArtifactFingerprint: 'a'.repeat(64) } },
    })
  })

  it('binds current Devin Desktop to its signed bundle and documented user files', async () => {
    const runtime = fakeRuntime()
    runtime.fs.addApp('Devin.app', {
      bundleId: 'com.exafunction.windsurf',
      version: '3.8.20',
      executable: 'Devin',
      signature: {
        valid: true,
        identifier: 'com.exafunction.windsurf',
        teamIdentifier: '83Z2LHX6XW',
      },
    })
    runtime.fs.addDirectory(`${HOME}/.config/devin`)

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)
    const devin = report.installations.find(item => item.catalogId === 'windsurf-desktop')
    expect(devin).toMatchObject({
      displayName: 'Devin Desktop（原 Windsurf）',
      configRoot: `${HOME}/.config/devin`,
      componentConfigRoots: {
        instruction: `${HOME}/.config/devin`,
        memory_tools: `${HOME}/.config/devin`,
        lifecycle: `${HOME}/.config/devin`,
      },
      componentConfigFiles: {
        instruction: `${HOME}/.config/devin/skills/tidemind/SKILL.md`,
        memory_tools: `${HOME}/.config/devin/mcp_config.json`,
        lifecycle: `${HOME}/.config/devin/config.json`,
      },
      identity: {
        distribution: {
          distributionId: 'com.exafunction.windsurf',
          packageProvenance: 'signed_app:com.exafunction.windsurf:83Z2LHX6XW',
        },
      },
    })
  })

  it('does not mistake the legacy Windsurf bundle contract for current Devin Desktop', async () => {
    const runtime = fakeRuntime()
    runtime.fs.addApp('Windsurf.app', {
      bundleId: 'com.codeium.windsurf',
      version: '1.9.1',
      executable: 'Windsurf',
    })
    runtime.fs.addDirectory(`${HOME}/.codeium/windsurf`)

    const report = await discoverLocalP0Agents(context(), runtime.dependencies)
    expect(report.installations).not.toContainEqual(expect.objectContaining({
      catalogId: 'windsurf-desktop',
    }))
  })

  it.each([
    {
      name: 'KIMI_CODE_HOME',
      command: 'kimi',
      environment: { KIMI_CODE_HOME: 'relative/kimi' },
      catalogIds: ['kimi-code-cli', 'kimi-code-native'],
    },
    {
      name: 'OPENCLAW_HOME',
      command: 'openclaw',
      environment: { OPENCLAW_HOME: 'relative/openclaw-home' },
      catalogIds: ['openclaw-local'],
    },
    {
      name: 'OPENCLAW_PREFIX',
      command: 'openclaw',
      environment: { OPENCLAW_PREFIX: 'relative/openclaw-prefix' },
      catalogIds: ['openclaw-local'],
    },
    {
      name: 'XDG_CONFIG_HOME',
      environment: { XDG_CONFIG_HOME: 'relative/xdg' },
    },
    {
      name: 'OPENCODE_CONFIG_DIR',
      environment: { OPENCODE_CONFIG_DIR: 'relative/opencode' },
    },
    {
      name: 'OPENCODE_CONFIG',
      environment: { OPENCODE_CONFIG: 'relative/opencode.jsonc' },
    },
  ] as const)('fails closed on a relative $name override', async ({ name, environment, ...input }) => {
    const runtime = fakeRuntime()
    if ('command' in input) {
      addCommand(runtime, input.command)
    } else {
      addCommand(runtime, 'opencode')
      addCommand(runtime, 'opencode2')
    }

    const report = await discoverLocalP0Agents(context({ environment }), runtime.dependencies)

    const catalogIds = 'catalogIds' in input
      ? input.catalogIds
      : ['opencode-v1-cli', 'opencode-v2-beta-cli'] as const
    for (const catalogId of catalogIds) {
      expect(report.installations.map(item => item.catalogId)).not.toContain(catalogId)
      expect(report.unresolved).toContainEqual(expect.objectContaining({
        catalogIds: name === 'KIMI_CODE_HOME' ? [...catalogIds] : [catalogId],
        reason: 'invalid_environment_override',
      }))
    }
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

  it('uses a separate bounded budget for slow platform code-signature verification', async () => {
    const runtime = fakeRuntime()
    runtime.fs.addApp('ZCode.app', {
      bundleId: 'dev.zcode.app',
      signature: {
        valid: true,
        identifier: 'dev.zcode.app',
        teamIdentifier: '8A5X4JJ39T',
      },
    })
    const inspect = runtime.dependencies.inspectAppSignature!
    runtime.dependencies.inspectAppSignature = async (targetPath, options) => {
      await new Promise(resolve => setTimeout(resolve, 30))
      return inspect(targetPath, options)
    }

    const report = await discoverLocalP0Agents(context({
      operationTimeoutMs: 10,
      signatureTimeoutMs: 100,
    }), runtime.dependencies)

    expect(report.installations).toContainEqual(expect.objectContaining({ catalogId: 'zcode-desktop' }))
    expect(report.unresolved).not.toContainEqual(expect.objectContaining({
      catalogIds: ['zcode-desktop'],
      reason: 'distribution_identity_unproven',
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
