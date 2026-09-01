import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { AGENT_INTEGRATION_WRITER_PROTOCOL } from '@server/db/agent-integration-schema.js'
import { checkPlanAgainstConsent, type ConsentEnvelope } from './consent'
import {
  type CoordinatorInstallation,
  type CoordinatorRepositoryPort,
  type InstallationControlState,
  type MutableRecoverableExecution,
  type PrepareExecutionInput,
  type PrepareExecutionResult,
  type PreparedMutationExecution,
  type RecoverableExecution,
  type WriterFenceLease,
  frozenPlanInstallationSurfaceFingerprint,
  frozenPlanLiveTrustProofFingerprint,
  supplementalConsentClaims,
} from './coordinator'
import { sha256Json } from './fingerprint'
import { buildLegacyMutationDomain } from './legacy-writer'
import type { IntegrationEvent } from './events'
import type { MutationJournalRecord } from './mutation-runner'
import type { PreparedCoordinatorPlan } from './planner'
import {
  AgentIntegrationRepository,
  persistedComponentConfigFiles,
  persistedDistribution,
  persistedHostOwnedIdentity,
  persistedProjectionSurfaceFingerprint,
  type AgentInstallationRow,
} from './repository'
import type {
  CapabilityLevel,
  CatalogId,
  ComponentKey,
  ComponentVerificationResult,
  DesiredState,
  OwnedArtifactBaseline,
  PlannedMutation,
} from './types'

const WRITER_GENERATION = 1
const DEFAULT_LEASE_MS = 30_000

interface BridgeOptions {
  ownerInstanceId?: string
  now?: () => Date
  leaseDurationMs?: number
  id?: (prefix: string) => string
  lockDirectory?: string
  /** Trusted lexical root whose descendants must never contain symlinks. */
  lockDirectoryTrustRoot?: string
}

interface RunRow {
  id: string
  installation_id: string
  operation_type: string
  consent_envelope_id: string
  state: RecoverableExecution['runState'] | 'planned' | 'preconditions_checked'
  prepared_plan_json: string
  desired_capability: number
}

interface MutationRow {
  id: string
  operation_id: string
  mutation_domain: string
  planned_mutation_json: string
  idempotency_strategy: string
  state: MutationJournalRecord['state']
  journal_version: number
  attempt_count: number
  before_hash: string | null
  after_hash: string | null
  post_effect_fingerprint: string | null
  compensation_precondition: string | null
  apply_receipt_json: string | null
  failure_code: string | null
  failure_stage: string | null
  updated_at: string
}

interface OwnedArtifactBaselineRow {
  component_key: ComponentKey
  target_path: string
  ownership_key: string
  owned_fragment_hash: string
  selector_schema_version: string | number
}

export interface ManagedReconcileCandidate {
  artifactId: string
  componentKey: ComponentKey
  componentName: string
  desiredCapability: CapabilityLevel
  consentId: string | null
  ownedFragmentHash: string
  desiredFragmentHash: string | null
  installation: CoordinatorInstallation
  affectedConsumers: readonly { installationId: string; displayName: string }[]
}

/** SQLite-backed Coordinator port. No state in this bridge is authoritative in memory. */
export class SqliteCoordinatorRepository implements CoordinatorRepositoryPort {
  private readonly ownerInstanceId: string
  private readonly now: () => Date
  private readonly leaseDurationMs: number
  private readonly id: (prefix: string) => string
  private readonly lockDirectory: string
  private readonly lockDirectoryTrustRoot: string
  private readonly processStartIdentity: string | null

  constructor(
    private readonly db: Database.Database,
    private readonly repository: AgentIntegrationRepository,
    options: BridgeOptions = {},
  ) {
    this.ownerInstanceId = options.ownerInstanceId ?? `agent-integration-${randomUUID()}`
    this.now = options.now ?? (() => new Date())
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS
    this.id = options.id ?? (prefix => `${prefix}_${randomUUID()}`)
    this.lockDirectory = path.resolve(
      options.lockDirectory ?? path.join(os.tmpdir(), 'tidemind-agent-integration-writer-locks'),
    )
    this.lockDirectoryTrustRoot = path.resolve(
      options.lockDirectoryTrustRoot ?? path.dirname(this.lockDirectory),
    )
    this.processStartIdentity = processStartIdentity(process.pid)
  }

  getInstallationControl(installationId: string): InstallationControlState | null {
    const row = this.repository.getInstallation(installationId)
    if (!row?.agent_id) return null
    const healthState: InstallationControlState['healthState'] = row.status_reason === 'host_uninstalled'
      || row.health_state === 'absent'
      ? 'host_uninstalled'
      : row.health_state === 'discovered'
        ? 'discovered'
        : 'unknown'
    return {
      desiredState: row.desired_state,
      tombstoned: row.tombstoned_at !== null,
      healthState,
      statusReason: row.status_reason,
      installKey: row.install_key,
      agentId: row.agent_id,
      hostVariant: row.host_variant as CatalogId,
      consentId: row.consent_envelope_id,
    }
  }

  getInstallationHostVersion(installationId: string): string | null {
    return this.repository.getInstallation(installationId)?.detected_version ?? null
  }

  listOwnedArtifactBaselines(installationId: string): readonly OwnedArtifactBaseline[] {
    const rows = this.db.prepare(`
      SELECT c.component_key, a.target_path, a.ownership_key, a.owned_fragment_hash,
             a.selector_schema_version
      FROM artifact_consumers c
      JOIN managed_artifacts a ON a.id = c.artifact_id
      WHERE c.installation_id = ?
        AND c.state = 'active'
        AND c.desired_state IN ('managed','disabled')
        AND c.tombstoned_at IS NULL
        AND a.state NOT IN ('removed','conflict')
        AND a.owned_fragment_hash IS NOT NULL
      ORDER BY c.component_key, a.target_path, a.ownership_key
    `).all(installationId) as OwnedArtifactBaselineRow[]
    return rows.map(row => ({
      componentKey: row.component_key as ComponentKey,
      physicalTarget: String(row.target_path),
      ownershipKey: String(row.ownership_key),
      ownedFragmentHash: String(row.owned_fragment_hash),
      selectorSchemaVersion: Number(row.selector_schema_version),
    }))
  }

  /** Durable managed-ledger rows eligible for read-only inspection and repair orchestration. */
  listManagedReconcileCandidates(): readonly ManagedReconcileCandidate[] {
    const rows = this.db.prepare(`
      SELECT a.id AS artifact_id, a.owned_fragment_hash, a.desired_fragment_hash,
             c.installation_id, c.component_key, c.required_capability, c.consent_envelope_id
      FROM managed_artifacts a
      JOIN artifact_consumers c ON c.artifact_id = a.id
      JOIN agent_installations i ON i.id = c.installation_id
      LEFT JOIN agent_consents active_consent
        ON active_consent.id = c.consent_envelope_id
        AND active_consent.installation_id = c.installation_id
        AND active_consent.status = 'active'
        AND i.consent_envelope_id = c.consent_envelope_id
      WHERE c.state = 'active' AND c.desired_state = 'managed'
        AND c.tombstoned_at IS NULL
        AND i.desired_state IN ('managed','disabled') AND i.tombstoned_at IS NULL
        AND i.health_state = 'discovered'
        AND a.state NOT IN ('removed','removal_pending','conflict')
        AND a.owned_fragment_hash IS NOT NULL
      ORDER BY a.id,
               CASE
                 WHEN i.desired_state = 'managed' AND active_consent.id IS NOT NULL THEN 0
                 WHEN i.desired_state = 'managed' THEN 1
                 ELSE 2
               END,
               c.installation_id, c.component_key
    `).all() as Array<{
      artifact_id: string
      owned_fragment_hash: string
      desired_fragment_hash: string | null
      installation_id: string
      component_key: ComponentKey
      required_capability: number
      consent_envelope_id: string | null
    }>
    const consumersByArtifact = new Map<string, Array<{ installationId: string; displayName: string }>>()
    for (const row of rows) {
      const installation = this.repository.getInstallation(row.installation_id)
      if (!installation) continue
      const consumers = consumersByArtifact.get(row.artifact_id) ?? []
      consumers.push({
        installationId: installation.id,
        displayName: installation.display_alias ?? installation.display_name,
      })
      consumersByArtifact.set(row.artifact_id, consumers)
    }
    const candidates: ManagedReconcileCandidate[] = []
    for (const row of rows) {
      const installation = this.repository.getInstallation(row.installation_id)
      if (!installation) continue
      candidates.push({
        artifactId: row.artifact_id,
        componentKey: row.component_key,
        componentName: componentDisplayName(row.component_key),
        desiredCapability: capability(row.required_capability),
        consentId: row.consent_envelope_id,
        ownedFragmentHash: row.owned_fragment_hash,
        desiredFragmentHash: row.desired_fragment_hash,
        installation: installationFromRow(installation),
        affectedConsumers: consumersByArtifact.get(row.artifact_id) ?? [],
      })
    }
    return candidates
  }

  beginMissingEpisode(input: {
    artifactId: string
    episodeId: string
    observedAt: string
    windowMs?: number
  }) {
    return this.repository.beginMissingEpisode(input)
  }

  markArtifactHealthyAfterReadback(artifactId: string, verifiedAt: string): boolean {
    return this.repository.markArtifactHealthyAfterReadback(artifactId, verifiedAt)
  }

  getConsent(consentId: string): ConsentEnvelope | null {
    const row = this.repository.getConsent(consentId)
    if (!row || row.status !== 'active') return null
    return {
      id: String(row.id),
      installationId: String(row.installation_id),
      componentKeys: stringArray(String(row.allowed_components_json)),
      targetScopes: stringArray(String(row.allowed_scopes_json)),
      selectorResolution: stringRecord(String(row.selector_resolution_json), 'selector resolution'),
      executableRealpaths: stringArray(String(row.executable_realpaths_json)).map(value => path.resolve(value)),
      commandCategories: stringArray(String(row.command_categories_json)) as ConsentEnvelope['commandCategories'],
      maxRisk: row.maximum_risk as ConsentEnvelope['maxRisk'],
      selectorSchemaVersion: positiveInteger(row.selector_schema_version, 'selector schema version'),
      policyVersion: positiveInteger(row.policy_version, 'policy version'),
      approvedAt: String(row.confirmed_at),
      revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : null,
    }
  }

  setInstallationReconcileState(
    installationId: string,
    state: Parameters<CoordinatorRepositoryPort['setInstallationReconcileState']>[1],
    reason: string | null,
    updatedAt: string,
    options: { expectedDesiredState?: DesiredState; expectedConsentId?: string | null } = {},
  ): boolean {
    const hasExpectedConsent = Object.prototype.hasOwnProperty.call(options, 'expectedConsentId')
    const result = this.db.prepare(`
      UPDATE agent_installations
      SET reconcile_state = ?, status_reason = ?, updated_at = ?
      WHERE id = ?
        AND (
          ? IS NULL OR (
            desired_state = ?
            AND health_state = 'discovered'
            AND COALESCE(status_reason, '') != 'conflict'
            AND (
              (? = 'managed' AND tombstoned_at IS NULL)
              OR (? = 'removed' AND tombstoned_at IS NOT NULL)
              OR (? NOT IN ('managed', 'removed'))
            )
          )
        )
        AND (? = 0 OR consent_envelope_id IS ?)
    `).run(
      state,
      reason,
      updatedAt,
      installationId,
      options.expectedDesiredState ?? null,
      options.expectedDesiredState ?? null,
      options.expectedDesiredState ?? null,
      options.expectedDesiredState ?? null,
      options.expectedDesiredState ?? null,
      hasExpectedConsent ? 1 : 0,
      options.expectedConsentId ?? null,
    )
    if (result.changes !== 1 && !this.repository.getInstallation(installationId)) {
      throw new Error(`unknown Installation: ${installationId}`)
    }
    return result.changes === 1
  }

  prepareExecution(input: PrepareExecutionInput): PrepareExecutionResult {
    assertCapability(input.desiredCapability)
    return this.db.transaction(() => {
      const persistedMutations: PreparedMutationExecution[] = []
      const installation = this.repository.getInstallation(input.installationId)
      if (!installation?.agent_id) throw new Error(`unknown Installation: ${input.installationId}`)
      const expectedSurface = frozenPlanInstallationSurfaceFingerprint(input.preparedPlan)
      if (expectedSurface
        && expectedSurface !== persistedProjectionSurfaceFingerprint(installation)) {
        throw new Error('Installation projection surface changed before prepare')
      }
      if (installation.health_state !== 'discovered' || installation.status_reason === 'conflict') {
        throw new Error('Installation is not authoritatively present')
      }
      if (installation.desired_state !== input.expectedDesiredState) {
        throw new Error(`Installation intent changed before prepare: ${installation.desired_state}`)
      }
      const reconnectFromRemoved = input.reconnectFromRemoved === true
      if (reconnectFromRemoved && (
        input.operation !== 'connect'
        || input.intentAfterPrepare !== 'managed'
        || installation.desired_state !== 'removed'
        || !installation.tombstoned_at
      )) {
        throw new Error('reconnect prepare requires an explicitly removed Installation')
      }
      if ((installation.desired_state === 'removed' || installation.tombstoned_at)
        && input.operation !== 'disconnect' && !reconnectFromRemoved) {
        throw new Error('tombstoned Installation cannot prepare a write')
      }
      const consent = this.repository.getConsent(input.consentId)
      if (!consent || consent.status !== 'active' || consent.installation_id !== input.installationId) {
        throw new Error('active Installation consent is required')
      }
      const consentEnvelope = this.getConsent(input.consentId)
      const consentCoverage = consentEnvelope
        ? checkPlanAgainstConsent(
          input.preparedPlan.executionPlan,
          consentEnvelope,
          supplementalConsentClaims(
            installationFromRow(installation),
            input.preparedPlan,
            this.listOwnedArtifactBaselines(input.installationId),
          ),
        )
        : null
      if (!consentCoverage?.allowed
        || consentCoverage.executionPlanHash !== input.preparedPlan.executionPlanHash) {
        throw new Error(`active consent does not cover prepared plan: ${consentCoverage?.reasons.join(',') ?? 'missing'}`)
      }

      if (input.operation === 'disconnect' && input.disconnectScopeExpectations) {
        this.assertFrozenDisconnectScopes(input)
      }

      if (reconnectFromRemoved) {
        this.db.prepare(`
          UPDATE agent_consents SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?)
          WHERE installation_id = ? AND status = 'active' AND id != ?
        `).run(input.createdAt, input.installationId, input.consentId)
        this.db.prepare(`
          UPDATE verification_results
          SET invalidated_at = COALESCE(invalidated_at, ?),
              invalidation_reason = COALESCE(invalidation_reason, 'explicit_reconnect')
          WHERE installation_id = ?
        `).run(input.createdAt, input.installationId)
        this.db.prepare(`DELETE FROM artifact_consumers WHERE installation_id = ? AND state = 'removed'`)
          .run(input.installationId)
        this.db.prepare(`DELETE FROM installation_components WHERE installation_id = ? AND desired_state = 'removed'`)
          .run(input.installationId)
      }

      const managedDomains = new Set<string>()
      const ensureManagedFence = (mutationDomain: string): void => {
        const snapshotOverlap = this.db.prepare(`
          SELECT r.id
          FROM reconcile_runs r, json_each(r.writer_fence_snapshot_json, '$.mutationDomains') domain
          WHERE domain.value = ?
            AND r.state IN ('planned','preconditions_checked','applying','applied_unverified','verified','compensating','needs_recovery')
            AND NOT (
              r.state = 'applied_unverified'
              AND ? = 'disconnect'
              AND r.operation_type IN ('connect','repair')
              AND r.installation_id = ?
            )
          LIMIT 1
        `).get(mutationDomain, input.operation, input.installationId) as { id: string } | undefined
        const mutationOverlap = this.db.prepare(`
          SELECT pm.id
          FROM projection_mutations pm
          JOIN reconcile_runs r ON r.id = pm.run_id
          WHERE pm.mutation_domain = ?
            AND r.state IN ('planned','preconditions_checked','applying','applied_unverified','verified','compensating','needs_recovery')
            AND pm.idempotency_strategy != 'consumer_detach_only'
            AND NOT (
              r.state = 'applied_unverified'
              AND ? = 'disconnect'
              AND r.operation_type IN ('connect','repair')
              AND r.installation_id = ?
            )
          LIMIT 1
        `).get(mutationDomain, input.operation, input.installationId) as { id: string } | undefined
        if (snapshotOverlap || mutationOverlap) {
          throw new Error(`mutation domain already has a non-terminal run: ${mutationDomain}`)
        }
        this.db.prepare(`
          INSERT INTO writer_fences (
            mutation_domain, scope_mode, minimum_writer_protocol, writer_generation,
            epoch, state, metadata_json, created_at, updated_at
          ) VALUES (?, 'managed', ?, ?, 0, 'released', ?, ?, ?)
          ON CONFLICT(mutation_domain) DO UPDATE SET
            scope_mode = 'managed',
            minimum_writer_protocol = MAX(writer_fences.minimum_writer_protocol, excluded.minimum_writer_protocol),
            writer_generation = MAX(writer_fences.writer_generation, excluded.writer_generation),
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `).run(
          mutationDomain,
          AGENT_INTEGRATION_WRITER_PROTOCOL,
          WRITER_GENERATION,
          JSON.stringify({ source: 'managed_agent_consent_cutover', runId: input.runId }),
          input.createdAt,
          input.createdAt,
        )
      }

      this.db.prepare(`
        INSERT INTO reconcile_runs (
          id, installation_id, operation_type, execution_plan_hash, consent_envelope_id,
          state, recovery_strategy, writer_fence_snapshot_json, adapter_version,
          catalog_version, projection_version, selector_schema_version,
          prepared_plan_json, desired_capability, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'planned', 'readback_before_replay', '{}', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.runId,
        input.installationId,
        input.operation,
        input.planHash,
        input.consentId,
        input.preparedPlan.adapterPlan.adapterVersion,
        String(input.preparedPlan.executionPlan.catalogVersion),
        input.preparedPlan.adapterPlan.projectionVersion,
        String(maxSelectorVersion(input.preparedPlan)),
        JSON.stringify(input.preparedPlan),
        input.desiredCapability,
        input.createdAt,
        input.createdAt,
      )

      if (input.applyTaskBinding) {
        const binding = input.applyTaskBinding
        if (binding.installationId !== input.installationId
          || binding.executionPlanHash !== input.planHash) {
          throw new Error('apply task binding does not match frozen execution')
        }
        const bound = this.db.prepare(`
          UPDATE agent_integration_apply_task_items
          SET run_id = ?, updated_at = ?
          WHERE task_id = ? AND installation_id = ? AND execution_plan_hash = ?
            AND state = 'running' AND run_id IS NULL
            AND EXISTS (
              SELECT 1 FROM agent_integration_apply_tasks task
              WHERE task.id = agent_integration_apply_task_items.task_id
                AND task.state = 'running' AND task.operation_type = 'connect'
            )
        `).run(
          input.runId,
          input.createdAt,
          binding.taskId,
          binding.installationId,
          binding.executionPlanHash,
        )
        if (bound.changes !== 1) {
          throw new Error(`apply task item could not bind exact run: ${binding.installationId}`)
        }
      }

      for (const componentKey of input.preparedPlan.componentKeys) {
        this.upsertDesiredComponent(
          installation,
          componentKey,
          input.operation === 'disconnect' ? 'removed' : 'managed',
          input.desiredCapability,
          input.consentId,
          input.createdAt,
        )
      }

      const mutationComponents = new Set(input.mutations.map(mutation => mutation.plannedMutation.componentKey))
      for (const componentKey of input.preparedPlan.componentKeys) {
        if (mutationComponents.has(componentKey)) continue
        managedDomains.add(input.operation === 'disconnect'
          ? this.stageAbsentOwnedArtifactConsumer(input, componentKey)
          : this.activateOwnedExistingArtifactConsumer(input, componentKey))
      }

      const preparedArtifacts = input.mutations.map(mutation => {
        const artifact = this.prepareArtifactAndConsumer(input, mutation.plannedMutation)
        const journal = artifact.effectDisposition === 'consumer_detach'
          ? { ...mutation.journal, state: 'committed' as const, updatedAt: input.createdAt }
          : mutation.journal
        if (artifact.effectDisposition !== 'consumer_detach') managedDomains.add(mutation.mutationDomain)
        return { mutation, artifact, journal }
      })
      for (const mutationDomain of managedDomains) {
        ensureManagedFence(mutationDomain)
      }
      this.db.prepare(`
        UPDATE reconcile_runs SET writer_fence_snapshot_json = ?, updated_at = ? WHERE id = ?
      `).run(
        JSON.stringify({ mutationDomains: [...managedDomains].sort() }),
        input.createdAt,
        input.runId,
      )

      for (const { mutation, artifact, journal } of preparedArtifacts) {
        this.db.prepare(`
          INSERT INTO projection_mutations (
            id, run_id, operation_id, installation_id, component_key, artifact_id,
            mutation_domain, target, before_hash, after_hash, precondition_json,
            adapter_version, catalog_version, projection_version, selector_schema_version,
            idempotency_strategy, readback_strategy, compensation_precondition,
            planned_mutation_json, state, attempt_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(
          mutation.journal.id,
          input.runId,
          mutation.operationId,
          input.installationId,
          mutation.plannedMutation.componentKey,
          artifact.artifactId,
          mutation.mutationDomain,
          mutation.plannedMutation.physicalTarget,
          mutation.journal.beforeFingerprint,
          mutation.journal.desiredFingerprint,
          JSON.stringify({
            selectorHash: mutation.plannedMutation.preconditionHash ?? null,
            containerHash: mutation.plannedMutation.containerPreconditionHash ?? null,
          }),
          input.preparedPlan.adapterPlan.adapterVersion,
          String(input.preparedPlan.executionPlan.catalogVersion),
          input.preparedPlan.adapterPlan.projectionVersion,
          String(mutation.plannedMutation.selectorSchemaVersion),
          artifact.effectDisposition === 'consumer_detach'
            ? 'consumer_detach_only'
            : mutation.plannedMutation.idempotent ? 'readback_exact_then_replay' : 'never_replay',
          'adapter_readback',
          mutation.journal.compensationPrecondition,
          JSON.stringify(mutation.plannedMutation),
          journal.state,
          input.createdAt,
          input.createdAt,
        )
        persistedMutations.push({
          ...mutation,
          journal,
          effectDisposition: artifact.effectDisposition,
        })
      }

      this.db.prepare(`
        UPDATE agent_installations
        SET desired_state = ?, desired_capability = ?, consent_envelope_id = ?, consented_at = ?,
            reconcile_state = 'planning', status_reason = NULL,
            tombstoned_at = CASE
              WHEN ? = 'removed' THEN COALESCE(tombstoned_at, ?)
              WHEN ? THEN NULL ELSE tombstoned_at END,
            tombstone_reason = CASE
              WHEN ? = 'removed' THEN 'user_disconnect'
              WHEN ? THEN NULL ELSE tombstone_reason END,
            verified_capability = CASE WHEN ? THEN 0 ELSE verified_capability END,
            verification_summary = CASE WHEN ? THEN 'unverified' ELSE verification_summary END,
            verification_result_id = CASE WHEN ? THEN NULL ELSE verification_result_id END,
            updated_at = ?
        WHERE id = ?
      `).run(
        input.intentAfterPrepare,
        input.desiredCapability,
        input.consentId,
        input.createdAt,
        input.intentAfterPrepare,
        input.createdAt,
        reconnectFromRemoved ? 1 : 0,
        input.intentAfterPrepare,
        reconnectFromRemoved ? 1 : 0,
        reconnectFromRemoved ? 1 : 0,
        reconnectFromRemoved ? 1 : 0,
        reconnectFromRemoved ? 1 : 0,
        input.createdAt,
        input.installationId,
      )
      if (reconnectFromRemoved) {
        this.repository.recordEvent({
          installationId: input.installationId,
          kind: 'installation_explicitly_reopened',
          severity: 'info',
          dedupeKey: `${input.installationId}:reopened:${input.createdAt}`,
          payload: { runId: input.runId },
          createdAt: input.createdAt,
        })
      }
      return { mutations: persistedMutations }
    }).immediate()
  }

  saveMutation(runId: string, mutation: MutationJournalRecord): MutationJournalRecord {
    const timestampColumn = mutationTimestampColumn(mutation.state)
    const timestampAssignment = timestampColumn ? `, ${timestampColumn} = ?` : ''
    const allowedPredecessors = mutationStatePredecessors(mutation.state)
    if (allowedPredecessors.length === 0) {
      throw new Error(`mutation state has no legal predecessor: ${mutation.state}`)
    }
    const predecessorPlaceholders = allowedPredecessors.map(() => '?').join(',')
    const values: unknown[] = [
      mutation.state,
      mutation.attemptCount,
      mutation.postEffectFingerprint,
      mutation.compensationPrecondition,
      mutation.receiptJson,
      mutation.failureCode,
      mutation.failureStage,
      mutation.updatedAt,
    ]
    if (timestampColumn) values.push(mutation.updatedAt)
    values.push(mutation.id, runId, mutation.journalVersion, ...allowedPredecessors)
    const result = this.db.prepare(`
      UPDATE projection_mutations
      SET state = ?, attempt_count = MAX(attempt_count, ?),
          post_effect_fingerprint = COALESCE(post_effect_fingerprint, ?),
          compensation_precondition = COALESCE(compensation_precondition, ?),
          apply_receipt_json = COALESCE(apply_receipt_json, ?), failure_code = ?,
          failure_stage = ?, updated_at = ?, journal_version = journal_version + 1${timestampAssignment}
      WHERE id = ? AND run_id = ? AND journal_version = ?
        AND state NOT IN ('committed','compensated')
        AND state IN (${predecessorPlaceholders})
    `).run(...values)
    if (result.changes !== 1) {
      const terminal = this.db.prepare(`
        SELECT state, journal_version FROM projection_mutations
        WHERE id = ? AND run_id = ?
      `).get(mutation.id, runId) as { state: string; journal_version: number } | undefined
      // A duplicate recovery may hold a stale journal after another worker has
      // already reached a terminal state. Terminal evidence is monotonic: keep
      // it and make the stale persistence attempt an idempotent no-op.
      if (terminal?.state === 'committed' || terminal?.state === 'compensated') {
        return { ...mutation, state: terminal.state, journalVersion: terminal.journal_version }
      }
      if (terminal) {
        if (terminal.journal_version === mutation.journalVersion) {
          throw new Error(
            `invalid mutation journal transition: ${mutation.id} ${terminal.state} -> ${mutation.state}`,
          )
        }
        throw new Error(
          `stale mutation journal version: ${mutation.id} expected ${mutation.journalVersion}, current ${terminal.journal_version}`,
        )
      }
      throw new Error(`unknown persisted mutation: ${mutation.id}`)
    }

    if (mutation.state === 'committed') {
      this.db.prepare(`
        UPDATE managed_artifacts
        SET owned_fragment_hash = CASE
              WHEN (SELECT after_hash FROM projection_mutations WHERE id = ?) IS NULL THEN owned_fragment_hash
              ELSE (SELECT after_hash FROM projection_mutations WHERE id = ?)
            END,
            observed_fragment_hash = ?, last_applied_at = ?, updated_at = ?
        WHERE id = (SELECT artifact_id FROM projection_mutations WHERE id = ?)
      `).run(mutation.id, mutation.id, mutation.postEffectFingerprint, mutation.updatedAt, mutation.updatedAt, mutation.id)
    }
    return { ...mutation, journalVersion: mutation.journalVersion + 1 }
  }

  claimMutationEffect(input: {
    runId: string
    mutationId: string
    installation: CoordinatorInstallation
    consentId: string
    expectedDesiredState: 'managed' | 'removed'
    claimedAt: string
  }): boolean {
    const result = this.db.prepare(`
      UPDATE projection_mutations
      SET effect_started_at = COALESCE(effect_started_at, ?), updated_at = ?
      WHERE id = ? AND run_id = ? AND state = 'effect_started'
        AND EXISTS (
          SELECT 1
          FROM reconcile_runs r
          JOIN agent_installations i ON i.id = r.installation_id
          JOIN agent_consents c ON c.id = r.consent_envelope_id
          WHERE r.id = projection_mutations.run_id
            AND r.state = 'applying'
            AND r.consent_envelope_id = ?
            AND c.status = 'active'
            AND i.id = ?
            AND i.install_key = ?
            AND i.agent_id = ?
            AND i.host_variant = ?
            AND i.consent_envelope_id = ?
            AND i.desired_state = ?
            AND i.health_state = 'discovered'
            AND COALESCE(i.status_reason, '') != 'conflict'
            AND (
              (? = 'managed' AND i.tombstoned_at IS NULL)
              OR (? = 'removed' AND i.tombstoned_at IS NOT NULL)
            )
        )
    `).run(
      input.claimedAt,
      input.claimedAt,
      input.mutationId,
      input.runId,
      input.consentId,
      input.installation.id,
      input.installation.identity.installKey,
      input.installation.agentId,
      input.installation.identity.hostVariant,
      input.consentId,
      input.expectedDesiredState,
      input.expectedDesiredState,
      input.expectedDesiredState,
    )
    return result.changes === 1
  }

  revalidateClaimedMutationEffect(input: {
    runId: string
    mutationId: string
    installation: CoordinatorInstallation
    consentId: string
    expectedDesiredState: 'managed' | 'removed'
  }): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM projection_mutations mutation
      JOIN reconcile_runs run ON run.id = mutation.run_id
      JOIN agent_installations installation ON installation.id = run.installation_id
      JOIN agent_consents consent ON consent.id = run.consent_envelope_id
      WHERE mutation.id = ? AND mutation.run_id = ?
        AND mutation.state = 'effect_started' AND mutation.effect_started_at IS NOT NULL
        AND run.state = 'applying' AND run.consent_envelope_id = ?
        AND consent.installation_id = installation.id AND consent.status = 'active'
        AND installation.id = ? AND installation.install_key = ?
        AND installation.agent_id = ? AND installation.host_variant = ?
        AND installation.consent_envelope_id = ?
        AND installation.desired_state = ?
        AND installation.health_state = 'discovered'
        AND COALESCE(installation.status_reason, '') != 'conflict'
        AND (
          (? = 'managed' AND installation.tombstoned_at IS NULL)
          OR (? = 'removed' AND installation.tombstoned_at IS NOT NULL)
        )
      LIMIT 1
    `).get(
      input.mutationId,
      input.runId,
      input.consentId,
      input.installation.id,
      input.installation.identity.installKey,
      input.installation.agentId,
      input.installation.identity.hostVariant,
      input.consentId,
      input.expectedDesiredState,
      input.expectedDesiredState,
      input.expectedDesiredState,
    ))
  }

  setRunState(
    runId: string,
    state: Parameters<CoordinatorRepositoryPort['setRunState']>[1],
    updatedAt: string,
    failure?: { code: string; stage: string },
  ): void {
    let finalizationRejection: string | null = null
    this.db.transaction(() => {
      if (state === 'committed') {
        const currentRun = this.db.prepare(`
          SELECT state, installation_id FROM reconcile_runs WHERE id = ?
        `).get(runId) as { state: string; installation_id: string | null } | undefined
        if (currentRun?.state === 'verified') {
          const unfinished = this.db.prepare(`
            SELECT 1
            FROM projection_mutations pm
            WHERE pm.run_id = ? AND pm.state NOT IN ('committed','compensated')
            LIMIT 1
          `).get(runId)
          if (unfinished) throw new Error(`verified run has unfinished mutation: ${runId}`)
          finalizationRejection = this.verificationFinalizationProblem(runId, updatedAt)
        }
        if (finalizationRejection && currentRun?.state === 'verified') {
          const run = this.db.prepare(`
            SELECT installation_id FROM reconcile_runs WHERE id = ? AND state = 'verified'
          `).get(runId) as { installation_id: string | null } | undefined
          this.db.prepare(`
            UPDATE reconcile_runs
            SET state = 'cancelled', failure_code = 'verification_evidence_stale',
                failure_stage = 'finalization', completed_at = ?, updated_at = ?
            WHERE id = ? AND state = 'verified'
          `).run(updatedAt, updatedAt, runId)
          if (run?.installation_id) {
            this.db.prepare(`
              UPDATE agent_installations
              SET reconcile_state = 'needs_recovery', status_reason = 'verification_stale',
                  updated_at = ?
              WHERE id = ? AND reconcile_state != 'paused'
                AND health_state = 'discovered' AND COALESCE(status_reason, '') != 'conflict'
            `).run(updatedAt, run.installation_id)
          }
          return
        }
      }
      const allowedPreviousStates = reconcileRunPreviousStates(state)
      const statePlaceholders = allowedPreviousStates.map(() => '?').join(',')
      const result = this.db.prepare(`
        UPDATE reconcile_runs
        SET state = ?, failure_code = ?, failure_stage = ?,
            started_at = CASE WHEN ? = 'applying' THEN COALESCE(started_at, ?) ELSE started_at END,
            completed_at = CASE WHEN ? IN ('applied_unverified','committed','needs_recovery','cancelled') THEN ? ELSE completed_at END,
            updated_at = ?
        WHERE id = ? AND state IN (${statePlaceholders})
      `).run(
        state,
        failure?.code ?? null,
        failure?.stage ?? null,
        state,
        updatedAt,
        state,
        updatedAt,
        updatedAt,
        runId,
        ...allowedPreviousStates,
      )
      if (result.changes !== 1) throw new Error(`invalid reconcile run transition to ${state}: ${runId}`)

      if (state === 'applied_unverified') this.markProjectionApplied(runId, updatedAt)
      if (state === 'needs_recovery') this.markProjectionNeedsRecovery(runId, updatedAt)
      if (state === 'committed') this.finalizeRun(runId, updatedAt)
    }).immediate()
    if (finalizationRejection) {
      throw new Error(`verification evidence is not current at finalization: ${finalizationRejection}`)
    }
  }

  private verificationFinalizationProblem(runId: string, at: string): string | null {
    const run = this.db.prepare(`
      SELECT installation_id, operation_type, consent_envelope_id, prepared_plan_json
      FROM reconcile_runs WHERE id = ? AND state = 'verified'
    `).get(runId) as {
      installation_id: string | null
      operation_type: string
      consent_envelope_id: string | null
      prepared_plan_json: string
    } | undefined
    if (!run?.installation_id || !run.consent_envelope_id) return 'run_control_missing'
    let componentKeys: ComponentKey[]
    let installationSurfaceFingerprint: string | null
    try {
      componentKeys = persistedComponentKeys(run.prepared_plan_json)
      const preparedPlan = parseObject(run.prepared_plan_json, 'prepared plan') as unknown as PreparedCoordinatorPlan
      installationSurfaceFingerprint = frozenPlanInstallationSurfaceFingerprint(preparedPlan)
    } catch {
      return 'prepared_plan_invalid'
    }
    const currentInstallation = this.repository.getInstallation(run.installation_id)
    if (!installationSurfaceFingerprint || !currentInstallation
      || installationSurfaceFingerprint !== persistedProjectionSurfaceFingerprint(currentInstallation)) {
      return 'installation_surface_changed'
    }
    const currentControl = this.db.prepare(`
      SELECT 1
      FROM agent_installations installation
      JOIN agent_consents consent ON consent.id = installation.consent_envelope_id
      WHERE installation.id = ? AND installation.consent_envelope_id = ?
        AND consent.installation_id = installation.id AND consent.status = 'active'
        AND installation.agent_id IS NOT NULL
        AND installation.health_state = 'discovered'
        AND COALESCE(installation.status_reason, '') != 'conflict'
        AND (
          (? = 'disconnect' AND installation.desired_state = 'removed'
            AND installation.tombstoned_at IS NOT NULL)
          OR (? != 'disconnect' AND installation.desired_state = 'managed'
            AND installation.tombstoned_at IS NULL)
        )
    `).get(
      run.installation_id,
      run.consent_envelope_id,
      run.operation_type,
      run.operation_type,
    )
    if (!currentControl) return 'run_control_changed'
    const componentPlaceholders = componentKeys.map(() => '?').join(',')
    const outOfScopeMutation = this.db.prepare(`
      SELECT 1 FROM projection_mutations
      WHERE run_id = ?
        AND (component_key IS NULL OR component_key NOT IN (${componentPlaceholders}))
      LIMIT 1
    `).get(runId, ...componentKeys)
    if (outOfScopeMutation) return 'mutation_scope_changed'
    const unboundPendingConsumer = this.db.prepare(`
      SELECT 1
      FROM artifact_consumers consumer
      WHERE consumer.installation_id = ?
        AND consumer.component_key IN (${componentPlaceholders})
        AND consumer.state = 'removal_pending'
        AND (
          consumer.desired_state != 'removal_pending'
          OR consumer.tombstoned_at IS NULL
          OR consumer.consent_envelope_id IS NOT ?
          OR NOT EXISTS (
            SELECT 1 FROM installation_components component
            WHERE component.installation_id = consumer.installation_id
              AND component.component_key = consumer.component_key
              AND component.artifact_id = consumer.artifact_id
              AND component.desired_state = 'removed'
              AND component.tombstoned_at IS NOT NULL
              AND component.consent_envelope_id = ?
          )
          OR (
            EXISTS (
              SELECT 1 FROM projection_mutations scoped
              WHERE scoped.run_id = ? AND scoped.component_key = consumer.component_key
            )
            AND NOT EXISTS (
              SELECT 1 FROM projection_mutations mutation
              WHERE mutation.run_id = ?
                AND mutation.installation_id = consumer.installation_id
                AND mutation.component_key = consumer.component_key
                AND mutation.artifact_id = consumer.artifact_id
                AND mutation.state = 'committed'
            )
          )
        )
      LIMIT 1
    `).get(
      run.installation_id,
      ...componentKeys,
      run.consent_envelope_id,
      run.consent_envelope_id,
      runId,
      runId,
    )
    if (unboundPendingConsumer) return 'consumer_scope_changed'
    const detachBindings = this.db.prepare(`
      SELECT mutation.id,
        CASE WHEN mutation.installation_id = ?
          AND mutation.artifact_id IS NOT NULL
          AND mutation.idempotency_strategy = 'consumer_detach_only'
          AND mutation.state = 'committed'
          AND EXISTS (
            SELECT 1
            FROM artifact_consumers consumer
            JOIN installation_components component
              ON component.installation_id = consumer.installation_id
             AND component.component_key = consumer.component_key
             AND component.artifact_id = consumer.artifact_id
            JOIN managed_artifacts artifact ON artifact.id = consumer.artifact_id
            WHERE consumer.artifact_id = mutation.artifact_id
              AND consumer.installation_id = mutation.installation_id
              AND consumer.component_key = mutation.component_key
              AND consumer.state = 'removal_pending'
              AND consumer.desired_state = 'removal_pending'
              AND consumer.tombstoned_at IS NOT NULL
              AND consumer.consent_envelope_id = ?
              AND component.desired_state = 'removed'
              AND component.tombstoned_at IS NOT NULL
              AND component.consent_envelope_id = ?
              AND artifact.state IN ('healthy','removal_pending')
          ) THEN 1 ELSE 0 END AS exact_binding
      FROM projection_mutations mutation
      WHERE mutation.run_id = ? AND mutation.component_key = ?
    `)
    for (const componentKey of componentKeys) {
      const bindings = detachBindings.all(
        run.installation_id,
        run.consent_envelope_id,
        run.consent_envelope_id,
        runId,
        componentKey,
      ) as Array<{ id: string; exact_binding: number }>
      if (run.operation_type === 'disconnect'
        && bindings.length > 0
        && bindings.every(binding => binding.exact_binding === 1)) continue
      const current = this.db.prepare(`
        SELECT 1
        FROM reconcile_runs r
        JOIN agent_installations i ON i.id = r.installation_id
        JOIN agent_consents consent ON consent.id = r.consent_envelope_id
        JOIN installation_components component
          ON component.installation_id = i.id AND component.component_key = ?
        JOIN verification_results evidence
          ON evidence.id = component.verification_result_id
        LEFT JOIN managed_artifacts artifact ON artifact.id = component.artifact_id
        WHERE r.id = ? AND r.state = 'verified'
          AND i.id = ? AND i.consent_envelope_id = r.consent_envelope_id
          AND consent.status = 'active'
          AND i.health_state = 'discovered' AND COALESCE(i.status_reason, '') != 'conflict'
          AND (
            (r.operation_type = 'disconnect' AND i.desired_state = 'removed' AND i.tombstoned_at IS NOT NULL)
            OR (r.operation_type != 'disconnect' AND i.desired_state = 'managed' AND i.tombstoned_at IS NULL)
          )
          AND evidence.run_id = r.id AND evidence.installation_id = i.id
          AND evidence.component_key = component.component_key
          AND evidence.result = 'verified' AND evidence.invalidated_at IS NULL
          AND (evidence.expires_at IS NULL OR evidence.expires_at > ?)
          AND evidence.identity_assertion IS NOT NULL
          AND evidence.identity_assertion = i.agent_id
          AND evidence.family = i.family AND evidence.host_variant = i.host_variant
          AND evidence.runtime_realm = i.runtime_realm
          AND evidence.artifact_hash IS artifact.observed_fragment_hash
          AND component.verification_status = 'verified'
      `).get(componentKey, runId, run.installation_id, at)
      if (!current) return `component:${componentKey}`
    }
    return null
  }

  acquireWriterFence(mutationDomain: string): WriterFenceLease | null {
    const osLock = this.acquireOsLock(mutationDomain)
    if (!osLock) return null
    const now = this.now()
    const claim = this.repository.claimWriterFence({
      mutationDomain,
      writerProtocol: AGENT_INTEGRATION_WRITER_PROTOCOL,
      writerGeneration: WRITER_GENERATION,
      ownerInstanceId: this.ownerInstanceId,
      nowMs: now.getTime(),
      leaseDurationMs: this.leaseDurationMs,
      nowIso: now.toISOString(),
      metadata: { source: 'managed_agent_coordinator' },
    })
    if (!claim.acquired || !claim.fence) {
      osLock.release()
      return null
    }
    const epoch = claim.fence.epoch
    let heartbeatFailed = false
    const heartbeat = setInterval(() => {
      const at = this.now()
      try {
        heartbeatFailed = !this.repository.renewWriterFence({
          mutationDomain,
          writerProtocol: AGENT_INTEGRATION_WRITER_PROTOCOL,
          ownerInstanceId: this.ownerInstanceId,
          epoch,
          nowMs: at.getTime(),
          leaseDurationMs: this.leaseDurationMs,
          nowIso: at.toISOString(),
        })
        if (!heartbeatFailed) osLock.touch(at)
      } catch {
        heartbeatFailed = true
      }
    }, Math.max(1_000, Math.floor(this.leaseDurationMs / 3)))
    heartbeat.unref?.()
    return {
      epoch,
      writerGeneration: WRITER_GENERATION,
      assertOwned: () => {
        if (heartbeatFailed) throw new Error(`writer fence heartbeat failed: ${mutationDomain}`)
        osLock.assertOwned()
        const current = this.repository.getWriterFence(mutationDomain)
        if (!current
          || current.state !== 'active'
          || current.owner_instance_id !== this.ownerInstanceId
          || current.epoch !== epoch
          || (current.lease_expires_at ?? 0) <= this.now().getTime()) {
          throw new Error(`writer fence lost: ${mutationDomain}`)
        }
      },
      release: () => {
        clearInterval(heartbeat)
        try {
          if (!this.repository.releaseWriterFence({
            mutationDomain,
            ownerInstanceId: this.ownerInstanceId,
            epoch,
            nowIso: this.now().toISOString(),
          })) throw new Error(`writer fence release failed: ${mutationDomain}`)
        } finally {
          osLock.release()
        }
      },
    }
  }

  private acquireOsLock(mutationDomain: string): {
    assertOwned(): void
    touch(at: Date): void
    release(): void
  } | null {
    const lockDirectoryStat = ensurePrivateLockDirectory(
      this.lockDirectory,
      this.lockDirectoryTrustRoot,
    )
    const lockPath = path.join(this.lockDirectory, `${sha256Json(mutationDomain)}.lock`)
    const ownerToken = randomUUID()
    const open = (): { fd: number; stat: fs.Stats } | null => {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600)
        const createdStat = fs.fstatSync(fd)
        try {
          fs.writeFileSync(fd, JSON.stringify({
            owner: this.ownerInstanceId,
            ownerToken,
            pid: process.pid,
            processStartIdentity: this.processStartIdentity,
            mutationDomain,
          }))
          fs.fsyncSync(fd)
          return { fd, stat: createdStat }
        } catch (error) {
          try { fs.closeSync(fd) } catch { /* Preserve the primary write failure. */ }
          try {
            if (sameFile(createdStat, fs.statSync(lockPath))) fs.unlinkSync(lockPath)
          } catch { /* A failed creation remains unavailable. */ }
          throw error
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        return null
      }
    }
    let opened = open()
    if (opened === null) {
      const fence = this.repository.getWriterFence(mutationDomain)
      let stale = false
      let existing: OsLockSnapshot | null = null
      try {
        existing = readOsLockSnapshot(lockPath)
        const ageMs = this.now().getTime() - existing.stat.mtimeMs
        stale = ageMs > this.leaseDurationMs * 2
          && (!fence || fence.state !== 'active' || (fence.lease_expires_at ?? 0) <= this.now().getTime())
          && existing.owner.mutationDomain === mutationDomain
          && osLockOwnerProvenDead(existing.owner)
      } catch {
        // An unreadable lock cannot be proven stale, so acquisition remains blocked.
      }
      if (!stale || !existing || !quarantineExactStaleOsLock(lockPath, existing)) return null
      opened = open()
      if (opened === null) return null
    }
    const { fd, stat: acquiredStat } = opened
    let released = false
    const assertPathOwned = (): void => {
      if (released || !osLockPathMatches(
        lockPath,
        acquiredStat,
        ownerToken,
        mutationDomain,
        this.lockDirectory,
        this.lockDirectoryTrustRoot,
        lockDirectoryStat,
      )) {
        throw new Error(`OS writer lock lost: ${mutationDomain}`)
      }
    }
    return {
      assertOwned: assertPathOwned,
      touch: at => {
        if (!released) {
          assertPathOwned()
          fs.futimesSync(fd, at, at)
        }
      },
      release: () => {
        if (released) return
        released = true
        let closeError: unknown
        try {
          fs.closeSync(fd)
        } catch (error) {
          closeError = error
        }
        let unlinkError: unknown
        try {
          if (osLockPathMatches(
            lockPath,
            acquiredStat,
            ownerToken,
            mutationDomain,
            this.lockDirectory,
            this.lockDirectoryTrustRoot,
            lockDirectoryStat,
          )) fs.unlinkSync(lockPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unlinkError = error
        }
        // Cleanup must not replace the primary close failure with a secondary
        // unlink failure. This also avoids control flow escaping from `finally`.
        if (closeError) throw closeError
        if (unlinkError) throw unlinkError
      },
    }
  }

  recordVerification(input: {
    runId: string
    installation: CoordinatorInstallation
    result: ComponentVerificationResult
    adapterVersion: string
    catalogVersion: string
    tideMindVersion?: string
    projectionVersion: string
    expectedHostVersion: string | null
    verifiedAt: string
  }): void {
    this.db.transaction(() => {
    const authorization = this.db.prepare(`
      SELECT r.operation_type, r.prepared_plan_json
      FROM reconcile_runs r
      JOIN agent_installations i ON i.id = r.installation_id
      JOIN agent_consents c ON c.id = r.consent_envelope_id
      WHERE r.id = ? AND r.state = 'applied_unverified'
        AND i.id = ? AND i.install_key = ? AND i.agent_id = ? AND i.host_variant = ?
        AND i.health_state = 'discovered' AND COALESCE(i.status_reason, '') != 'conflict'
        AND c.status = 'active' AND i.consent_envelope_id = c.id
        AND i.detected_version IS ?
        AND (
          (r.operation_type = 'disconnect' AND i.desired_state = 'removed' AND i.tombstoned_at IS NOT NULL)
          OR (r.operation_type != 'disconnect' AND i.desired_state = 'managed' AND i.tombstoned_at IS NULL)
        )
    `).get(
      input.runId,
      input.installation.id,
      input.installation.identity.installKey,
      input.installation.agentId,
      input.installation.identity.hostVariant,
      input.expectedHostVersion,
    )
    if (!authorization) throw new Error('verification authorization changed before evidence commit')
    const result = input.result
    if (result.status === 'verified'
      && result.invalidationKeys.includes('tide_mind_version')
      && !input.tideMindVersion?.trim()) {
      throw new Error('host activity verification requires a Tide Mind version binding')
    }
    if (result.status === 'verified' && result.identityAssertion !== input.installation.agentId) {
      throw new Error('verification identity assertion does not match the prepared Installation')
    }
    if (!persistedComponentKeys(String((authorization as { prepared_plan_json: string }).prepared_plan_json))
      .includes(result.componentKey)) {
      throw new Error('verification result is outside persisted plan scope')
    }
    if (result.status === 'verified' || result.status === 'failed') {
      const artifact = this.db.prepare(`
        SELECT a.observed_fragment_hash
        FROM installation_components c
        LEFT JOIN managed_artifacts a ON a.id = c.artifact_id
        WHERE c.installation_id = ? AND c.component_key = ?
      `).get(input.installation.id, result.componentKey) as
        | { observed_fragment_hash: string | null }
        | undefined
      const verification = {
        runId: input.runId,
        installationId: input.installation.id,
        componentKey: result.componentKey,
        family: input.installation.identity.productFamilyId,
        hostVariant: input.installation.identity.hostVariant,
        distributionId: input.installation.identity.distribution.distributionId,
        runtimeRealm: input.installation.identity.runtimeRealm,
        hostVersion: input.expectedHostVersion,
        osVersion: os.release(),
        tideMindVersion: input.tideMindVersion ?? null,
        adapterVersion: input.adapterVersion,
        catalogVersion: input.catalogVersion,
        projectionVersion: input.projectionVersion,
        selectorSchemaVersion: String(maxSelectorVersionForComponent(input.runId, result.componentKey, this.db)),
        verificationManifestVersion: '1',
        method: result.diagnostics.join(',') || 'adapter_verification',
        identityAssertion: result.identityAssertion,
        artifactHash: artifact?.observed_fragment_hash ?? null,
        reloadGeneration: result.reloadGeneration,
        invalidationKeys: result.invalidationKeys,
        result: result.status,
        evidenceRef: result.evidenceRef,
        evidenceHash: result.evidenceHash ?? sha256Json({
          componentKey: result.componentKey,
          status: result.status,
          diagnostics: result.diagnostics,
        }),
        verifiedAt: input.verifiedAt,
        expiresAt: result.expiresAt,
      }
      const existing = this.db.prepare(`
        SELECT id, installation_id, component_key, family, host_variant, distribution_id,
               runtime_realm, host_version, os_version, tide_mind_version,
               adapter_version, catalog_version,
               projection_version, selector_schema_version, verification_manifest_version,
               method, identity_assertion, artifact_hash, reload_generation,
               invalidation_keys_json, result, evidence_ref, evidence_hash,
               verified_at, expires_at, invalidated_at,
               invalidation_reason
        FROM verification_results WHERE run_id = ? AND component_key = ?
      `).get(input.runId, result.componentKey) as Record<string, unknown> | undefined
      const expectedReplay = {
        installation_id: verification.installationId,
        component_key: verification.componentKey,
        family: verification.family,
        host_variant: verification.hostVariant,
        distribution_id: verification.distributionId ?? null,
        runtime_realm: verification.runtimeRealm,
        host_version: verification.hostVersion ?? null,
        os_version: verification.osVersion ?? null,
        tide_mind_version: verification.tideMindVersion ?? null,
        adapter_version: verification.adapterVersion,
        catalog_version: verification.catalogVersion,
        projection_version: verification.projectionVersion ?? null,
        selector_schema_version: verification.selectorSchemaVersion ?? null,
        verification_manifest_version: verification.verificationManifestVersion,
        method: verification.method,
        identity_assertion: verification.identityAssertion ?? null,
        artifact_hash: verification.artifactHash ?? null,
        reload_generation: verification.reloadGeneration ?? null,
        invalidation_keys_json: JSON.stringify(verification.invalidationKeys),
        result: verification.result,
        evidence_ref: verification.evidenceRef ?? null,
        evidence_hash: verification.evidenceHash,
        verified_at: verification.verifiedAt,
        expires_at: verification.expiresAt ?? null,
      }
      if (existing) {
        const existingId = existing.id
        const invalidatedAt = existing.invalidated_at
        const existingReplay = { ...existing }
        delete existingReplay.id
        delete existingReplay.invalidated_at
        delete existingReplay.invalidation_reason
        if (invalidatedAt !== null || existing.result === 'failed') {
          this.db.prepare(`
            UPDATE verification_results
            SET run_id = NULL,
                invalidated_at = COALESCE(invalidated_at, ?),
                invalidation_reason = COALESCE(invalidation_reason, 'verification_retry_superseded')
            WHERE id = ?
          `).run(input.verifiedAt, existingId)
          this.repository.recordVerificationResult({
            id: this.id('verification'),
            ...verification,
          })
        } else if (sha256Json(existingReplay) !== sha256Json(expectedReplay)) {
          throw new Error(`verification evidence changed during retry: ${result.componentKey}`)
        }
      } else {
        this.repository.recordVerificationResult({
          id: this.id('verification'),
          ...verification,
        })
      }
    } else {
      this.db.prepare(`
        UPDATE installation_components
        SET verification_status = ?, visibility_state = CASE
              WHEN ? = 'unverified' THEN 'dedicated' ELSE visibility_state END,
            updated_at = ?
        WHERE installation_id = ? AND component_key = ?
      `).run(result.status, result.status, input.verifiedAt, input.installation.id, result.componentKey)
    }
    this.refreshInstallationVerification(input.installation.id, input.verifiedAt)
    }).immediate()
  }

  recordVerificationBatch(inputs: readonly Parameters<SqliteCoordinatorRepository['recordVerification']>[0][]): void {
    this.db.transaction(() => {
      for (const input of inputs) this.recordVerification(input)
    }).immediate()
  }

  blockVerifiedFinalization(input: {
    runId: string
    installationId: string
    reason: string
    blockedAt: string
  }): void {
    this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE reconcile_runs
        SET state = 'cancelled', failure_code = ?, failure_stage = 'startup_recovery',
            completed_at = ?, updated_at = ?
        WHERE id = ? AND installation_id = ? AND state = 'verified'
      `).run(input.reason, input.blockedAt, input.blockedAt, input.runId, input.installationId)
      if (result.changes !== 1) {
        throw new Error(`verified recovery token changed before trust rejection: ${input.runId}`)
      }
      this.db.prepare(`
        UPDATE agent_installations
        SET reconcile_state = 'needs_recovery', status_reason = ?, updated_at = ?
        WHERE id = ? AND reconcile_state != 'paused'
      `).run(input.reason, input.blockedAt, input.installationId)
    }).immediate()
  }

  listRecoverableExecutions(): readonly RecoverableExecution[] {
    const runs = this.db.prepare(`
      SELECT id, installation_id, operation_type, consent_envelope_id, state,
             prepared_plan_json, desired_capability
      FROM reconcile_runs
      WHERE state IN ('planned','preconditions_checked','applying','applied_unverified','verified','compensating','needs_recovery')
      ORDER BY created_at, id
    `).all() as RunRow[]
    const recoverable: RecoverableExecution[] = []
    for (const run of runs) {
      // A verified run is a finalizer-only token, but its exact frozen trust
      // bindings are still required. Invalid/legacy plans remain non-replayable
      // and are rejected by production recovery plus the atomic finalizer.
      if (run.state === 'verified') {
        let installationSurfaceFingerprint: string | null = null
        let liveTrustProofFingerprint: string | null = null
        try {
          const preparedPlan = parseObject(run.prepared_plan_json, 'prepared plan') as unknown as PreparedCoordinatorPlan
          installationSurfaceFingerprint = frozenPlanInstallationSurfaceFingerprint(preparedPlan)
          liveTrustProofFingerprint = frozenPlanLiveTrustProofFingerprint(preparedPlan)
        } catch {
          // Keep null bindings so recovery fails closed without decoding mutations.
        }
        recoverable.push({
          runId: run.id,
          runState: 'verified',
          installationId: run.installation_id,
          installationSurfaceFingerprint,
          liveTrustProofFingerprint,
        })
        continue
      }
      try {
        const installation = installationFromRow(this.repository.getInstallation(run.installation_id))
        const preparedPlan = parseObject(run.prepared_plan_json, 'prepared plan') as unknown as PreparedCoordinatorPlan
        const mutationRows = this.db.prepare(`
          SELECT id, operation_id, mutation_domain, planned_mutation_json, state,
                 idempotency_strategy, journal_version,
                 attempt_count, before_hash, after_hash, post_effect_fingerprint,
                 compensation_precondition, apply_receipt_json, failure_code,
                 failure_stage, updated_at
          FROM projection_mutations WHERE run_id = ? ORDER BY created_at, id
        `).all(run.id) as MutationRow[]
        recoverable.push({
          runId: run.id,
          runState: normalizeRecoverableState(run.state),
          installation,
          consentId: run.consent_envelope_id,
          desiredCapability: capability(run.desired_capability),
          preparedPlan,
          mutations: mutationRows.map(row => {
            const plannedMutation = parseObject(
              row.planned_mutation_json,
              'planned mutation',
            ) as unknown as PlannedMutation
            return {
              operationId: row.operation_id,
              mutationDomain: row.mutation_domain,
              plannedMutation,
              effectDisposition: row.idempotency_strategy === 'consumer_detach_only'
                ? 'consumer_detach'
                : 'apply',
              journal: {
                id: row.id,
                state: row.state,
                journalVersion: row.journal_version,
                attemptCount: row.attempt_count,
                idempotent: plannedMutation.idempotent === true,
                beforeFingerprint: row.before_hash,
                desiredFingerprint: row.after_hash,
                postEffectFingerprint: row.post_effect_fingerprint,
                compensationPrecondition: row.compensation_precondition,
                receiptJson: row.apply_receipt_json,
                failureCode: row.failure_code,
                failureStage: row.failure_stage,
                updatedAt: row.updated_at,
              },
            }
          }),
        })
      } catch (error) {
        const now = this.now().toISOString()
        this.db.prepare(`
          UPDATE reconcile_runs SET state = 'needs_recovery', failure_code = 'journal_decode_failed',
            failure_stage = 'startup_recovery', updated_at = ? WHERE id = ?
        `).run(now, run.id)
        this.repository.recordEvent({
          installationId: run.installation_id,
          kind: 'reconcile_journal_decode_failed',
          severity: 'error',
          dedupeKey: `${run.id}:journal_decode_failed`,
          payload: { message: error instanceof Error ? error.message : String(error) },
          createdAt: now,
        })
      }
    }
    return recoverable
  }

  recordEvent(event: IntegrationEvent): void {
    this.repository.recordEvent({
      id: event.id,
      installationId: event.installationId,
      componentKey: event.componentKey,
      artifactId: event.artifactId,
      kind: event.kind,
      severity: event.severity,
      episodeId: event.episodeId,
      dedupeKey: event.dedupeKey,
      payload: event.payload,
      createdAt: event.createdAt,
    })
  }

  private upsertDesiredComponent(
    installation: AgentInstallationRow,
    componentKey: ComponentKey,
    desiredState: 'managed' | 'removed',
    desiredCapability: CapabilityLevel,
    consentId: string,
    at: string,
  ): void {
    this.db.prepare(`
      INSERT INTO installation_components (
        installation_id, component_key, desired_state, desired_capability, delivery_mode,
        verification_status, visibility_state, tombstoned_at, tombstone_reason,
        consent_envelope_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'managed', 'unverified', 'unknown', ?, ?, ?, ?, ?)
      ON CONFLICT(installation_id, component_key) DO UPDATE SET
        desired_state = excluded.desired_state,
        desired_capability = excluded.desired_capability,
        verification_status = CASE WHEN excluded.desired_state = 'removed' THEN 'stale' ELSE installation_components.verification_status END,
        tombstoned_at = CASE WHEN excluded.desired_state = 'removed' THEN COALESCE(installation_components.tombstoned_at, excluded.tombstoned_at) ELSE installation_components.tombstoned_at END,
        tombstone_reason = CASE WHEN excluded.desired_state = 'removed' THEN excluded.tombstone_reason ELSE installation_components.tombstone_reason END,
        consent_envelope_id = excluded.consent_envelope_id,
        updated_at = excluded.updated_at
    `).run(
      installation.id,
      componentKey,
      desiredState,
      desiredCapability,
      desiredState === 'removed' ? at : null,
      desiredState === 'removed' ? 'user_disconnect' : null,
      consentId,
      at,
      at,
    )
  }

  private activateOwnedExistingArtifactConsumer(input: PrepareExecutionInput, componentKey: ComponentKey): string {
    const observation = input.preparedPlan.inspection.components.find(component => component.componentKey === componentKey)
    if (!observation?.observedTarget || !observation.observedFragmentHash) {
      throw new Error(`ownership_conflict:${componentKey}_adoption`)
    }
    const installation = this.repository.getInstallation(input.installationId)
    if (!installation) throw new Error(`unknown Installation: ${input.installationId}`)
    let artifact = this.db.prepare(`
      SELECT a.id, a.mutation_domain, a.target_path, a.ownership_key,
             a.selector_schema_version, c.discover_reachability
      FROM artifact_consumers c
      JOIN managed_artifacts a ON a.id = c.artifact_id
      WHERE c.installation_id = ? AND c.component_key = ?
        AND c.state = 'active' AND c.tombstoned_at IS NULL
        AND a.runtime_realm = ? AND a.target_path = ?
        AND a.state IN ('healthy','needs_recovery') AND a.owned_fragment_hash = ?
        AND a.desired_fragment_hash = ?
    `).get(
      input.installationId,
      componentKey,
      installation.runtime_realm,
      observation.observedTarget,
      observation.observedFragmentHash,
      observation.observedFragmentHash,
    ) as {
      id: string
      mutation_domain: string
      target_path: string
      ownership_key: string
      selector_schema_version: number
      discover_reachability: 'dedicated' | 'shared_visible' | 'per_host_ignorable'
    } | undefined

    // A portable Skill can be shared by several hosts.  A new consumer may
    // attach only to a previously proven exact document; MCP/hook/plugin
    // fragments require an Installation-specific migrated consumer baseline.
    if (!artifact && componentKey === 'instruction') artifact = this.db.prepare(`
      SELECT id, mutation_domain, target_path, ownership_key, selector_schema_version,
             'shared_visible' AS discover_reachability FROM managed_artifacts
      WHERE runtime_realm = ? AND target_path = ? AND ownership_key = 'document'
        AND component_type = 'skill' AND state = 'healthy'
        AND owned_fragment_hash = ? AND desired_fragment_hash = ?
    `).get(
      installation.runtime_realm,
      observation.observedTarget,
      observation.observedFragmentHash,
      observation.observedFragmentHash,
    ) as typeof artifact
    if (!artifact && componentKey === 'memory_tools') {
      const relocated = this.db.prepare(`
        SELECT a.id AS previous_id, a.component_type, a.ownership_key,
               a.projection_version, a.selector_schema_version
        FROM artifact_consumers c
        JOIN managed_artifacts a ON a.id = c.artifact_id
        WHERE c.installation_id = ? AND c.component_key = ?
          AND c.state = 'active' AND c.desired_state IN ('managed','disabled')
          AND c.tombstoned_at IS NULL
          AND a.runtime_realm = ? AND a.target_path != ?
          AND a.state IN ('healthy','needs_recovery')
          AND a.owned_fragment_hash = ? AND a.desired_fragment_hash = ?
        ORDER BY a.id
      `).all(
        input.installationId,
        componentKey,
        installation.runtime_realm,
        observation.observedTarget,
        observation.observedFragmentHash,
        observation.observedFragmentHash,
      ) as Array<{
        previous_id: string
        component_type: string
        ownership_key: string
        projection_version: string
        selector_schema_version: string | number
      }>
      if (relocated.length === 1) {
        const previous = relocated[0]
        const artifactId = `artifact_${sha256Json({
          runtimeRealm: installation.runtime_realm,
          target: observation.observedTarget,
          ownershipKey: previous.ownership_key,
        }).slice(0, 32)}`
        const mutationDomain = buildLegacyMutationDomain({
          adapterId: installation.host_variant,
          target: observation.observedTarget,
          selector: 'document',
        })
        this.db.prepare(`
          INSERT INTO managed_artifacts (
            id, runtime_realm, component_type, target_path, ownership_key, mutation_domain,
            projection_version, selector_schema_version, owned_fragment_hash,
            desired_fragment_hash, observed_fragment_hash, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_recovery', ?, ?)
          ON CONFLICT(runtime_realm, target_path, ownership_key) DO NOTHING
        `).run(
          artifactId,
          installation.runtime_realm,
          previous.component_type,
          observation.observedTarget,
          previous.ownership_key,
          mutationDomain,
          previous.projection_version,
          String(previous.selector_schema_version),
          observation.observedFragmentHash,
          observation.observedFragmentHash,
          observation.observedFragmentHash,
          input.createdAt,
          input.createdAt,
        )
        artifact = this.db.prepare(`
          SELECT id, mutation_domain, target_path, ownership_key, selector_schema_version,
                 'dedicated' AS discover_reachability
          FROM managed_artifacts
          WHERE runtime_realm = ? AND target_path = ? AND ownership_key = ?
            AND state = 'needs_recovery' AND owned_fragment_hash = ? AND desired_fragment_hash = ?
        `).get(
          installation.runtime_realm,
          observation.observedTarget,
          previous.ownership_key,
          observation.observedFragmentHash,
          observation.observedFragmentHash,
        ) as typeof artifact
      }
    }
    if (!artifact) throw new Error(`ownership_conflict:${componentKey}_adoption`)

    const consent = this.getConsent(input.consentId)
    const coverage = consent ? checkPlanAgainstConsent(
      input.preparedPlan.executionPlan,
      consent,
      [{
        componentKey,
        artifactKey: `${installation.host_variant}:${componentKey}:${artifact.ownership_key}`,
        targetPath: artifact.target_path,
        ownershipSelector: artifact.ownership_key,
        selectorSchemaVersion: positiveInteger(artifact.selector_schema_version, 'selector schema version'),
        commandCategory: 'file_write',
        risk: 'low',
      }],
    ) : null
    if (!coverage?.allowed || coverage.executionPlanHash !== input.preparedPlan.executionPlanHash) {
      throw new Error(`consent does not cover no-op activation: ${coverage?.reasons.join(',') ?? 'missing'}`)
    }

    this.repository.addArtifactConsumer({
      artifactId: artifact.id,
      installationId: input.installationId,
      componentKey,
      requiredCapability: input.desiredCapability,
      discoverReachability: artifact.discover_reachability,
      consentEnvelopeId: input.consentId,
      ownershipFingerprint: observation.observedFragmentHash,
      allowNeedsRecoveryPending: true,
      addedAt: input.createdAt,
    })
    const previousArtifact = this.db.prepare(`
      SELECT artifact_id FROM installation_components
      WHERE installation_id = ? AND component_key = ?
    `).get(input.installationId, componentKey) as { artifact_id: string | null } | undefined
    if (previousArtifact?.artifact_id && previousArtifact.artifact_id !== artifact.id) {
      this.db.prepare(`
        UPDATE artifact_consumers
        SET desired_state = 'removed', state = 'removed',
            tombstoned_at = COALESCE(tombstoned_at, ?),
            tombstone_reason = 'host_installation_surface_changed',
            removed_at = COALESCE(removed_at, ?), updated_at = ?
        WHERE artifact_id = ? AND installation_id = ? AND component_key = ?
          AND state = 'active' AND tombstoned_at IS NULL
      `).run(
        input.createdAt,
        input.createdAt,
        input.createdAt,
        previousArtifact.artifact_id,
        input.installationId,
        componentKey,
      )
    }
    // A no-mutation activation has no effect journal or live precondition
    // claim. Keep the new consumer disabled (and a migrated Artifact in
    // needs_recovery) until host verification commits this exact run.
    const stagedConsumer = this.db.prepare(`
      UPDATE artifact_consumers SET desired_state = 'disabled', updated_at = ?
      WHERE artifact_id = ? AND installation_id = ? AND component_key = ?
        AND state = 'active' AND consent_envelope_id = ?
    `).run(input.createdAt, artifact.id, input.installationId, componentKey, input.consentId)
    if (stagedConsumer.changes !== 1) {
      throw new Error(`consumer activation could not be staged: ${componentKey}`)
    }
    if (artifact.discover_reachability === 'shared_visible') {
      this.db.prepare(`
        UPDATE artifact_consumers SET discover_reachability = 'shared_visible', updated_at = ?
        WHERE artifact_id = ? AND state = 'active'
      `).run(input.createdAt, artifact.id)
    }
    this.db.prepare(`
      UPDATE installation_components SET artifact_id = ?, visibility_state = ?, updated_at = ?
      WHERE installation_id = ? AND component_key = ?
    `).run(
      artifact.id,
      artifact.discover_reachability === 'shared_visible' ? 'shared_visible' : 'dedicated',
      input.createdAt,
      input.installationId,
      componentKey,
    )
    return artifact.mutation_domain
  }

  private stageAbsentOwnedArtifactConsumer(input: PrepareExecutionInput, componentKey: ComponentKey): string {
    const observation = input.preparedPlan.inspection.components.find(component => component.componentKey === componentKey)
    if (observation?.visibility !== 'absent') {
      throw new Error(`disconnect_noop_requires_absent_readback:${componentKey}`)
    }
    const owned = this.db.prepare(`
      SELECT a.id, a.mutation_domain, a.state
      FROM installation_components ic
      JOIN managed_artifacts a ON a.id = ic.artifact_id
      JOIN artifact_consumers c
        ON c.artifact_id = a.id AND c.installation_id = ic.installation_id
       AND c.component_key = ic.component_key
      WHERE ic.installation_id = ? AND ic.component_key = ?
        AND c.state = 'active' AND c.desired_state IN ('managed','disabled')
        AND c.tombstoned_at IS NULL
    `).get(input.installationId, componentKey) as {
      id: string
      mutation_domain: string
      state: 'healthy' | 'missing' | 'paused' | 'needs_recovery' | 'conflict' | 'removal_pending' | 'removed'
    } | undefined
    if (!owned) throw new Error(`disconnect ownership ledger missing: ${componentKey}`)
    const otherConsumers = this.db.prepare(`
      SELECT COUNT(*) AS count FROM artifact_consumers
      WHERE artifact_id = ? AND installation_id != ?
        AND state = 'active' AND desired_state IN ('managed','disabled') AND tombstoned_at IS NULL
    `).get(owned.id, input.installationId) as { count: number }
    const updated = this.db.prepare(`
      UPDATE artifact_consumers
      SET desired_state = 'removal_pending', state = 'removal_pending',
          tombstoned_at = COALESCE(tombstoned_at, ?), tombstone_reason = 'user_disconnect',
          consent_envelope_id = ?, updated_at = ?
      WHERE artifact_id = ? AND installation_id = ? AND component_key = ?
        AND state = 'active' AND desired_state IN ('managed','disabled')
        AND tombstoned_at IS NULL
    `).run(
      input.createdAt,
      input.consentId,
      input.createdAt,
      owned.id,
      input.installationId,
      componentKey,
    )
    if (updated.changes !== 1) throw new Error(`disconnect consumer missing: ${componentKey}`)
    if (otherConsumers.count > 0) {
      if (owned.state === 'healthy') {
        // Positive absent read-back proves the shared physical Artifact has
        // disappeared for every remaining consumer. Persist the missing edge
        // in the same transaction as the detach so no observer can report a
        // healthy shared Skill after manual deletion.
        this.repository.beginMissingEpisode({
          artifactId: owned.id,
          episodeId: this.id('episode'),
          observedAt: input.createdAt,
        })
      }
      this.db.prepare(`
        UPDATE installation_components SET visibility_state = 'shared_visible', updated_at = ?
        WHERE installation_id = ? AND component_key = ?
      `).run(input.createdAt, input.installationId, componentKey)
    } else {
      this.db.prepare(`
        UPDATE managed_artifacts
        SET state = 'removal_pending', observed_fragment_hash = NULL, updated_at = ?
        WHERE id = ?
      `).run(input.createdAt, owned.id)
    }
    return owned.mutation_domain
  }

  private prepareArtifactAndConsumer(
    input: PrepareExecutionInput,
    mutation: PlannedMutation,
  ): { artifactId: string; effectDisposition: 'apply' | 'consumer_detach' } {
    const installation = this.repository.getInstallation(input.installationId)
    if (!installation) throw new Error(`unknown Installation: ${input.installationId}`)
    const artifactId = `artifact_${sha256Json({
      runtimeRealm: installation.runtime_realm,
      target: mutation.physicalTarget,
      ownershipKey: mutation.ownershipKey,
    }).slice(0, 32)}`
    const existing = this.db.prepare(`
      SELECT id FROM managed_artifacts
      WHERE runtime_realm = ? AND target_path = ? AND ownership_key = ?
    `).get(installation.runtime_realm, mutation.physicalTarget, mutation.ownershipKey) as { id: string } | undefined

    if (input.operation === 'disconnect') {
      if (!existing) throw new Error(`disconnect ownership ledger missing: ${mutation.operationId}`)
      const otherConsumers = this.db.prepare(`
        SELECT COUNT(*) AS count FROM artifact_consumers
        WHERE artifact_id = ? AND installation_id != ?
          AND state = 'active' AND desired_state IN ('managed','disabled') AND tombstoned_at IS NULL
      `).get(existing.id, input.installationId) as { count: number }
      const updated = this.db.prepare(`
        UPDATE artifact_consumers
        SET desired_state = 'removal_pending', state = 'removal_pending',
            tombstoned_at = COALESCE(tombstoned_at, ?), tombstone_reason = 'user_disconnect',
            consent_envelope_id = ?, updated_at = ?
        WHERE artifact_id = ? AND installation_id = ? AND component_key = ?
          AND state = 'active' AND desired_state IN ('managed','disabled')
      `).run(input.createdAt, input.consentId, input.createdAt, existing.id, input.installationId, mutation.componentKey)
      if (updated.changes !== 1) throw new Error(`disconnect consumer missing: ${mutation.operationId}`)
      if (otherConsumers.count > 0) {
        this.db.prepare(`
          UPDATE installation_components
          SET visibility_state = 'shared_visible', updated_at = ?
          WHERE installation_id = ? AND component_key = ?
        `).run(input.createdAt, input.installationId, mutation.componentKey)
        return { artifactId: existing.id, effectDisposition: 'consumer_detach' }
      }
      this.db.prepare(`UPDATE managed_artifacts SET state = 'removal_pending', updated_at = ? WHERE id = ?`)
        .run(input.createdAt, existing.id)
      return { artifactId: existing.id, effectDisposition: 'apply' }
    }

    const componentType = artifactTypeFor(mutation)
    this.db.prepare(`
      INSERT INTO managed_artifacts (
        id, runtime_realm, component_type, target_path, ownership_key, mutation_domain,
        projection_version, selector_schema_version, container_precondition_hash,
        owned_fragment_hash, desired_fragment_hash, observed_fragment_hash,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_recovery', ?, ?)
      ON CONFLICT(runtime_realm, target_path, ownership_key) DO UPDATE SET
        mutation_domain = excluded.mutation_domain,
        projection_version = excluded.projection_version,
        selector_schema_version = excluded.selector_schema_version,
        container_precondition_hash = excluded.container_precondition_hash,
        desired_fragment_hash = excluded.desired_fragment_hash,
        updated_at = excluded.updated_at
    `).run(
      artifactId,
      installation.runtime_realm,
      componentType,
      mutation.physicalTarget,
      mutation.ownershipKey,
      input.mutations.find(candidate => candidate.operationId === mutation.operationId)!.mutationDomain,
      input.preparedPlan.adapterPlan.projectionVersion,
      String(mutation.selectorSchemaVersion),
      mutation.containerPreconditionHash ?? null,
      mutation.preconditionHash ?? null,
      mutation.desiredFragmentHash ?? null,
      mutation.preconditionHash ?? null,
      input.createdAt,
      input.createdAt,
    )
    const resolvedId = existing?.id ?? artifactId
    const previousComponent = this.db.prepare(`
      SELECT artifact_id FROM installation_components
      WHERE installation_id = ? AND component_key = ?
    `).get(input.installationId, mutation.componentKey) as { artifact_id: string | null } | undefined
    if (previousComponent?.artifact_id && previousComponent.artifact_id !== resolvedId) {
      // A stable host identity may move to a different config root.  The old
      // projection remains an auditable Artifact, but this Installation must
      // stop consuming it before verification is rebound to the new target.
      this.db.prepare(`
        UPDATE artifact_consumers
        SET desired_state = 'removed', state = 'removed',
            tombstoned_at = COALESCE(tombstoned_at, ?),
            tombstone_reason = 'host_installation_surface_changed',
            removed_at = COALESCE(removed_at, ?), updated_at = ?
        WHERE artifact_id = ? AND installation_id = ? AND component_key = ?
          AND state = 'active' AND tombstoned_at IS NULL
      `).run(
        input.createdAt,
        input.createdAt,
        input.createdAt,
        previousComponent.artifact_id,
        input.installationId,
        mutation.componentKey,
      )
    }
    this.db.prepare(`
      UPDATE installation_components
      SET artifact_id = ?, verification_status = 'stale', verification_result_id = NULL,
          visibility_state = 'unknown', updated_at = ?
      WHERE installation_id = ? AND component_key = ?
    `).run(resolvedId, input.createdAt, input.installationId, mutation.componentKey)
    this.db.prepare(`
      INSERT INTO artifact_consumers (
        artifact_id, installation_id, component_key, required_capability, desired_state,
        discover_reachability, consent_envelope_id, state, added_at, updated_at
      ) VALUES (?, ?, ?, ?, 'managed', 'dedicated', ?, 'active', ?, ?)
      ON CONFLICT(artifact_id, installation_id, component_key) DO UPDATE SET
        required_capability = excluded.required_capability,
        desired_state = 'managed',
        consent_envelope_id = excluded.consent_envelope_id,
        state = 'active',
        tombstoned_at = NULL,
        tombstone_reason = NULL,
        removed_at = NULL,
        updated_at = excluded.updated_at
    `).run(
      resolvedId,
      input.installationId,
      mutation.componentKey,
      input.desiredCapability,
      input.consentId,
      input.createdAt,
      input.createdAt,
    )
    return { artifactId: resolvedId, effectDisposition: 'apply' }
  }

  private markProjectionApplied(runId: string, at: string): void {
    this.db.prepare(`
      UPDATE managed_artifacts
      SET state = CASE WHEN state = 'removal_pending' THEN state ELSE 'healthy' END,
          observed_fragment_hash = desired_fragment_hash,
          owned_fragment_hash = desired_fragment_hash,
          last_applied_at = ?, updated_at = ?
      WHERE id IN (SELECT artifact_id FROM projection_mutations WHERE run_id = ?)
        AND id NOT IN (
          SELECT artifact_id FROM projection_mutations
          WHERE run_id = ? AND idempotency_strategy = 'consumer_detach_only'
        )
    `).run(at, at, runId, runId)
    this.db.prepare(`
      UPDATE installation_components
      SET visibility_state = CASE
            WHEN EXISTS (
              SELECT 1 FROM projection_mutations pm
              WHERE pm.run_id = ? AND pm.component_key = installation_components.component_key
                AND pm.idempotency_strategy = 'consumer_detach_only'
            ) THEN 'shared_visible'
            WHEN desired_state = 'removed' THEN 'absent'
            ELSE 'dedicated'
          END,
          updated_at = ?
      WHERE installation_id = (SELECT installation_id FROM reconcile_runs WHERE id = ?)
        AND component_key IN (SELECT component_key FROM projection_mutations WHERE run_id = ?)
    `).run(runId, at, runId, runId)
  }

  private markProjectionNeedsRecovery(runId: string, at: string): void {
    this.db.prepare(`
      UPDATE managed_artifacts SET state = 'needs_recovery', updated_at = ?
      WHERE id IN (SELECT artifact_id FROM projection_mutations WHERE run_id = ?)
        AND state != 'removed'
    `).run(at, runId)
  }

  private assertFrozenDisconnectScopes(input: PrepareExecutionInput): void {
    const expectations = input.disconnectScopeExpectations ?? []
    if (expectations.length !== input.preparedPlan.componentKeys.length) {
      throw new Error('disconnect consumer scope no longer matches the approved plan')
    }
    const seenComponents = new Set<ComponentKey>()
    for (const expectation of expectations) {
      if (seenComponents.has(expectation.componentKey)) {
        throw new Error('disconnect consumer scope contains a duplicate component')
      }
      seenComponents.add(expectation.componentKey)
      if (!input.preparedPlan.componentKeys.includes(expectation.componentKey)) {
        throw new Error('disconnect consumer scope contains an unapproved component')
      }
      const mutation = input.preparedPlan.executionPlan.mutations.find(candidate => (
        candidate.componentKey === expectation.componentKey
      ))
      if (mutation && (
        mutation.targetPath !== expectation.physicalTarget
        || mutation.ownershipSelector !== expectation.ownershipKey
      )) {
        throw new Error('disconnect consumer scope target differs from the approved mutation')
      }
      if (!mutation) {
        const observation = input.preparedPlan.inspection.components.find(candidate => (
          candidate.componentKey === expectation.componentKey
        ))
        if (observation?.observedTarget !== expectation.physicalTarget) {
          throw new Error('disconnect consumer scope target differs from approved read-back')
        }
      }
      const artifact = this.db.prepare(`
        SELECT a.id
        FROM agent_installations i
        JOIN managed_artifacts a ON a.runtime_realm = i.runtime_realm
        JOIN artifact_consumers own
          ON own.artifact_id = a.id AND own.installation_id = i.id
         AND own.component_key = ?
        WHERE i.id = ? AND a.target_path = ? AND a.ownership_key = ?
          AND a.state NOT IN ('removed','conflict')
          AND own.state = 'active' AND own.desired_state IN ('managed','disabled')
          AND own.tombstoned_at IS NULL
      `).get(
        expectation.componentKey,
        input.installationId,
        expectation.physicalTarget,
        expectation.ownershipKey,
      ) as { id: string } | undefined
      if (!artifact) throw new Error('disconnect consumer scope no longer exists')
      const consumerKeys = (this.db.prepare(`
        SELECT installation_id, component_key FROM artifact_consumers
        WHERE artifact_id = ? AND state = 'active'
          AND desired_state IN ('managed','disabled') AND tombstoned_at IS NULL
        ORDER BY installation_id, component_key
      `).all(artifact.id) as Array<{ installation_id: string; component_key: string }>)
        .map(row => `${row.installation_id}\0${row.component_key}`)
      if (sha256Json(consumerKeys) !== sha256Json([...expectation.consumerKeys].sort())) {
        throw new Error('disconnect consumer scope changed after confirmation; preview again')
      }
    }
  }

  private finalizeRun(runId: string, at: string): void {
    const run = this.db.prepare(`
      SELECT installation_id, operation_type, consent_envelope_id, prepared_plan_json
      FROM reconcile_runs WHERE id = ?
    `).get(runId) as {
      installation_id: string
      operation_type: string
      consent_envelope_id: string
      prepared_plan_json: string
    } | undefined
    if (!run) throw new Error(`unknown run: ${runId}`)
    const componentKeys = persistedComponentKeys(run.prepared_plan_json)
    const componentPlaceholders = componentKeys.map(() => '?').join(',')
    if (run.operation_type === 'disconnect') {
      this.db.prepare(`
        UPDATE artifact_consumers AS consumer
        SET desired_state = 'removed', state = 'removed', removed_at = ?, updated_at = ?
        WHERE consumer.installation_id = ? AND consumer.state = 'removal_pending'
          AND consumer.consent_envelope_id = ?
          AND EXISTS (
            SELECT 1
            FROM projection_mutations mutation
            JOIN installation_components component
              ON component.installation_id = mutation.installation_id
             AND component.component_key = mutation.component_key
             AND component.artifact_id = mutation.artifact_id
            WHERE mutation.run_id = ?
              AND mutation.installation_id = consumer.installation_id
              AND mutation.component_key = consumer.component_key
              AND mutation.artifact_id = consumer.artifact_id
              AND mutation.idempotency_strategy = 'consumer_detach_only'
              AND mutation.state = 'committed'
              AND component.desired_state = 'removed'
              AND component.tombstoned_at IS NOT NULL
              AND component.consent_envelope_id = ?
          )
      `).run(
        at,
        at,
        run.installation_id,
        run.consent_envelope_id,
        runId,
        run.consent_envelope_id,
      )
      // Physical removal and already-absent no-op components also close one
      // exact current-consent consumer, but never through the detach exception.
      this.db.prepare(`
        UPDATE artifact_consumers AS consumer
        SET desired_state = 'removed', state = 'removed', removed_at = ?, updated_at = ?
        WHERE consumer.installation_id = ? AND consumer.state = 'removal_pending'
          AND consumer.consent_envelope_id = ?
          AND EXISTS (
            SELECT 1 FROM installation_components component
            WHERE component.installation_id = consumer.installation_id
              AND component.component_key = consumer.component_key
              AND component.artifact_id = consumer.artifact_id
              AND component.desired_state = 'removed'
              AND component.tombstoned_at IS NOT NULL
              AND component.consent_envelope_id = ?
          )
          AND (
            EXISTS (
              SELECT 1 FROM projection_mutations mutation
              WHERE mutation.run_id = ?
                AND mutation.installation_id = consumer.installation_id
                AND mutation.component_key = consumer.component_key
                AND mutation.artifact_id = consumer.artifact_id
                AND mutation.idempotency_strategy != 'consumer_detach_only'
                AND mutation.state = 'committed'
            )
            OR (
              consumer.component_key IN (${componentPlaceholders})
              AND NOT EXISTS (
                SELECT 1 FROM projection_mutations scoped
                WHERE scoped.run_id = ? AND scoped.component_key = consumer.component_key
              )
            )
          )
      `).run(
        at,
        at,
        run.installation_id,
        run.consent_envelope_id,
        run.consent_envelope_id,
        runId,
        ...componentKeys,
        runId,
      )
      // An already-absent projection produces no host mutation.  Its consumer
      // was still staged above and disconnect verification proved the target
      // absent; close the physical ledger after the last consumer is gone.
      this.db.prepare(`
        UPDATE managed_artifacts
        SET state = 'removed', observed_fragment_hash = NULL,
            owned_fragment_hash = NULL, last_verified_at = ?, updated_at = ?
        WHERE state = 'removal_pending'
          AND id IN (
            SELECT artifact_id FROM artifact_consumers
            WHERE installation_id = ? AND state = 'removed' AND removed_at = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM artifact_consumers c
            WHERE c.artifact_id = managed_artifacts.id
              AND c.state IN ('active','removal_pending')
          )
      `).run(at, at, run.installation_id, at)
      this.db.prepare(`
        UPDATE managed_artifacts SET state = 'removed', observed_fragment_hash = NULL,
          owned_fragment_hash = NULL, last_verified_at = ?, updated_at = ?
        WHERE id IN (SELECT artifact_id FROM projection_mutations WHERE run_id = ?)
          AND id NOT IN (
            SELECT artifact_id FROM projection_mutations
            WHERE run_id = ? AND idempotency_strategy = 'consumer_detach_only'
          )
          AND NOT EXISTS (
            SELECT 1 FROM artifact_consumers c
            WHERE c.artifact_id = managed_artifacts.id
              AND c.state IN ('active','removal_pending')
          )
      `).run(at, at, runId, runId)
      // Disconnect runs may finalize in either order. A detach finalizer must
      // close a prior physical-removal reservation once every consumer is gone,
      // but only when a committed non-detach removal mutation proves the effect.
      this.db.prepare(`
        UPDATE managed_artifacts
        SET state = 'removed', observed_fragment_hash = NULL,
            owned_fragment_hash = NULL, last_verified_at = ?, updated_at = ?
        WHERE id IN (SELECT artifact_id FROM projection_mutations WHERE run_id = ?)
          AND state = 'removal_pending'
          AND NOT EXISTS (
            SELECT 1 FROM artifact_consumers c
            WHERE c.artifact_id = managed_artifacts.id
              AND c.state IN ('active','removal_pending')
          )
          AND EXISTS (
            SELECT 1 FROM projection_mutations proof
            WHERE proof.artifact_id = managed_artifacts.id
              AND proof.idempotency_strategy != 'consumer_detach_only'
              AND proof.state = 'committed'
              AND proof.after_hash IS NULL
          )
      `).run(at, at, runId)
      const sharedVisibilityRemaining = this.db.prepare(`
        SELECT 1
        FROM installation_components ic
        JOIN managed_artifacts a ON a.id = ic.artifact_id
        WHERE ic.installation_id = ?
          AND ic.component_key IN (${componentPlaceholders})
          AND ic.visibility_state = 'shared_visible'
          AND a.state NOT IN ('removed','conflict')
        LIMIT 1
      `).get(run.installation_id, ...componentKeys) !== undefined
      this.db.prepare(`
        UPDATE agent_installations SET
          reconcile_state = CASE WHEN health_state = 'discovered' THEN 'idle' ELSE 'paused' END,
          status_reason = CASE WHEN health_state = 'discovered' THEN ? ELSE status_reason END,
          verified_capability = 0, verification_summary = 'unverified', last_verified_at = ?, updated_at = ?
        WHERE id = ?
          AND desired_state = 'removed' AND tombstoned_at IS NOT NULL
          AND consent_envelope_id = ?
      `).run(
        sharedVisibilityRemaining ? 'shared_visibility_remaining' : 'disconnect_verified',
        at,
        at,
        run.installation_id,
        run.consent_envelope_id,
      )
      // A later physical-removal finalizer can eliminate the residual visibility
      // previously reported by another Installation's detach-only run.
      this.db.prepare(`
        UPDATE agent_installations
        SET status_reason = 'disconnect_verified', updated_at = ?
        WHERE desired_state = 'removed' AND tombstoned_at IS NOT NULL
          AND status_reason = 'shared_visibility_remaining'
          AND NOT EXISTS (
            SELECT 1 FROM installation_components ic
            JOIN managed_artifacts a ON a.id = ic.artifact_id
            WHERE ic.installation_id = agent_installations.id
              AND ic.visibility_state = 'shared_visible'
              AND a.state NOT IN ('removed','conflict')
          )
      `).run(at)
    } else {
      // No-mutation activations stay disabled until verification reaches the
      // committed finalizer. Guard promotion by the exact current consent so
      // an older run cannot revive a consumer after pause/reconnect.
      this.db.prepare(`
        UPDATE managed_artifacts
        SET state = 'healthy', observed_fragment_hash = owned_fragment_hash,
            last_verified_at = ?, updated_at = ?
        WHERE id IN (
          SELECT c.artifact_id FROM artifact_consumers c
          JOIN agent_installations i ON i.id = c.installation_id
          WHERE c.installation_id = ? AND c.state = 'active'
            AND c.desired_state = 'disabled' AND c.consent_envelope_id = ?
            AND c.component_key IN (${componentPlaceholders})
            AND i.desired_state = 'managed' AND i.tombstoned_at IS NULL
            AND i.consent_envelope_id = ?
            AND i.health_state = 'discovered' AND COALESCE(i.status_reason, '') != 'conflict'
        ) AND state = 'needs_recovery'
      `).run(
        at,
        at,
        run.installation_id,
        run.consent_envelope_id,
        ...componentKeys,
        run.consent_envelope_id,
      )
      this.db.prepare(`
        UPDATE artifact_consumers
        SET desired_state = 'managed', updated_at = ?
        WHERE installation_id = ? AND state = 'active'
          AND desired_state = 'disabled' AND consent_envelope_id = ?
          AND component_key IN (${componentPlaceholders})
          AND EXISTS (
            SELECT 1 FROM agent_installations i
            WHERE i.id = artifact_consumers.installation_id
              AND i.desired_state = 'managed' AND i.tombstoned_at IS NULL
              AND i.consent_envelope_id = ?
              AND i.health_state = 'discovered' AND COALESCE(i.status_reason, '') != 'conflict'
          )
      `).run(
        at,
        run.installation_id,
        run.consent_envelope_id,
        ...componentKeys,
        run.consent_envelope_id,
      )
      const stillAuthorized = this.db.prepare(`
        SELECT 1 FROM agent_installations i
        JOIN agent_consents c ON c.id = i.consent_envelope_id
        WHERE i.id = ? AND i.consent_envelope_id = ? AND c.status = 'active'
          AND i.desired_state = 'managed' AND i.tombstoned_at IS NULL
          AND i.health_state = 'discovered' AND COALESCE(i.status_reason, '') != 'conflict'
      `).get(run.installation_id, run.consent_envelope_id)
      if (stillAuthorized) this.refreshInstallationVerification(run.installation_id, at)
      this.db.prepare(`
        UPDATE agent_installations SET reconcile_state = 'idle', status_reason = NULL, updated_at = ?
        WHERE id = ? AND desired_state = 'managed' AND tombstoned_at IS NULL
          AND health_state = 'discovered' AND COALESCE(status_reason, '') != 'conflict'
          AND consent_envelope_id = ?
          AND EXISTS (
            SELECT 1 FROM agent_consents c
            WHERE c.id = ? AND c.status = 'active'
          )
      `).run(at, run.installation_id, run.consent_envelope_id, run.consent_envelope_id)
    }
  }

  private refreshInstallationVerification(installationId: string, at: string): void {
    const eligible = this.db.prepare(`
      SELECT 1
      FROM agent_installations i
      JOIN agent_consents c ON c.id = i.consent_envelope_id AND c.status = 'active'
      WHERE i.id = ? AND i.desired_state = 'managed' AND i.tombstoned_at IS NULL
        AND i.health_state = 'discovered' AND COALESCE(i.status_reason, '') != 'conflict'
    `).get(installationId)
    if (!eligible) return
    const rows = this.db.prepare(`
      SELECT component_key, verification_status FROM installation_components
      WHERE installation_id = ? AND desired_state = 'managed'
    `).all(installationId) as Array<{ component_key: ComponentKey; verification_status: string }>
    const statuses = new Set(rows.map(row => row.verification_status))
    const verified = new Set(rows.filter(row => row.verification_status === 'verified').map(row => row.component_key))
    const capability: CapabilityLevel = verified.has('instruction') && verified.has('memory_tools') && verified.has('lifecycle')
      ? 4
      : verified.has('instruction') && verified.has('memory_tools')
        ? 3
        : verified.has('memory_tools')
          ? 2
          : verified.has('instruction')
            ? 1
            : 0
    const summary = rows.length === 0
      ? 'unverified'
      : statuses.size === 1
        ? normalizeVerificationSummary([...statuses][0])
        : 'mixed'
    this.db.prepare(`
      UPDATE agent_installations
      SET verified_capability = ?, verification_summary = ?,
          last_verified_at = CASE WHEN ? = 'verified' THEN ? ELSE last_verified_at END,
          updated_at = ? WHERE id = ?
    `).run(capability, summary, summary, at, at, installationId)
  }
}

function mutationStatePredecessors(
  state: MutationJournalRecord['state'],
): readonly MutationJournalRecord['state'][] {
  if (state === 'effect_started') return ['prepared', 'effect_started', 'needs_recovery']
  if (state === 'effect_observed') return ['prepared', 'effect_started', 'effect_observed', 'needs_recovery']
  if (state === 'receipt_persisted') return ['effect_observed', 'receipt_persisted']
  if (state === 'verified') return ['receipt_persisted', 'verified', 'needs_recovery']
  if (state === 'committed') return ['verified']
  if (state === 'compensating') return ['needs_recovery', 'compensating']
  if (state === 'compensated') return ['compensating']
  if (state === 'needs_recovery') {
    return [
      'prepared', 'effect_started', 'effect_observed', 'receipt_persisted',
      'verified', 'compensating', 'needs_recovery',
    ]
  }
  return []
}

interface OsLockOwner {
  owner: string
  ownerToken: string
  pid: number
  processStartIdentity: string | null
  mutationDomain: string
}

function parseOsLockOwner(raw: string): OsLockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<OsLockOwner>
    if (typeof value.owner !== 'string' || !value.owner
      || typeof value.ownerToken !== 'string' || !value.ownerToken
      || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) < 1
      || (value.processStartIdentity !== null && typeof value.processStartIdentity !== 'string')
      || typeof value.mutationDomain !== 'string' || !value.mutationDomain) return null
    return value as OsLockOwner
  } catch {
    return null
  }
}

function processStartIdentity(pid: number): string | null {
  try {
    const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }).trim().replace(/\s+/gu, ' ')
    return output || null
  } catch {
    return null
  }
}

interface OsLockSnapshot {
  owner: OsLockOwner
  stat: fs.Stats
}

function readOsLockSnapshot(lockPath: string): OsLockSnapshot {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
  const fd = fs.openSync(lockPath, fs.constants.O_RDONLY | noFollow)
  try {
    const stat = fs.fstatSync(fd)
    const pathStat = fs.lstatSync(lockPath)
    const owner = parseOsLockOwner(fs.readFileSync(fd, 'utf8'))
    if (!stat.isFile() || pathStat.isSymbolicLink() || !sameFile(stat, pathStat)
      || !secureOwnerAndMode(stat, 0o077) || !owner) {
      throw new Error('invalid OS writer lock')
    }
    return { owner, stat }
  } finally {
    fs.closeSync(fd)
  }
}

function ensurePrivateLockDirectory(lockDirectory: string, trustRoot: string): fs.Stats {
  const relative = path.relative(trustRoot, lockDirectory)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`OS writer lock directory escapes trusted root: ${lockDirectory}`)
  }
  const segments = relative === '' ? [] : relative.split(path.sep)
  let current = trustRoot
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) {
      current = path.join(current, segments[index - 1])
      try {
        fs.mkdirSync(current, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const stat = fs.lstatSync(current)
    const isLeaf = index === segments.length
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || !secureOwnerAndMode(stat, isLeaf ? 0o077 : 0o022)) {
      throw new Error(`insecure OS writer lock directory ancestor: ${current}`)
    }
  }
  const stat = fs.lstatSync(lockDirectory)
  const canonical = fs.realpathSync(lockDirectory)
  const expectedCanonical = path.resolve(fs.realpathSync(trustRoot), relative)
  if (path.resolve(canonical) !== expectedCanonical) {
    throw new Error(`non-canonical OS writer lock directory: ${lockDirectory}`)
  }
  return stat
}

function secureOwnerAndMode(stat: fs.Stats, forbiddenMode: number): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  return (uid === null || stat.uid === uid) && (stat.mode & forbiddenMode) === 0
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameOsLockOwner(left: OsLockOwner, right: OsLockOwner): boolean {
  return left.owner === right.owner
    && left.ownerToken === right.ownerToken
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.mutationDomain === right.mutationDomain
}

function osLockPathMatches(
  lockPath: string,
  acquiredStat: fs.Stats,
  ownerToken: string,
  mutationDomain: string,
  lockDirectory: string,
  trustRoot: string,
  acquiredDirectoryStat: fs.Stats,
): boolean {
  try {
    const currentDirectoryStat = ensurePrivateLockDirectory(lockDirectory, trustRoot)
    if (!sameFile(acquiredDirectoryStat, currentDirectoryStat)) return false
    const current = readOsLockSnapshot(lockPath)
    return sameFile(acquiredStat, current.stat)
      && current.owner.ownerToken === ownerToken
      && current.owner.mutationDomain === mutationDomain
  } catch {
    return false
  }
}

/**
 * Rename first, then validate the exact inode and owner token that were judged
 * stale. A second stale cleaner can no longer unlink a successor based on an
 * observation of the predecessor; a mismatched successor is restored and the
 * contender fails closed.
 */
function quarantineExactStaleOsLock(lockPath: string, expected: OsLockSnapshot): boolean {
  const quarantinePath = `${lockPath}.stale-${randomUUID()}`
  try {
    fs.renameSync(lockPath, quarantinePath)
  } catch {
    return false
  }
  try {
    const moved = readOsLockSnapshot(quarantinePath)
    const exact = sameFile(moved.stat, expected.stat) && sameOsLockOwner(moved.owner, expected.owner)
    if (exact) return true

    // The path was replaced after the stale observation. Restore that exact
    // successor with an exclusive hard link when the public path is still free.
    try { fs.linkSync(quarantinePath, lockPath) } catch { /* A newer owner wins. */ }
    return false
  } finally {
    try { fs.unlinkSync(quarantinePath) } catch { /* Quarantine cleanup is best effort. */ }
  }
}

function osLockOwnerProvenDead(owner: OsLockOwner): boolean {
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
  const firstLiveStartIdentity = processStartIdentity(owner.pid)
  if (owner.processStartIdentity === null
    || firstLiveStartIdentity === null
    || owner.processStartIdentity === firstLiveStartIdentity) return false

  // A textual process-start probe is external to the lock protocol and can
  // transiently misreport under host pressure. PID reuse is only proven after
  // two stable, matching observations of the replacement process. Any drift or
  // probe failure remains fail-closed and can be retried by a later reconcile.
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
  const secondLiveStartIdentity = processStartIdentity(owner.pid)
  return secondLiveStartIdentity !== null
    && firstLiveStartIdentity === secondLiveStartIdentity
    && owner.processStartIdentity !== secondLiveStartIdentity
}

function installationFromRow(row: AgentInstallationRow | undefined): CoordinatorInstallation {
  if (!row?.agent_id || !row.config_root) throw new Error('recoverable Installation identity is incomplete')
  return {
    id: row.id,
    displayName: row.display_alias ?? row.display_name,
    desiredState: row.desired_state,
    agentId: row.agent_id,
    identity: {
      runtimeRealm: row.runtime_realm as CoordinatorInstallation['identity']['runtimeRealm'],
      osUserIdentity: row.os_user_identity ?? 'local-user',
      productFamilyId: row.family,
      hostVariant: row.host_variant as CatalogId,
      canonicalConfigRoot: row.config_root,
      componentConfigFiles: persistedComponentConfigFiles(row),
      explicitProfile: row.profile_id || 'default',
      hostOwnedIdentity: persistedHostOwnedIdentity(row),
      distribution: persistedDistribution(row),
      installKey: row.install_key,
    },
  }
}

function normalizeRecoverableState(state: RunRow['state']): MutableRecoverableExecution['runState'] {
  return state === 'compensating' ? 'compensating'
    : state === 'applied_unverified' ? 'applied_unverified'
      : state === 'needs_recovery' ? 'needs_recovery'
        : 'applying'
}

function persistedComponentKeys(preparedPlanJson: string): ComponentKey[] {
  const plan = parseObject(preparedPlanJson, 'prepared plan')
  const keys = plan.componentKeys
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every(key => (
    key === 'instruction' || key === 'memory_tools' || key === 'lifecycle'
  ))) {
    throw new Error('invalid prepared plan component keys')
  }
  const unique = [...new Set(keys)] as ComponentKey[]
  if (unique.length !== keys.length) throw new Error('duplicate prepared plan component keys')
  return unique
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`invalid ${label}`)
  return parsed as Record<string, unknown>
}

function stringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) return []
  return parsed
}

function stringRecord(value: string, label: string): Record<string, string> {
  const parsed = parseObject(value, label)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== 'string') throw new Error(`invalid ${label}`)
    result[key] = item
  }
  return result
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`invalid ${label}`)
  return parsed
}

function assertCapability(value: number): asserts value is CapabilityLevel {
  if (!Number.isInteger(value) || value < 0 || value > 4) throw new Error(`invalid capability: ${value}`)
}

function capability(value: number): CapabilityLevel {
  assertCapability(value)
  return value
}

function maxSelectorVersion(plan: PreparedCoordinatorPlan): number {
  return Math.max(1, ...plan.executionPlan.mutations.map(mutation => mutation.selectorSchemaVersion))
}

function maxSelectorVersionForComponent(runId: string, componentKey: ComponentKey, db: Database.Database): number {
  const row = db.prepare(`
    SELECT MAX(CAST(selector_schema_version AS INTEGER)) AS version
    FROM projection_mutations WHERE run_id = ? AND component_key = ?
  `).get(runId, componentKey) as { version: number | null }
  return row.version ?? 1
}

function artifactTypeFor(mutation: PlannedMutation): 'skill' | 'mcp' | 'hook' | 'plugin' | 'rule' {
  const metadataType = mutation.metadata?.artifactType
  if (metadataType === 'skill' || metadataType === 'mcp' || metadataType === 'hook'
    || metadataType === 'plugin' || metadataType === 'rule') return metadataType
  if (mutation.componentKey === 'memory_tools') return 'mcp'
  if (mutation.componentKey === 'lifecycle') return 'hook'
  return 'skill'
}

function mutationTimestampColumn(state: MutationJournalRecord['state']): string | null {
  if (state === 'effect_started') return 'effect_started_at'
  if (state === 'effect_observed') return 'effect_observed_at'
  if (state === 'receipt_persisted') return 'receipt_persisted_at'
  if (state === 'verified') return 'verified_at'
  if (state === 'committed') return 'committed_at'
  return null
}

function reconcileRunPreviousStates(
  state: Parameters<CoordinatorRepositoryPort['setRunState']>[1],
): readonly string[] {
  if (state === 'preconditions_checked') return ['planned']
  if (state === 'applying') return ['planned', 'preconditions_checked', 'applying', 'needs_recovery']
  if (state === 'applied_unverified') return ['applying', 'needs_recovery']
  if (state === 'verified') return ['applied_unverified']
  if (state === 'committed') return ['verified']
  if (state === 'needs_recovery') {
    return ['planned', 'preconditions_checked', 'applying', 'applied_unverified', 'compensating', 'needs_recovery']
  }
  if (state === 'cancelled') {
    return ['planned', 'preconditions_checked', 'applying', 'applied_unverified', 'compensating', 'needs_recovery']
  }
  return []
}

function normalizeVerificationSummary(value: string): string {
  return ['unverified', 'verifying', 'verified', 'stale', 'failed'].includes(value) ? value : 'mixed'
}

function componentDisplayName(componentKey: ComponentKey): string {
  if (componentKey === 'instruction') return 'Skill/指令'
  if (componentKey === 'memory_tools') return 'MCP 记忆工具'
  return '生命周期 Hook'
}
