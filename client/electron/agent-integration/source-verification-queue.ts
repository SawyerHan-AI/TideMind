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

export interface BackgroundSourceVerifierOptions {
  cache: NpmOfficialVerificationCache
  /** Called after a verification produced a durable verified/mismatch result. */
  onResult: () => void
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
  private running = false
  private stopped = false

  constructor(private readonly options: BackgroundSourceVerifierOptions) {}

  readonly enqueue: SourceVerifier = async key => {
    if (this.stopped) return
    const id = keyId(key)
    const now = (this.options.now ?? Date.now)()
    if (this.queued.has(id) || (this.backoffUntil.get(id) ?? 0) > now) return
    this.queued.add(id)
    this.queue.push(key)
    void this.drain()
  }

  stop(): void {
    this.stopped = true
    this.queue.length = 0
    this.queued.clear()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.stopped && this.queue.length > 0) {
        const key = this.queue.shift()!
        const id = keyId(key)
        let result: NpmOfficialVerificationResult
        try {
          result = await (this.options.verify ?? verifyNpmOfficialDistribution)({
            catalogId: key.catalogId,
            distributionId: key.distributionId,
            packageProvenance: key.packageProvenance,
            version: key.version,
            architecture: key.architecture,
            localPortableArtifactFingerprint: key.portableArtifactFingerprint,
          }, { cache: this.options.cache })
        } catch (error) {
          log.warn(`official source verification failed for ${key.catalogId}: ${(error as Error).message}`)
          result = { status: 'unavailable', reason: 'protocol', checkedAt: new Date().toISOString() }
        } finally {
          this.queued.delete(id)
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
        } else if (result.status === 'unavailable') {
          const now = (this.options.now ?? Date.now)()
          this.backoffUntil.set(id, now + (this.options.retryAfterUnavailableMs ?? 30 * 60_000))
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
): { store: SourceVerificationStore; verifier: BackgroundSourceVerifier } {
  const cache = createSqliteNpmOfficialVerificationCache(db)
  return {
    store: createNpmSourceVerificationStore(cache),
    verifier: new BackgroundSourceVerifier({ cache, onResult }),
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
