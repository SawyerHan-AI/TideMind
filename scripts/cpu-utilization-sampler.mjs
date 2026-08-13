import os from 'node:os'
import { performance } from 'node:perf_hooks'

export function readCpuTimes() {
  return os.cpus().reduce((summary, cpu) => ({
    idle: summary.idle + cpu.times.idle,
    total: summary.total + Object.values(cpu.times).reduce((sum, value) => sum + value, 0),
  }), { idle: 0, total: 0 })
}

export function cpuUtilizationBetween(previous, current) {
  const total = current.total - previous.total
  if (total <= 0) return 1
  return 1 - ((current.idle - previous.idle) / total)
}

export function createCpuUtilizationSampler({
  minimumWindowMs = 1_000,
  read = readCpuTimes,
  now = () => performance.now(),
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
} = {}) {
  if (!Number.isSafeInteger(minimumWindowMs) || minimumWindowMs < 1) {
    throw new Error('CPU utilization sample window must be a positive integer')
  }
  let previous = read()
  let previousAt = now()
  return {
    async sample() {
      let remaining = minimumWindowMs - (now() - previousAt)
      while (remaining > 0) {
        await wait(remaining)
        remaining = minimumWindowMs - (now() - previousAt)
      }
      const current = read()
      const currentAt = now()
      const utilization = cpuUtilizationBetween(previous, current)
      previous = current
      previousAt = currentAt
      return utilization
    },
  }
}
