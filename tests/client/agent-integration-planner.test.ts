import { describe, expect, it } from 'vitest'
import { buildExecutionPlan } from '../../client/electron/agent-integration/planner'
import type { AdapterInspection, AdapterPlan } from '../../client/electron/agent-integration/types'

const inspection: AdapterInspection = {
  catalogId: 'cursor-desktop',
  detected: true,
  distribution: { distributionId: 'cursor' },
  components: [],
  provenance: ['fixture'],
  diagnostics: [],
}

function adapterPlan(mutations: AdapterPlan['mutations']): AdapterPlan {
  return {
    catalogId: 'cursor-desktop',
    installationKey: 'cursor:default',
    adapterVersion: '1.0.0',
    projectionVersion: '1',
    mutations,
    requiredUserActions: [],
    diagnostics: [],
  }
}

const first = {
  operationId: 'op-z',
  componentKey: 'memory_tools',
  operation: 'create',
  domainKind: 'file_fragment',
  physicalTarget: '/tmp/tidemind/cursor.json',
  ownershipKey: 'mcpServers.tidemind',
  selectorSchemaVersion: 1,
  risk: 'low',
  reload: 'reload',
  desiredFragmentHash: 'desired-mcp',
  idempotent: true,
} as const

const second = {
  operationId: 'op-a',
  componentKey: 'instruction',
  operation: 'create',
  domainKind: 'directory',
  physicalTarget: '/tmp/tidemind/skills/tidemind',
  ownershipKey: 'skill:tidemind',
  selectorSchemaVersion: 1,
  risk: 'low',
  reload: 'new_session',
  desiredFragmentHash: 'desired-skill',
  idempotent: true,
} as const

describe('agent integration planner', () => {
  it('projects and sorts an adapter plan without mutating its input', () => {
    const source = adapterPlan([first, second])
    const prepared = buildExecutionPlan({
      installationId: 'installation-1',
      installationKey: 'cursor:default',
      operation: 'connect',
      componentKeys: ['memory_tools', 'instruction'],
      inspection,
      adapterPlan: source,
      catalogGeneration: 1,
      adapterGeneration: 1,
      projectionGeneration: 1,
      createdAt: '2026-08-25T00:00:00.000Z',
    })

    expect(prepared.executionPlan.mutations.map(mutation => mutation.id)).toEqual(['op-a', 'op-z'])
    expect(prepared.componentKeys).toEqual(['instruction', 'memory_tools'])
    expect(prepared.executionPlanHash).toMatch(/^[a-f0-9]{64}$/)
    expect(source.mutations.map(mutation => mutation.operationId)).toEqual(['op-z', 'op-a'])
  })

  it('rejects an adapter mutation that expands beyond requested components', () => {
    expect(() => buildExecutionPlan({
      installationId: 'installation-1',
      installationKey: 'cursor:default',
      operation: 'connect',
      componentKeys: ['instruction'],
      inspection,
      adapterPlan: adapterPlan([first]),
      catalogGeneration: 1,
      adapterGeneration: 1,
      projectionGeneration: 1,
      createdAt: '2026-08-25T00:00:00.000Z',
    })).toThrow(/unrequested component/)
  })

  it('requires explicit executable and command category for host commands', () => {
    expect(() => buildExecutionPlan({
      installationId: 'installation-1',
      installationKey: 'cursor:default',
      operation: 'connect',
      componentKeys: ['memory_tools'],
      inspection,
      adapterPlan: adapterPlan([{ ...first, operation: 'host_command', domainKind: 'host_registry' }]),
      catalogGeneration: 1,
      adapterGeneration: 1,
      projectionGeneration: 1,
      createdAt: '2026-08-25T00:00:00.000Z',
    })).toThrow(/lacks executable realpath or args/)
  })

  it('binds consent to the canonical target and never equates idempotence with reversibility', () => {
    const prepared = buildExecutionPlan({
      installationId: 'installation-1',
      installationKey: 'cursor:default',
      operation: 'connect',
      componentKeys: ['memory_tools'],
      inspection,
      adapterPlan: adapterPlan([{
        ...first,
        metadata: { canonicalPath: '/private/tmp/tidemind/cursor.json' },
      }]),
      catalogGeneration: 1,
      adapterGeneration: 1,
      projectionGeneration: 1,
      createdAt: '2026-08-25T00:00:00.000Z',
    })

    expect(prepared.executionPlan.mutations[0]).toMatchObject({
      targetPath: '/private/tmp/tidemind/cursor.json',
      reversible: false,
    })
  })
})
