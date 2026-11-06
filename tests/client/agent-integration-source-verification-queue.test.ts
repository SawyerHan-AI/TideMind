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
    const states: ReturnType<BackgroundSourceVerifier['status']>[] = []
    const queue = new BackgroundSourceVerifier({
      cache: memoryCache(), onResult, verify, now: () => now, retryAfterUnavailableMs: 60_000,
      onProgress: () => { states.push(queue.status(key)) },
    })
    await queue.enqueue(key)
    await settle()
    await queue.enqueue(key)
    await settle()
    expect(verify).toHaveBeenCalledTimes(1)
    expect(onResult).not.toHaveBeenCalled()
    expect(states).toEqual([
      { state: 'queued' },
      { state: 'checking' },
      { state: 'unavailable', reason: 'offline', retryAt: 61_000 },
    ])
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

  it('manually retries unavailable checks immediately, coalesces active work and reports click throttling', async () => {
    let now = 1_000
    const verify = vi.fn(async (): Promise<NpmOfficialVerificationResult> => ({ status: 'unavailable', reason: 'offline', checkedAt: 'T' }))
    const queue = new BackgroundSourceVerifier({ cache: memoryCache(), onResult: vi.fn(), verify, now: () => now })
    await queue.enqueue(key)
    await settle()
    expect(queue.status(key)?.state).toBe('unavailable')
    expect(await queue.retry(key)).toEqual({ status: 'started' })
    await settle()
    expect(verify).toHaveBeenCalledTimes(2)
    expect(await queue.retry(key)).toEqual({ status: 'throttled', retryAt: 11_000 })
    now = 11_000
    expect(await queue.retry(key)).toEqual({ status: 'started' })
    await settle()
    expect(verify).toHaveBeenCalledTimes(3)
  })

  it('does not rerun an unsupported source and exposes its precise reason', async () => {
    const verify = vi.fn(async (): Promise<NpmOfficialVerificationResult> => ({ status: 'unsupported', reason: 'unreproducible_installation' }))
    const onProgress = vi.fn()
    const queue = new BackgroundSourceVerifier({ cache: memoryCache(), onResult: vi.fn(), onProgress, verify })
    await queue.enqueue(key)
    await settle()
    expect(queue.status(key)).toEqual({ state: 'unsupported', reason: 'unreproducible_installation' })
    expect(onProgress).toHaveBeenCalledTimes(3)
    expect(await queue.retry(key)).toEqual({ status: 'unsupported' })
    await queue.enqueue(key)
    await settle()
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it('stops the active verifier and rejects late cache writes and rescan callbacks', async () => {
    const cache = memoryCache()
    const onResult = vi.fn()
    const onProgress = vi.fn()
    let release!: () => void
    let signal: AbortSignal | undefined
    const queue = new BackgroundSourceVerifier({ cache, onResult, onProgress, verify: async (_input, deps) => {
      signal = deps?.signal
      await new Promise<void>(resolve => { release = resolve })
      deps!.cache!.put({} as NpmOfficialVerificationCacheRecord)
      return { status: 'verified', officialFingerprint: key.portableArtifactFingerprint, checkedAt: 'T', evidence: 'registry' }
    } })
    await queue.enqueue(key)
    expect(await queue.retry(key)).toEqual({ status: 'in_progress' })
    queue.stop()
    onProgress.mockClear()
    expect(signal?.aborted).toBe(true)
    release()
    await settle()
    expect(cache.records).toEqual([])
    expect(onResult).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalled()
    expect(await queue.retry(key)).toEqual({ status: 'stopped' })
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
