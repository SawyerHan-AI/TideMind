// Explicit user approval for this release only. Raw threshold failures remain failures.
const allowedFailures = new Set([
  'external CPU utilization maximumObserved',
  'external CPU utilization end',
  'renderer writer p99',
  'worker/main throughput',
])

export function performanceReleaseException(evaluation, { appVersion, packaged }) {
  if (appVersion !== '0.2.94' || packaged !== true || evaluation?.protocolVersion !== 3
    || evaluation.status !== 'failed' || !Array.isArray(evaluation.failures)
    || evaluation.failures.length === 0
    || evaluation.failures.some(failure => !allowedFailures.has(failure))) return null
  return {
    id: '0.2.94-packaged-performance-user-approved',
    appVersion: '0.2.94',
    status: 'accepted-with-release-exception',
    failures: [...evaluation.failures],
  }
}

export function assertPerformanceReleaseAccepted(receipt, context) {
  const evaluation = receipt?.thresholdEvaluation
  if (receipt?.error || evaluation?.protocolVersion !== 3 || !Array.isArray(evaluation.failures)) {
    throw new Error('invalid performance evaluation')
  }
  if (evaluation.status === 'passed' && evaluation.failures.length === 0 && !receipt.releaseException) return
  const expected = performanceReleaseException(evaluation, context)
  if (!expected || JSON.stringify(receipt.releaseException) !== JSON.stringify(expected)) {
    throw new Error('performance receipt did not pass or carry the approved 0.2.94 exception')
  }
}
