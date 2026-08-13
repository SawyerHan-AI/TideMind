import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpuUtilizationBetween, createCpuUtilizationSampler } from '../../scripts/cpu-utilization-sampler.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('CPU utilization sampler', () => {
  it('rejects an invalid sample window before reading host state', () => {
    expect(() => createCpuUtilizationSampler({ minimumWindowMs: 0 })).toThrow('positive integer')
  })

  it('uses a monotonic clock for the production sampler and wrapper deadline', () => {
    const samplerSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'cpu-utilization-sampler.mjs'), 'utf8')
    const wrapperSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-packaged-metabolism-worker-performance.mjs'), 'utf8')
    expect(samplerSource).toContain("from 'node:perf_hooks'")
    expect(samplerSource).toContain('now = () => performance.now()')
    expect(wrapperSource).toContain('const deadline = performance.now() + 15 * 60_000')
    expect(wrapperSource).toContain('while (performance.now() < deadline)')
  })

  it('computes aggregate idle and busy utilization', () => {
    expect(cpuUtilizationBetween({ idle: 100, total: 200 }, { idle: 150, total: 300 })).toBe(0.5)
    expect(cpuUtilizationBetween({ idle: 100, total: 200 }, { idle: 200, total: 300 })).toBe(0)
    expect(cpuUtilizationBetween({ idle: 100, total: 200 }, { idle: 100, total: 300 })).toBe(1)
    expect(cpuUtilizationBetween({ idle: 100, total: 200 }, { idle: 100, total: 200 })).toBe(1)
  })

  it('waits out the minimum window instead of emitting a zero-delta sample', async () => {
    let now = 0
    const snapshots = [{ idle: 0, total: 0 }, { idle: 50, total: 100 }]
    const waits: number[] = []
    const sampler = createCpuUtilizationSampler({
      minimumWindowMs: 1_000,
      now: () => now,
      read: () => snapshots.shift()!,
      wait: async delay => { waits.push(delay); now += delay },
    })
    await expect(sampler.sample()).resolves.toBe(0.5)
    expect(waits).toEqual([1_000])
  })

  it('does not wait again after a synchronous block already spans the window', async () => {
    let now = 0
    const snapshots = [{ idle: 0, total: 0 }, { idle: 75, total: 100 }]
    const waits: number[] = []
    const sampler = createCpuUtilizationSampler({
      minimumWindowMs: 1_000,
      now: () => now,
      read: () => snapshots.shift()!,
      wait: async delay => { waits.push(delay); now += delay },
    })
    now = 2_000
    await expect(sampler.sample()).resolves.toBe(0.25)
    expect(waits).toEqual([])
  })

  it('waits again when an injected timer returns before the minimum window', async () => {
    let now = 0
    const snapshots = [{ idle: 0, total: 0 }, { idle: 25, total: 100 }]
    const waits: number[] = []
    const sampler = createCpuUtilizationSampler({
      minimumWindowMs: 1_000,
      now: () => now,
      read: () => snapshots.shift()!,
      wait: async delay => { waits.push(delay); now += Math.min(delay, 400) },
    })
    await expect(sampler.sample()).resolves.toBe(0.75)
    expect(waits).toEqual([1_000, 600, 200])
  })
})
