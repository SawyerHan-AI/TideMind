import path from 'node:path'
import { createCompositeHostAdapter } from './composite-adapter'
import { createManagedTextHostAdapter, type ManagedTextHostSpec } from './managed-text-adapter'
import { createP0JsonMcpAdapters } from './p0-json-registry'
import type { AdapterOperationContext, AgentHostAdapter, CatalogId } from '../types'

const PORTABLE_SKILL = `---
name: tidemind
description: Tide Mind 外部记忆系统。用于在对话开始时准备用户上下文、按需检索历史记忆，并沉淀有长期价值的信息。
---

# Tide Mind

- 新会话开始时，优先调用 \`brain_prepare\` 获取用户画像、记忆索引和行为指导。
- 回答依赖历史背景、既往决策或用户偏好时，调用 \`brain_recall\`，并提供清晰的查询背景。
- 对话产生重要决策、事实、偏好、纠正或后续行动时，调用 \`brain_digest\` 保存；不要存储无实质价值的寒暄。
- 如果记忆工具当前不可用，请明确说明，不能假装已经查询或保存。
`

function textSpec(
  catalogId: CatalogId,
  root: (context: AdapterOperationContext) => string,
): ManagedTextHostSpec {
  return {
    catalogId,
    adapterVersion: '1',
    componentKey: 'instruction',
    artifactType: 'skill',
    targetFile: context => path.join(root(context), 'tidemind', 'SKILL.md'),
    allowedRoot: root,
    content: () => PORTABLE_SKILL,
    reload: 'new_session',
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
  'codex-cli': textSpec('codex-cli', codexSharedSkills),
  'codex-desktop': textSpec('codex-desktop', codexSharedSkills),
  'cursor-desktop': textSpec('cursor-desktop', hostSkills),
  'windsurf-desktop': textSpec('windsurf-desktop', hostSkills),
  'kimi-code-cli': textSpec('kimi-code-cli', hostSkills),
  'openclaw-local': textSpec('openclaw-local', hostSkills),
  'qwen-code-cli': textSpec('qwen-code-cli', hostSkills),
  'zcode-desktop': textSpec('zcode-desktop', zcodeNativeSkills),
  'opencode-v1-cli': textSpec('opencode-v1-cli', sharedAgentsSkills),
  'opencode-v2-beta-cli': textSpec('opencode-v2-beta-cli', sharedAgentsSkills),
  'pi-official-cli': textSpec('pi-official-cli', hostSkills),
  'omp-cli': textSpec('omp-cli', hostSkills),
})

/** Enabled adapters are assembled only from implemented component projections. */
export function createP0HostAdapters(): ReadonlyMap<CatalogId, AgentHostAdapter> {
  const jsonAdapters = createP0JsonMcpAdapters()
  const adapters = new Map<CatalogId, AgentHostAdapter>()
  const catalogIds = new Set<CatalogId>([
    ...jsonAdapters.keys(),
    ...(Object.keys(P0_INSTRUCTION_SPECS) as CatalogId[]),
  ])
  for (const catalogId of catalogIds) {
    const components: AgentHostAdapter[] = []
    const instruction = P0_INSTRUCTION_SPECS[catalogId]
    if (instruction) components.push(createManagedTextHostAdapter(instruction))
    const memory = jsonAdapters.get(catalogId)
    if (memory) components.push(memory)
    adapters.set(catalogId, components.length === 1
      ? components[0]
      : createCompositeHostAdapter(catalogId, components))
  }
  return adapters
}

export function portableSkillContent(): string {
  return PORTABLE_SKILL
}
