import { describe, expect, it } from 'vitest'
import { physicalMutationDomain, type CoordinatorInstallation } from '../../client/electron/agent-integration/coordinator'
import { createP0HostAdapters, P0_INSTRUCTION_SPECS, portableSkillContent } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import type { AdapterOperationContext, CatalogId, PlannedMutation } from '../../client/electron/agent-integration/types'

function context(catalogId: CatalogId): AdapterOperationContext {
  const family = catalogId.startsWith('zcode-') ? 'zcode' : 'codex'
  return {
    runtime: {
      runtimeRealm: 'local_macos',
      homeDir: '/Users/fixture',
      applicationDataDir: '/Users/fixture/Library/Application Support/Tide Mind',
      shimPath: '/Applications/Tide Mind.app/Contents/Resources/shim',
      mcpServerPath: '/Applications/Tide Mind.app/Contents/Resources/mcp',
      hookScriptPath: '/Applications/Tide Mind.app/Contents/Resources/hook',
      preCompactScriptPath: '/Applications/Tide Mind.app/Contents/Resources/pre-compact',
      postCompactScriptPath: '/Applications/Tide Mind.app/Contents/Resources/post-compact',
      tideMindVersion: '1',
      catalogVersion: '1',
      projectionVersion: '1',
    },
    installation: canonicalizeInstallationIdentity({
      runtimeRealm: 'local_macos',
      osUserIdentity: 'usr_01JADAPTERREGISTRY',
      productFamilyId: family,
      hostVariant: catalogId,
      configRoot: catalogId.startsWith('zcode-') ? '/Users/fixture/.zcode/cli' : '/Users/fixture/.codex',
    }),
    agentId: `eb_${catalogId}`,
    operationId: `operation_${catalogId}`,
  }
}

describe('P0 host adapter registry', () => {
  it('exposes implemented adapters without claiming unsupported surfaces', () => {
    const adapters = createP0HostAdapters()
    expect(adapters.has('qwen-code-cli')).toBe(true)
    expect(adapters.has('windsurf-desktop')).toBe(true)
    expect(adapters.has('zcode-desktop')).toBe(true)
    expect(adapters.has('zcode-cli')).toBe(false)
    expect(adapters.has('opencode-v1-cli')).toBe(true)
    expect(adapters.has('pi-official-cli')).toBe(true)
    expect(adapters.has('openclaw-local')).toBe(true)
    expect(adapters.has('gemini-cli')).toBe(true)
    expect(adapters.has('qwenwork-desktop')).toBe(true)
    expect(adapters.has('claude-cowork-local')).toBe(true)
  })

  it('registers ZCode Desktop as Skill plus one MCP/lifecycle JSON aggregate', () => {
    const adapter = createP0HostAdapters().get('zcode-desktop')!

    expect(adapter.adapterVersion).toBe('1+2')
    expect(adapter.componentKeys).toEqual(['instruction', 'memory_tools', 'lifecycle'])
    expect(adapter.implementationTypes).toEqual({
      instruction: ['skill'],
      memory_tools: ['mcp'],
      lifecycle: ['hook'],
    })
  })

  it('registers Windsurf as Skill + MCP + official user Hook aggregate', () => {
    const adapter = createP0HostAdapters().get('windsurf-desktop')!
    expect(adapter.componentKeys).toEqual(['instruction', 'memory_tools', 'lifecycle'])
    expect(adapter.implementationTypes).toEqual({
      instruction: ['skill'],
      memory_tools: ['mcp'],
      lifecycle: ['hook'],
    })
  })

  it('registers Cowork as a guided two-component plugin export', () => {
    const adapter = createP0HostAdapters().get('claude-cowork-local')!
    expect(adapter.componentKeys).toEqual(['instruction', 'memory_tools'])
    expect(adapter.implementationTypes).toEqual({
      instruction: ['plugin', 'skill'],
      memory_tools: ['plugin', 'mcp'],
    })
  })

  it('registers QwenWork as one honest managed/guided hybrid aggregate', () => {
    const adapter = createP0HostAdapters().get('qwenwork-desktop')!

    expect(P0_INSTRUCTION_SPECS['qwenwork-desktop']).toBeUndefined()
    expect(adapter.componentKeys).toEqual(['instruction', 'memory_tools', 'lifecycle'])
    expect(adapter.implementationTypes).toEqual({
      instruction: ['skill'],
      memory_tools: ['mcp'],
      lifecycle: ['hook'],
    })
  })

  it('registers Pi as one native package aggregate rather than the portable text fallback', () => {
    const adapter = createP0HostAdapters().get('pi-official-cli')!

    expect(P0_INSTRUCTION_SPECS['pi-official-cli']).toBeUndefined()
    expect(adapter.adapterVersion).toBe('1')
    expect(adapter.componentKeys).toEqual(['instruction', 'memory_tools', 'lifecycle'])
    expect(adapter.implementationTypes).toEqual({
      instruction: ['plugin', 'skill'],
      memory_tools: ['plugin'],
      lifecycle: ['plugin'],
    })
  })

  it('registers OpenClaw as one native Plugin aggregate rather than portable Skill plus loose MCP', () => {
    const adapter = createP0HostAdapters().get('openclaw-local')!

    expect(P0_INSTRUCTION_SPECS['openclaw-local']).toBeUndefined()
    expect(adapter.adapterVersion).toBe('1')
    expect(adapter.componentKeys).toEqual(['instruction', 'memory_tools', 'lifecycle'])
    expect(adapter.implementationTypes).toEqual({
      instruction: ['plugin', 'skill'],
      memory_tools: ['plugin'],
      lifecycle: ['plugin', 'hook'],
    })
  })

  it('registers Gemini as one official Extension aggregate for all components', () => {
    const adapter = createP0HostAdapters().get('gemini-cli')!

    expect(P0_INSTRUCTION_SPECS['gemini-cli']).toBeUndefined()
    expect(adapter.adapterVersion).toBe('1')
    expect(adapter.componentKeys).toEqual(['instruction', 'memory_tools', 'lifecycle'])
    expect(adapter.implementationTypes).toEqual({
      instruction: ['plugin', 'skill'],
      memory_tools: ['plugin', 'mcp'],
      lifecycle: ['plugin', 'hook'],
    })
  })

  it('keeps one portable skill body free of Installation identity', () => {
    expect(Object.keys(P0_INSTRUCTION_SPECS).length).toBeGreaterThan(5)
    expect(portableSkillContent()).toContain('brain_prepare')
    expect(portableSkillContent()).toContain('brain_recall')
    expect(portableSkillContent()).toContain('brain_digest')
    expect(portableSkillContent()).not.toContain('EB_AGENT_ID')
  })

  it('recognizes Kimi instruction only after a real SessionStart signal', () => {
    for (const catalogId of ['kimi-code-cli', 'kimi-code-native'] as const) {
      expect(P0_INSTRUCTION_SPECS[catalogId]?.recognitionViaHostActivity).toEqual({
        componentKey: 'lifecycle',
        signalNames: ['session_start'],
        require: 'any',
        diagnostic: 'document_recognized_after_real_session_start',
      })
    }
  })

  it('declares concrete Artifact carriers for every implemented component', () => {
    for (const [catalogId, adapter] of createP0HostAdapters()) {
      expect(new Set(adapter.componentKeys).size, catalogId).toBe(adapter.componentKeys.length)
      for (const componentKey of adapter.componentKeys) {
        expect(adapter.implementationTypes[componentKey]?.length, `${catalogId}:${componentKey}`).toBeGreaterThan(0)
      }
      expect(Object.keys(adapter.implementationTypes).sort(), catalogId)
        .toEqual([...adapter.componentKeys].sort())
    }
  })

  it('advertises lifecycle omission only when lifecycle has an independent projection', () => {
    const adapters = createP0HostAdapters()
    for (const catalogId of [
      'cursor-desktop', 'windsurf-desktop', 'codex-cli', 'codex-desktop',
      'kimi-code-cli', 'kimi-code-native', 'omp-cli', 'opencode-v1-cli', 'qwenwork-desktop',
    ] as const) {
      expect(adapters.get(catalogId)?.connectOptionalComponentKeys, catalogId).toContain('lifecycle')
    }
    for (const catalogId of [
      'claude-code-cli', 'claude-code-native', 'gemini-cli', 'openclaw-local',
      'qwen-code-cli', 'zcode-desktop', 'pi-official-cli',
    ] as const) {
      expect(adapters.get(catalogId)?.connectOptionalComponentKeys ?? [], catalogId).not.toContain('lifecycle')
    }
  })

  it('projects ZCode Skill into the native user Skill root', () => {
    const spec = P0_INSTRUCTION_SPECS['zcode-desktop']!
    const operationContext = context('zcode-desktop')

    expect(spec.allowedRoot(operationContext)).toBe('/Users/fixture/.zcode/skills')
    expect(spec.targetFile(operationContext)).toBe('/Users/fixture/.zcode/skills/tidemind/SKILL.md')
  })

  it('keeps Codex CLI and Desktop as separate Installations over one physical Skill domain', () => {
    const cliContext = context('codex-cli')
    const desktopContext = context('codex-desktop')
    const cliSpec = P0_INSTRUCTION_SPECS['codex-cli']!
    const desktopSpec = P0_INSTRUCTION_SPECS['codex-desktop']!

    expect(cliContext.installation.installKey).not.toBe(desktopContext.installation.installKey)
    expect(cliSpec.allowedRoot(cliContext)).toBe(desktopSpec.allowedRoot(desktopContext))
    expect(cliSpec.targetFile(cliContext)).toBe(desktopSpec.targetFile(desktopContext))
    expect(cliSpec.targetFile(cliContext)).toBe('/Users/fixture/.agents/skills/tidemind/SKILL.md')

    const target = cliSpec.targetFile(cliContext)
    const mutation: PlannedMutation = {
      operationId: 'operation_codex_skill',
      componentKey: 'instruction',
      operation: 'create',
      domainKind: 'file_fragment',
      physicalTarget: target,
      ownershipKey: 'document',
      selectorSchemaVersion: 1,
      risk: 'low',
      reload: 'new_session',
      idempotent: true,
    }
    const coordinatorInstallation = (
      id: string,
      operationContext: AdapterOperationContext,
    ): CoordinatorInstallation => ({
      id,
      displayName: id,
      desiredState: 'managed',
      identity: operationContext.installation,
      agentId: operationContext.agentId,
    })
    expect(physicalMutationDomain(coordinatorInstallation('codex-cli', cliContext), mutation))
      .toBe(physicalMutationDomain(coordinatorInstallation('codex-desktop', desktopContext), mutation))
  })
})
