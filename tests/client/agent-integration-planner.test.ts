import { describe, expect, it } from 'vitest'
import {
  assertPersistedPlannedMutationShape,
  assertPersistedPreparedPlanShape,
  buildExecutionPlan,
} from '../../client/electron/agent-integration/planner'
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
  it('keeps every currently supported persisted Adapter enum value compatible', () => {
    for (const operation of ['create', 'update', 'remove', 'host_command'] as const) {
      expect(() => assertPersistedPlannedMutationShape({ ...first, operation })).not.toThrow()
    }
    for (const risk of ['read_only', 'low', 'elevated', 'high'] as const) {
      expect(() => assertPersistedPlannedMutationShape({ ...first, risk })).not.toThrow()
    }
    for (const reload of [
      'none', 'reload', 'new_session', 'restart_host', 'user_confirmation', 'version_dependent',
    ] as const) {
      expect(() => assertPersistedPlannedMutationShape({ ...first, reload })).not.toThrow()
    }
    for (const commandCategory of [
      'none', 'file_write', 'host_cli', 'plugin_install', 'host_trust', 'admin',
    ] as const) {
      expect(() => assertPersistedPlannedMutationShape({ ...first, commandCategory })).not.toThrow()
    }
  })

  it('fails closed on unknown enums in a persisted prepared plan before Adapter execution', () => {
    const prepared = buildExecutionPlan({
      installationId: 'installation-1',
      installationKey: 'cursor:default',
      operation: 'connect',
      componentKeys: ['memory_tools'],
      inspection,
      adapterPlan: adapterPlan([first]),
      catalogGeneration: 1,
      adapterGeneration: 1,
      projectionGeneration: 1,
      createdAt: '2026-08-25T00:00:00.000Z',
    })
    expect(() => assertPersistedPreparedPlanShape(prepared)).not.toThrow()

    const cases: Array<[string, (candidate: any) => void]> = [
      ['outer operation', candidate => { candidate.operation = 'future_operation' }],
      ['outer component', candidate => { candidate.componentKeys = ['future_component'] }],
      ['adapter operation', candidate => { candidate.adapterPlan.mutations[0].operation = 'future_operation' }],
      ['adapter component', candidate => { candidate.adapterPlan.mutations[0].componentKey = 'future_component' }],
      ['adapter risk', candidate => { candidate.adapterPlan.mutations[0].risk = 'future_risk' }],
      ['adapter reload', candidate => { candidate.adapterPlan.mutations[0].reload = 'future_reload' }],
      ['adapter command category', candidate => {
        candidate.adapterPlan.mutations[0].commandCategory = 'future_command'
      }],
      ['frozen command category', candidate => {
        candidate.adapterPlan.mutations[0].frozenCommands = [{
          category: 'future_command', executableRealpath: '/usr/bin/true', args: [],
        }]
      }],
    ]
    for (const [_label, corrupt] of cases) {
      const candidate = structuredClone(prepared) as any
      corrupt(candidate)
      expect(() => assertPersistedPreparedPlanShape(candidate)).toThrow(/persisted|invalid/)
    }
  })

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

  it('rejects missing or forged mutation domains before producing a consent plan', () => {
    const build = (mutation: any) => buildExecutionPlan({
      installationId: 'installation-1',
      installationKey: 'cursor:default',
      operation: 'connect',
      componentKeys: ['memory_tools'],
      inspection,
      adapterPlan: adapterPlan([mutation]),
      catalogGeneration: 1,
      adapterGeneration: 1,
      projectionGeneration: 1,
      createdAt: '2026-08-25T00:00:00.000Z',
    })
    expect(() => build({ ...first, domainKind: undefined })).toThrow(/invalid domain kind/)
    expect(() => build({ ...first, domainKind: 'forged_domain' })).toThrow(/invalid domain kind/)
    expect(() => build({
      ...first,
      additionalFenceTargets: [{ domainKind: undefined, physicalTarget: '/tmp/source' }],
    })).toThrow(/invalid additional fence domain kind/)
    expect(() => build({
      ...first,
      additionalFenceTargets: [{ domainKind: 'forged_domain', physicalTarget: '/tmp/source' }],
    })).toThrow(/invalid additional fence domain kind/)
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

  it('freezes aggregate component coverage and rejects overlapping consumers', () => {
    const aggregate = {
      ...first,
      coveredComponentKeys: ['memory_tools', 'lifecycle'] as const,
    }
    const prepared = buildExecutionPlan({
      installationId: 'installation-1',
      installationKey: 'cursor:default',
      operation: 'connect',
      componentKeys: ['memory_tools', 'lifecycle'],
      inspection,
      adapterPlan: adapterPlan([aggregate]),
      catalogGeneration: 1,
      adapterGeneration: 1,
      projectionGeneration: 1,
      createdAt: '2026-08-25T00:00:00.000Z',
    })
    expect(prepared.executionPlan.mutations[0].coveredComponentKeys)
      .toEqual(['memory_tools', 'lifecycle'])

    expect(() => buildExecutionPlan({
      installationId: 'installation-1',
      installationKey: 'cursor:default',
      operation: 'connect',
      componentKeys: ['memory_tools', 'lifecycle'],
      inspection,
      adapterPlan: adapterPlan([aggregate, {
        ...first,
        operationId: 'overlap',
        componentKey: 'lifecycle',
      }]),
      catalogGeneration: 1,
      adapterGeneration: 1,
      projectionGeneration: 1,
      createdAt: '2026-08-25T00:00:00.000Z',
    })).toThrow(/overlapping aggregate component/)
  })
})
