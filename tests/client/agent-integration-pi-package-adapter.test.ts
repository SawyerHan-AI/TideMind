import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import {
  createPiPackageHostAdapter,
  type PiPackageAdapterDependencies,
} from '../../client/electron/agent-integration/hosts/pi-package-adapter'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { buildExecutionPlan } from '../../client/electron/agent-integration/planner'
import type {
  AdapterOperationContext,
  HostActivityEvidenceQuery,
  HostActivityEvidenceRecord,
  OwnedArtifactBaseline,
} from '../../client/electron/agent-integration/types'

describe('Pi official native Package adapter', () => {
  let root: string
  let context: AdapterOperationContext
  let dependencies: PiPackageAdapterDependencies

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-package-adapter-'))
    const configRoot = path.join(root, '.pi', 'agent')
    const executable = path.join(root, 'bin', 'pi')
    const runtimeRoot = path.join(root, 'Tide Mind.app', 'Contents', 'Resources')
    for (const asset of [
      executable,
      path.join(runtimeRoot, 'tm-node'),
      path.join(runtimeRoot, 'mcp-server.cjs'),
      path.join(runtimeRoot, 'hook-session-start.cjs'),
      path.join(runtimeRoot, 'hook-pre-compact.cjs'),
      path.join(runtimeRoot, 'hook-post-compact.cjs'),
      path.join(runtimeRoot, 'hook-pi-lifecycle.cjs'),
    ]) {
      fs.mkdirSync(path.dirname(asset), { recursive: true })
      fs.writeFileSync(asset, '')
    }
    fs.mkdirSync(configRoot, { recursive: true })
    context = {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: root,
        applicationDataDir: path.join(root, 'tide-mind-data'),
        shimPath: path.join(runtimeRoot, 'tm-node'),
        mcpServerPath: path.join(runtimeRoot, 'mcp-server.cjs'),
        hookScriptPath: path.join(runtimeRoot, 'hook-session-start.cjs'),
        preCompactScriptPath: path.join(runtimeRoot, 'hook-pre-compact.cjs'),
        postCompactScriptPath: path.join(runtimeRoot, 'hook-post-compact.cjs'),
        tideMindVersion: '0.2.92',
        catalogVersion: '1.3.0',
        projectionVersion: '7',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'usr_01JPIADAPTER',
        productFamilyId: 'pi-official',
        hostVariant: 'pi-official-cli',
        configRoot,
        distribution: {
          distributionId: 'pi:earendil',
          executableRealpath: executable,
          packageProvenance: 'npm_metadata:@earendil-works/pi-coding-agent',
          capabilityFingerprint: 'cli-surface:pi-package',
        },
      }),
      installationId: 'installation_pi',
      hostVersion: '0.36.1',
      agentId: 'eb_pi_1234',
      operationId: 'operation_pi',
      activityGenerationToken: 'generation_pi',
    }
    dependencies = fakePi(context)
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  async function connectPlan(ownedArtifacts: readonly OwnedArtifactBaseline[] = []) {
    const adapter = createPiPackageHostAdapter({ adapterVersion: '1', dependencies })
    return adapter.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      observed: await adapter.inspect(context),
      ownedArtifacts,
    })
  }

  it('plans one aggregate Package mutation with both physical writer domains frozen', async () => {
    const plan = await connectPlan()
    expect(plan.diagnostics).toEqual([])
    expect(plan.mutations).toHaveLength(1)
    expect(plan.mutations[0]).toMatchObject({
      componentKey: 'instruction',
      coveredComponentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      operation: 'host_command',
      domainKind: 'plugin_manager',
      commandCategory: 'plugin_install',
      args: ['install', expect.stringContaining('/agent-integration/pi-packages/eb_pi_1234'), '--no-approve'],
      additionalFenceTargets: [{
        domainKind: 'file_fragment',
        physicalTarget: path.join(context.installation.canonicalConfigRoot, 'settings.json'),
      }],
    })
    expect(plan.mutations[0].metadata).toMatchObject({
      artifactType: 'plugin',
      reversible: true,
      settingsContainerPreconditionHash: null,
      beforeRegistrationSelectorHash: null,
      remove: false,
    })
    const frozen = buildExecutionPlan({
      installationId: 'installation_pi',
      installationKey: context.installation.installKey,
      operation: 'connect',
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      inspection: await createPiPackageHostAdapter({ adapterVersion: '1', dependencies }).inspect(context),
      adapterPlan: plan,
      catalogGeneration: 1,
      adapterGeneration: 1,
      projectionGeneration: 1,
      createdAt: '2026-09-03T00:00:00.000Z',
    })
    expect(frozen.executionPlan.mutations[0]).toMatchObject({
      targetPath: plan.mutations[0].physicalTarget,
      reversible: true,
    })
  })

  it('installs Skill, native tools and lifecycle Extension while preserving user settings', async () => {
    const settingsPath = path.join(context.installation.canonicalConfigRoot, 'settings.json')
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'user-theme', packages: ['npm:user-package'] }, null, 2))
    const adapter = createPiPackageHostAdapter({ adapterVersion: '1', dependencies })
    const plan = await connectPlan()
    const mutation = plan.mutations[0]

    await adapter.apply(context, mutation)
    const readBack = await adapter.readBack(context, mutation)
    expect(readBack).toMatchObject({ observed: true, matchesDesired: true, visibility: 'dedicated' })

    const packageRoot = mutation.physicalTarget
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    const skill = fs.readFileSync(path.join(packageRoot, 'skills', 'tidemind', 'SKILL.md'), 'utf8')
    const extension = fs.readFileSync(path.join(packageRoot, 'extensions', 'tidemind.ts'), 'utf8')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(manifest).toMatchObject({
      name: '@tidemind/pi-eb_pi_1234',
      pi: { extensions: ['./extensions/tidemind.ts'], skills: ['./skills/tidemind'] },
      tidemind: { agentId: 'eb_pi_1234', hostVariant: 'pi-official-cli', adapterVersion: '1', projectionVersion: '7' },
    })
    expect(skill).toContain('`eb_pi_1234`')
    expect(extension).toContain('pi.registerTool({')
    expect(extension).toContain('name: "brain_prepare"')
    expect(extension).toContain('name: "brain_recall"')
    expect(extension).toContain('name: "brain_digest"')
    expect(extension).toContain('pi.on("session_shutdown"')
    expect(extension).toContain('EB_AGENT_ID: BINDING.agentId')
    expect(settings).toEqual({
      theme: 'user-theme',
      packages: ['npm:user-package', path.relative(context.installation.canonicalConfigRoot, packageRoot)],
    })
  })

  it('delivers post-compaction context before an automatic continuation but defers manual compaction context', async () => {
    const adapter = createPiPackageHostAdapter({ adapterVersion: '1', dependencies })
    const plan = await connectPlan()
    await adapter.apply(context, plan.mutations[0])
    const extension = fs.readFileSync(
      path.join(plan.mutations[0].physicalTarget, 'extensions', 'tidemind.ts'),
      'utf8',
    )
    expect(extension).toContain('pi.on("session_compact", async (event) =>')

    const generated = transpileModule(extension, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    }).outputText
    const module = { exports: {} as Record<string, unknown> }
    const fakeSpawn = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter
        stderr: EventEmitter
        stdin: { write: (value: string) => boolean; end: (value?: string) => void }
        kill: () => boolean
      }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = {
        write: () => true,
        end: () => queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('restored Tide Mind context\n'))
          child.emit('close', 0)
        }),
      }
      child.kill = () => true
      return child
    }
    const load = new Function('require', 'module', 'exports', generated)
    load((specifier: string) => {
      if (specifier === 'typebox') {
        const schema = () => ({})
        return { Type: { Object: schema, Optional: schema, String: schema } }
      }
      if (specifier === 'node:child_process') return { spawn: fakeSpawn }
      throw new Error(`Unexpected generated extension import: ${specifier}`)
    }, module, module.exports)

    const handlers = new Map<string, (event: { willRetry: boolean }) => Promise<void>>()
    const sent: Array<{ options: { deliverAs: string; triggerTurn: boolean } }> = []
    const register = (module.exports as {
      default: (pi: {
        registerTool: (tool: unknown) => void
        on: (event: string, handler: (payload: { willRetry: boolean }) => Promise<void>) => void
        sendMessage: (message: unknown, options: { deliverAs: string; triggerTurn: boolean }) => void
      }) => void
    }).default
    register({
      registerTool: () => {},
      on: (event, handler) => handlers.set(event, handler),
      sendMessage: (_message, options) => sent.push({ options }),
    })

    await handlers.get('session_compact')!({ willRetry: false })
    await handlers.get('session_compact')!({ willRetry: true })
    expect(sent.map(item => item.options)).toEqual([
      { deliverAs: 'nextTurn', triggerTurn: false },
      { deliverAs: 'steer', triggerTurn: true },
    ])
  })

  it('fails closed on an exact pre-existing aggregate without Ledger ownership', async () => {
    const adapter = createPiPackageHostAdapter({ adapterVersion: '1', dependencies })
    const initial = await connectPlan()
    await adapter.apply(context, initial.mutations[0])

    const repeated = await connectPlan()
    expect(repeated.mutations).toEqual([])
    expect(repeated.diagnostics).toContain('pi_package_exact_state_requires_aggregate_ownership')
  })

  it('does not overwrite a filtered Pi package selector with the same resolved identity', async () => {
    const packageRoot = path.join(
      context.runtime.applicationDataDir,
      'agent-integration',
      'pi-packages',
      context.agentId,
    )
    const storedSource = path.relative(context.installation.canonicalConfigRoot, packageRoot)
    const settingsPath = path.join(context.installation.canonicalConfigRoot, 'settings.json')
    const original = { packages: [{ source: storedSource, skills: [] }], theme: 'keep' }
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2))

    const plan = await connectPlan()
    expect(plan.mutations).toEqual([])
    expect(plan.diagnostics).toContain('pi_package_registration_selector_conflict')
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual(original)
  })

  it('keeps the historical pre-Earendil distribution observe-only', async () => {
    context = {
      ...context,
      installation: {
        ...context.installation,
        distribution: {
          ...context.installation.distribution,
          packageProvenance: 'npm_metadata:@mariozechner/pi-coding-agent',
        },
      },
    }
    const adapter = createPiPackageHostAdapter({ adapterVersion: '1', dependencies })
    const inspected = await adapter.inspect(context)
    expect(inspected.detected).toBe(true)
    expect(inspected.diagnostics).toContain('pi_official_distribution_identity_unproven')
    const plan = await adapter.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['instruction', 'memory_tools', 'lifecycle'],
      observed: inspected,
      ownedArtifacts: [],
    })
    expect(plan.mutations).toEqual([])
  })

  it('rejects a settings change after preview and never invokes install', async () => {
    const calls: string[][] = []
    const delegate = fakePi(context)
    dependencies = {
      async run(executable, args, options) {
        calls.push([...args])
        return delegate.run(executable, args, options)
      },
    }
    const adapter = createPiPackageHostAdapter({ adapterVersion: '1', dependencies })
    const plan = await connectPlan()
    const settingsPath = path.join(context.installation.canonicalConfigRoot, 'settings.json')
    fs.writeFileSync(settingsPath, JSON.stringify({ userChanged: true }))

    await expect(adapter.apply(context, plan.mutations[0])).rejects.toThrow('pi_settings_precondition_changed')
    expect(calls).toEqual([['list', '--no-approve']])
    expect(fs.existsSync(plan.mutations[0].physicalTarget)).toBe(false)
  })

  it('disconnects the exact owned aggregate and preserves unrelated Pi configuration', async () => {
    const settingsPath = path.join(context.installation.canonicalConfigRoot, 'settings.json')
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'keep-me', packages: ['npm:user-package'] }, null, 2))
    const adapter = createPiPackageHostAdapter({ adapterVersion: '1', dependencies })
    const connected = await connectPlan()
    await adapter.apply(context, connected.mutations[0])
    const baselines = aggregateBaselines(connected.mutations[0].physicalTarget, connected.mutations[0].desiredFragmentHash!)

    const disconnect = await adapter.disconnect(context, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      observed: await adapter.inspect(context),
      ownedArtifacts: baselines,
    })
    expect(disconnect.mutations).toHaveLength(1)
    expect(disconnect.mutations[0]).toMatchObject({ args: ['remove', connected.mutations[0].physicalTarget, '--no-approve'] })
    await adapter.apply(context, disconnect.mutations[0])
    expect(await adapter.readBack(context, disconnect.mutations[0])).toMatchObject({ matchesDesired: true, visibility: 'absent' })
    expect(fs.existsSync(connected.mutations[0].physicalTarget)).toBe(false)
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({ theme: 'keep-me', packages: ['npm:user-package'] })
  })

  it('recognizes and resumes the exact crash-visible package-written prefix', async () => {
    const adapter = createPiPackageHostAdapter({ adapterVersion: '1', dependencies })
    const plan = await connectPlan()
    const mutation = plan.mutations[0]
    const metadata = mutation.metadata as { desiredFiles: Record<string, string> }
    for (const [relative, content] of Object.entries(metadata.desiredFiles)) {
      const target = path.join(mutation.physicalTarget, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }

    const interrupted = await adapter.readBack(context, mutation)
    expect(interrupted).toMatchObject({
      matchesDesired: false,
      safeToResumeFrom: { completedStepIds: ['pi_package_written'] },
    })
    await adapter.apply(context, mutation)
    expect(await adapter.readBack(context, mutation)).toMatchObject({ matchesDesired: true })
  })

  it('resumes after Pi removed registration without invoking the non-idempotent remove twice', async () => {
    const base = fakePi(context)
    let removeCalls = 0
    dependencies = {
      async run(executable, args, options) {
        if (args[0] === 'remove') {
          removeCalls += 1
          if (removeCalls > 1) return { exitCode: 1, stdout: '', stderr: 'No matching package' }
        }
        return base.run(executable, args, options)
      },
    }
    const adapter = createPiPackageHostAdapter({ adapterVersion: '1', dependencies })
    const connected = await connectPlan()
    await adapter.apply(context, connected.mutations[0])
    const disconnect = await adapter.disconnect(context, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      observed: await adapter.inspect(context),
      ownedArtifacts: aggregateBaselines(connected.mutations[0].physicalTarget, connected.mutations[0].desiredFragmentHash!),
    })
    const mutation = disconnect.mutations[0]
    await dependencies.run(context.installation.distribution.executableRealpath!, mutation.args!, {
      timeoutMs: 1,
      env: {},
      cwd: root,
    })
    expect(await adapter.readBack(context, mutation)).toMatchObject({
      matchesDesired: false,
      safeToResumeFrom: { completedStepIds: ['pi_registration_removed'] },
    })

    await adapter.apply(context, mutation)
    expect(removeCalls).toBe(1)
    expect(fs.existsSync(connected.mutations[0].physicalTarget)).toBe(false)
  })

  it('keeps static/package-list state unverified and requires real bound activity', async () => {
    const adapter = createPiPackageHostAdapter({ adapterVersion: '1', dependencies })
    const plan = await connectPlan()
    await adapter.apply(context, plan.mutations[0])
    const inspection = await adapter.inspect(context)
    const activityBinding = {
      installationId: 'installation_pi',
      tideMindVersion: '0.2.92',
      adapterVersion: '1',
      projectionVersion: '7',
      hostVersion: '0.36.1',
      activationRunId: 'operation_pi',
      activityGenerationToken: 'generation_pi',
      observedAfter: '2026-09-03T00:00:00.000Z',
      verifiedAt: '2026-09-03T00:10:00.000Z',
    }
    const staticOnly = await adapter.verify(context, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      expectedCapability: 4,
      inspection,
      activityBinding,
    })
    expect(staticOnly.every(item => item.status === 'unverified')).toBe(true)

    context = {
      ...context,
      hostActivityEvidence: {
        find(query: HostActivityEvidenceQuery) {
          return query.signalNames.map((signalName, index): HostActivityEvidenceRecord => ({
            id: `evidence_${query.componentKey}_${index}`,
            installationId: query.installationId,
            agentId: query.agentId,
            hostVariant: query.hostVariant,
            componentKey: query.componentKey,
            signalName,
            tideMindVersion: query.tideMindVersion,
            adapterVersion: query.adapterVersion,
            projectionVersion: query.projectionVersion,
            hostVersion: query.hostVersion,
            evidenceHash: `hash_${signalName}`,
            observedAt: `2026-09-03T00:0${index + 1}:00.000Z`,
          }))
        },
      },
    }
    const verified = await adapter.verify(context, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      expectedCapability: 4,
      inspection,
      activityBinding,
    })
    expect(verified.map(item => [item.componentKey, item.status, item.verifiedCapability])).toEqual([
      ['instruction', 'verified', 1],
      ['memory_tools', 'verified', 2],
      ['lifecycle', 'verified', 4],
    ])
  })

  it('does not claim complete lifecycle before a post-compaction event is observed', async () => {
    const adapter = createPiPackageHostAdapter({ adapterVersion: '1', dependencies })
    const plan = await connectPlan()
    await adapter.apply(context, plan.mutations[0])
    const inspection = await adapter.inspect(context)
    context = {
      ...context,
      hostActivityEvidence: {
        find(query: HostActivityEvidenceQuery) {
          const available = query.componentKey === 'lifecycle'
            ? ['session_start', 'pre_compact', 'session_end']
            : ['brain_prepare', 'brain_recall', 'brain_digest']
          return query.signalNames
            .filter(signalName => available.includes(signalName))
            .map((signalName, index): HostActivityEvidenceRecord => ({
              id: `evidence_${query.componentKey}_${index}`,
              installationId: query.installationId,
              agentId: query.agentId,
              hostVariant: query.hostVariant,
              componentKey: query.componentKey,
              signalName,
              tideMindVersion: query.tideMindVersion,
              adapterVersion: query.adapterVersion,
              projectionVersion: query.projectionVersion,
              hostVersion: query.hostVersion,
              evidenceHash: `hash_${signalName}`,
              observedAt: `2026-09-03T00:0${index + 1}:00.000Z`,
            }))
        },
      },
    }

    const verified = await adapter.verify(context, {
      componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
      expectedCapability: 4,
      inspection,
      activityBinding: {
        installationId: 'installation_pi',
        tideMindVersion: '0.2.92',
        adapterVersion: '1',
        projectionVersion: '7',
        hostVersion: '0.36.1',
        activationRunId: 'operation_pi',
        activityGenerationToken: 'generation_pi',
        observedAfter: '2026-09-03T00:00:00.000Z',
        verifiedAt: '2026-09-03T00:10:00.000Z',
      },
    })

    expect(verified.find(item => item.componentKey === 'lifecycle')).toMatchObject({
      status: 'unverified',
      verifiedCapability: null,
    })
    expect(verified.find(item => item.componentKey === 'lifecycle')?.diagnostics)
      .toContain('fresh_host_activity_evidence_missing')
  })
})

function aggregateBaselines(physicalTarget: string, ownedFragmentHash: string): OwnedArtifactBaseline[] {
  return (['instruction', 'memory_tools', 'lifecycle'] as const).map(componentKey => ({
    componentKey,
    physicalTarget,
    ownershipKey: physicalTarget,
    ownedFragmentHash,
    selectorSchemaVersion: 1,
  }))
}

function fakePi(context: AdapterOperationContext): PiPackageAdapterDependencies {
  const settingsPath = path.join(context.installation.canonicalConfigRoot, 'settings.json')
  const read = (): Record<string, unknown> => fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    : {}
  const write = (document: Record<string, unknown>) => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify(document, null, 2)}\n`)
  }
  return {
    async run(_executable, args) {
      if (args[0] === 'install') {
        const document = read()
        const packages = Array.isArray(document.packages) ? [...document.packages] : []
        const storedSource = path.relative(context.installation.canonicalConfigRoot, args[1]) || '.'
        if (!packages.includes(storedSource)) packages.push(storedSource)
        write({ ...document, packages })
        return { exitCode: 0, stdout: `Installed ${args[1]}\n`, stderr: '' }
      }
      if (args[0] === 'remove') {
        const document = read()
        const storedSource = path.relative(context.installation.canonicalConfigRoot, args[1]) || '.'
        const packages = Array.isArray(document.packages) ? document.packages.filter(value => value !== storedSource) : []
        write({ ...document, packages })
        return { exitCode: 0, stdout: `Removed ${args[1]}\n`, stderr: '' }
      }
      if (args[0] === 'list') {
        const document = read()
        const packages = Array.isArray(document.packages) ? document.packages.filter(value => typeof value === 'string') : []
        return {
          exitCode: 0,
          stdout: packages.length > 0 ? `User packages:\n${packages.map(value => `  ${value}`).join('\n')}\n` : 'No packages installed.\n',
          stderr: '',
        }
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected fake Pi command' }
    },
  }
}
