import { describe, expect, it } from 'vitest'
import { performanceReleaseException, assertPerformanceReleaseAccepted } from '../../scripts/metabolism-performance-release-exception.mjs'

const context = { appVersion: '0.2.94', packaged: true }
const labels = ['external CPU utilization maximumObserved', 'external CPU utilization end', 'renderer writer p99', 'worker/main throughput']
const evaluation = (failures: string[]) => ({ protocolVersion: 3, status: 'failed', failures })

describe('0.2.94 packaged performance release exception', () => {
  it.each([...labels.map(label => [label]), labels])('accepts only reviewed failures without changing evaluation: %j', (...failures) => {
    const raw = evaluation(failures)
    const before = structuredClone(raw)
    const receipt = { thresholdEvaluation: raw, releaseException: performanceReleaseException(raw, context) }
    expect(receipt.releaseException?.status).toBe('accepted-with-release-exception')
    expect(() => assertPerformanceReleaseAccepted(receipt, context)).not.toThrow()
    expect(raw).toEqual(before)
    expect(raw.status).toBe('failed')
  })

  it.each(['0.2.93', '0.2.95', '0.2.94-beta', null])('does not inherit approval in %s', appVersion => {
    const raw = evaluation(labels)
    const receipt = { thresholdEvaluation: raw, releaseException: performanceReleaseException(raw, context) }
    expect(performanceReleaseException(raw, { appVersion, packaged: true })).toBeNull()
    expect(() => assertPerformanceReleaseAccepted(receipt, { appVersion, packaged: true })).toThrow()
  })

  it('rejects nonpackaged runs and missing or altered exception records', () => {
    const raw = evaluation(labels)
    expect(performanceReleaseException(raw, { ...context, packaged: false })).toBeNull()
    expect(() => assertPerformanceReleaseAccepted({ thresholdEvaluation: raw }, context)).toThrow()
    const exception = performanceReleaseException(raw, context)!
    expect(() => assertPerformanceReleaseAccepted({ thresholdEvaluation: raw, releaseException: { ...exception, failures: [labels[0]] } }, context)).toThrow()
    expect(() => assertPerformanceReleaseAccepted({ thresholdEvaluation: raw, releaseException: exception }, { ...context, packaged: false })).toThrow()
  })

  it.each(['external CPU utilization start', 'renderer writer max', 'note writer p99', 'source drift during measurement', 'packaged/source Worker bundle mismatch', 'unexpected SQLite contention', 'invalid worker/main throughput', 'unknown'])('rejects an additional failure: %s', failure => {
    const raw = evaluation([...labels, failure])
    expect(performanceReleaseException(raw, context)).toBeNull()
    expect(() => assertPerformanceReleaseAccepted({ thresholdEvaluation: raw, releaseException: performanceReleaseException(evaluation(labels), context) }, context)).toThrow()
  })

  it('rejects errors, malformed evaluations, and passed statuses hiding failures', () => {
    for (const raw of [null, {}, { status: 'failed', failures: labels }, evaluation([]), { ...evaluation(labels), status: 'passed' }]) {
      expect(performanceReleaseException(raw, context)).toBeNull()
      expect(() => assertPerformanceReleaseAccepted({ thresholdEvaluation: raw }, context)).toThrow()
    }
    const raw = evaluation(labels)
    expect(() => assertPerformanceReleaseAccepted({ error: 'execution failed', thresholdEvaluation: raw, releaseException: performanceReleaseException(raw, context) }, context)).toThrow()
  })

  it('preserves ordinary passing receipts without declaring an exception', () => {
    const raw = { protocolVersion: 3, status: 'passed', failures: [] }
    expect(performanceReleaseException(raw, context)).toBeNull()
    expect(() => assertPerformanceReleaseAccepted({ thresholdEvaluation: raw }, context)).not.toThrow()
  })
})
