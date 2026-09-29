import { describe, expect, it, vi } from 'vitest'
import {
  BackgroundSourceVerifier,
  createNpmSourceVerificationStore,
} from '../../client/electron/agent-integration/source-verification-queue'
import {
  NPM_OFFICIAL_VERIFIER_VERSION,
  type NpmOfficialVerificationCache,
  type NpmOfficialVerificationCacheRecord,
  type NpmOfficialVerificationResult,
} from '../../client/electron/agent-integration/npm-official-verification'

const key = {
  catalogId: 'codex-cli' as const,
  distributionId: 'cli:codex-cli',
  packageProvenance: 'npm_metadata:@openai/codex',
  version: '9.9.9',
  architecture: 'arm64' as const,
  portableArtifactFingerprint: 'a'.repeat(64),
}

function memoryCache(): NpmOfficialVerificationCache & { records: NpmOfficialVerificationCacheRecord[] } {
  const records: NpmOfficialVerificationCacheRecord[] = []
  return {
    records,
    get: k => records.find(r => (
      r.distributionId === k.distributionId && r.version === k.version
      && r.localPortableArtifactFingerprint === k.localPortableArtifactFingerprint
      && r.verifierVersion === k.verifierVersion
    )) ?? null,
    put: record => { records.push(record) },
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
}

describe('background official source verification', () => {
  it('coalesces duplicate keys and rescans only after a durable result', async () => {
    let release!: (value: NpmOfficialVerificationResult) => void
    const verify = vi.fn(() => new Promise<NpmOfficialVerificationResult>(resolve => { release = resolve }))
    const onResult = vi.fn()
    const queue = new BackgroundSourceVerifier({ cache: memoryCache(), onResult, verify })
    await queue.enqueue(key)
    await queue.enqueue(key)
    await settle()
    expect(verify).toHaveBeenCalledTimes(1)
    expect(verify.mock.calls[0][0]).toMatchObject({
      distributionId: key.distributionId,
      version: key.version,
      localPortableArtifactFingerprint: key.portableArtifactFingerprint,
    })
    release({ status: 'verified', officialFingerprint: key.portableArtifactFingerprint, checkedAt: 'T', evidence: 'registry' })
    await settle()
    expect(onResult).toHaveBeenCalledTimes(1)
  })

  it('backs off after an unavailable result instead of looping, and never rescans for it', async () => {
    let now = 1_000
    const verify = vi.fn(async (): Promise<NpmOfficialVerificationResult> => (
      { status: 'unavailable', reason: 'offline', checkedAt: 'T' }
    ))
    const onResult = vi.fn()
    const queue = new BackgroundSourceVerifier({
      cache: memoryCache(), onResult, verify, now: () => now, retryAfterUnavailableMs: 60_000,
    })
    await queue.enqueue(key)
    await settle()
    await queue.enqueue(key)
    await settle()
    expect(verify).toHaveBeenCalledTimes(1)
    expect(onResult).not.toHaveBeenCalled()
    now += 61_000
    await queue.enqueue(key)
    await settle()
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('treats a thrown verifier as unavailable (no trust, no rescan)', async () => {
    const onResult = vi.fn()
    const queue = new BackgroundSourceVerifier({
      cache: memoryCache(),
      onResult,
      verify: vi.fn(async () => { throw new Error('boom') }),
    })
    await queue.enqueue(key)
    await settle()
    expect(onResult).not.toHaveBeenCalled()
  })

  it('maps cached verified/mismatch records to runtime lookups and fails closed on read errors', () => {
    const cache = memoryCache()
    const store = createNpmSourceVerificationStore(cache)
    expect(store.lookup(key)).toBeNull()
    cache.put({
      distributionId: key.distributionId,
      packageProvenance: key.packageProvenance,
      version: key.version,
      architecture: key.architecture,
      localPortableArtifactFingerprint: key.portableArtifactFingerprint,
      verifierVersion: NPM_OFFICIAL_VERIFIER_VERSION,
      status: 'mismatch',
      officialFingerprint: 'b'.repeat(64),
      checkedAt: '2026-09-25T00:00:00.000Z',
      evidence: { packages: [] } as never,
    })
    expect(store.lookup(key)).toEqual({ status: 'mismatch', checkedAt: '2026-09-25T00:00:00.000Z' })
    const broken = createNpmSourceVerificationStore({
      get: () => { throw new Error('sqlite busy') },
      put: () => undefined,
    })
    expect(broken.lookup(key)).toBeNull()
  })
})
