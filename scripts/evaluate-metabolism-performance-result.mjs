function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonnegativeNumber(value) {
  return finiteNumber(value) && value >= 0
}

function positiveNumber(value) {
  return finiteNumber(value) && value > 0
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function requireNumber(failures, value, label, predicate = nonnegativeNumber) {
  if (!predicate(value)) failures.push(`invalid ${label}`)
  return predicate(value)
}

function requireNumberArray(failures, value, label, expectedLength, predicate = nonnegativeNumber) {
  if (!Array.isArray(value) || value.length !== expectedLength || value.some(item => !predicate(item))) {
    failures.push(`invalid ${label}`)
    return false
  }
  return true
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]
}

function approximatelyEqual(left, right) {
  return finiteNumber(left) && finiteNumber(right)
    && Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-9)
}

const REQUIRED_WORKLOADS = [
  'focused-renderer-ipc-writes',
  'note-source-writes',
  'cloud-outbox-writes',
  'background-full-backlog',
  'foreground-single-attempt',
  'suspend-resume',
  'worker-owner-terminate-reacquire',
]

export function evaluateMetabolismPerformanceResult({ result, thresholds, packaged, writesPerKind, maximumCpuUtilization }) {
  const failures = []
  if (!packaged) failures.push('packaged Electron candidate not exercised by development harness')
  if (thresholds?.protocolVersion !== 2 || result?.protocolVersion !== 2) failures.push('protocol version')
  if (thresholds?.status !== 'refrozen-before-external-cpu-fix-results') failures.push('threshold frozen status')
  if (thresholds?.scope !== 'local packaged Electron metabolism Worker candidate; not a release SLO') failures.push('threshold scope')
  if (!Array.isArray(thresholds?.requiredWorkloads)
    || thresholds.requiredWorkloads.length !== REQUIRED_WORKLOADS.length
    || thresholds.requiredWorkloads.some((value, index) => value !== REQUIRED_WORKLOADS[index])) {
    failures.push('threshold required workloads')
  }
  if (thresholds?.gateRule !== 'Any failure keeps production activation blocked. Rerun the same workload and thresholds after a targeted fix.') {
    failures.push('threshold gate rule')
  }

  const thresholdNumbers = [
    ['event-loop p95 threshold', thresholds?.eventLoopDelayMs?.p95Max, nonnegativeNumber],
    ['event-loop p99 threshold', thresholds?.eventLoopDelayMs?.p99Max, nonnegativeNumber],
    ['event-loop max threshold', thresholds?.eventLoopDelayMs?.absoluteMax, nonnegativeNumber],
    ['event-loop improvement threshold', thresholds?.eventLoopDelayMs?.p99ImprovementVsMainBaselineMin,
      value => finiteNumber(value) && value >= 0 && value <= 1],
    ['renderer p99 threshold', thresholds?.foregroundWriterDelayMs?.rendererIpcP99Max, nonnegativeNumber],
    ['renderer max threshold', thresholds?.foregroundWriterDelayMs?.rendererIpcAbsoluteMax, nonnegativeNumber],
    ['note p99 threshold', thresholds?.foregroundWriterDelayMs?.noteSourceP99Max, nonnegativeNumber],
    ['note max threshold', thresholds?.foregroundWriterDelayMs?.noteSourceAbsoluteMax, nonnegativeNumber],
    ['cloud p99 threshold', thresholds?.foregroundWriterDelayMs?.cloudOutboxP99Max, nonnegativeNumber],
    ['cloud max threshold', thresholds?.foregroundWriterDelayMs?.cloudOutboxAbsoluteMax, nonnegativeNumber],
    ['throughput threshold', thresholds?.throughput?.workerVsMainBaselineRatioMin, nonnegativeNumber],
    ['SQLite contention threshold', thresholds?.correctness?.unexpectedSqliteBusyOrLockedMax, nonnegativeInteger],
    ['scheduler concurrency threshold', thresholds?.correctness?.concurrentSchedulerPassesMax, nonnegativeInteger],
    ['main-thread execution threshold', thresholds?.correctness?.mainThreadSchedulerTaskExecutionsMax, nonnegativeInteger],
    ['orphan CLI threshold', thresholds?.correctness?.orphanCliProcessGroupsAfterShutdownMax, nonnegativeInteger],
    ['CPU utilization threshold', thresholds?.environment?.cpuUtilizationMax,
      value => finiteNumber(value) && value > 0 && value < 1],
    ['CPU sample window', thresholds?.environment?.cpuSampleMinimumWindowMs,
      value => Number.isSafeInteger(value) && value >= 500],
  ]
  for (const [label, value, predicate] of thresholdNumbers) requireNumber(failures, value, label, predicate)

  if (!nonnegativeInteger(writesPerKind) || !finiteNumber(maximumCpuUtilization)
    || maximumCpuUtilization <= 0 || maximumCpuUtilization >= 1) failures.push('invalid evaluator inputs')
  if (finiteNumber(maximumCpuUtilization) && finiteNumber(thresholds?.environment?.cpuUtilizationMax)
    && maximumCpuUtilization !== thresholds.environment.cpuUtilizationMax) failures.push('CPU utilization threshold binding')
  if (result?.fixture?.nodeCount !== 10_000 || result?.fixture?.linkCount !== 20_000
    || result?.fixture?.writesPerKind !== 100 || result.fixture.writesPerKind !== writesPerKind
    || result?.fixture?.dataRoot !== 'ephemeral-temp-only') failures.push('frozen fixture')
  if (typeof result?.measuredAt !== 'string' || !finiteNumber(Date.parse(result.measuredAt))) failures.push('invalid measurement time')
  if (typeof result?.machine?.cpu !== 'string' || result.machine.cpu.length === 0
    || !Number.isSafeInteger(result?.machine?.cpuCount) || result.machine.cpuCount <= 0
    || !Number.isSafeInteger(result?.machine?.memoryBytes) || result.machine.memoryBytes <= 0
    || typeof result?.machine?.os !== 'string' || result.machine.os.length === 0
    || result?.machine?.arch !== 'arm64'
    || typeof result?.machine?.electronVersion !== 'string' || result.machine.electronVersion.length === 0) {
    failures.push('invalid machine facts')
  }
  requireNumberArray(failures, result?.machine?.loadAverageAtStart, 'start load averages', 3)
  requireNumberArray(failures, result?.machine?.loadAverageAtEnd, 'end load averages', 3)
  const cpuGate = result?.machine?.cpuUtilizationGate
  for (const field of ['start', 'baselineExternalMaximumObserved', 'beforeCandidate', 'maximumObserved', 'end']) {
    const utilization = cpuGate?.[field]
    if (!requireNumber(failures, utilization, `external CPU utilization ${field}`, value => finiteNumber(value) && value >= 0 && value <= 1)) continue
    if (utilization > maximumCpuUtilization) failures.push(`external CPU utilization ${field}`)
  }
  for (const field of ['baselineHostMaximumObserved', 'baselineProcessMaximumObserved']) {
    requireNumber(failures, result?.machine?.cpuUtilizationGate?.[field], `baseline CPU diagnostic ${field}`,
      value => finiteNumber(value) && value >= 0 && value <= 1)
  }
  const baselineWindows = result?.machine?.cpuUtilizationGate?.baselineWindows
  if (!Array.isArray(baselineWindows) || baselineWindows.length !== 3) {
    failures.push('baseline CPU windows')
  } else {
    for (const [index, window] of baselineWindows.entries()) {
      const values = ['host', 'process', 'external'].map(field => window?.[field])
      if (!values.every(value => finiteNumber(value) && value >= 0 && value <= 1)) {
        failures.push(`baseline CPU window ${index + 1}`)
        continue
      }
      const expectedExternal = Math.max(0, window.host - window.process)
      if (Math.abs(window.external - expectedExternal) > 1e-9) failures.push(`baseline CPU external binding ${index + 1}`)
      if (window.process > window.host + 0.01) failures.push(`baseline CPU counter consistency ${index + 1}`)
    }
    const summaryBindings = [
      ['host', cpuGate?.baselineHostMaximumObserved],
      ['process', cpuGate?.baselineProcessMaximumObserved],
      ['external', cpuGate?.baselineExternalMaximumObserved],
    ]
    for (const [field, summary] of summaryBindings) {
      const expected = Math.max(...baselineWindows.map(window => window?.[field]))
      if (!finiteNumber(expected) || !finiteNumber(summary) || Math.abs(expected - summary) > 1e-9) {
        failures.push(`baseline CPU ${field} maximum binding`)
      }
    }
  }
  if ([cpuGate?.start, cpuGate?.beforeCandidate, cpuGate?.end, cpuGate?.maximumObserved].every(finiteNumber)
    && cpuGate.maximumObserved < Math.max(cpuGate.start, cpuGate.beforeCandidate, cpuGate.end)) failures.push('maximum CPU utilization binding')
  if (result?.workloads?.focusedRendererIpcWrites !== true) failures.push('focused renderer writer workload')
  if (result?.workloads?.backgroundFullBacklog !== true) failures.push('background full backlog workload')

  const eventLoopP95 = result?.eventLoopDelayMs?.p95
  const eventLoopP99 = result?.eventLoopDelayMs?.p99
  const eventLoopMax = result?.eventLoopDelayMs?.max
  const baselineP99 = result?.mainBaselineEventLoopDelayMs?.p99
  const throughputRatio = result?.throughput?.workerVsMainBaselineRatio
  const coreNumbers = [
    ['event-loop p50', result?.eventLoopDelayMs?.p50], ['event-loop p95', eventLoopP95],
    ['event-loop p99', eventLoopP99], ['event-loop max', eventLoopMax],
    ['main baseline event-loop p50', result?.mainBaselineEventLoopDelayMs?.p50],
    ['main baseline event-loop p95', result?.mainBaselineEventLoopDelayMs?.p95],
    ['main baseline event-loop p99', baselineP99], ['main baseline event-loop max', result?.mainBaselineEventLoopDelayMs?.max],
    ['worker/main throughput', throughputRatio],
    ['background backlog duration', result?.backgroundFullBacklog?.durationMs, positiveNumber],
    ['CPU user time', result?.resourceUsage?.cpuUserMs], ['CPU system time', result?.resourceUsage?.cpuSystemMs],
    ['WAL bytes', result?.resourceUsage?.walBytesBeforeCheckpoint],
  ]
  for (const [label, value, predicate] of coreNumbers) requireNumber(failures, value, label, predicate ?? nonnegativeNumber)
  for (const [label, summary] of [
    ['event-loop', result?.eventLoopDelayMs],
    ['main baseline event-loop', result?.mainBaselineEventLoopDelayMs],
  ]) {
    if (![summary?.p50, summary?.p95, summary?.p99, summary?.max].every(nonnegativeNumber)
      || !(summary.p50 <= summary.p95 && summary.p95 <= summary.p99 && summary.p99 <= summary.max)) {
      failures.push(`invalid ${label} summary`)
    }
  }
  const mainRuns = result?.throughput?.mainBaselineRunsMs
  const workerRuns = result?.throughput?.workerRunsMs
  if (requireNumberArray(failures, mainRuns, 'main baseline runs', 3, positiveNumber)
  ) {
    if (!approximatelyEqual(result?.throughput?.mainBaselineMs, percentile(mainRuns, 0.5))) failures.push('main baseline median')
    const expectedBaseline = {
      p50: percentile(mainRuns, 0.5),
      p95: percentile(mainRuns, 0.95),
      p99: percentile(mainRuns, 0.99),
      max: percentile(mainRuns, 1),
    }
    for (const [field, expected] of Object.entries(expectedBaseline)) {
      if (!approximatelyEqual(result?.mainBaselineEventLoopDelayMs?.[field], expected)) failures.push(`main baseline ${field} binding`)
    }
  }
  if (requireNumberArray(failures, workerRuns, 'worker runs', 3, positiveNumber)
    && !approximatelyEqual(result?.throughput?.workerRuntimeMs, percentile(workerRuns, 0.5))) failures.push('worker runtime median')
  requireNumber(failures, result?.throughput?.mainBaselineMs, 'main baseline runtime', positiveNumber)
  requireNumber(failures, result?.throughput?.workerRuntimeMs, 'worker runtime', positiveNumber)
  if (positiveNumber(result?.throughput?.mainBaselineMs) && positiveNumber(result?.throughput?.workerRuntimeMs)
    && !approximatelyEqual(throughputRatio, result.throughput.mainBaselineMs / result.throughput.workerRuntimeMs)) {
    failures.push('worker/main throughput ratio')
  }
  if (result?.backgroundFullBacklog?.llmAndEmbeddingTasksCircuitGated !== true) failures.push('background circuit gate')
  for (const field of ['busy', 'log', 'checkpointed']) {
    requireNumber(failures, result?.resourceUsage?.checkpoint?.[field], `checkpoint ${field}`, nonnegativeInteger)
  }

  if (finiteNumber(eventLoopP95) && finiteNumber(thresholds?.eventLoopDelayMs?.p95Max)
    && eventLoopP95 > thresholds.eventLoopDelayMs.p95Max) failures.push('event-loop p95')
  if (finiteNumber(eventLoopP99) && finiteNumber(thresholds?.eventLoopDelayMs?.p99Max)
    && eventLoopP99 > thresholds.eventLoopDelayMs.p99Max) failures.push('event-loop p99')
  if (finiteNumber(eventLoopMax) && finiteNumber(thresholds?.eventLoopDelayMs?.absoluteMax)
    && eventLoopMax > thresholds.eventLoopDelayMs.absoluteMax) failures.push('event-loop max')
  if (finiteNumber(eventLoopP99) && finiteNumber(baselineP99)
    && finiteNumber(thresholds?.eventLoopDelayMs?.p99ImprovementVsMainBaselineMin)
    && eventLoopP99 > baselineP99 * (1 - thresholds.eventLoopDelayMs.p99ImprovementVsMainBaselineMin)) {
    failures.push('event-loop p99 improvement')
  }
  if (finiteNumber(throughputRatio) && finiteNumber(thresholds?.throughput?.workerVsMainBaselineRatioMin)
    && throughputRatio < thresholds.throughput.workerVsMainBaselineRatioMin) failures.push('worker/main throughput')

  const writerThresholds = {
    renderer: [thresholds?.foregroundWriterDelayMs?.rendererIpcP99Max, thresholds?.foregroundWriterDelayMs?.rendererIpcAbsoluteMax],
    note: [thresholds?.foregroundWriterDelayMs?.noteSourceP99Max, thresholds?.foregroundWriterDelayMs?.noteSourceAbsoluteMax],
    cloud: [thresholds?.foregroundWriterDelayMs?.cloudOutboxP99Max, thresholds?.foregroundWriterDelayMs?.cloudOutboxAbsoluteMax],
  }
  for (const [kind, limits] of Object.entries(writerThresholds)) {
    const writer = result?.foregroundWriterDelayMs?.[kind]
    if (!nonnegativeInteger(writer?.count)) failures.push(`invalid ${kind} writer sample count`)
    else if (writer.count !== writesPerKind) failures.push(`${kind} writer sample count`)
    const p99Valid = requireNumber(failures, writer?.p99, `${kind} writer p99`)
    const maxValid = requireNumber(failures, writer?.max, `${kind} writer max`)
    const p50Valid = requireNumber(failures, writer?.p50, `${kind} writer p50`)
    const p95Valid = requireNumber(failures, writer?.p95, `${kind} writer p95`)
    if (p50Valid && p95Valid && p99Valid && maxValid
      && !(writer.p50 <= writer.p95 && writer.p95 <= writer.p99 && writer.p99 <= writer.max)) {
      failures.push(`invalid ${kind} writer summary`)
    }
    if (p99Valid && finiteNumber(limits[0]) && writer.p99 > limits[0]) failures.push(`${kind} writer p99`)
    if (maxValid && finiteNumber(limits[1]) && writer.max > limits[1]) failures.push(`${kind} writer max`)
  }

  const correctness = result?.correctness
  for (const field of ['foregroundSingleAttempt', 'suspendResume', 'workerOwnerTerminateReacquire']) {
    if (correctness?.[field] !== true) failures.push(field)
  }
  const correctnessCounters = [
    ['unexpectedSqliteBusyOrLocked', thresholds?.correctness?.unexpectedSqliteBusyOrLockedMax, 'unexpected SQLite contention'],
    ['concurrentSchedulerPasses', thresholds?.correctness?.concurrentSchedulerPassesMax, 'concurrent scheduler passes'],
    ['mainThreadSchedulerTaskExecutions', thresholds?.correctness?.mainThreadSchedulerTaskExecutionsMax, 'main thread scheduler task executions'],
    ['orphanCliProcessGroupsAfterShutdown', thresholds?.correctness?.orphanCliProcessGroupsAfterShutdownMax, 'orphan CLI process groups'],
  ]
  for (const [field, limit, exceededLabel] of correctnessCounters) {
    const value = correctness?.[field]
    if (!nonnegativeInteger(value)) failures.push(`invalid ${field}`)
    else if (nonnegativeInteger(limit) && value > limit) failures.push(exceededLabel)
  }
  return failures
}
