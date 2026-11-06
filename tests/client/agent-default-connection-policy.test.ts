import { createClaudeCodePluginHostAdapter } from '../../client/electron/agent-integration/hosts/claude-code-plugin-adapter'
import { createGeminiExtensionHostAdapter } from '../../client/electron/agent-integration/hosts/gemini-extension-adapter'
import { createOpenClawPluginHostAdapter } from '../../client/electron/agent-integration/hosts/openclaw-plugin-adapter'
import { createPiPackageHostAdapter } from '../../client/electron/agent-integration/hosts/pi-package-adapter'
import { getCatalogVariant } from '../../client/electron/agent-integration/catalog'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createP0HostAdapters } from '../../client/electron/agent-integration/hosts/p0-adapter-registry'
import { canonicalizeInstallationIdentity } from '../../client/electron/agent-integration/identity'
import { buildExecutionPlan } from '../../client/electron/agent-integration/planner'
import { checkDefaultConnectionPolicy, type DefaultConnectionPolicyContext } from '../../client/electron/agent-integration/default-connection-policy'
import type { AdapterOperationContext, CatalogId } from '../../client/electron/agent-integration/types'

async function fixture(variant: CatalogId, configRootOverride?: string) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'automatic-policy-')))
  // Synthetic discovery outputs mirror the accepted provenance in each adapter's
  // own tests; this fixture does not claim to perform real source verification.
  const nativeFixtures: Partial<Record<CatalogId, { root: string; distributionId: string; provenance: string; version: string }>> = {
    'claude-code-cli': { root: '.claude', distributionId: 'claude-code-cli', provenance: 'npm_metadata:@anthropic-ai/claude-code', version: '2.1.0' },
    'claude-code-native': { root: '.claude', distributionId: 'claude-code-native', provenance: 'signed_cli:com.anthropic.claude-code:Q6L2SF6YDW', version: '2.1.0' },
    'gemini-cli': { root: '.gemini', distributionId: 'npm:@google/gemini-cli', provenance: 'npm_metadata:@google/gemini-cli', version: '0.39.1' },
    'pi-official-cli': { root: '.pi/agent', distributionId: 'pi:earendil', provenance: 'npm_metadata:@earendil-works/pi-coding-agent', version: '0.36.1' },
    'openclaw-local': { root: '.openclaw', distributionId: 'openclaw:npm', provenance: 'npm_metadata:openclaw', version: '2026.8.1' },
  }
  const native = nativeFixtures[variant]
  const home = path.join(base, 'home'), appData = path.join(base, 'data')
  const configRoot = path.join(home, configRootOverride ?? native?.root ?? (variant === 'zcode-desktop' ? '.zcode' : '.host'))
  fs.mkdirSync(configRoot, { recursive: true }); fs.mkdirSync(appData)
  for (const file of ['tm-node','mcp-server.cjs','hook-session-start.cjs','hook-pre-compact.cjs','hook-post-compact.cjs','hook-session-end.cjs','hook-cursor-lifecycle.cjs','hook-windsurf-lifecycle.cjs','hook-kimi-lifecycle.cjs','hook-omp-lifecycle.cjs','hook-opencode-v1-lifecycle.cjs','hook-pi-lifecycle.cjs','hook-openclaw-lifecycle.cjs']) fs.writeFileSync(path.join(base,file), '// synthetic runtime fixture\n')
  const executable = path.join(base, 'fixture-host'); fs.writeFileSync(executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const identity = canonicalizeInstallationIdentity({ runtimeRealm: 'local_macos', osUserIdentity: 'fixture-user-01',
    productFamilyId: getCatalogVariant(variant).productFamilyId, hostVariant: variant, configRoot,
    distribution: { distributionId: native?.distributionId ?? `fixture:${variant}`, executableRealpath: executable, packageProvenance: native?.provenance ?? 'fixture', capabilityFingerprint: 'fixture' } })
  if (variant === 'opencode-v1-cli') { identity.componentConfigFiles = { lifecycle: path.join(configRoot, 'plugins', 'tidemind-v1.ts'), instruction: path.join(home, '.agents', 'skills', 'tidemind', 'SKILL.md'), memory_tools: path.join(configRoot, 'opencode.json') }; identity.componentConfigRoots = { lifecycle: path.join(configRoot, 'plugins') } }
  const context: AdapterOperationContext = { installation: identity, installationId: 'fixture', agentId: 'eb_fixture',
    operationId: 'operation_fixture', hostVersion: native?.version ?? (variant.startsWith('codex') ? '0.153.4' : '1.0.0'), activityGenerationToken: 'fixture-generation',
    runtime: { runtimeRealm: 'local_macos', homeDir: home, applicationDataDir: appData,
      shimPath: path.join(base, 'tm-node'), mcpServerPath: path.join(base, 'mcp-server.cjs'),
      hookScriptPath: path.join(base, 'hook-session-start.cjs'), preCompactScriptPath: path.join(base, 'hook-pre-compact.cjs'),
      postCompactScriptPath: path.join(base, 'hook-post-compact.cjs'), tideMindVersion: 'fixture', catalogVersion: '1', projectionVersion: '1' } }
  const dependencies = { run: async (_executable: string, args: readonly string[]) => {
    // Only cold inventory reads are needed. Do not silently accept an accidental
    // install, permission grant, or runtime load while constructing the fixture.
    const command = args.join(' ')
    if (['plugin marketplace list --json', 'plugin list --json', 'extensions list --output-format json'].includes(command)) {
      return { exitCode: 0, stdout: '[]', stderr: '' }
    }
    if (command === 'list --no-approve') return { exitCode: 0, stdout: 'No packages installed.\n', stderr: '' }
    if (command === 'plugins list --json') return { exitCode: 0, stdout: '{"plugins":[]}', stderr: '' }
    throw new Error(`Unexpected fixture host command: ${command}`)
  } }
  const adapter = variant === 'claude-code-cli' || variant === 'claude-code-native'
    ? createClaudeCodePluginHostAdapter({ catalogId: variant, adapterVersion: '1', dependencies })
    : variant === 'gemini-cli' ? createGeminiExtensionHostAdapter({ dependencies })
    : variant === 'pi-official-cli' ? createPiPackageHostAdapter({ adapterVersion: '1', dependencies })
    : variant === 'openclaw-local' ? createOpenClawPluginHostAdapter({ adapterVersion: '1', dependencies })
    : createP0HostAdapters().get(variant)!
  const inspection = await adapter.inspect(context)
  const componentKeys = adapter.componentKeys
  const adapterPlan = await adapter.plan(context, { desiredCapability: componentKeys.includes('lifecycle') ? 4 : 2,
    desiredComponents: componentKeys, observed: inspection, ownedArtifacts: [] })
  const plan = buildExecutionPlan({ installationId: 'fixture', installationKey: identity.installKey, operation: 'connect',
    componentKeys, inspection, adapterPlan, catalogGeneration: 1, adapterGeneration: 1, projectionGeneration: 1,
    createdAt: '2026-11-06T00:00:00Z', activityGenerationToken: context.activityGenerationToken })
  const policy: DefaultConnectionPolicyContext = { installation: { id: 'fixture', displayName: 'Fixture', desiredState: 'unmanaged',
    identity, agentId: 'eb_fixture' }, intent: { domainKey: 'domain', revision: 0, state: 'active', pausedMemberIds: [], excludedMemberIds: [] },
    homeDir: home, applicationDataDir: appData, mode: 'initial' }
  return { plan, policy, close: () => fs.rmSync(base, { recursive: true, force: true }) }
}

describe('default automatic connection policy', () => {
  it.each(['codex-cli','codex-desktop','cursor-desktop','windsurf-desktop','kimi-code-cli','kimi-code-native',
    'qwen-code-cli','zcode-desktop','opencode-v1-cli','opencode-v2-beta-cli','omp-cli'] as CatalogId[])(
    'allows the existing %s file projector on its declared scope', async variant => {
      const f = await fixture(variant)
      try {
        expect(f.plan.executionPlan.mutations.length).toBeGreaterThan(0)
        expect(checkDefaultConnectionPolicy(f.policy, f.plan), JSON.stringify(f.plan.executionPlan.mutations)).toEqual([])
      } finally { f.close() }
    })
  it.each(['claude-code-cli','claude-code-native','gemini-cli','pi-official-cli','openclaw-local'] as CatalogId[])(
    'classifies the actual native component command sequence for %s', async variant => {
      const f = await fixture(variant)
      try {
        expect(f.plan.adapterPlan.diagnostics).toEqual([])
        expect(f.plan.executionPlan.mutations.length).toBeGreaterThan(0)
        const expected = ['gemini-cli', 'openclaw-local'].includes(variant) ? ['native_permission_required'] : []
        expect(checkDefaultConnectionPolicy(f.policy, f.plan), JSON.stringify(f.plan.executionPlan.mutations)).toEqual(expected)
        const changed = structuredClone(f.plan)
        const mutation = changed.executionPlan.mutations.find(item => item.command || item.commands)!
        const command = mutation.commands?.[0] ?? mutation.command!
        command.args = ['update','--all']
        expect(checkDefaultConnectionPolicy(f.policy, changed)).toContain('automatic_command_not_allowed')
      } finally { f.close() }
    })
  it('allows only the known Kimi legacy Skill fence during its owned instruction migration', async () => {
    const f = await fixture('kimi-code-native')
    try {
      const mutation = f.plan.executionPlan.mutations.find(item => item.componentKey === 'instruction')!
      const legacy = path.join(f.policy.installation.identity.canonicalConfigRoot, 'skills', 'tidemind-eb_fixture', 'SKILL.md')
      mutation.additionalFenceTargets = [{ domainKind: 'file_fragment', targetPath: legacy }]
      mutation.ownershipTransferFrom = { targetPath: legacy, ownershipSelector: 'document', ownedFragmentHash: 'a'.repeat(64), selectorSchemaVersion: 1 }
      expect(checkDefaultConnectionPolicy(f.policy, f.plan)).toEqual([])
      mutation.additionalFenceTargets = [{ domainKind: 'file_fragment', targetPath: path.join(f.policy.homeDir, 'unrelated.md') }]
      expect(checkDefaultConnectionPolicy(f.policy, f.plan)).toContain('automatic_target_not_allowed')
    } finally { f.close() }
  })
  it('allows the discovered Claude configuration root and rejects default-root fences for it', async () => {
    const f = await fixture('claude-code-cli', '.claude-work')
    try {
      expect(checkDefaultConnectionPolicy(f.policy, f.plan)).toEqual([])
      const fences = f.plan.executionPlan.mutations[0].additionalFenceTargets!
      const settings = fences.find(fence => fence.targetPath.endsWith('/settings.json'))!
      expect(settings.targetPath).toBe(path.join(f.policy.homeDir, '.claude-work', 'settings.json'))
      settings.targetPath = path.join(f.policy.homeDir, '.claude', 'settings.json')
      expect(checkDefaultConnectionPolicy(f.policy, f.plan)).toContain('automatic_target_not_allowed')
    } finally { f.close() }
  })
  it('rejects new targets, foreign selectors, commands and higher risk instead of granting whatever a plan requests', async () => {
    const f = await fixture('cursor-desktop')
    try {
      for (const change of [
        (plan: typeof f.plan) => { plan.executionPlan.mutations[0].targetPath = path.join(f.policy.homeDir, '.ssh', 'config') },
        (plan: typeof f.plan) => { plan.executionPlan.mutations[0].ownershipSelector = 'foreign-entry' },
        (plan: typeof f.plan) => { plan.executionPlan.mutations[0].risk = 'high' },
        (plan: typeof f.plan) => { plan.executionPlan.mutations[0].command = { category: 'host_cli', executablePath: '/bin/sh', args: ['-c','echo forbidden'] } },
      ]) {
        const changed = structuredClone(f.plan); change(changed)
        expect(checkDefaultConnectionPolicy(f.policy, changed).length).toBeGreaterThan(0)
      }
      f.policy.intent.excludedMemberIds = ['previously-disconnected-sibling']
      expect(checkDefaultConnectionPolicy(f.policy, f.plan)).toContain('user_disabled')
    } finally { f.close() }
  })
})
