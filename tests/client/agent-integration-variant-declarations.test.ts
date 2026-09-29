import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { createCustomGuidedMcpHostAdapter } from '../../client/electron/agent-integration/hosts/custom-guided-mcp-adapter'
import {
  AGENT_INTEGRATION_RELEASE_ENTRIES,
  CUSTOM_CONFIG_ROOT_RELOCATABLE_CATALOG_IDS,
} from '../../client/electron/agent-integration/release-manifest'
import {
  AGENT_VARIANT_DECLARATIONS,
  deactivationMethodsForComponents,
  variantDeclarationById,
  variantDeclarationFor,
  type VariantDeclaration,
} from '../../client/electron/agent-integration/variant-declarations'
import type { AgentHostAdapter, ComponentKey } from '../../client/electron/agent-integration/types'

const sorted = (values: readonly string[]) => [...values].sort()
const requirements = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../scripts/agent-integration-host-acceptance-requirements.json'),
  'utf8',
)) as {
  releaseMacArchitectures: string[]
  customPaths: string[]
  customGuidedTargets: Array<{ schemaKind: string; selectorKey: string }>
}

/** Every official distribution of every writable release entry (the 21 P0 targets and their x64 twins). */
function releaseTargets() {
  return AGENT_INTEGRATION_RELEASE_ENTRIES
    .filter(entry => entry.releaseMode === 'production' && entry.disposition !== 'observe_only')
    .flatMap(entry => entry.officialDistributions.map(distribution => ({ entry, distribution })))
}

function adapterFor(declaration: VariantDeclaration, adapters: ReadonlyMap<string, AgentHostAdapter>): AgentHostAdapter {
  if (declaration.disposition === 'custom_user_owned') return createCustomGuidedMcpHostAdapter()
  const adapter = adapters.get(declaration.catalogId!)
  if (!adapter) throw new Error(`no Adapter for ${declaration.variantId}`)
  return adapter
}

describe('per-variant atomic groups and shared-domain declarations', () => {
  const adapters = createP0HostAdapters()

  it('declares every official distribution target, including the 21 arm64 P0 targets, and the five Custom targets', () => {
    const arm64Targets = releaseTargets().filter(({ distribution }) => (
      requirements.releaseMacArchitectures.some(architecture => (
        (distribution as { supportedMacArchitectures?: readonly string[] }).supportedMacArchitectures?.includes(architecture)
      ))
    ))
    expect(arm64Targets).toHaveLength(21)
    for (const { entry, distribution } of releaseTargets()) {
      const declaration = AGENT_VARIANT_DECLARATIONS.find(candidate => (
        candidate.catalogId === entry.catalogId && candidate.distributionId === distribution.distributionId
      ))
      expect(declaration, `${entry.catalogId}:${distribution.distributionId}`).toBeDefined()
    }
    const customKeys = [
      ...requirements.customPaths,
      ...requirements.customGuidedTargets.map(target => `manual_mcp_client:${target.schemaKind}:${target.selectorKey}`),
    ]
    expect(customKeys).toHaveLength(5)
    for (const key of customKeys) expect(variantDeclarationById(key), key).toBeDefined()
    expect(new Set(AGENT_VARIANT_DECLARATIONS.map(declaration => declaration.variantId)).size)
      .toBe(AGENT_VARIANT_DECLARATIONS.length)
  })

  it('matches the release manifest required components and the concrete Adapter component keys', () => {
    for (const { entry, distribution } of releaseTargets()) {
      const declaration = variantDeclarationFor(entry.catalogId, distribution.distributionId)!
      expect(sorted(declaration.logicalComponents), declaration.variantId).toEqual(sorted(entry.requiredComponents))
      const adapter = adapters.get(entry.catalogId)!
      expect(sorted(adapter.componentKeys), declaration.variantId).toEqual(sorted(declaration.logicalComponents))
      for (const [component, dependencies] of Object.entries(adapter.verificationDependencies ?? {})) {
        expect(sorted(declaration.dependencies[component as ComponentKey] ?? []), `${declaration.variantId}:${component}`)
          .toEqual(expect.arrayContaining(sorted(dependencies ?? [])))
      }
    }
    for (const declaration of AGENT_VARIANT_DECLARATIONS.filter(item => item.catalogId === 'custom-local-mcp')) {
      expect(sorted(adapterFor(declaration, adapters).componentKeys)).toEqual(sorted(declaration.logicalComponents))
    }
  })

  it('derives supported bundles exactly from connect-optional Adapter components', () => {
    for (const declaration of AGENT_VARIANT_DECLARATIONS) {
      if (declaration.disposition === 'custom_inherited') continue
      if (declaration.disposition === 'migration') {
        expect(declaration.supportedBundles).toEqual([])
        continue
      }
      const adapter = adapterFor(declaration, adapters)
      const all = sorted(declaration.logicalComponents)
      const expected = [all]
      for (const optional of adapter.connectOptionalComponentKeys ?? []) {
        expected.push(all.filter(component => component !== optional))
      }
      expect(declaration.supportedBundles.map(bundle => sorted(bundle)).sort(), declaration.variantId)
        .toEqual(expected.sort())
    }
  })

  it('makes atomic groups partition the components and every bundle a union of whole groups', () => {
    for (const declaration of AGENT_VARIANT_DECLARATIONS) {
      const grouped = declaration.atomicGroups.flatMap(group => group.components)
      expect(sorted(grouped), declaration.variantId).toEqual(sorted(declaration.logicalComponents))
      expect(new Set(grouped).size, declaration.variantId).toBe(grouped.length)
      for (const bundle of declaration.supportedBundles) {
        const covering = declaration.atomicGroups.filter(group => group.components.some(component => bundle.includes(component)))
        for (const group of covering) {
          expect(group.components.every(component => bundle.includes(component)), `${declaration.variantId}:${group.id}`)
            .toBe(true)
        }
        expect(sorted(covering.flatMap(group => group.components))).toEqual(sorted(bundle))
      }
      for (const domain of declaration.physicalDomains) {
        expect(domain.components.every(component => declaration.logicalComponents.includes(component))).toBe(true)
      }
    }
  })

  it('binds each deactivation method to the Adapter mutation domain that implements it', () => {
    for (const declaration of AGENT_VARIANT_DECLARATIONS) {
      if (declaration.disposition === 'custom_inherited') continue
      const adapter = adapterFor(declaration, adapters)
      for (const group of declaration.atomicGroups) {
        for (const component of group.components) {
          const contract = adapter.componentContracts?.[component]
          expect(contract, `${declaration.variantId}:${component}`).toBeDefined()
          if (group.deactivationMethod === 'host_command') {
            expect(contract!.mutationDomain, `${declaration.variantId}:${component}`).toBe('plugin_manager')
          } else {
            expect(contract!.mutationDomain, `${declaration.variantId}:${component}`).not.toBe('plugin_manager')
          }
          if (group.deactivationMethod === 'ownership_cas_file_fragment') {
            expect(contract!.mutationDomain).toBe('file_fragment')
          }
        }
      }
      const methods = new Set(declaration.atomicGroups.map(group => group.deactivationMethod))
      expect(methods.has(declaration.deactivationMethod) || declaration.atomicGroups.length === 0).toBe(true)
    }
  })

  it('names the shared physical domains of matrix §6 and nothing else as cross-variant', () => {
    const consumers = new Map<string, Set<string>>()
    for (const declaration of AGENT_VARIANT_DECLARATIONS) {
      for (const domain of declaration.physicalDomains) {
        if (domain.sharing === 'dedicated') continue
        const catalogVariant = declaration.distributionId?.includes('darwin-x64') ? null : declaration.variantId
        if (!catalogVariant) continue
        consumers.set(domain.id, (consumers.get(domain.id) ?? new Set()).add(catalogVariant))
      }
    }
    expect(sorted([...consumers.get('agents_shared_skill')!])).toEqual(sorted([
      'codex-cli', 'codex-desktop', 'opencode-v1-cli:darwin-arm64', 'opencode-v2-beta-cli:darwin-arm64',
    ]))
    expect(sorted([...consumers.get('opencode_json')!])).toEqual(sorted([
      'opencode-v1-cli:darwin-arm64', 'opencode-v2-beta-cli:darwin-arm64',
    ]))
    expect(sorted([...consumers.get('codex_config_toml')!])).toEqual(['codex-cli', 'codex-desktop'])
    expect(sorted([...consumers.get('codex_hooks_json')!])).toEqual(['codex-cli', 'codex-desktop'])
    expect(sorted([...consumers.get('qwen_settings_json')!])).toEqual(['qwen-code-cli:npm-global', 'qwen-code-cli:standalone'])
    expect(sorted([...consumers.get('openclaw_state_root')!])).toEqual(['openclaw-local:npm-global', 'openclaw-local:portable-wrapper'])
    expect(sorted([...consumers.get('claude_plugin_registry')!])).toEqual(['claude-code-cli', 'claude-code-native'])
    expect(sorted([...consumers.get('kimi_config_toml')!])).toEqual(['kimi-code-cli', 'kimi-code-native'])
  })

  it('keeps aggregate plugins whole, Custom C1 inheriting and C3–C5 user-owned', () => {
    for (const catalogId of ['claude-code-cli', 'gemini-cli', 'pi-official-cli'] as const) {
      const declaration = variantDeclarationFor(catalogId, undefined)!
      expect(declaration.supportedBundles).toEqual([['instruction', 'memory_tools', 'lifecycle']])
      expect(declaration.deactivationMethod).toBe('host_command')
    }
    expect(variantDeclarationFor('openclaw-local', 'cli:openclaw-local:npm-global')!.deactivationMethod).toBe('host_command')
    expect(variantDeclarationFor('claude-cowork-local', 'com.anthropic.claudefordesktop')!.supportedBundles)
      .toEqual([['instruction', 'memory_tools']])
    expect(variantDeclarationById('nonstandard_config_root')!.inheritsFromSourceHost)
      .toEqual([...CUSTOM_CONFIG_ROOT_RELOCATABLE_CATALOG_IDS])
    expect(variantDeclarationById('manual_mcp_client')!.deactivationMethod).toBe('ownership_cas_file_fragment')
    expect(variantDeclarationById('manual_mcp_client:opencode_mcp:tidemind_opencode')!.deactivationMethod).toBe('guided_manual')
    const codex = variantDeclarationFor('codex-cli', 'cli:codex-cli')!
    expect(deactivationMethodsForComponents(codex, ['memory_tools', 'lifecycle'])).toEqual(['ownership_cas_file_fragment'])
    expect(deactivationMethodsForComponents(codex, ['instruction'])).toEqual(['guided_manual'])
  })
})
