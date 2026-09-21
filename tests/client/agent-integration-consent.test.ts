import { describe, expect, it } from 'vitest'
import {
  checkPlanAgainstConsent,
  executionPlanHash,
  type ConsentEnvelope,
  type ExecutionPlan,
} from '../../client/electron/agent-integration/consent'

const consent: ConsentEnvelope = {
  id: 'consent-1',
  installationId: 'installation-1',
  componentKeys: ['memory_tools'],
  targetScopes: ['directory:/Users/test/.agent'],
  selectorResolution: { 'cursor-mcp': 'mcpServers.tidemind' },
  executableRealpaths: [],
  commandCategories: ['file_write'],
  maxRisk: 'elevated',
  selectorSchemaVersion: 1,
  policyVersion: 1,
  approvedAt: '2026-08-25T00:00:00.000Z',
  revokedAt: null,
}

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    installationId: 'installation-1',
    operation: 'connect',
    componentKeys: ['memory_tools'],
    catalogVersion: 1,
    adapterVersion: 1,
    projectionVersion: 1,
    createdAt: '2026-08-25T00:01:00.000Z',
    mutations: [{
      id: 'mutation-1',
      componentKey: 'memory_tools',
      artifactKey: 'cursor-mcp',
      action: 'create',
      domainKind: 'file_fragment',
      targetPath: '/Users/test/.agent/config.json',
      ownershipSelector: 'mcpServers.tidemind',
      selectorSchemaVersion: 1,
      risk: 'low',
      commandCategory: 'file_write',
      containerPreconditionHash: null,
      desiredFragmentHash: 'abc',
      reversible: true,
    }],
    ...overrides,
  }
}

describe('execution plan consent boundary', () => {
  it('allows an exact, lower-risk plan inside the approved target scope', () => {
    const result = checkPlanAgainstConsent(plan(), consent)
    expect(result).toMatchObject({ allowed: true, reasons: [] })
    expect(result.executionPlanHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('produces the same hash when only mutation order changes', () => {
    const second = {
      ...plan().mutations[0],
      id: 'mutation-2',
      targetPath: '/Users/test/.agent/skill.md',
    }
    const forward = plan({ mutations: [plan().mutations[0], second] })
    const reverse = plan({ mutations: [second, plan().mutations[0]] })
    expect(executionPlanHash(forward)).toBe(executionPlanHash(reverse))
  })

  it('rejects a path traversal outside the approved scope', () => {
    const escaped = plan()
    escaped.mutations[0].targetPath = '/Users/test/.agent/../secrets.json'

    expect(checkPlanAgainstConsent(escaped, consent)).toMatchObject({
      allowed: false,
      reasons: ['/Users/test/secrets.json'].map(path => `target_out_of_scope:${path}`),
    })
  })

  it('treats file scopes as exact targets rather than directories', () => {
    const nested = plan()
    nested.mutations[0].targetPath = '/Users/test/.agent/config.json/child'
    const fileConsent = { ...consent, targetScopes: ['file:/Users/test/.agent/config.json'] }

    expect(checkPlanAgainstConsent(nested, fileConsent).reasons)
      .toContain('target_out_of_scope:/Users/test/.agent/config.json/child')
  })

  it('binds every additional aggregate fence target into consent and the normalized plan hash', () => {
    const aggregate = plan()
    aggregate.mutations[0].additionalFenceTargets = [{
      domainKind: 'file_fragment',
      targetPath: '/Users/test/.agent/settings.json',
    }]
    expect(checkPlanAgainstConsent(aggregate, consent).allowed).toBe(true)

    const escaped = structuredClone(aggregate)
    escaped.mutations[0].additionalFenceTargets![0].targetPath = '/Users/test/.other/settings.json'
    expect(checkPlanAgainstConsent(escaped, consent).reasons)
      .toContain('additional_fence_target_out_of_scope:/Users/test/.other/settings.json')
    expect(executionPlanHash(aggregate)).not.toBe(executionPlanHash(escaped))
  })

  it('rejects component, selector, command, schema and risk expansion', () => {
    const expanded = plan()
    expanded.mutations[0] = {
      ...expanded.mutations[0],
      componentKey: 'lifecycle',
      ownershipSelector: 'hooks.SessionStart',
      selectorSchemaVersion: 2,
      risk: 'high',
      commandCategory: 'host_cli',
      action: 'invoke',
      command: {
        category: 'host_cli',
        executablePath: '/usr/local/bin/agent',
        args: ['install'],
      },
    }

    const result = checkPlanAgainstConsent(expanded, consent)
    expect(result.allowed).toBe(false)
    expect(result.reasons).toEqual(expect.arrayContaining([
      'component_out_of_scope:lifecycle',
      'selector_out_of_scope:hooks.SessionStart',
      'selector_schema_changed:cursor-mcp',
      'command_category_out_of_scope:host_cli',
      'risk_exceeds_consent:high',
    ]))
  })

  it.each([
    ['operation', (candidate: any) => { candidate.operation = 'future_operation' }, 'operation_invalid'],
    ['component', (candidate: any) => {
      candidate.componentKeys = ['future_component']
      candidate.mutations[0].componentKey = 'future_component'
    }, 'component_key_invalid:future_component'],
    ['risk', (candidate: any) => { candidate.mutations[0].risk = 'future_risk' }, 'invalid_risk:mutation-1'],
    ['action', (candidate: any) => { candidate.mutations[0].action = 'future_action' }, 'invalid_action:mutation-1'],
    ['mutation command category', (candidate: any) => {
      candidate.mutations[0].commandCategory = 'future_command'
    }, 'invalid_command_category:mutation-1'],
    ['nested command category', (candidate: any) => {
      candidate.mutations[0].action = 'invoke'
      candidate.mutations[0].commandCategory = 'host_cli'
      candidate.mutations[0].command = {
        category: 'future_command', executablePath: '/usr/local/bin/agent', args: [],
      }
    }, 'invalid_command_category:mutation-1'],
  ])('fails closed on an unknown persisted plan %s', (_label, corrupt, reason) => {
    const candidate: any = plan()
    corrupt(candidate)
    const result = checkPlanAgainstConsent(candidate, {
      ...consent,
      commandCategories: [...consent.commandCategories, 'host_cli'],
      executableRealpaths: ['/usr/local/bin/agent'],
      maxRisk: 'high',
    })
    expect(result.allowed).toBe(false)
    expect(result.reasons).toContain(reason)
  })

  it.each([
    ['component', { componentKeys: ['memory_tools', 'future_component'] },
      'consent_component_invalid:future_component'],
    ['maximum risk', { maxRisk: 'future_risk' }, 'consent_max_risk_invalid'],
    ['command category', { commandCategories: ['file_write', 'future_command'] },
      'consent_command_category_invalid:future_command'],
  ])('fails closed on an unknown persisted consent %s', (_label, corrupt, reason) => {
    const result = checkPlanAgainstConsent(plan(), { ...consent, ...corrupt } as ConsentEnvelope)
    expect(result.allowed).toBe(false)
    expect(result.reasons).toContain(reason)
  })

  it('rejects a revoked consent and a different Installation', () => {
    const result = checkPlanAgainstConsent(
      plan({ installationId: 'installation-2' }),
      { ...consent, revokedAt: '2026-08-25T00:02:00.000Z' },
    )
    expect(result.reasons).toEqual(expect.arrayContaining(['consent_revoked', 'installation_out_of_scope']))
  })

  it('rejects consent issued under an obsolete policy version', () => {
    expect(checkPlanAgainstConsent(plan(), { ...consent, policyVersion: 0 })).toMatchObject({
      allowed: false,
      reasons: ['consent_policy_changed:0->1'],
    })
  })

  it('rejects shell-like command representation by requiring an absolute executable and args array', () => {
    const invalid = plan()
    invalid.mutations[0] = {
      ...invalid.mutations[0],
      action: 'invoke',
      commandCategory: 'host_cli',
      command: { category: 'host_cli', executablePath: 'agent install', args: [] },
    }
    const matchingConsent: ConsentEnvelope = { ...consent, commandCategories: ['host_cli'] }

    expect(checkPlanAgainstConsent(invalid, matchingConsent).reasons)
      .toContain('executable_not_absolute:mutation-1')
  })

  it('binds host commands and selectors to the exact approved Artifact', () => {
    const commandPlan = plan()
    commandPlan.mutations[0] = {
      ...commandPlan.mutations[0],
      action: 'invoke',
      commandCategory: 'host_cli',
      command: { category: 'host_cli', executablePath: '/usr/local/bin/agent', args: ['status'] },
    }
    const approved: ConsentEnvelope = {
      ...consent,
      commandCategories: ['host_cli'],
      executableRealpaths: ['/usr/local/bin/agent'],
    }
    expect(checkPlanAgainstConsent(commandPlan, approved).allowed).toBe(true)

    commandPlan.mutations[0].command = {
      category: 'host_cli',
      executablePath: '/usr/local/bin/other-agent',
      args: ['status'],
    }
    expect(checkPlanAgainstConsent(commandPlan, approved).reasons)
      .toContain('executable_out_of_scope:/usr/local/bin/other-agent')

    commandPlan.mutations[0].artifactKey = 'different-artifact'
    expect(checkPlanAgainstConsent(commandPlan, approved).reasons)
      .toContain('selector_out_of_scope:mcpServers.tidemind')
  })

  it('freezes and authorizes every command in an aggregate command sequence', () => {
    const aggregate = plan()
    aggregate.mutations[0] = {
      ...aggregate.mutations[0],
      action: 'invoke',
      commandCategory: 'plugin_install',
      commands: [
        { category: 'host_cli', executablePath: '/usr/local/bin/agent', args: ['marketplace', 'add'] },
        { category: 'plugin_install', executablePath: '/usr/local/bin/agent', args: ['plugin', 'install'] },
      ],
    }
    const approved: ConsentEnvelope = {
      ...consent,
      commandCategories: ['host_cli', 'plugin_install'],
      executableRealpaths: ['/usr/local/bin/agent'],
    }
    expect(checkPlanAgainstConsent(aggregate, approved).allowed).toBe(true)

    const changed = structuredClone(aggregate)
    changed.mutations[0].commands![1].args.push('--broader')
    expect(executionPlanHash(changed)).not.toBe(executionPlanHash(aggregate))

    const hiddenSecondSource = structuredClone(aggregate)
    hiddenSecondSource.mutations[0].command = hiddenSecondSource.mutations[0].commands![0]
    expect(checkPlanAgainstConsent(hiddenSecondSource, approved).reasons)
      .toContain('duplicate_command_sources:mutation-1')

    const relative = structuredClone(aggregate)
    relative.mutations[0].commands![1].executablePath = 'agent'
    expect(checkPlanAgainstConsent(relative, approved).reasons)
      .toContain('executable_not_absolute:mutation-1:1')
  })

  it('allows an approved aggregate file update to transfer one exact owned selector', () => {
    const aggregate = plan({ componentKeys: ['memory_tools', 'lifecycle'] })
    aggregate.mutations[0] = {
      ...aggregate.mutations[0],
      coveredComponentKeys: ['memory_tools', 'lifecycle'],
      action: 'update',
      ownershipTransferFrom: {
        targetPath: '/Users/test/.agent/config.json',
        ownershipSelector: 'mcp.servers.tidemind',
        ownedFragmentHash: 'a'.repeat(64),
        selectorSchemaVersion: 1,
      },
    }
    const approved: ConsentEnvelope = {
      ...consent,
      componentKeys: ['memory_tools', 'lifecycle'],
    }

    expect(checkPlanAgainstConsent(aggregate, approved)).toMatchObject({ allowed: true, reasons: [] })
  })

  it('allows a same-selector file move only when the exact source is an additional fenced target', () => {
    const moved = plan()
    moved.mutations[0] = {
      ...moved.mutations[0],
      targetPath: '/Users/test/.agent/skills/tidemind/SKILL.md',
      ownershipSelector: 'document',
      additionalFenceTargets: [{
        domainKind: 'file_fragment',
        targetPath: '/Users/test/.agent/skills/tidemind-eb_legacy/SKILL.md',
      }],
      ownershipTransferFrom: {
        targetPath: '/Users/test/.agent/skills/tidemind-eb_legacy/SKILL.md',
        ownershipSelector: 'document',
        ownedFragmentHash: 'a'.repeat(64),
        selectorSchemaVersion: 1,
      },
    }
    const approved = {
      ...consent,
      selectorResolution: { 'cursor-mcp': 'document' },
    }
    expect(checkPlanAgainstConsent(moved, approved)).toMatchObject({ allowed: true, reasons: [] })

    const unfenced = structuredClone(moved)
    unfenced.mutations[0].additionalFenceTargets = []
    expect(checkPlanAgainstConsent(unfenced, approved).reasons)
      .toContain('transfer_source_fence_missing:mutation-1')
  })

  it('rejects missing or unknown top-level and additional fence domains', () => {
    for (const domainKind of [undefined, 'forged_domain']) {
      const invalid = structuredClone(plan()) as any
      invalid.mutations[0].domainKind = domainKind
      expect(checkPlanAgainstConsent(invalid, consent).reasons)
        .toContain('invalid_domain_kind:mutation-1')
    }
    for (const domainKind of [undefined, 'forged_domain']) {
      const invalid = structuredClone(plan()) as any
      invalid.mutations[0].additionalFenceTargets = [{
        domainKind,
        targetPath: '/Users/test/.agent/source.json',
      }]
      expect(checkPlanAgainstConsent(invalid, consent).reasons)
        .toContain('invalid_additional_fence_domain_kind:mutation-1')
    }
  })
})
