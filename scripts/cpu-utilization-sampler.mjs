import os from 'node:os'
import { performance } from 'node:perf_hooks'

export function readCpuTimes() {
  return os.cpus().reduce((summary, cpu) => ({
    idle: summary.idle + cpu.times.idle,
    total: summary.total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
  }), { idle: 0, total: 0 })
}

export function readCpuEnvironmentSnapshot() {
  const host = readCpuTimes()
  const currentProcess = process.cpuUsage()
  return {
    ...host,
    processCpuMicros: currentProcess.user + currentProcess.system,
  }
}

export function cpuUtilizationBetween(previous, current) {
  const total = current.total - previous.total
  const idle = current.idle - previous.idle
  if (!Number.isFinite(total) || !Number.isFinite(idle) || total <= 0 || idle < 0 || idle > total) return 1
  return 1 - (idle / total)
}

// The performance gate is an environment gate, not a workload CPU budget.
// Subtract CPU consumed by the benchmark process itself so a deliberately
// synchronous main-thread baseline cannot fail merely by doing the work being
// measured. Absolute latency, event-loop and throughput gates still constrain
// the workload. Host CPU-time counters are milliseconds summed over all cores;
// process.cpuUsage() is microseconds summed over this process' threads.
export function externalCpuUtilizationBetween(previous, current) {
  const total = current.total - previous.total
  const idle = current.idle - previous.idle
  const processCpuMillis = (current.processCpuMicros - previous.processCpuMicros) / 1_000
  if (!Number.isFinite(total) || !Number.isFinite(idle) || total <= 0 || idle < 0 || idle > total
    || !Number.isFinite(processCpuMillis) || processCpuMillis < 0) return 1
  const hostBusyMillis = Math.max(0, total - idle)
  if (processCpuMillis > hostBusyMillis + (total * 0.01)) return 1
  const externalBusyMillis = Math.max(0, hostBusyMillis - processCpuMillis)
  return Math.min(1, externalBusyMillis / total)
}

export function cpuEnvironmentUtilizationsBetween(previous, current) {
  const total = current.total - previous.total
  const processCpuMillis = (current.processCpuMicros - previous.processCpuMicros) / 1_000
  return {
    host: cpuUtilizationBetween(previous, current),
    process: total > 0 && Number.isFinite(processCpuMillis) && processCpuMillis >= 0
      ? Math.min(1, processCpuMillis / total)
      : 1,
    external: externalCpuUtilizationBetween(previous, current),
  }
}

export function createCpuUtilizationSampler({
  minimumWindowMs = 1_000,
  read = readCpuEnvironmentSnapshot,
  calculate = cpuUtilizationBetween,
  now = () => performance.now(),
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
} = {}) {
  if (!Number.isSafeInteger(minimumWindowMs) || minimumWindowMs < 1) {
    throw new Error('CPU utilization sample window must be a positive integer')
  }
  let previous = read()
  let previousAt = now()
  const sampleSnapshot = async () => {
    let remaining = minimumWindowMs - (now() - previousAt)
    while (remaining > 0) {
      await wait(remaining)
      remaining = minimumWindowMs - (now() - previousAt)
    }
    const prior = previous
    const current = read()
    const currentAt = now()
    const utilization = calculate(prior, current)
    previous = current
    previousAt = currentAt
    return { previous: prior, current, utilization }
  }
  return {
    sampleSnapshot,
    async sample() {
      return (await sampleSnapshot()).utilization
    },
  }
}
