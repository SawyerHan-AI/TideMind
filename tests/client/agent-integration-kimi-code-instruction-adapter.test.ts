import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createKimiCodeInstructionHostAdapter } from '../../client/electron/agent-integration/hosts/kimi-code-instruction-adapter'
import { P0_INSTRUCTION_SPECS } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type { AdapterOperationContext, OwnedArtifactBaseline } from '../../client/electron/agent-integration/types'

const AGENT_ID = 'eb_kimi_instruction_test'
const DESCRIPTION = 'Tide Mind 外部记忆系统。用户上下文在每次会话开始时通过 Hook 自动加载（在第一条消息前注入）。对话过程中使用 brain_recall 查询历史信息，使用 brain_digest 存储有价值的内容。'

describe('Kimi 0.2.91 instruction migration adapter', () => {
  let root: string
  let context: AdapterOperationContext
  const spec = P0_INSTRUCTION_SPECS['kimi-code-cli']!
  const adapter = () => createKimiCodeInstructionHostAdapter(spec)

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-instruction-migration-')))
    const configRoot = path.join(root, '.kimi-code')
    fs.mkdirSync(configRoot, { recursive: true })
    context = {
      runtime: {
        runtimeRealm: 'local_macos',
        homeDir: root,
        applicationDataDir: path.join(root, '.tidemind'),
        shimPath: path.join(root, 'tm-node'),
        mcpServerPath: path.join(root, 'mcp-server.cjs'),
        hookScriptPath: path.join(root, 'hook-session-start.cjs'),
        preCompactScriptPath: path.join(root, 'hook-pre-compact.cjs'),
        postCompactScriptPath: path.join(root, 'hook-post-compact.cjs'),
        tideMindVersion: '0.2.92',
        catalogVersion: '2',
        projectionVersion: '3',
      },
      installation: canonicalizeInstallationIdentity({
        runtimeRealm: 'local_macos',
        osUserIdentity: 'usr_kimi_instruction',
        productFamilyId: 'kimi-code',
        hostVariant: 'kimi-code-cli',
        configRoot,
        distribution: { executableRealpath: path.join(root, 'kimi') },
      }),
      agentId: AGENT_ID,
      operationId: 'operation-1',
    }
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  function legacyPath(): string {
    return path.join(context.installation.canonicalConfigRoot, 'skills', `tidemind-${AGENT_ID}`, 'SKILL.md')
  }

  function currentPath(): string {
    return path.join(context.installation.canonicalConfigRoot, 'skills', 'tidemind', 'SKILL.md')
  }

  function writeLegacy(suffix = ''): void {
    const body = fs.readFileSync(path.resolve('data', 'skill', 'kimi-code-skill.md'), 'utf8')
    fs.mkdirSync(path.dirname(legacyPath()), { recursive: true })
    fs.writeFileSync(legacyPath(), [
      '---',
      `name: tidemind-${AGENT_ID}`,
      `description: ${JSON.stringify(DESCRIPTION)}`,
      '---',
      '',
    ].join('\n') + body + suffix)
  }

  async function adoptedBaseline(): Promise<OwnedArtifactBaseline> {
    const observation = (await adapter().inspectAdoptableArtifacts!(context))[0]
    return {
      componentKey: 'instruction',
      physicalTarget: observation.physicalTarget,
      ownershipKey: observation.ownershipKey,
      ownedFragmentHash: observation.fragmentHash,
      selectorSchemaVersion: observation.selectorSchemaVersion,
    }
  }

  it('adopts without writing, then migrates the exact legacy Skill and removes its empty directory', async () => {
    writeLegacy()
    const before = fs.readFileSync(legacyPath(), 'utf8')
    const host = adapter()
    const observation = await host.inspectAdoptableArtifacts!(context)
    expect(observation).toEqual([expect.objectContaining({
      componentKey: 'instruction',
      physicalTarget: fs.realpathSync(legacyPath()),
      identityAssertion: AGENT_ID,
    })])
    expect(fs.readFileSync(legacyPath(), 'utf8')).toBe(before)
    expect(fs.existsSync(currentPath())).toBe(false)

    const plan = await host.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['instruction'],
      observed: await host.inspect(context),
      ownedArtifacts: [await adoptedBaseline()],
    })
    expect(plan.mutations).toEqual([expect.objectContaining({
      operation: 'create',
      physicalTarget: currentPath(),
      additionalFenceTargets: [{ domainKind: 'file_fragment', physicalTarget: fs.realpathSync(legacyPath()) }],
      ownershipTransferFrom: expect.objectContaining({ physicalTarget: fs.realpathSync(legacyPath()) }),
    })])
    await host.apply(context, plan.mutations[0])

    expect(fs.existsSync(legacyPath())).toBe(false)
    expect(fs.existsSync(path.dirname(legacyPath()))).toBe(false)
    expect(fs.readFileSync(currentPath(), 'utf8')).toContain('name: tidemind')
    expect(await host.readBack(context, plan.mutations[0])).toMatchObject({
      matchesDesired: true,
      observedFragmentHash: plan.mutations[0].desiredFragmentHash,
    })
  })

  it('resumes only the frozen partial state where the new Skill exists and the exact legacy Skill remains', async () => {
    writeLegacy()
    const host = adapter()
    const plan = await host.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['instruction'],
      observed: await host.inspect(context),
      ownedArtifacts: [await adoptedBaseline()],
    })
    const desiredContent = String(plan.mutations[0].metadata!.desiredContent)
    fs.mkdirSync(path.dirname(currentPath()), { recursive: true })
    fs.writeFileSync(currentPath(), desiredContent)

    expect(await host.readBack(context, plan.mutations[0])).toMatchObject({
      matchesDesired: false,
      safeToResumeFrom: plan.mutations[0].safeResumeStates![0],
    })
    await host.apply(context, plan.mutations[0])
    expect(fs.existsSync(legacyPath())).toBe(false)
    expect(fs.readFileSync(currentPath(), 'utf8')).toBe(desiredContent)
  })

  it('does not adopt or mutate a similar user Skill, and blocks an occupied migration target', async () => {
    writeLegacy('\nuser edit\n')
    const host = adapter()
    expect(await host.inspectAdoptableArtifacts!(context)).toEqual([])
    const changed = fs.readFileSync(legacyPath(), 'utf8')
    const unowned = await host.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['instruction'],
      observed: await host.inspect(context),
      ownedArtifacts: [],
    })
    expect(unowned.mutations).toEqual([])
    expect(unowned.requiredUserActions).toContain('review_kimi_instruction_migration_conflict')
    expect(unowned.requiredUserActionDetails?.[0]).toMatchObject({
      kind: 'kimi_instruction_conflict',
      reason: 'legacy_not_exact',
      sourcePath: legacyPath(),
      targetPath: currentPath(),
    })
    expect(fs.readFileSync(legacyPath(), 'utf8')).toBe(changed)

    fs.rmSync(path.dirname(legacyPath()), { recursive: true })
    writeLegacy()
    const baseline = await adoptedBaseline()
    fs.mkdirSync(path.dirname(currentPath()), { recursive: true })
    fs.writeFileSync(currentPath(), '# user target\n')
    const conflict = await host.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['instruction'],
      observed: await host.inspect(context),
      ownedArtifacts: [baseline],
    })
    expect(conflict.mutations).toEqual([])
    expect(conflict.diagnostics).toContain('kimi_instruction_target_conflict')
    expect(conflict.requiredUserActionDetails?.[0]).toMatchObject({
      kind: 'kimi_instruction_conflict',
      reason: 'target_occupied',
    })
    expect(fs.readFileSync(currentPath(), 'utf8')).toBe('# user target\n')
    expect(fs.existsSync(legacyPath())).toBe(true)
  })

  it('disconnects only the exact owned current Skill and preserves sibling user Skills', async () => {
    const host = adapter()
    const create = await host.plan(context, {
      desiredCapability: 4,
      desiredComponents: ['instruction'],
      observed: await host.inspect(context),
      ownedArtifacts: [],
    })
    await host.apply(context, create.mutations[0])
    const userSkill = path.join(context.installation.canonicalConfigRoot, 'skills', 'mine', 'SKILL.md')
    fs.mkdirSync(path.dirname(userSkill), { recursive: true })
    fs.writeFileSync(userSkill, '# mine\n')
    const baseline: OwnedArtifactBaseline = {
      componentKey: 'instruction',
      physicalTarget: fs.realpathSync(currentPath()),
      ownershipKey: 'document',
      ownedFragmentHash: create.mutations[0].desiredFragmentHash!,
      selectorSchemaVersion: 1,
    }
    const disconnect = await host.disconnect(context, {
      componentKeys: ['instruction'],
      observed: await host.inspect(context),
      ownedArtifacts: [baseline],
    })
    expect(disconnect.requiredUserActions).toEqual([])
    expect(disconnect.mutations[0]).toMatchObject({ operation: 'remove', preconditionHash: baseline.ownedFragmentHash })
    await host.apply(context, disconnect.mutations[0])
    expect(fs.existsSync(currentPath())).toBe(false)
    expect(fs.existsSync(path.dirname(currentPath()))).toBe(false)
    expect(fs.readFileSync(userSkill, 'utf8')).toBe('# mine\n')
  })
})
