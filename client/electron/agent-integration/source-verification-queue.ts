import type Database from 'better-sqlite3'
import { createLogger } from '@server/utils/logger.js'
import {
  NPM_OFFICIAL_VERIFIER_VERSION,
  createSqliteNpmOfficialVerificationCache,
  verifyNpmOfficialDistribution,
  type NpmOfficialVerificationCache,
  type NpmOfficialVerificationResult,
} from './npm-official-verification.js'
import type {
  SourceVerificationKey,
  SourceVerificationStore,
  SourceVerifier,
} from './runtime-compatibility.js'
import type { CatalogId } from './types.js'

const log = createLogger('agent-source-verification')

/** Synchronous view of cached npm official verifications for runtime decisions. */
export function createNpmSourceVerificationStore(cache: NpmOfficialVerificationCache): SourceVerificationStore {
  return {
    lookup(key) {
      try {
        const record = cache.get({
          distributionId: key.distributionId,
          packageProvenance: key.packageProvenance,
          version: key.version,
          architecture: key.architecture,
          localPortableArtifactFingerprint: key.portableArtifactFingerprint,
          verifierVersion: NPM_OFFICIAL_VERIFIER_VERSION,
        })
        return record ? { status: record.status, checkedAt: record.checkedAt } : null
      } catch {
        // A cache read failure never grants trust.
        return null
      }
    },
  }
}

export interface SourceVerificationProgress {
  state: 'queued' | 'checking' | 'verified' | 'mismatch' | 'unavailable' | 'unsupported' | 'stopped'
  reason?: string
  retryAt?: number
}

export interface SourceVerificationRetryResult {
  status: 'started' | 'in_progress' | 'throttled' | 'unsupported' | 'not_needed' | 'stopped'
  retryAt?: number
}

export interface BackgroundSourceVerifierOptions {
  cache: NpmOfficialVerificationCache
  /** Called after a verification produced a durable verified/mismatch result. */
  onResult: () => void
  /** Invalidate presentation even when no rescan is needed. */
  onProgress?: () => void
  verify?: typeof verifyNpmOfficialDistribution
  now?: () => number
  /** Do not retry an unavailable (offline/timeout/…) key before this delay. */
  retryAfterUnavailableMs?: number
}

/**
 * Background official-source verification (A-WP2 integration). The scanner only
 * enqueues; downloads of up to hundreds of MB run one at a time outside the scan,
 * and a completed durable result triggers a rescan so the runtime decision picks it
 * up. Duplicate keys coalesce; an unavailable result backs off instead of looping.
 */
export class BackgroundSourceVerifier {
  private readonly queue: Array<SourceVerificationKey & { catalogId: CatalogId }> = []
  private readonly queued = new Set<string>()
  private readonly backoffUntil = new Map<string, number>()
  private readonly progress = new Map<string, SourceVerificationProgress>()
  private readonly manualRetryAt = new Map<string, number>()
  private activeController: AbortController | null = null
  private running = false
  private stopped = false

  constructor(private readonly options: BackgroundSourceVerifierOptions) {}

  readonly enqueue: SourceVerifier = async key => {
    if (this.stopped) return
    const id = keyId(key)
    const now = (this.options.now ?? Date.now)()
    if (this.queued.has(id) || this.progress.get(id)?.state === 'unsupported' || (this.backoffUntil.get(id) ?? 0) > now) return
    this.queued.add(id)
    this.queue.push(key)
    this.setProgress(id, { state: 'queued' })
    void this.drain()
  }

  status(key: SourceVerificationKey): SourceVerificationProgress | null {
    return this.stopped ? { state: 'stopped' } : this.progress.get(keyId(key)) ?? null
  }

  async retry(key: SourceVerificationKey & { catalogId: CatalogId }): Promise<SourceVerificationRetryResult> {
    if (this.stopped) return { status: 'stopped' }
    const id = keyId(key)
    if (this.queued.has(id)) return { status: 'in_progress' }
    const state = this.progress.get(id)?.state
    if (state === 'unsupported' || state === 'mismatch') return { status: 'unsupported' }
    if (state === 'verified') return { status: 'not_needed' }
    const now = (this.options.now ?? Date.now)()
    const retryAt = this.manualRetryAt.get(id) ?? 0
    if (retryAt > now) return { status: 'throttled', retryAt }
    this.manualRetryAt.set(id, now + 10_000)
    this.backoffUntil.delete(id)
    await this.enqueue(key)
    return { status: 'started' }
  }

  stop(): void {
    this.stopped = true
    this.activeController?.abort(new Error('source_verification_stopped'))
    this.queue.length = 0
    this.queued.clear()
  }

  private setProgress(id: string, progress: SourceVerificationProgress): void {
    this.progress.set(id, progress)
    try { this.options.onProgress?.() } catch { /* Presentation cannot interrupt verification. */ }
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.stopped && this.queue.length > 0) {
        const key = this.queue.shift()!
        const id = keyId(key)
        const controller = new AbortController()
        this.activeController = controller
        this.setProgress(id, { state: 'checking' })
        let result: NpmOfficialVerificationResult
        try {
          result = await (this.options.verify ?? verifyNpmOfficialDistribution)({
            catalogId: key.catalogId,
            distributionId: key.distributionId,
            packageProvenance: key.packageProvenance,
            version: key.version,
            architecture: key.architecture,
            localPortableArtifactFingerprint: key.portableArtifactFingerprint,
          }, {
            signal: controller.signal,
            cache: {
              get: key => this.options.cache.get(key),
              put: record => { if (!this.stopped && !controller.signal.aborted) this.options.cache.put(record) },
            },
          })
        } catch (error) {
          if (this.stopped) return
          log.warn(`official source verification failed for ${key.catalogId}: ${(error as Error).message}`)
          result = { status: 'unavailable', reason: 'protocol', checkedAt: new Date().toISOString() }
        } finally {
          this.queued.delete(id)
          this.activeController = null
        }
        if (this.stopped) return
        if (result.status === 'unavailable') {
          const now = (this.options.now ?? Date.now)()
          const retryAt = now + (this.options.retryAfterUnavailableMs ?? 30 * 60_000)
          this.backoffUntil.set(id, retryAt)
          this.setProgress(id, { state: 'unavailable', reason: result.reason, retryAt })
        } else {
          this.setProgress(id, { state: result.status, ...('reason' in result ? { reason: result.reason } : {}) })
        }
        if (result.status === 'verified' || result.status === 'mismatch') {
          if (result.status === 'mismatch') {
            log.warn(`local ${key.catalogId} ${key.version} does not match the official registry package`)
          }
          try {
            this.options.onResult()
          } catch {
            // Rescan scheduling is best effort; the next periodic scan picks it up.
          }
        }
      }
    } finally {
      this.running = false
    }
  }
}

export function createProductionSourceVerification(
  db: Database.Database,
  onResult: () => void,
  onProgress?: () => void,
): { store: SourceVerificationStore; verifier: BackgroundSourceVerifier } {
  const cache = createSqliteNpmOfficialVerificationCache(db)
  return {
    store: createNpmSourceVerificationStore(cache),
    verifier: new BackgroundSourceVerifier({ cache, onResult, onProgress }),
  }
}

function keyId(key: SourceVerificationKey): string {
  return [
    key.distributionId,
    key.packageProvenance,
    key.version,
    key.architecture,
    key.portableArtifactFingerprint,
  ].join('\u0000')
}
