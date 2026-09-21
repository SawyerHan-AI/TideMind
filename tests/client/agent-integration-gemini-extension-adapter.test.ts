import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createGeminiExtensionHostAdapter,
  type GeminiExtensionAdapterDependencies,
} from '../../client/electron/agent-integration/hosts/gemini-extension-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type {
  AdapterOperationContext,
  AdapterPlanRequest,
  HostActivityEvidenceRecord,
  OwnedArtifactBaseline,
  PlannedMutation,
} from '../../client/electron/agent-integration/types'

describe('Gemini official Extension adapter', () => {
  let root: string
  let executable: string
  let commands: string[][]
  let active: Map<string, boolean>
  let failNextInstall: boolean

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-extension-adapter-'))
    executable = path.join(root, 'bin', 'gemini')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, '#!/bin/sh\n')
    commands = []
    active = new Map()
    failNextInstall = false
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('freezes and installs one identity-bound Extension for all three components', async () => {
    const ctx = context()
    const adapter = createGeminiExtensionHostAdapter({ dependencies: runner() })
    const plan = await adapter.plan(ctx, request(ctx))

    expect(plan.mutations).toHaveLength(1)
    const mutation = plan.mutations[0]
    expect(mutation).toMatchObject({
      componentKey: 'instruction',
      coveredComponentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      operation: 'host_command',
      commandCategory: 'plugin_install',
      executableRealpath: executable,
      args: ['extensions', 'install', expect.stringContaining('agent-integration-staging/gemini/'), '--consent', '--skip-settings'],
      reload: 'new_session',
    })
    expect(mutation.metadata).toMatchObject({
      artifactType: 'plugin',
      previewTitle: expect.stringContaining('Gemini 将安装本机 Tide Mind Extension'),
      previewDescription: expect.stringContaining('宿主写入域'),
      reversal: expect.stringContaining('gemini extensions uninstall'),
    })
    await adapter.apply(ctx, mutation)

    const installed = mutation.physicalTarget
    expect(JSON.parse(fs.readFileSync(path.join(installed, 'gemini-extension.json'), 'utf8'))).toMatchObject({
      mcpServers: {
        tidemind: {
          env: { EB_AGENT_ID: ctx.agentId, EB_HOST_VARIANT: 'gemini-cli' },
        },
      },
      contextFileName: 'GEMINI.md',
    })
    const hooks = JSON.parse(fs.readFileSync(path.join(installed, 'hooks', 'hooks.json'), 'utf8'))
    expect(hooks.hooks.SessionStart[0].matcher).toBeUndefined()
    expect(hooks.hooks.SessionStart[0].hooks[0]).toMatchObject({
      type: 'command',
      name: expect.stringContaining(ctx.agentId),
      timeout: 60_000,
    })
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toContain("'--tool' 'gemini'")
    expect(hooks.hooks.PreCompress[0].hooks[0]).toMatchObject({
      type: 'command',
      name: expect.stringContaining('pre-compress'),
    })
    expect(hooks.hooks.PreCompress[0].hooks[0].command).toContain('hook-pre-compact.cjs')
    expect(hooks.hooks.PreCompress[0].hooks[0].command).toContain("'--event-name' 'PreCompress'")
    expect(hooks.hooks.SessionEnd[0].hooks[0]).toMatchObject({
      type: 'command',
      name: expect.stringContaining('session-end'),
    })
    expect(hooks.hooks.SessionEnd[0].hooks[0].command).toContain('hook-session-end.cjs')
    expect(await adapter.readBack(ctx, mutation)).toMatchObject({
      observed: true,
      matchesDesired: true,
      visibility: 'dedicated',
    })
    expect(fs.existsSync((mutation.metadata as { stagingRoot: string }).stagingRoot)).toBe(false)
  })

  it('repairs a Tide Mind version upgrade through frozen uninstall/install and resumes only from exact absence', async () => {
    const oldContext = context('0.2.92')
    const adapter = createGeminiExtensionHostAdapter({ dependencies: runner() })
    const initial = await adapter.plan(oldContext, request(oldContext))
    await adapter.apply(oldContext, initial.mutations[0])
    const oldHash = initial.mutations[0].desiredFragmentHash!

    const nextContext = context('0.2.93')
    const repair = await adapter.plan(nextContext, request(nextContext, owned(nextContext, initial.mutations[0], oldHash)))
    expect(repair.mutations).toHaveLength(1)
    expect(repair.mutations[0]).toMatchObject({
      frozenCommands: [
        { args: ['extensions', 'uninstall', expect.any(String)] },
        { args: ['extensions', 'install', expect.any(String), '--consent', '--skip-settings'] },
      ],
      safeResumeStates: [{ fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), completedStepIds: ['uninstall'] }],
      preconditionHash: oldHash,
    })

    failNextInstall = true
    await expect(adapter.apply(nextContext, repair.mutations[0])).rejects.toThrow('gemini_extension_command_failed')
    expect(await adapter.readBack(nextContext, repair.mutations[0])).toMatchObject({
      observed: true,
      matchesDesired: false,
      visibility: 'absent',
      safeToResumeFrom: {
        fingerprint: repair.mutations[0].safeResumeStates![0].fingerprint,
        completedStepIds: ['uninstall'],
      },
    })

    await adapter.apply(nextContext, repair.mutations[0])
    expect(await adapter.readBack(nextContext, repair.mutations[0])).toMatchObject({ matchesDesired: true })
    expect(commands.filter(args => args[1] === 'uninstall')).toHaveLength(1)
    expect(commands.filter(args => args[1] === 'install')).toHaveLength(3)
  })

  it('fails closed when the extension name exists without Ledger ownership', async () => {
    const ctx = context()
    const adapter = createGeminiExtensionHostAdapter({ dependencies: runner() })
    const first = await adapter.plan(ctx, request(ctx))
    await adapter.apply(ctx, first.mutations[0])

    const unowned = await adapter.plan(ctx, request(ctx))
    expect(unowned.mutations).toEqual([])
    expect(unowned.diagnostics).toContain('gemini_extension_name_exists_without_ownership')
  })

  it('uninstalls only the exact owned extension and verifies all covered components absent', async () => {
    const ctx = context()
    const adapter = createGeminiExtensionHostAdapter({ dependencies: runner() })
    const connect = await adapter.plan(ctx, request(ctx))
    await adapter.apply(ctx, connect.mutations[0])
    const hash = connect.mutations[0].desiredFragmentHash!
    const disconnect = await adapter.disconnect(ctx, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      observed: await adapter.inspect(ctx),
      ownedArtifacts: owned(ctx, connect.mutations[0], hash),
    })
    expect(disconnect.mutations).toHaveLength(1)
    expect(disconnect.mutations[0]).toMatchObject({
      coveredComponentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      args: ['extensions', 'uninstall', expect.any(String)],
      preconditionHash: hash,
    })
    await adapter.apply(ctx, disconnect.mutations[0])
    const verification = await adapter.verify(ctx, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      expectedCapability: 0,
      inspection: await adapter.inspect(ctx),
    })
    expect(verification).toHaveLength(3)
    expect(verification.every(result => result.status === 'verified' && result.verifiedCapability === 0)).toBe(true)
  })

  it('adopts only the exact identity-bound 0.2.89/0.2.91 extension', async () => {
    const ctx = context()
    const name = `tidemind-${ctx.agentId}`
    const installed = path.join(ctx.installation.canonicalConfigRoot, 'extensions', name)
    const staging = path.join(ctx.runtime.applicationDataDir, 'plugins', `gemini-${ctx.agentId}`)
    const sourceSkill = '---\ndescription: legacy\n---\n# Tide Mind\n'
    fs.mkdirSync(path.join(ctx.runtime.applicationDataDir, 'skill'), { recursive: true })
    fs.writeFileSync(path.join(ctx.runtime.applicationDataDir, 'skill', 'gemini-skill.md'), sourceSkill)
    fs.mkdirSync(path.join(installed, 'hooks'), { recursive: true })
    fs.writeFileSync(path.join(installed, 'gemini-extension.json'), JSON.stringify({
      name,
      version: '1.0.0',
      description: 'Tide Mind external memory',
      mcpServers: { tidemind: { command: ctx.runtime.shimPath, args: [ctx.runtime.mcpServerPath], env: { EB_AGENT_ID: ctx.agentId } } },
      contextFileName: 'GEMINI.md',
      excludeTools: [],
    }, null, 2))
    fs.writeFileSync(path.join(installed, 'GEMINI.md'), '# Tide Mind\n')
    const command = [JSON.stringify(ctx.runtime.shimPath), JSON.stringify(ctx.runtime.hookScriptPath), '--agent-id', JSON.stringify(ctx.agentId), '--skill-path', JSON.stringify(path.join(installed, 'GEMINI.md')), '--tool', JSON.stringify('gemini')].join(' ')
    fs.writeFileSync(path.join(installed, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command, timeout: 15000 }] }] } }, null, 2))
    fs.writeFileSync(path.join(installed, '.gemini-extension-install.json'), JSON.stringify({ source: staging, type: 'local' }))

    const adapter = createGeminiExtensionHostAdapter({ dependencies: runner() })
    active.set(name, false)
    expect(await adapter.inspectAdoptableArtifacts!(ctx)).toEqual([])
    active.set(name, true)
    expect((await adapter.inspectAdoptableArtifacts!(ctx)).map(item => item.componentKey)).toEqual(['instruction', 'memory_tools', 'lifecycle'])
    fs.mkdirSync(path.join(installed, 'commands'), { recursive: true })
    fs.writeFileSync(path.join(installed, 'commands', 'brain-recall.toml'), 'user command')
    expect(await adapter.inspectAdoptableArtifacts!(ctx)).toEqual([])
    fs.rmSync(path.join(installed, 'commands'), { recursive: true })
    fs.appendFileSync(path.join(installed, 'GEMINI.md'), '# user edit\n')
    expect(await adapter.inspectAdoptableArtifacts!(ctx)).toEqual([])
    fs.writeFileSync(path.join(installed, 'GEMINI.md'), '# Tide Mind\n')
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'gemini-extension.json'), 'utf8'))
    manifest.mcpServers.tidemind.env.EB_AGENT_ID = 'eb_other'
    fs.writeFileSync(path.join(installed, 'gemini-extension.json'), JSON.stringify(manifest, null, 2))
    expect(await adapter.inspectAdoptableArtifacts!(ctx)).toEqual([])
  })

  it('does not promote list/hash read-back to C4 without fresh memory and all lifecycle activity', async () => {
    let ctx = context()
    const adapter = createGeminiExtensionHostAdapter({ adapterVersion: '7', dependencies: runner() })
    const connect = await adapter.plan(ctx, request(ctx))
    await adapter.apply(ctx, connect.mutations[0])
    const staticOnly = await adapter.verify(ctx, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      expectedCapability: 4,
      inspection: await adapter.inspect(ctx),
    })
    expect(staticOnly.every(result => result.status === 'unverified')).toBe(true)

    ctx = {
      ...ctx,
      hostActivityEvidence: {
        find(query) {
          return query.componentKey === 'memory_tools'
            ? [
                activity(ctx, 'memory_tools', 'brain_recall'),
                activity(ctx, 'memory_tools', 'brain_digest'),
              ]
            : (['session_start', 'pre_compact', 'session_end'] as const)
                .map(signal => activity(ctx, 'lifecycle', signal))
        },
      },
    }
    const verified = await adapter.verify(ctx, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      expectedCapability: 4,
      inspection: await adapter.inspect(ctx),
      activityBinding: {
        installationId: 'installation-gemini',
        tideMindVersion: '0.2.92',
        adapterVersion: '7',
        projectionVersion: '1',
        hostVersion: '0.39.1',
        activationRunId: 'run-gemini',
        activityGenerationToken: 'generation-gemini',
        observedAfter: '2026-09-02T00:00:00.000Z',
        verifiedAt: '2026-09-02T00:10:00.000Z',
      },
    })
    expect(verified).toEqual(expect.arrayContaining([
      expect.objectContaining({ componentKey: 'instruction', status: 'verified', verifiedCapability: 1 }),
      expect.objectContaining({ componentKey: 'memory_tools', status: 'verified', verifiedCapability: 2 }),
      expect.objectContaining({ componentKey: 'lifecycle', status: 'verified', verifiedCapability: 4 }),
    ]))
  })

  it.each(['session_start', 'pre_compact', 'session_end'] as const)(
    'does not verify Gemini C4 when %s evidence is missing',
    async (missingSignal) => {
      let ctx = context()
      const adapter = createGeminiExtensionHostAdapter({ adapterVersion: '7', dependencies: runner() })
      const connect = await adapter.plan(ctx, request(ctx))
      await adapter.apply(ctx, connect.mutations[0])
      const lifecycleSignals = (['session_start', 'pre_compact', 'session_end'] as const)
        .filter(signal => signal !== missingSignal)
      ctx = {
        ...ctx,
        hostActivityEvidence: {
          find(query) {
            return query.componentKey === 'memory_tools'
              ? [
                  activity(ctx, 'memory_tools', 'brain_recall'),
                  activity(ctx, 'memory_tools', 'brain_digest'),
                ]
              : lifecycleSignals.map(signal => activity(ctx, 'lifecycle', signal))
          },
        },
      }

      const results = await adapter.verify(ctx, {
        componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
        expectedCapability: 4,
        inspection: await adapter.inspect(ctx),
        activityBinding: {
          installationId: 'installation-gemini',
          tideMindVersion: '0.2.92',
          adapterVersion: '7',
          projectionVersion: '1',
          hostVersion: '0.39.1',
          activationRunId: 'run-gemini',
          activityGenerationToken: 'generation-gemini',
          observedAfter: '2026-09-02T00:00:00.000Z',
          verifiedAt: '2026-09-02T00:10:00.000Z',
        },
      })
      expect(results.find(result => result.componentKey === 'lifecycle')).toMatchObject({
        status: 'unverified',
        verifiedCapability: null,
      })
    },
  )

  function context(tideMindVersion = '0.2.92'): AdapterOperationContext {
    const configRoot = path.join(root, '.gemini')
    fs.mkdirSync(configRoot, { recursive: true })
    return {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: root,
        applicationDataDir: path.join(root, 'app-data'),
        shimPath: '/Applications/Tide Mind.app/Contents/Resources/tm-node',
        mcpServerPath: '/Applications/Tide Mind.app/Contents/Resources/mcp-server.cjs',
        hookScriptPath: '/Applications/Tide Mind.app/Contents/Resources/hook-session-start.cjs',
        preCompactScriptPath: '/Applications/Tide Mind.app/Contents/Resources/hook-pre-compact.cjs',
        postCompactScriptPath: '/Applications/Tide Mind.app/Contents/Resources/hook-post-compact.cjs',
        tideMindVersion,
        catalogVersion: '2026-09-02',
        projectionVersion: '1',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'usr_fixture',
        productFamilyId: 'gemini',
        hostVariant: 'gemini-cli',
        configRoot,
        distribution: {
          distributionId: 'npm:@google/gemini-cli',
          executableRealpath: executable,
          packageProvenance: 'npm_metadata:@google/gemini-cli',
        },
      }),
      installationId: 'installation-gemini',
      hostVersion: '0.39.1',
      agentId: 'eb_gemini_1234',
      operationId: `operation-${tideMindVersion}`,
      activityGenerationToken: 'generation-gemini',
    }
  }

  function request(
    ctx: AdapterOperationContext,
    ownedArtifacts: readonly OwnedArtifactBaseline[] = [],
  ): AdapterPlanRequest {
    return {
      desiredCapability: 4,
      desiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      observed: {
        catalogId: 'gemini-cli',
        detected: true,
        distribution: ctx.installation.distribution,
        components: [],
        provenance: [],
        diagnostics: [],
      },
      ownedArtifacts,
    }
  }

  function owned(
    ctx: AdapterOperationContext,
    mutation: PlannedMutation,
    hash: string,
  ): OwnedArtifactBaseline[] {
    return (['instruction', 'memory_tools', 'lifecycle'] as const).map(componentKey => ({
      componentKey,
      physicalTarget: mutation.physicalTarget,
      ownershipKey: mutation.ownershipKey,
      ownedFragmentHash: hash,
      selectorSchemaVersion: 1,
    }))
  }

  function runner(): GeminiExtensionAdapterDependencies {
    return {
      async run(_executable, args) {
        commands.push([...args])
        const extensionsRoot = path.join(root, '.gemini', 'extensions')
        if (args[0] !== 'extensions') return { exitCode: 1, stdout: '', stderr: 'unexpected command' }
        if (args[1] === 'list') {
          const records = fs.existsSync(extensionsRoot)
            ? fs.readdirSync(extensionsRoot).flatMap((name) => {
                const manifestPath = path.join(extensionsRoot, name, 'gemini-extension.json')
                if (!fs.existsSync(manifestPath)) return []
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
                return [{ name, version: manifest.version, path: path.join(extensionsRoot, name), isActive: active.get(name) ?? true }]
              })
            : []
          return { exitCode: 0, stdout: JSON.stringify(records), stderr: '' }
        }
        if (args[1] === 'install') {
          if (failNextInstall) {
            failNextInstall = false
            return { exitCode: 7, stdout: '', stderr: 'simulated install interruption' }
          }
          const source = args[2]
          const manifest = JSON.parse(fs.readFileSync(path.join(source, 'gemini-extension.json'), 'utf8'))
          const destination = path.join(extensionsRoot, manifest.name)
          if (fs.existsSync(destination)) return { exitCode: 1, stdout: '', stderr: 'already installed' }
          fs.mkdirSync(extensionsRoot, { recursive: true })
          fs.cpSync(source, destination, { recursive: true })
          fs.writeFileSync(path.join(destination, '.gemini-extension-install.json'), JSON.stringify({ source, type: 'local' }))
          active.set(manifest.name, true)
          return { exitCode: 0, stdout: 'installed', stderr: '' }
        }
        if (args[1] === 'uninstall') {
          const name = args[2]
          fs.rmSync(path.join(extensionsRoot, name), { recursive: true, force: true })
          active.delete(name)
          return { exitCode: 0, stdout: 'uninstalled', stderr: '' }
        }
        if (args[1] === 'enable') {
          active.set(args[2], true)
          return { exitCode: 0, stdout: 'enabled', stderr: '' }
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected extension command' }
      },
    }
  }

  function activity(
    ctx: AdapterOperationContext,
    componentKey: 'memory_tools' | 'lifecycle',
    signalName: 'brain_recall' | 'brain_digest' | 'session_start' | 'pre_compact' | 'session_end',
  ): HostActivityEvidenceRecord {
    return {
      id: `activity-${componentKey}`,
      installationId: 'installation-gemini',
      agentId: ctx.agentId,
      hostVariant: 'gemini-cli',
      componentKey,
      signalName,
      tideMindVersion: '0.2.92',
      adapterVersion: '7',
      projectionVersion: '1',
      hostVersion: '0.39.1',
      evidenceHash: `evidence-${componentKey}`,
      observedAt: '2026-09-02T00:05:00.000Z',
    }
  }
})
