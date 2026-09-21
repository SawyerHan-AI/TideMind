import path from 'node:path'
import { createClaudeCodePluginHostAdapter } from './claude-code-plugin-adapter'
import { createClaudeCoworkGuidedHostAdapter } from './claude-cowork-guided-adapter'
import { createCompositeHostAdapter } from './composite-adapter'
import { createCustomLocalMcpHostAdapter } from './custom-local-mcp-adapter'
import { createCursorLifecycleHostAdapter } from './cursor-lifecycle-adapter'
import { createWindsurfLifecycleHostAdapter } from './windsurf-lifecycle-adapter'
import { createCodexLifecycleHostAdapter, type CodexOfficialHooksPort } from './codex-lifecycle-adapter'
import { createCodexMcpTomlHostAdapter } from './codex-mcp-toml-adapter'
import { createGeminiExtensionHostAdapter } from './gemini-extension-adapter'
import {
  createQwenCodeJsonAggregateAdapter,
  createZCodeDesktopJsonAggregateAdapter,
} from './json-mcp-lifecycle-aggregate-adapter'
import { createKimiCodeLifecycleHostAdapter } from './kimi-code-lifecycle-adapter'
import { createKimiCodeInstructionHostAdapter } from './kimi-code-instruction-adapter'
import { createOmpLifecycleHostAdapter } from './omp-lifecycle-adapter'
import { createOpenCodeV1LifecycleHostAdapter } from './opencode-v1-lifecycle-adapter'
import { createManagedTextHostAdapter, type ManagedTextHostSpec } from './managed-text-adapter'
import { createOpenClawPluginHostAdapter } from './openclaw-plugin-adapter'
import { createP0JsonMcpAdapters } from './p0-json-registry'
import { createPiPackageHostAdapter } from './pi-package-adapter'
import { createQwenWorkHybridHostAdapter } from './qwenwork-hybrid-adapter'
import type { AdapterOperationContext, AgentHostAdapter, CatalogId } from '../types'
import { PORTABLE_TIDEMIND_SKILL } from './portable-skill'

function textSpec(
  catalogId: CatalogId,
  root: (context: AdapterOperationContext) => string,
  recognitionViaLifecycle = false,
  recognitionDiagnostic = 'document_loaded_by_lifecycle_command',
): ManagedTextHostSpec {
  return {
    catalogId,
    adapterVersion: '1',
    componentKey: 'instruction',
    artifactType: 'skill',
    targetFile: context => path.join(root(context), 'tidemind', 'SKILL.md'),
    allowedRoot: root,
    content: () => PORTABLE_TIDEMIND_SKILL,
    reload: 'new_session',
    ...(recognitionViaLifecycle ? {
      recognitionViaHostActivity: {
        componentKey: 'lifecycle' as const,
        signalNames: ['session_start'] as const,
        require: 'any' as const,
        diagnostic: recognitionDiagnostic,
      },
    } : {}),
  }
}

const sharedAgentsSkills = (context: AdapterOperationContext) =>
  path.join(context.runtime.homeDir, '.agents', 'skills')
const hostSkills = (context: AdapterOperationContext) =>
  path.join(context.installation.canonicalConfigRoot, 'skills')
const zcodeNativeSkills = (context: AdapterOperationContext) =>
  path.join(context.runtime.homeDir, '.zcode', 'skills')

// CLI and Desktop are distinct verification surfaces but consume one shared
// Codex Skill document. The coordinator's physical-target fence and Ownership
// Ledger therefore serialize them as consumers of the same physical domain.
const codexSharedSkills = sharedAgentsSkills

export const P0_INSTRUCTION_SPECS: Readonly<Partial<Record<CatalogId, ManagedTextHostSpec>>> = Object.freeze({
  'codex-cli': textSpec('codex-cli', codexSharedSkills, true),
  'codex-desktop': textSpec('codex-desktop', codexSharedSkills, true),
  'cursor-desktop': textSpec('cursor-desktop', hostSkills, true),
  'windsurf-desktop': textSpec('windsurf-desktop', hostSkills, true),
  'kimi-code-cli': textSpec('kimi-code-cli', hostSkills, true, 'document_recognized_after_real_session_start'),
  'kimi-code-native': textSpec('kimi-code-native', hostSkills, true, 'document_recognized_after_real_session_start'),
  'qwen-code-cli': textSpec('qwen-code-cli', hostSkills, true),
  'zcode-desktop': textSpec('zcode-desktop', zcodeNativeSkills, true),
  'opencode-v1-cli': textSpec('opencode-v1-cli', sharedAgentsSkills, true),
  'opencode-v2-beta-cli': {
    ...textSpec('opencode-v2-beta-cli', sharedAgentsSkills),
    recognitionViaHostActivity: {
      componentKey: 'memory_tools',
      signalNames: ['brain_prepare'],
      require: 'any',
      diagnostic: 'document_recognized_by_instruction_triggered_prepare',
    },
  },
  'omp-cli': textSpec('omp-cli', hostSkills, true),
})

/** Enabled adapters are assembled only from implemented component projections. */
export function createP0HostAdapters(options: { codexHooksPort?: CodexOfficialHooksPort } = {}): ReadonlyMap<CatalogId, AgentHostAdapter> {
  const memoryAdapters = new Map(createP0JsonMcpAdapters())
  memoryAdapters.set('custom-local-mcp', createCustomLocalMcpHostAdapter())
  memoryAdapters.set('codex-cli', createCodexMcpTomlHostAdapter({ catalogId: 'codex-cli', adapterVersion: '1' }))
  memoryAdapters.set('codex-desktop', createCodexMcpTomlHostAdapter({ catalogId: 'codex-desktop', adapterVersion: '1' }))
  const lifecycleAdapters = new Map<CatalogId, AgentHostAdapter>([
    ['cursor-desktop', createCursorLifecycleHostAdapter()],
    ['windsurf-desktop', createWindsurfLifecycleHostAdapter()],
    ['codex-cli', createCodexLifecycleHostAdapter({ catalogId: 'codex-cli', adapterVersion: '1', hooksPort: options.codexHooksPort })],
    ['codex-desktop', createCodexLifecycleHostAdapter({ catalogId: 'codex-desktop', adapterVersion: '1', hooksPort: options.codexHooksPort })],
    ['kimi-code-cli', createKimiCodeLifecycleHostAdapter({
      catalogId: 'kimi-code-cli',
      adapterVersion: '1',
    })],
    ['kimi-code-native', createKimiCodeLifecycleHostAdapter({
      catalogId: 'kimi-code-native',
      adapterVersion: '1',
    })],
    ['omp-cli', createOmpLifecycleHostAdapter()],
    ['opencode-v1-cli', createOpenCodeV1LifecycleHostAdapter()],
  ])
  const aggregateAdapters = new Map<CatalogId, AgentHostAdapter>([
    ['claude-cowork-local', createClaudeCoworkGuidedHostAdapter()],
    ['claude-code-cli', createClaudeCodePluginHostAdapter({
      catalogId: 'claude-code-cli',
      adapterVersion: '1',
    })],
    ['claude-code-native', createClaudeCodePluginHostAdapter({
      catalogId: 'claude-code-native',
      adapterVersion: '1',
    })],
    ['gemini-cli', createGeminiExtensionHostAdapter({ adapterVersion: '1' })],
    ['openclaw-local', createOpenClawPluginHostAdapter({ adapterVersion: '1' })],
    ['qwen-code-cli', createQwenCodeJsonAggregateAdapter()],
    ['zcode-desktop', createZCodeDesktopJsonAggregateAdapter()],
    ['pi-official-cli', createPiPackageHostAdapter({ adapterVersion: '1' })],
    ['qwenwork-desktop', createQwenWorkHybridHostAdapter({
      adapterVersion: '1',
      skillContent: PORTABLE_TIDEMIND_SKILL,
    })],
  ])
  const adapters = new Map<CatalogId, AgentHostAdapter>()
  const catalogIds = new Set<CatalogId>([
    ...memoryAdapters.keys(),
    ...lifecycleAdapters.keys(),
    ...aggregateAdapters.keys(),
    ...(Object.keys(P0_INSTRUCTION_SPECS) as CatalogId[]),
  ])
  for (const catalogId of catalogIds) {
    const components: AgentHostAdapter[] = []
    const instruction = P0_INSTRUCTION_SPECS[catalogId]
    if (instruction) components.push(
      catalogId === 'kimi-code-cli' || catalogId === 'kimi-code-native'
        ? createKimiCodeInstructionHostAdapter(instruction)
        : createManagedTextHostAdapter(instruction),
    )
    const aggregate = aggregateAdapters.get(catalogId)
    if (aggregate) components.push(aggregate)
    else {
      const memory = memoryAdapters.get(catalogId)
      if (memory) components.push(memory)
      const lifecycle = lifecycleAdapters.get(catalogId)
      if (lifecycle) components.push(lifecycle)
    }
    adapters.set(catalogId, components.length === 1
      ? components[0]
      : createCompositeHostAdapter(catalogId, components))
  }
  return adapters
}

export function portableSkillContent(): string {
  return PORTABLE_TIDEMIND_SKILL
}
