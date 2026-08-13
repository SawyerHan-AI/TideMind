import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  bindMetabolismWorkerRuntimeMutationRestart,
  fingerprintMetabolismWorkerExternalRuntimeSources,
  notifyMetabolismWorkerRuntimeMutation,
  setMetabolismWorkerRuntimeMutationListener,
} from '../../client/electron/workers/metabolism-worker-runtime-mutations.js'

afterEach(() => setMetabolismWorkerRuntimeMutationListener(null))

describe('metabolism Worker runtime mutation bridge', () => {
  it('routes durable mutation kinds to restart and surfaces rebuild failures', async () => {
    const restart = vi.fn(async (kind: string) => {
      if (kind === 'credential') throw new Error('snapshot rebuild failed')
    })
    const degraded = vi.fn()
    const unbind = bindMetabolismWorkerRuntimeMutationRestart(restart, degraded)
    notifyMetabolismWorkerRuntimeMutation('config')
    notifyMetabolismWorkerRuntimeMutation('credential')
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(degraded).toHaveBeenCalledWith(expect.objectContaining({ message: 'snapshot rebuild failed' })))
    unbind()
    notifyMetabolismWorkerRuntimeMutation('strategy')
    expect(restart).toHaveBeenCalledTimes(2)
  })

  it('keeps the fixed runtime mutation entry inventory wired', () => {
    const expected: Array<[string, string]> = [
      ['client/electron/ipc/config.ts', "notifyMetabolismWorkerRuntimeMutation('strategy')"],
      ['client/electron/ipc/config.ts', "notifyMetabolismWorkerRuntimeMutation('config')"],
      ['client/electron/ipc/connections.ts', "notifyMetabolismWorkerRuntimeMutation('connection')"],
      ['client/electron/ipc/connections.ts', "notifyMetabolismWorkerRuntimeMutation('credential')"],
      ['client/electron/ipc/credentials.ts', "notifyMetabolismWorkerRuntimeMutation('credential')"],
      ['client/electron/ipc/cloud.ts', "notifyMetabolismWorkerRuntimeMutation('config')"],
    ]
    for (const [file, marker] of expected) {
      expect(fs.readFileSync(path.join(process.cwd(), file), 'utf8'), `${file} missing ${marker}`).toContain(marker)
    }
  })

  it('rejects symlinked strategy roots and credential sources instead of hashing a different projection', () => {
    const dataDir = fs.mkdtempSync(path.join(process.cwd(), '.runtime-source-test-'))
    try {
      const outside = fs.mkdtempSync(path.join(process.cwd(), '.runtime-source-outside-'))
      try {
        fs.mkdirSync(path.join(outside, 'strategies'))
        fs.symlinkSync(path.join(outside, 'strategies'), path.join(dataDir, 'strategies'))
        expect(() => fingerprintMetabolismWorkerExternalRuntimeSources(dataDir)).toThrow(/canonical data-dir directory/)
        fs.unlinkSync(path.join(dataDir, 'strategies'))
        fs.writeFileSync(path.join(outside, 'credential.json'), '{}')
        fs.symlinkSync(path.join(outside, 'credential.json'), path.join(dataDir, 'vertex-credentials.json'))
        expect(() => fingerprintMetabolismWorkerExternalRuntimeSources(dataDir)).toThrow(/single-link regular file/)
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('accepts a stable data-dir symlink but fingerprints a changed symlink target', () => {
    const linkParent = fs.mkdtempSync(path.join(process.cwd(), '.runtime-source-link-'))
    const first = fs.mkdtempSync(path.join(process.cwd(), '.runtime-source-target-a-'))
    const second = fs.mkdtempSync(path.join(process.cwd(), '.runtime-source-target-b-'))
    try {
      for (const root of [first, second]) {
        fs.mkdirSync(path.join(root, 'strategies'))
        fs.writeFileSync(path.join(root, 'strategies', 'worker.system.md'), 'same')
      }
      const linked = path.join(linkParent, 'data')
      fs.symlinkSync(first, linked)
      const before = fingerprintMetabolismWorkerExternalRuntimeSources(linked)
      fs.unlinkSync(linked)
      fs.symlinkSync(second, linked)
      expect(fingerprintMetabolismWorkerExternalRuntimeSources(linked)).not.toBe(before)
    } finally {
      fs.rmSync(linkParent, { recursive: true, force: true })
      fs.rmSync(first, { recursive: true, force: true })
      fs.rmSync(second, { recursive: true, force: true })
    }
  })
})
