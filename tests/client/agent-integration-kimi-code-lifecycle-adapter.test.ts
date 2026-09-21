import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createKimiCodeLifecycleHostAdapter,
} from '../../client/electron/agent-integration/hosts/kimi-code-lifecycle-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type {
  AdapterOperationContext,
  AdapterPlanRequest,
  HostActivityEvidenceQuery,
  HostActivityEvidenceRecord,
} from '../../client/electron/agent-integration/types'

describe('Kimi Code lifecycle TOML host adapter', () => {
  let root: string
  let context: AdapterOperationContext

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-lifecycle-adapter-'))
    const configRoot = path.join(root, 'frozen-kimi-home')
    context = {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: root,
        applicationDataDir: path.join(root, 'app-data'),
        shimPath: '/Applications/Tide Mind.app/Contents/Resources/tm-node',
        mcpServerPath: '/Applications/Tide Mind.app/Contents/Resources/mcp-server.cjs',
        hookScriptPath: '/Applications/Tide Mind.app/Contents/Resources/hook-session-start.cjs',
        preCompactScriptPath: '/Applications/Tide Mind.app/Contents/Resources/pre.cjs',
        postCompactScriptPath: '/Applications/Tide Mind.app/Contents/Resources/post.cjs',
        tideMindVersion: '0.2.92',
        catalogVersion: '2',
        projectionVersion: '3',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'usr_01JABCDEF0123456789',
        productFamilyId: 'kimi-code',
        hostVariant: 'kimi-code-cli',
        configRoot,
        componentConfigFiles: {
          lifecycle: path.join(configRoot, 'profiles', 'work.toml'),
          instruction: path.join(configRoot, 'skills', 'work', 'SKILL.md'),
        },
        distribution: { executableRealpath: path.join(root, 'bin', 'kimi') },
      }),
      agentId: 'eb_12345678',
      operationId: 'run-1',
      activityGenerationToken: 'generation-kimi-1',
    }
    fs.mkdirSync(path.dirname(context.installation.distribution.executableRealpath!), { recursive: true })
    fs.writeFileSync(context.installation.distribution.executableRealpath!, '')
  })

  afterEach(() => {
    delete process.env.KIMI_CODE_HOME
    fs.rmSync(root, { recursive: true, force: true })
  })

  const adapter = () => createKimiCodeLifecycleHostAdapter({
    catalogId: 'kimi-code-cli',
    adapterVersion: '1',
  })

  async function request(ownedFragmentHash?: string): Promise<AdapterPlanRequest> {
    const observed = await adapter().inspect(context)
    return {
      desiredCapability: 4,
      desiredComponents: ['lifecycle'],
      observed,
      ownedArtifacts: ownedFragmentHash === undefined ? [] : [{
        componentKey: 'lifecycle',
        physicalTarget: context.installation.componentConfigFiles?.lifecycle
          ?? path.join(context.installation.canonicalConfigRoot, 'config.toml'),
        ownershipKey: `hooks.tidemind-${context.agentId}`,
        ownedFragmentHash,
      }],
    }
  }

  function legacy091Hook(overrides: {
    agentId?: string
    shimPath?: string
    hookPath?: string
    skillPath?: string
    oncePerSession?: boolean
    extraArg?: string
  } = {}): string {
    const command = [
      JSON.stringify(overrides.shimPath ?? context.runtime.shimPath),
      JSON.stringify(overrides.hookPath ?? context.runtime.hookScriptPath),
      '--agent-id', JSON.stringify(overrides.agentId ?? context.agentId),
      '--skill-path', JSON.stringify(overrides.skillPath ?? context.installation.componentConfigFiles!.instruction!),
      '--tool', JSON.stringify('kimi-code'),
      ...(overrides.oncePerSession === false ? [] : ['--once-per-session']),
      ...(overrides.extraArg ? [overrides.extraArg] : []),
    ].join(' ')
    return `[[hooks]]\nevent = "UserPromptSubmit"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`
  }

  it('uses only frozen Installation paths and separates Kimi injection from lifecycle evidence', async () => {
    process.env.KIMI_CODE_HOME = path.join(root, 'ignored-process-home')
    const host = adapter()
    const plan = await host.plan(context, await request())

    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({
      operation: 'create',
      componentKey: 'lifecycle',
      physicalTarget: context.installation.componentConfigFiles!.lifecycle,
      ownershipKey: `hooks.tidemind-${context.agentId}`,
    })
    await host.apply(context, plan.mutations[0])

    const target = context.installation.componentConfigFiles!.lifecycle!
    const parsed = parseToml(fs.readFileSync(target, 'utf8')) as any
    expect(parsed.hooks).toHaveLength(5)
    expect(parsed.hooks.map((hook: any) => hook.event)).toEqual([
      'UserPromptSubmit', 'SessionStart', 'PreCompact', 'PostCompact', 'SessionEnd',
    ])
    expect(parsed.hooks.map((hook: any) => hook.matcher)).toEqual([
      undefined, 'startup|resume', 'manual|auto', 'manual|auto', 'exit|archive',
    ])
    expect(parsed.hooks.every((hook: any) => hook.timeout === 30)).toBe(true)
    expect(parsed.hooks[0].command).toContain(`'--agent-id' '${context.agentId}'`)
    expect(parsed.hooks[0].command).toContain(
      `'--skill-path' '${context.installation.componentConfigFiles!.instruction}'`,
    )
    expect(parsed.hooks[0].command).toContain("'--tool' 'kimi-code'")
    expect(parsed.hooks[0].command).toContain('--once-per-session')
    expect(parsed.hooks[0].command).toContain('--expected-skill-sha256')
    expect(parsed.hooks[0].command).toContain('--suppress-session-start-activity')
    expect(parsed.hooks[1].command).toContain('hook-kimi-session-start-activity.cjs')
    expect(parsed.hooks[2].command).toContain(context.runtime.preCompactScriptPath)
    expect(parsed.hooks[3].command).toContain(context.runtime.postCompactScriptPath)
    expect(parsed.hooks[4].command).toContain('hook-session-end.cjs')
    expect(fs.existsSync(process.env.KIMI_CODE_HOME)).toBe(false)
    expect(await host.readBack(context, plan.mutations[0])).toMatchObject({
      observed: true,
      matchesDesired: true,
      visibility: 'dedicated',
    })
  })

  it('preserves literal paths in every installed Kimi hook through a real POSIX shell', async () => {
    const literalRoot = path.join(root, "Tide Mind's $(printf INJECTED) `printf EXPANDED` $HOME", 'line\nnext')
    context = {
      ...context,
      runtime: {
        ...context.runtime,
        shimPath: path.join(literalRoot, 'tm-node'),
        hookScriptPath: path.join(literalRoot, 'hook-session-start.cjs'),
        preCompactScriptPath: path.join(literalRoot, 'pre.cjs'),
        postCompactScriptPath: path.join(literalRoot, 'post.cjs'),
      },
      installation: {
        ...context.installation,
        componentConfigFiles: {
          ...context.installation.componentConfigFiles,
          instruction: path.join(literalRoot, 'SKILL.md'),
        },
      },
    }
    const host = adapter()
    const plan = await host.plan(context, await request())
    await host.apply(context, plan.mutations[0])
    const parsed = parseToml(fs.readFileSync(context.installation.componentConfigFiles!.lifecycle!, 'utf8')) as any
    const expectedScripts = [
      context.runtime.hookScriptPath, path.join(literalRoot, 'hook-kimi-session-start-activity.cjs'),
      context.runtime.preCompactScriptPath, context.runtime.postCompactScriptPath,
      path.join(literalRoot, 'hook-session-end.cjs'),
    ]
    for (const [index, hook] of parsed.hooks.entries()) {
      const args = execFileSync('/bin/sh', ['-c', `set -- ${hook.command}; printf '%s\\0' "$@"`])
        .toString().split('\0').slice(0, -1)
      expect(args.slice(0, 2)).toEqual([context.runtime.shimPath, expectedScripts[index]])
      if (index === 0) expect(args[args.indexOf('--skill-path') + 1])
        .toBe(context.installation.componentConfigFiles!.instruction)
    }
    expect(await host.readBack(context, plan.mutations[0])).toMatchObject({ matchesDesired: true })
  })

  it('adopts and atomically upgrades the exact 0.2.91 Kimi hook without leaving a duplicate', async () => {
    const target = context.installation.componentConfigFiles!.lifecycle!
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `model = "k2"\n\n${legacy091Hook()}`)
    const host = adapter()
    const observations = await host.inspectAdoptableArtifacts!(context)
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      componentKey: 'lifecycle',
      ownershipKey: `hooks.tidemind-${context.agentId}`,
      identityAssertion: context.agentId,
    })

    const upgrade = await host.plan(context, await request(observations[0].fragmentHash))
    expect(upgrade.diagnostics).toEqual([])
    expect(upgrade.mutations).toHaveLength(1)
    expect(upgrade.mutations[0]).toMatchObject({ operation: 'update' })
    await host.apply(context, upgrade.mutations[0])

    const parsed = parseToml(fs.readFileSync(target, 'utf8')) as any
    expect(parsed.model).toBe('k2')
    expect(parsed.hooks).toHaveLength(5)
    expect(parsed.hooks.filter((hook: any) => hook.event === 'UserPromptSubmit')).toHaveLength(1)
    expect(parsed.hooks[0].command).toContain('--expected-skill-sha256')
    expect(parsed.hooks[0].command).toContain('--suppress-session-start-activity')

    const afterHash = upgrade.mutations[0].desiredFragmentHash!
    context = { ...context, operationId: 'run-after-restart' }
    const afterRestart = await host.plan(context, await request(afterHash))
    expect(afterRestart).toMatchObject({ mutations: [], diagnostics: [] })

    const disconnect = await host.disconnect(context, {
      componentKeys: ['lifecycle'],
      observed: await host.inspect(context),
      ownedArtifacts: (await request(afterHash)).ownedArtifacts,
    })
    expect(disconnect.mutations).toHaveLength(1)
    await host.apply(context, disconnect.mutations[0])
    const disconnected = parseToml(fs.readFileSync(target, 'utf8')) as any
    expect(disconnected.hooks).toBeUndefined()
    expect(disconnected.model).toBe('k2')
  })

  it('moves the default 0.2.91 identity-specific skill path to the 0.2.92 managed skill path', async () => {
    const configRoot = context.installation.canonicalConfigRoot
    context = {
      ...context,
      installation: canonicalizeInstallationIdentity({
        ...context.installation,
        configRoot,
        componentConfigFiles: undefined,
      }),
    }
    const target = path.join(configRoot, 'config.toml')
    const oldSkill = path.join(configRoot, 'skills', `tidemind-${context.agentId}`, 'SKILL.md')
    const command = [
      JSON.stringify(context.runtime.shimPath),
      JSON.stringify(context.runtime.hookScriptPath),
      '--agent-id', JSON.stringify(context.agentId),
      '--skill-path', JSON.stringify(oldSkill),
      '--tool', JSON.stringify('kimi-code'),
      '--once-per-session',
    ].join(' ')
    fs.mkdirSync(configRoot, { recursive: true })
    fs.writeFileSync(target, `[[hooks]]\nevent = "UserPromptSubmit"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`)

    const host = adapter()
    const observations = await host.inspectAdoptableArtifacts!(context)
    expect(observations).toHaveLength(1)
    const upgrade = await host.plan(context, await request(observations[0].fragmentHash))
    await host.apply(context, upgrade.mutations[0])

    const parsed = parseToml(fs.readFileSync(target, 'utf8')) as any
    expect(parsed.hooks[0].command).toContain(
      `'--skill-path' '${path.join(configRoot, 'skills', 'tidemind', 'SKILL.md')}'`,
    )
    expect(parsed.hooks[0].command).not.toContain(oldSkill)
  })

  it.each([
    ['wrong identity', { agentId: 'eb_someone_else' }],
    ['wrong shim path', { shimPath: '/tmp/user-shim' }],
    ['wrong hook path', { hookPath: '/tmp/user-hook.cjs' }],
    ['wrong skill path', { skillPath: '/tmp/user-skill.md' }],
    ['missing once guard', { oncePerSession: false }],
    ['extra command argument', { extraArg: '--user-owned' }],
  ] as const)('does not adopt a similar user hook with %s', async (_label, overrides) => {
    const target = context.installation.componentConfigFiles!.lifecycle!
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, legacy091Hook(overrides))
    expect(await adapter().inspectAdoptableArtifacts!(context)).toEqual([])
  })

  it('preserves user entries while updating only an exactly owned Tide Mind hook', async () => {
    const target = context.installation.componentConfigFiles!.lifecycle!
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const userHook = '[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "echo user"\ntimeout = 9\n'
    fs.writeFileSync(target, `model = "k2"\n\n${userHook}`)
    const host = adapter()
    const initial = await host.plan(context, await request())
    await host.apply(context, initial.mutations[0])
    const ownedHash = initial.mutations[0].desiredFragmentHash!

    context = {
      ...context,
      runtime: {
        ...context.runtime,
        shimPath: '/Applications/Tide Mind 2.app/Contents/Resources/tm-node',
      },
      operationId: 'run-2',
    }
    const update = await host.plan(context, await request(ownedHash))
    expect(update.mutations[0].operation).toBe('update')
    await host.apply(context, update.mutations[0])

    const content = fs.readFileSync(target, 'utf8')
    expect(content).toContain('model = "k2"')
    expect(content).toContain('command = "echo user"')
    const parsed = parseToml(content) as any
    expect(parsed.hooks).toHaveLength(6)
    expect(parsed.hooks.slice(1).every((hook: any) => hook.command.includes('Tide Mind 2.app'))).toBe(true)
  })

  it('does not adopt a Kimi lifecycle set whose matcher drifted', async () => {
    const host = adapter()
    const connect = await host.plan(context, await request())
    await host.apply(context, connect.mutations[0])
    const target = context.installation.componentConfigFiles!.lifecycle!
    const drifted = fs.readFileSync(target, 'utf8').replace(
      'matcher = "manual|auto"',
      'matcher = "never-match"',
    )
    fs.writeFileSync(target, drifted)

    const observed = await host.inspect(context)
    const plan = await host.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['lifecycle'],
      observed,
      ownedArtifacts: [],
    })
    expect(plan.mutations).toEqual([])
    expect(plan.diagnostics).toContain('identity_bound_hook_has_no_ownership_evidence')
  })

  it('rejects a stale CAS plan after an external edit', async () => {
    const host = adapter()
    const plan = await host.plan(context, await request())
    const target = context.installation.componentConfigFiles!.lifecycle!
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'model = "externally-edited"\n')

    await expect(host.apply(context, plan.mutations[0]))
      .rejects.toThrow(/container_precondition_changed/)
    expect(fs.readFileSync(target, 'utf8')).toBe('model = "externally-edited"\n')
  })

  it('disconnects only the exact owned block and preserves user TOML', async () => {
    const target = context.installation.componentConfigFiles!.lifecycle!
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'model = "k2"\n')
    const host = adapter()
    const connect = await host.plan(context, await request())
    await host.apply(context, connect.mutations[0])
    const ownedHash = connect.mutations[0].desiredFragmentHash!

    const disconnect = await host.disconnect(context, {
      componentKeys: ['lifecycle'],
      observed: await host.inspect(context),
      ownedArtifacts: (await request(ownedHash)).ownedArtifacts,
    })
    expect(disconnect.mutations).toHaveLength(1)
    expect(disconnect.mutations[0].operation).toBe('remove')
    expect(await host.readBack(context, disconnect.mutations[0])).toMatchObject({
      observed: true,
      matchesDesired: false,
      observedFragmentHash: disconnect.mutations[0].preconditionHash,
      visibility: 'dedicated',
    })
    await host.apply(context, disconnect.mutations[0])

    expect(fs.readFileSync(target, 'utf8')).toContain('model = "k2"')
    expect(fs.readFileSync(target, 'utf8')).not.toContain(context.agentId)
    expect(await host.readBack(context, disconnect.mutations[0])).toMatchObject({
      observed: false,
      matchesDesired: true,
      visibility: 'absent',
    })
  })

  it('does not update or remove an identity-shaped hook without exact ownership', async () => {
    const host = adapter()
    const connect = await host.plan(context, await request())
    await host.apply(context, connect.mutations[0])

    const reconnect = await host.plan(context, await request())
    expect(reconnect.mutations).toEqual([])
    expect(reconnect.diagnostics).toContain('matching_hook_has_no_ownership_evidence')
    const disconnect = await host.disconnect(context, {
      componentKeys: ['lifecycle'],
      observed: await host.inspect(context),
      ownedArtifacts: [],
    })
    expect(disconnect.mutations).toEqual([])
    expect(disconnect.diagnostics).toContain('remove_requires_exact_owned_hook')
  })

  it('refuses malformed TOML without overwriting it', async () => {
    const target = context.installation.componentConfigFiles!.lifecycle!
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const malformed = 'model = "k2"\n[broken'
    fs.writeFileSync(target, malformed)

    const inspection = await adapter().inspect(context)
    expect(inspection.components[0].visibility).toBe('unknown')
    await expect(adapter().plan(context, {
      desiredCapability: 4,
      desiredComponents: ['lifecycle'],
      observed: inspection,
      ownedArtifacts: [],
    })).rejects.toThrow(/malformed/)
    expect(fs.readFileSync(target, 'utf8')).toBe(malformed)
  })

  it('keeps static read-back unverified until all fresh lifecycle activity exists', async () => {
    const host = adapter()
    const plan = await host.plan(context, await request())
    await host.apply(context, plan.mutations[0])
    const inspection = await host.inspect(context)
    const binding = {
      installationId: 'installation-kimi',
      tideMindVersion: '0.2.92',
      adapterVersion: '1',
      projectionVersion: '3',
      hostVersion: '0.30.0',
      activationRunId: 'run-kimi-1',
      activityGenerationToken: 'generation-kimi-1',
      observedAfter: '2026-09-02T10:00:00.000Z',
      verifiedAt: '2026-09-02T10:10:00.000Z',
    }

    const staticOnly = await host.verify(context, {
      componentKeys: ['lifecycle'],
      expectedCapability: 4,
      inspection,
      activityBinding: binding,
    })
    expect(staticOnly[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })
    expect(staticOnly[0].diagnostics).toContain('static_readback_passed')

    let seenQuery: HostActivityEvidenceQuery | undefined
    context = {
      ...context,
      hostActivityEvidence: {
        find(query) {
          seenQuery = query
          return (['session_start', 'pre_compact', 'post_compact', 'session_end'] as const)
            .map(signalName => activityRecord(query, signalName))
        },
      },
    }
    const runtimeVerified = await host.verify(context, {
      componentKeys: ['lifecycle'],
      expectedCapability: 4,
      inspection,
      activityBinding: binding,
    })
    expect(seenQuery?.signalNames).toEqual(['session_start', 'pre_compact', 'post_compact', 'session_end'])
    expect(runtimeVerified[0]).toMatchObject({
      status: 'verified',
      verifiedCapability: 4,
      identityAssertion: context.agentId,
    })
  })

  it.each(['session_start', 'pre_compact', 'post_compact', 'session_end'] as const)(
    'does not verify Kimi C4 when %s evidence is missing',
    async (missingSignal) => {
      const host = adapter()
      const plan = await host.plan(context, await request())
      await host.apply(context, plan.mutations[0])
      const binding = {
        installationId: 'installation-kimi',
        tideMindVersion: '0.2.92',
        adapterVersion: '1',
        projectionVersion: '3',
        hostVersion: '0.30.0',
        activationRunId: 'run-kimi-1',
        activityGenerationToken: 'generation-kimi-1',
        observedAfter: '2026-09-02T10:00:00.000Z',
        verifiedAt: '2026-09-02T10:10:00.000Z',
      }
      context = {
        ...context,
        hostActivityEvidence: {
          find: query => (['session_start', 'pre_compact', 'post_compact', 'session_end'] as const)
            .filter(signal => signal !== missingSignal)
            .map(signal => activityRecord(query, signal)),
        },
      }
      const result = await host.verify(context, {
        componentKeys: ['lifecycle'],
        expectedCapability: 4,
        inspection: await host.inspect(context),
        activityBinding: binding,
      })
      expect(result[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })
    },
  )

  it('requires a real SessionStart event, not static hooks or UserPromptSubmit delivery', async () => {
    const host = adapter()
    const plan = await host.plan(context, await request())
    await host.apply(context, plan.mutations[0])
    const binding = {
      installationId: 'installation-kimi',
      tideMindVersion: '0.2.92',
      adapterVersion: '1',
      projectionVersion: '3',
      hostVersion: '0.41.0',
      activationRunId: 'run-kimi-1',
      activityGenerationToken: 'generation-kimi-1',
      observedAfter: '2026-09-02T10:00:00.000Z',
      verifiedAt: '2026-09-02T10:10:00.000Z',
    }
    context = {
      ...context,
      hostActivityEvidence: {
        find: query => (['pre_compact', 'post_compact', 'session_end'] as const)
          .map(signal => activityRecord(query, signal)),
      },
    }

    const result = await host.verify(context, {
      componentKeys: ['lifecycle'],
      expectedCapability: 4,
      inspection: await host.inspect(context),
      activityBinding: binding,
    })
    expect(result[0]).toMatchObject({ status: 'unverified', verifiedCapability: null })
    expect(result[0].diagnostics).toContain('fresh_host_activity_evidence_missing')
  })

  function activityRecord(
    query: HostActivityEvidenceQuery,
    signalName: 'session_start' | 'pre_compact' | 'post_compact' | 'session_end',
  ): HostActivityEvidenceRecord {
    return {
      id: `activity-${signalName}`,
      installationId: query.installationId,
      activationRunId: query.activationRunId,
      agentId: query.agentId,
      hostVariant: query.hostVariant,
      componentKey: 'lifecycle',
      signalName,
      tideMindVersion: query.tideMindVersion,
      adapterVersion: query.adapterVersion,
      projectionVersion: query.projectionVersion,
      hostVersion: query.hostVersion,
      evidenceHash: `runtime-evidence-${signalName}`,
      observedAt: '2026-09-02T10:05:00.000Z',
    }
  }
})
