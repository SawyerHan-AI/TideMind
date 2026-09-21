import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ inspect: vi.fn(), execute: vi.fn() }))
vi.mock('../../scripts/tidemind-candidate-app-identity.mjs', () => ({ inspectPhysicalTideMindCandidateApp: mocked.inspect }))
vi.mock('node:child_process', () => ({ execFileSync: mocked.execute }))
// @ts-expect-error plain ESM capture module
import { executeFrozenCandidateExporter } from '../../scripts/capture-agent-integration-host-acceptance.mjs'

const candidate = { bundleSha256: 'a'.repeat(64), executableSha256: 'b'.repeat(64), cdhash: 'c'.repeat(40) }
const state = {
  appVersion: '0.2.92', sourceCommit: 'd'.repeat(40),
  candidateAppPathsByArchitecture: { arm64: '/frozen/Tide Mind.app' },
  candidateAppsByArchitecture: { arm64: candidate },
}

describe('signed candidate exporter execution boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocked.inspect.mockReturnValue(candidate)
    mocked.execute.mockReturnValue('{"receipt":"exported"}')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('revalidates before and after execution and removes runtime injection environment', () => {
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_NO_ASAR', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD']) {
      vi.stubEnv(name, 'injection')
    }
    const order: string[] = []
    mocked.inspect.mockImplementation(() => { order.push('inspect'); return candidate })
    mocked.execute.mockImplementation(() => { order.push('execute'); return 'receipt' })
    expect(executeFrozenCandidateExporter(state, 'arm64', ['exporter.cjs'])).toBe('receipt')
    expect(order).toEqual(['inspect', 'execute', 'inspect'])
    expect(mocked.inspect).toHaveBeenCalledWith('/frozen/Tide Mind.app', state.appVersion, state.sourceCommit, 'arm64')
    const env = mocked.execute.mock.calls[0][2].env
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_NO_ASAR', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD']) {
      expect(env).not.toHaveProperty(name)
    }
  })

  it('never executes a candidate changed since initialization', () => {
    mocked.inspect.mockReturnValue({ ...candidate, bundleSha256: 'e'.repeat(64) })
    expect(() => executeFrozenCandidateExporter(state, 'arm64', [])).toThrow('differs from the frozen')
    expect(mocked.execute).not.toHaveBeenCalled()
  })

  it('discards output when the candidate changes during execution', () => {
    mocked.inspect.mockReturnValueOnce(candidate).mockReturnValueOnce({ ...candidate, cdhash: 'e'.repeat(40) })
    expect(() => executeFrozenCandidateExporter(state, 'arm64', [])).toThrow('differs from the frozen')
    expect(mocked.execute).toHaveBeenCalledOnce()
  })

  it('still revalidates after a failed exporter and propagates codesign failure', () => {
    mocked.execute.mockImplementation(() => { throw new Error('export failed') })
    mocked.inspect.mockReturnValueOnce(candidate).mockImplementationOnce(() => { throw new Error('codesign failed') })
    expect(() => executeFrozenCandidateExporter(state, 'arm64', [])).toThrow('codesign failed')
    expect(mocked.inspect).toHaveBeenCalledTimes(2)
  })
})
