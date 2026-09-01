import {
  autoRestoreNotification,
  circuitBreakerNotification,
  publishIntegrationEvent,
  type IntegrationEventRepositoryPort,
  type NotificationPort,
} from './events'
import type {
  AgentIntegrationCoordinator,
  ApplyPreparedRequest,
  CoordinatorInstallation,
  CoordinatorOutcome,
  PreviewRequest,
} from './coordinator'
import type { CapabilityLevel, ComponentKey, DesiredState, JsonValue } from './types'

export type ManagedArtifactObservationKind =
  | 'healthy'
  | 'exact_missing'
  | 'drifted'
  | 'conflicted'
  | 'inaccessible'

export interface ManagedArtifactObservation {
  kind: ManagedArtifactObservationKind
  /** Complete absence of the exact Tide Mind-owned selector/path. */
  selectorEmpty: boolean
  ownershipBaselineVerified: boolean
  containerResolvable: boolean
  observedFingerprint: string | null
  diagnostics: readonly string[]
}

export interface MissingEpisodeResult {
  changed: boolean
  eventCount: number
  shouldAutoRestore: boolean
  circuitBroken: boolean
}

export interface ReconcilerRepositoryPort extends IntegrationEventRepositoryPort {
  beginMissingEpisode(input: {
    artifactId: string
    episodeId: string
    observedAt: string
    windowMs?: number
  }): MissingEpisodeResult | Promise<MissingEpisodeResult>
  markArtifactHealthyAfterReadback(artifactId: string, verifiedAt: string): boolean | Promise<boolean>
}

export interface ReconcilerClock {
  now(): Date
}

export interface ReconcilerIdFactory {
  next(prefix: 'episode' | 'event'): string
}

export interface ReconcilerDependencies {
  coordinator: Pick<AgentIntegrationCoordinator, 'preview' | 'applyPrepared'>
  repository: ReconcilerRepositoryPort
  notifications: NotificationPort
  clock: ReconcilerClock
  ids: ReconcilerIdFactory
  locale?: string | (() => string)
}

export interface ReconcileManagedArtifactRequest {
  artifactId: string
  installation: CoordinatorInstallation
  installationDesiredState: DesiredState
  componentKey: ComponentKey
  componentName: string
  desiredCapability: CapabilityLevel
  consentId: string | null
  observation: ManagedArtifactObservation
  /** All consumers are only diagnostic/notification context; physical CAS is Artifact-scoped. */
  affectedConsumers?: readonly { installationId: string; displayName: string }[]
}

export type ManagedArtifactReconcileOutcome =
  | { status: 'healthy' | 'no_op' }
  | { status: 'awaiting_verification'; runId: string }
  | { status: 'paused'; reason: 'disabled' | 'removed' | 'circuit_breaker' }
  | { status: 'needs_attention'; reason: string }
  | { status: 'auto_restored'; coordinator: CoordinatorOutcome }

export class ManagedAgentReconciler {
  constructor(private readonly dependencies: ReconcilerDependencies) {}

  async reconcileArtifact(request: ReconcileManagedArtifactRequest): Promise<ManagedArtifactReconcileOutcome> {
    if (request.installationDesiredState === 'disabled') return { status: 'paused', reason: 'disabled' }
    if (request.installationDesiredState === 'removed') return { status: 'paused', reason: 'removed' }
    if (request.installationDesiredState !== 'managed') return { status: 'no_op' }

    if (request.observation.kind === 'healthy') {
      await this.dependencies.repository.markArtifactHealthyAfterReadback(
        request.artifactId,
        this.dependencies.clock.now().toISOString(),
      )
      return { status: 'healthy' }
    }
    if (request.observation.kind !== 'exact_missing') {
      await this.persistAttentionEvent(request, `artifact_${request.observation.kind}`)
      return { status: 'needs_attention', reason: request.observation.kind }
    }
    if (!request.observation.selectorEmpty
      || !request.observation.ownershipBaselineVerified
      || !request.observation.containerResolvable) {
      await this.persistAttentionEvent(request, 'artifact_missing_not_safe_to_restore')
      return { status: 'needs_attention', reason: 'missing_not_safe_to_restore' }
    }

    const episodeId = this.dependencies.ids.next('episode')
    const observedAt = this.dependencies.clock.now().toISOString()
    const episode = await this.dependencies.repository.beginMissingEpisode({
      artifactId: request.artifactId,
      episodeId,
      observedAt,
      windowMs: 24 * 60 * 60 * 1000,
    })
    if (!episode.changed && !episode.shouldAutoRestore) return { status: 'no_op' }
    if (episode.circuitBroken) {
      const eventId = this.dependencies.ids.next('event')
      const notification = circuitBreakerNotification({
        eventId,
        installationId: request.installation.id,
        agentName: request.installation.displayName,
        componentName: request.componentName,
        componentKey: request.componentKey,
        locale: currentLocale(this.dependencies.locale),
      })
      await publishIntegrationEvent(this.event(request, {
        id: eventId,
        kind: 'auto_repair_circuit_broken',
        severity: 'warning',
        episodeId,
        dedupeKey: `${request.artifactId}:${episodeId}:circuit`,
        payload: { eventCount: episode.eventCount, affectedConsumers: consumersJson(request) },
        createdAt: observedAt,
      }), notification, this.dependencies)
      return { status: 'paused', reason: 'circuit_breaker' }
    }
    if (!episode.shouldAutoRestore) return { status: 'no_op' }
    if (!request.consentId) {
      await this.persistAttentionEvent(request, 'auto_repair_consent_missing', episodeId)
      return { status: 'needs_attention', reason: 'consent_missing' }
    }

    let prepared
    try {
      const previewRequest: PreviewRequest = {
        installation: request.installation,
        operation: 'repair',
        componentKeys: [request.componentKey],
        desiredCapability: request.desiredCapability,
      }
      prepared = await this.dependencies.coordinator.preview(previewRequest)
    } catch (error) {
      await this.persistAttentionEvent(request, 'auto_repair_plan_failed', episodeId, error)
      return { status: 'needs_attention', reason: 'repair_plan_failed' }
    }

    const applyRequest: ApplyPreparedRequest = {
      installation: request.installation,
      preparedPlan: prepared,
      consentId: request.consentId,
      desiredCapability: request.desiredCapability,
    }
    const result = await this.dependencies.coordinator.applyPrepared(applyRequest)
    if (result.status === 'awaiting_verification') {
      const healthy = await this.dependencies.repository.markArtifactHealthyAfterReadback(
        request.artifactId,
        this.dependencies.clock.now().toISOString(),
      )
      if (!healthy) {
        await this.persistAttentionEvent(request, 'auto_repair_state_commit_failed', episodeId)
        return { status: 'needs_attention', reason: 'artifact_state_commit_failed' }
      }
      await this.publishRestored(request, episodeId, result.runId)
      return { status: 'awaiting_verification', runId: result.runId }
    }
    if (result.status !== 'committed') {
      await this.persistAttentionEvent(request, 'auto_repair_failed', episodeId, result)
      return { status: 'needs_attention', reason: result.status }
    }

    const healthy = await this.dependencies.repository.markArtifactHealthyAfterReadback(
      request.artifactId,
      this.dependencies.clock.now().toISOString(),
    )
    if (!healthy) {
      await this.persistAttentionEvent(request, 'auto_repair_state_commit_failed', episodeId)
      return { status: 'needs_attention', reason: 'artifact_state_commit_failed' }
    }

    await this.publishRestored(request, episodeId, result.runId)
    return { status: 'auto_restored', coordinator: result }
  }

  private async publishRestored(
    request: ReconcileManagedArtifactRequest,
    episodeId: string,
    runId: string,
  ): Promise<void> {
    const eventId = this.dependencies.ids.next('event')
    const notification = autoRestoreNotification({
      eventId,
      installationId: request.installation.id,
      agentName: request.installation.displayName,
      componentName: request.componentName,
      componentKey: request.componentKey,
      locale: currentLocale(this.dependencies.locale),
    })
    await publishIntegrationEvent(this.event(request, {
      id: eventId,
      kind: 'artifact_auto_restored',
      severity: 'info',
      episodeId,
      dedupeKey: `${request.artifactId}:${episodeId}:restored`,
      payload: { runId, affectedConsumers: consumersJson(request) },
      createdAt: this.dependencies.clock.now().toISOString(),
    }), notification, this.dependencies)
  }

  private async persistAttentionEvent(
    request: ReconcileManagedArtifactRequest,
    kind: string,
    episodeId: string | null = null,
    detail?: unknown,
  ): Promise<void> {
    const createdAt = this.dependencies.clock.now().toISOString()
    const detailText = detail instanceof Error ? detail.message : detail === undefined ? null : JSON.stringify(detail)
    await publishIntegrationEvent(this.event(request, {
      id: this.dependencies.ids.next('event'),
      kind,
      severity: 'warning',
      episodeId,
      dedupeKey: `${request.artifactId}:${kind}:${request.observation.observedFingerprint ?? 'none'}`,
      payload: {
        observedFingerprint: request.observation.observedFingerprint,
        diagnostics: [...request.observation.diagnostics],
        detail: detailText,
      },
      createdAt,
    }), null, this.dependencies)
  }

  private event(
    request: ReconcileManagedArtifactRequest,
    event: {
      id: string
      kind: string
      severity: 'info' | 'warning' | 'error'
      episodeId: string | null
      dedupeKey: string
      payload: Readonly<Record<string, JsonValue>>
      createdAt: string
    },
  ) {
    return {
      ...event,
      installationId: request.installation.id,
      componentKey: request.componentKey,
      artifactId: request.artifactId,
    }
  }
}

function currentLocale(locale: ReconcilerDependencies['locale']): string | undefined {
  return typeof locale === 'function' ? locale() : locale
}

function consumersJson(request: ReconcileManagedArtifactRequest): JsonValue {
  return (request.affectedConsumers ?? [{
    installationId: request.installation.id,
    displayName: request.installation.displayName,
  }]).map(consumer => ({
    installationId: consumer.installationId,
    displayName: consumer.displayName,
  }))
}
