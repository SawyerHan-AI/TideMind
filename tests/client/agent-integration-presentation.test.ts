import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AgentIntegrationInstallationDto,
  AgentIntegrationPlanInstallationDto,
  AgentIntegrationSnapshotDto,
  AgentIntegrationSupportProductDto,
} from '../../client/src/lib/api-contract'
import {
  isLowRiskDefault,
  requestedConnectCandidateIds,
} from '../../client/src/components/settings/agent-integration-managed/BatchConnectDialog'
import {
  aggregateAccess,
  aggregateComponents,
  canShowGreenAvailability,
  canCloseBatchDialog,
  customApplyOutcome,
  detailFocusDestination,
  isValidCustomSelectorKey,
  matchesSupportQuery,
  managementUnavailableHelpKey,
  nextRovingTabIndex,
  requiredUserActionDetailKey,
  requiredUserActionPresentation,
  safeDisplayTarget,
  sortProductFamilies,
  statusReasonKey,
  summarizeExecutionResults,
  summarizeSnapshot,
} from '../../client/src/components/settings/agent-integration-managed/presentation.ts'

function installation(
  id: string,
  overrides: Partial<AgentIntegrationInstallationDto> = {},
): AgentIntegrationInstallationDto {
  return {
    id,
    familyId: overrides.familyId ?? id.split('-')[0],
    hostVariant: `${id}-cli`,
    variantLabel: id,
    displayName: id,
    profileLabel: null,
    version: '1.0.0',
    desiredState: 'managed',
    manageable: true,
    statusGroup: 'available',
    statusReason: 'verified',
    accessLevel: 'complete',
    accessIsHistorical: false,
    components: [
      { key: 'instruction', state: 'verified', implementationTypes: ['skill'], targetLabel: '~/.agents/skills/tidemind', lastVerifiedAt: '2026-08-25T00:00:00Z' },
      { key: 'memory_tools', state: 'verified', implementationTypes: ['mcp'], targetLabel: '~/.agent/mcp.json', lastVerifiedAt: '2026-08-25T00:00:00Z' },
      { key: 'lifecycle', state: 'verified', implementationTypes: ['hook'], targetLabel: '~/.agent/hooks.json', lastVerifiedAt: '2026-08-25T00:00:00Z' },
    ],
    lastDetectedAt: '2026-08-25T00:00:00Z',
    lastVerifiedAt: '2026-08-25T00:00:00Z',
    lastRepairedAt: null,
    lastRealUseAt: null,
    ...overrides,
  }
}

function snapshot(installations: AgentIntegrationInstallationDto[]): AgentIntegrationSnapshotDto {
  const families = [...new Set(installations.map(item => item.familyId))].map(familyId => {
    const familyInstallations = installations.filter(item => item.familyId === familyId)
    return {
      id: familyId,
      displayName: familyId,
      installationIds: familyInstallations.map(item => item.id),
      statusGroup: familyInstallations[0].statusGroup,
      accessLevels: [...new Set(familyInstallations.map(item => item.accessLevel))],
      needsAttentionCount: familyInstallations.filter(item => item.statusGroup === 'needs_attention').length,
    }
  })
  return {
    families,
    installations,
    historyInstallations: [],
    summary: {
      familyCount: families.length,
      installationCount: installations.length,
      availableCount: installations.filter(item => item.statusGroup === 'available').length,
      needsAttentionCount: installations.filter(item => item.statusGroup === 'needs_attention').length,
      awaitingConnectionCount: installations.filter(item => item.statusGroup === 'awaiting_connection').length,
    },
    lastScanAt: '2026-08-25T00:00:00Z',
  }
}

function planItem(overrides: Partial<AgentIntegrationPlanInstallationDto> = {}): AgentIntegrationPlanInstallationDto {
  return {
    installationId: 'codex-default',
    displayName: 'Codex',
    desiredCapability: 4,
    componentKeys: ['instruction', 'memory_tools', 'lifecycle'],
    targets: [{
      componentKey: 'memory_tools',
      action: 'update',
      scope: 'user',
      targetLabel: '~/.codex/config.toml',
      risk: 'low',
      commandCategory: 'file_write',
      reversible: true,
    }],
    requiredUserActions: [],
    diagnostics: [],
    ...overrides,
  }
}

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key))
}

describe('managed Agent presentation', () => {
  it('rejects an explicitly requested batch when every exact Installation became unavailable', () => {
    expect(requestedConnectCandidateIds(
      ['uninstalled', 'trust-lost', 'eligibility-lost'],
      [
        installation('trust-lost', { manageable: false }),
        installation('eligibility-lost', { manageable: false }),
      ],
    )).toEqual([])
  })

  it('keeps current status and connection level orthogonal', () => {
    const partialButAvailable = installation('codex-default', { accessLevel: 'partial' })
    expect(partialButAvailable.statusGroup).toBe('available')
    expect(canShowGreenAvailability(partialButAvailable)).toBe(true)

    expect(canShowGreenAvailability(installation('codex-stale', {
      accessLevel: 'complete',
      accessIsHistorical: true,
      statusGroup: 'awaiting_verification',
    }))).toBe(false)
  })

  it('does not count detect-only installations as connectable work', () => {
    const detectOnly = installation('future-host', {
      desiredState: 'unmanaged',
      manageable: false,
      statusGroup: 'awaiting_connection',
      accessLevel: 'unconnected',
    })
    expect(summarizeSnapshot(snapshot([detectOnly])).pendingCount).toBe(0)
  })

  it('does not invent a uniform connection level or component state', () => {
    const current = installation('codex-cli', { familyId: 'codex' })
    const stale = installation('codex-desktop', {
      familyId: 'codex',
      accessIsHistorical: true,
      components: installation('fixture').components.map(component => component.key === 'lifecycle'
        ? { ...component, state: 'verification_stale' }
        : component),
    })

    expect(aggregateAccess([current, stale])).toMatchObject({ kind: 'mixed' })
    expect(aggregateComponents([current, stale]).find(item => item.key === 'lifecycle')).toMatchObject({
      kind: 'mixed',
      counts: { verified: 1, verification_stale: 1 },
    })
  })

  it('sorts actionable product families before available ones and summarizes backend facts', () => {
    const data = snapshot([
      installation('codex-cli', { familyId: 'codex' }),
      installation('kimi-default', { familyId: 'kimi', statusGroup: 'needs_attention', statusReason: 'new_session' }),
    ])
    expect(sortProductFamilies(data.families, data).map(family => family.id)).toEqual(['kimi', 'codex'])
    expect(summarizeSnapshot(data)).toEqual({
      productCount: 2,
      installationCount: 2,
      availableCount: 1,
      pendingCount: 0,
      attentionCount: 1,
    })
  })

  it('maps stable reasons and redacts accidental secrets in display-only targets', () => {
    expect(statusReasonKey('new_session')).toBe('agent.managed.reason.newSession')
    expect(statusReasonKey('legacy_callable_unmanaged')).toBe('agent.managed.reason.legacyCallableUnmanaged')
    expect(statusReasonKey('executable_proof_too_large')).toBe('agent.managed.reason.executableProofTooLarge')
    expect(statusReasonKey('executable_metadata_unavailable')).toBe('agent.managed.reason.executableMetadataUnavailable')
    expect(statusReasonKey('release_entry_missing')).toBe('agent.managed.reason.releaseEntryMissing')
    expect(statusReasonKey('release_mode_detect_only')).toBe('agent.managed.reason.releaseModeDetectOnly')
    expect(statusReasonKey('release_distribution_not_accepted')).toBe('agent.managed.reason.releaseDistributionNotAccepted')
    expect(statusReasonKey('release_version_unverified')).toBe('agent.managed.reason.releaseVersionUnverified')
    expect(statusReasonKey('release_version_not_accepted')).toBe('agent.managed.reason.releaseVersionNotAccepted')
    expect(statusReasonKey('release_artifact_not_accepted')).toBe('agent.managed.reason.releaseArtifactNotAccepted')
    expect(statusReasonKey('future_reason')).toBe('agent.managed.reason.unknown')
    expect(managementUnavailableHelpKey('executable_proof_too_large'))
      .toBe('agent.managed.reason.executableProofTooLarge')
    expect(managementUnavailableHelpKey('executable_metadata_unavailable'))
      .toBe('agent.managed.reason.executableMetadataUnavailable')
    expect(managementUnavailableHelpKey('release_entry_missing'))
      .toBe('agent.managed.reason.releaseEntryMissing')
    expect(managementUnavailableHelpKey('release_mode_detect_only'))
      .toBe('agent.managed.reason.releaseModeDetectOnly')
    expect(managementUnavailableHelpKey('release_distribution_not_accepted'))
      .toBe('agent.managed.reason.releaseDistributionNotAccepted')
    expect(managementUnavailableHelpKey('release_version_unverified'))
      .toBe('agent.managed.reason.releaseVersionUnverified')
    expect(managementUnavailableHelpKey('release_version_not_accepted'))
      .toBe('agent.managed.reason.releaseVersionNotAccepted')
    expect(managementUnavailableHelpKey('release_artifact_not_accepted'))
      .toBe('agent.managed.reason.releaseArtifactNotAccepted')
    expect(managementUnavailableHelpKey('detect_only')).toBe('agent.managed.supportMode.detectableHelp')
    expect(safeDisplayTarget('https://user:secret@example.test/path?token=abc&key=def')).toBe(
      'https://•••@example.test/path?token=•••&key=•••',
    )
  })

  it('preselects only reversible user-level plans without host trust or extra action', () => {
    expect(isLowRiskDefault(planItem())).toBe(true)
    expect(isLowRiskDefault(planItem({ targets: [{ ...planItem().targets[0], scope: 'project' }] }))).toBe(false)
    expect(isLowRiskDefault(planItem({ targets: [{ ...planItem().targets[0], commandCategory: 'host_trust' }] }))).toBe(false)
    expect(isLowRiskDefault(planItem({ targets: [{ ...planItem().targets[0], commandCategory: 'plugin_install' }] }))).toBe(false)
    expect(isLowRiskDefault(planItem({ requiredUserActions: ['Confirm in host'] }))).toBe(false)
    expect(isLowRiskDefault(planItem({ targets: [{ ...planItem().targets[0], reversible: false }] }))).toBe(false)
    expect(isLowRiskDefault(planItem({ targets: [{ ...planItem().targets[0], targetLabel: null }] }))).toBe(false)
  })

  it('matches the support catalog by product or host variant name', () => {
    const product: AgentIntegrationSupportProductDto = {
      id: 'qwen',
      displayName: 'Qwen Code',
      variants: [{
        id: 'qwen-cli',
        displayName: '通义灵码 CLI',
        hostKind: 'cli',
        maturity: 'managed',
        maximumAccessLevel: 'complete',
      }],
    }
    expect(matchesSupportQuery(product, 'qwen')).toBe(true)
    expect(matchesSupportQuery(product, '灵码')).toBe(true)
    expect(matchesSupportQuery(product, '  QWEN  ')).toBe(true)
    expect(matchesSupportQuery(product, 'codex')).toBe(false)
  })

  it('summarizes execution outcomes and keeps an in-flight dialog fail-safe', () => {
    expect(summarizeExecutionResults([
      { installationId: 'a', status: 'committed' },
      { installationId: 'b', status: 'awaiting_verification', reason: 'Start a new session' },
      { installationId: 'c', status: 'failed', reason: 'Read-back failed' },
      { installationId: 'd', status: 'needs_recovery' },
      { installationId: 'e', status: 'interrupted' },
      { installationId: 'f', status: 'superseded', reason: 'superseded_by_disconnect' },
    ])).toEqual({
      total: 6,
      committed: 1,
      awaitingVerification: 1,
      superseded: 1,
      failed: 1,
      needsRecovery: 1,
      interrupted: 1,
      otherAttention: 0,
      needsAttention: 3,
    })
    expect(canCloseBatchDialog(true)).toBe(false)
    expect(canCloseBatchDialog(false)).toBe(true)
  })

  it('classifies Custom connection results without presenting partial work as success', () => {
    expect(customApplyOutcome({ planHash: 'a', results: [
      { installationId: 'custom', status: 'committed' },
    ] })).toBe('committed')
    expect(customApplyOutcome({ planHash: 'b', results: [
      { installationId: 'custom', status: 'awaiting_verification' },
    ] })).toBe('awaiting_verification')
    expect(customApplyOutcome({ planHash: 'c', results: [
      { installationId: 'custom', status: 'committed' },
      { installationId: 'other', status: 'needs_recovery' },
    ] })).toBe('needs_recovery')
    expect(customApplyOutcome({ planHash: 'd', results: [
      { installationId: 'custom', status: 'failed' },
    ] })).toBe('failed')
    expect(customApplyOutcome({ planHash: 'superseded', results: [
      { installationId: 'custom', status: 'superseded', reason: 'superseded_by_disconnect' },
    ] })).toBe('failed')
    expect(customApplyOutcome({ planHash: 'empty', results: [] })).toBe('failed')
  })

  it('validates Custom MCP selector keys before IPC and never exposes unknown action tokens', () => {
    expect(isValidCustomSelectorKey('tidemind-agent_2')).toBe(true)
    expect(isValidCustomSelectorKey('bad selector')).toBe(false)
    expect(isValidCustomSelectorKey('__proto__')).toBe(false)
    expect(isValidCustomSelectorKey('constructor')).toBe(false)
    expect(requiredUserActionPresentation('qwenwork_mcp_gui_connect_required').labelKey)
      .toBe('agent.managed.userAction.qwenWorkConnect')
    expect(requiredUserActionPresentation('component_requires_other_projection:lifecycle')).toEqual({
      labelKey: 'agent.managed.userAction.componentRequiresOtherProjection',
      componentKey: 'lifecycle',
    })
    expect(requiredUserActionPresentation('future_internal_token').labelKey)
      .toBe('agent.managed.userAction.manualReview')
    expect(requiredUserActionPresentation('toString').labelKey)
      .toBe('agent.managed.userAction.manualReview')
    expect(requiredUserActionDetailKey({
      kind: 'mcp_activation',
      componentKey: 'memory_tools',
      operation: 'connect',
      instruction: 'Enable the server',
      hostVariant: 'qwen-code-cli',
      serverName: 'tidemind',
      configLabel: '~/.qwen/settings.json',
      reason: 'excluded',
    })).toBe('mcp_activation:qwen-code-cli:tidemind:excluded')
  })

  it('implements wrapped arrow, Home, and End navigation for installation tabs', () => {
    expect(nextRovingTabIndex(2, 3, 'ArrowRight')).toBe(0)
    expect(nextRovingTabIndex(0, 3, 'ArrowLeft')).toBe(2)
    expect(nextRovingTabIndex(1, 3, 'ArrowDown')).toBe(2)
    expect(nextRovingTabIndex(1, 3, 'ArrowUp')).toBe(0)
    expect(nextRovingTabIndex(1, 3, 'Home')).toBe(0)
    expect(nextRovingTabIndex(1, 3, 'End')).toBe(2)
    expect(nextRovingTabIndex(1, 3, 'Escape')).toBeNull()
  })

  it('returns retry focus to the current Installation without leaking across a tab switch', () => {
    expect(detailFocusDestination('codex-default', 'codex-default', 'success')).toBe('tab')
    expect(detailFocusDestination('codex-default', 'codex-default', 'failure')).toBe('retry')
    expect(detailFocusDestination('codex-default', 'kimi-default', 'success')).toBeNull()
    expect(detailFocusDestination(null, 'codex-default', 'failure')).toBeNull()
  })
})

describe('managed Agent locale resources', () => {
  it('keeps the managed key shape identical in every supported settings locale', () => {
    const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt-BR', 'ru', 'it', 'tr']
    const readManaged = (locale: string) => {
      const value = JSON.parse(readFileSync(resolve(process.cwd(), `client/src/locales/${locale}/settings.json`), 'utf8'))
      return value.agent.managed
    }
    const expected = flattenKeys(readManaged('en')).sort()
    expect(expected).toEqual(expect.arrayContaining([
      'status.available',
      'status.needsAttention',
      'reason.releaseModeDetectOnly',
      'reason.releaseDistributionNotAccepted',
      'reason.releaseVersionNotAccepted',
      'access.complete',
      'access.partial',
      'component.instruction',
      'component.memoryTools',
      'component.lifecycle',
      'componentStatus.verified',
      'componentStatus.stale',
      'scope.user',
      'commandCategory.host_cli',
      'risk.high',
      'execution.awaiting_verification',
      'execution.committed',
      'targetAccess.4',
      'releasePolicy.emergencyReadOnlyTitle',
      'releasePolicy.emergencyReadOnlyDescription',
      'releasePolicy.invalidManifestTitle',
      'releasePolicy.invalidManifestDescription',
      'custom.dialogTitle',
      'custom.mode.nonstandard_config_root.title',
      'custom.mode.manual_mcp_client.title',
      'custom.localOnlyNotice',
      'custom.approveExactPlan',
      'custom.selectorInvalid',
      'custom.result.awaiting_verification',
      'custom.result.needs_recovery',
      'custom.warning.new_session_and_real_tool_call_required',
      'userAction.qwenWorkConnect',
      'userAction.manualReview',
      'actionDetail.command',
      'actionDetail.activationReason.invalid_policy',
    ]))
    expect(flattenKeys(readManaged('zh-CN')).sort()).toEqual(expected)
    for (const locale of locales.slice(2)) {
      expect(flattenKeys(readManaged(locale)).sort(), locale).toEqual(expected)
    }
    expect(JSON.stringify(readManaged('en'))).not.toMatch(/\bC[0-4]\b/)
    expect(JSON.stringify(readManaged('zh-CN'))).not.toMatch(/\bC[0-4]\b/)
  })

  it('keeps the Custom flow modal, local-only inputs, consent, and keyboard semantics explicit', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      'client/src/components/settings/agent-integration-managed/CustomLocalAgentDialog.tsx',
    ), 'utf8')
    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-modal="true"')
    expect(source).toContain("event.key === 'Escape'")
    expect(source).toContain("pickCustomPath(kind)")
    expect(source).toContain("previewCustomInstallation")
    expect(source).toContain("prepareCustomConnect")
    expect(source).toContain("applyConnect(plan.planHash")
    expect(source).toContain('customApplyOutcome(result)')
    expect(source).toContain('theme-modal-overlay')
    expect(source).toContain('theme-popup-surface')
    const selectLines = source.split('\n').filter(line => line.includes('<select'))
    expect(selectLines).toHaveLength(3)
    expect(selectLines.every(line => line.includes('bg-white/[0.035]'))).toBe(true)
    expect(source).not.toContain('bg-slate-900/70')
    expect(source).toContain('}, [initialLegacyInstallationId, open])')
    expect(source).not.toContain('}, [open, sourceInstallations])')
    expect(source).not.toContain('`${item.reason}`')
    expect(source).not.toContain('shellCommand')
    expect(source).not.toContain('remoteUrl')
  })

  it('keeps Agent dialogs theme-aware and the full-row trigger described by visible facts', () => {
    const confirmSource = readFileSync(resolve(
      process.cwd(),
      'client/src/components/shared/ConfirmDialog.tsx',
    ), 'utf8')
    const listSource = readFileSync(resolve(
      process.cwd(),
      'client/src/components/settings/agent-integration-managed/ManagedFamilyList.tsx',
    ), 'utf8')
    expect(confirmSource).toContain('theme-modal-overlay')
    expect(confirmSource).toContain('theme-popup-surface')
    expect(confirmSource).not.toContain('#f87171')
    expect(listSource).toContain('aria-describedby={summaryId}')
    expect(listSource).toContain('className="sr-only"')
  })
})
