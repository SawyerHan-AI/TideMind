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
})
