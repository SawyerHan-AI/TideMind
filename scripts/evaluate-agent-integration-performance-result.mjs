function finiteNonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]
}

function approximatelyEqual(left, right) {
  return finiteNonnegative(left) && finiteNonnegative(right)
    && Math.abs(left - right) <= Math.max(1e-6, Math.abs(right) * 1e-6)
}

function validateSamples(failures, summary, label, expectedCount) {
  const samples = summary?.samplesMs
  if (!Array.isArray(samples)
    || samples.length !== expectedCount
    || samples.some(value => !finiteNonnegative(value))) {
    failures.push(`invalid ${label} raw samples`)
    return false
  }
  const expected = {
    p50: percentile(samples, 0.50),
    p95: percentile(samples, 0.95),
    max: percentile(samples, 1),
  }
  for (const [field, value] of Object.entries(expected)) {
    if (!approximatelyEqual(summary?.[field], value)) failures.push(`${label} ${field} binding`)
  }
  if (!(summary.p50 <= summary.p95 && summary.p95 <= summary.max)) {
    failures.push(`invalid ${label} summary order`)
  }
  return true
}

const EXPECTED_SCALES = [
  ['100-installations-10000-events', 100, 10_000],
  ['1000-installations-100000-events', 1_000, 100_000],
]

const QUERY_FIELDS = ['snapshot', 'detail', 'events']

export function evaluateAgentIntegrationPerformanceResult({ result, thresholds }) {
  const failures = []
  if (result?.protocolVersion !== 1 || thresholds?.protocolVersion !== 1) failures.push('protocol version')
  if (thresholds?.status !== 'frozen-local-and-self-hosted-ci-baseline-2026-09-02') failures.push('threshold frozen status')
  if (thresholds?.scope !== 'deterministic local and self-hosted CI Agent Integration gate; not a packaged release SLO') {
    failures.push('threshold scope')
  }
  if (thresholds?.gateRule !== 'Any failure blocks performance sign-off until the same frozen fixture passes after a targeted fix or an explicitly reviewed threshold refreeze.') {
    failures.push('threshold gate rule')
  }

  const fixture = thresholds?.fixture
  if (fixture?.probeCount !== 18
    || fixture?.probeOperationTimeoutMs !== 20
    || fixture?.probeWarmupRuns !== 1
    || fixture?.probeMeasuredRuns !== 5
    || fixture?.queryWarmupRuns !== 2
    || fixture?.queryMeasuredRuns !== 7
    || fixture?.scanRounds !== 100
    || fixture?.reconcileRounds !== 100) {
    failures.push('threshold frozen fixture')
  }
  if (result?.fixture?.dataRoot !== 'ephemeral-physical-sqlite-only'
    || result?.fixture?.writesRealAgentConfiguration !== false
    || result?.fixture?.probeCount !== fixture?.probeCount
    || result?.fixture?.probeOperationTimeoutMs !== fixture?.probeOperationTimeoutMs
    || result?.fixture?.probeWarmupRuns !== fixture?.probeWarmupRuns
    || result?.fixture?.probeMeasuredRuns !== fixture?.probeMeasuredRuns
    || result?.fixture?.queryWarmupRuns !== fixture?.queryWarmupRuns
    || result?.fixture?.queryMeasuredRuns !== fixture?.queryMeasuredRuns
    || result?.fixture?.scanRounds !== fixture?.scanRounds
    || result?.fixture?.reconcileRounds !== fixture?.reconcileRounds) {
    failures.push('result frozen fixture')
  }
  if (typeof result?.measuredAt !== 'string' || !Number.isFinite(Date.parse(result.measuredAt))) {
    failures.push('invalid measurement time')
  }
  if (typeof result?.machine?.cpu !== 'string' || result.machine.cpu.length === 0
    || !safeNonnegativeInteger(result?.machine?.cpuCount) || result.machine.cpuCount === 0
    || typeof result?.machine?.os !== 'string' || result.machine.os.length === 0
    || typeof result?.machine?.arch !== 'string' || result.machine.arch.length === 0
    || typeof result?.machine?.nodeVersion !== 'string' || result.machine.nodeVersion.length === 0) {
    failures.push('invalid machine facts')
  }

  const timeoutLimit = thresholds?.discoveryTimeout?.wallMaxMs
  if (!finiteNonnegative(timeoutLimit)) failures.push('invalid discovery timeout threshold')
  const timeout = result?.discoveryTimeout
  if (timeout?.timedOutCatalogCount !== fixture?.probeCount
    || !Array.isArray(timeout?.timedOutCatalogIds)
    || timeout.timedOutCatalogIds.length !== fixture?.probeCount
    || new Set(timeout.timedOutCatalogIds).size !== fixture?.probeCount) {
    failures.push('P0 timeout coverage')
  }
  if (validateSamples(failures, timeout?.wall, 'P0 timeout wall', fixture?.probeMeasuredRuns)
    && finiteNonnegative(timeoutLimit)
    && timeout.wall.max > timeoutLimit) {
    failures.push('P0 timeout wall max')
  }

  for (const [scaleKey, installationCount, eventCount] of EXPECTED_SCALES) {
    const resultScale = result?.queries?.[scaleKey]
    const thresholdScale = thresholds?.queries?.[scaleKey]
    if (resultScale?.installationCount !== installationCount || resultScale?.eventCount !== eventCount) {
      failures.push(`${scaleKey} cardinality`)
    }
    if (!thresholdScale) failures.push(`${scaleKey} thresholds`)
    for (const field of QUERY_FIELDS) {
      const valid = validateSamples(
        failures,
        resultScale?.[field],
        `${scaleKey} ${field}`,
        fixture?.queryMeasuredRuns,
      )
      const p95Max = thresholdScale?.[`${field}P95MaxMs`]
      const absoluteMax = thresholdScale?.[`${field}AbsoluteMaxMs`]
      if (!finiteNonnegative(p95Max) || !finiteNonnegative(absoluteMax) || absoluteMax < p95Max) {
        failures.push(`invalid ${scaleKey} ${field} thresholds`)
        continue
      }
      if (valid && resultScale[field].p95 > p95Max) failures.push(`${scaleKey} ${field} p95`)
      if (valid && resultScale[field].max > absoluteMax) failures.push(`${scaleKey} ${field} max`)
    }
  }

  const taskFeedThresholds = thresholds?.taskFeed
  if (taskFeedThresholds?.pageLimit !== 50) failures.push('invalid task feed page limit')
  for (const [key, taskCount, traverseAll, expectedPages, expectedReturned] of [
    ['10000-attention-full-traversal', 10_000, true, 200, 10_000],
    ['100000-attention-first-page', 100_000, false, 1, 50],
  ]) {
    const measurement = result?.taskFeed?.[key]
    const threshold = taskFeedThresholds?.[key]
    if (measurement?.taskCount !== taskCount
      || measurement?.pageLimit !== 50
      || measurement?.traverseAll !== traverseAll
      || measurement?.pageCount !== expectedPages
      || measurement?.returnedCount !== expectedReturned
      || measurement?.totalCount !== taskCount) {
      failures.push(`${key} cardinality`)
    }
    if (!finiteNonnegative(measurement?.elapsedMs)
      || !safeNonnegativeInteger(measurement?.rssDeltaBytes)) {
      failures.push(`${key} raw metrics`)
    }
    if (!finiteNonnegative(threshold?.elapsedMaxMs)
      || !safeNonnegativeInteger(threshold?.rssDeltaMaxBytes)) {
      failures.push(`${key} thresholds`)
    } else {
      if (finiteNonnegative(measurement?.elapsedMs)
        && measurement.elapsedMs > threshold.elapsedMaxMs) failures.push(`${key} elapsed`)
      if (safeNonnegativeInteger(measurement?.rssDeltaBytes)
        && measurement.rssDeltaBytes > threshold.rssDeltaMaxBytes) failures.push(`${key} RSS`)
    }
    if (measurement?.physicalSqlite !== true
      || measurement?.writesRealAgentConfiguration !== false) failures.push(`${key} isolation`)
  }

  const stabilityThresholds = thresholds?.stability
  for (const field of ['finalOutstandingTimersMax', 'databaseRowGrowthMax', 'maxOutstandingTimersMax']) {
    if (!safeNonnegativeInteger(stabilityThresholds?.[field])) failures.push(`invalid stability threshold ${field}`)
  }
  const stability = result?.stability
  if (stability?.scanRounds !== fixture?.scanRounds || stability?.reconcileRounds !== fixture?.reconcileRounds) {
    failures.push('stability round count')
  }
  for (const field of ['finalOutstandingTimers', 'maxOutstandingTimers', 'databaseRowGrowth']) {
    if (!safeNonnegativeInteger(stability?.[field])) failures.push(`invalid stability ${field}`)
  }
  if (!Array.isArray(stability?.rowCountsBefore) || !Array.isArray(stability?.rowCountsAfter)
    || JSON.stringify(stability?.rowCountsBefore) !== JSON.stringify(stability?.rowCountsAfter)) {
    failures.push('stability table row counts')
  }
  if (safeNonnegativeInteger(stability?.finalOutstandingTimers)
    && safeNonnegativeInteger(stabilityThresholds?.finalOutstandingTimersMax)
    && stability.finalOutstandingTimers > stabilityThresholds.finalOutstandingTimersMax) {
    failures.push('outstanding timer growth')
  }
  if (safeNonnegativeInteger(stability?.maxOutstandingTimers)
    && safeNonnegativeInteger(stabilityThresholds?.maxOutstandingTimersMax)
    && stability.maxOutstandingTimers > stabilityThresholds.maxOutstandingTimersMax) {
    failures.push('outstanding timer peak')
  }
  if (safeNonnegativeInteger(stability?.databaseRowGrowth)
    && safeNonnegativeInteger(stabilityThresholds?.databaseRowGrowthMax)
    && stability.databaseRowGrowth > stabilityThresholds.databaseRowGrowthMax) {
    failures.push('database row growth')
  }
  if (stability?.physicalSqlite !== true || stability?.writesRealAgentConfiguration !== false) {
    failures.push('stability isolation')
  }
  return failures
}
