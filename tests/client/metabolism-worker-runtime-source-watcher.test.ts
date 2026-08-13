import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fingerprintMetabolismWorkerExternalRuntimeSources,
  watchMetabolismWorkerExternalRuntimeSources,
} from '../../client/electron/workers/metabolism-worker-runtime-mutations.js'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metabolism-runtime-watch-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'strategies'))
  fs.writeFileSync(path.join(root, 'strategies', 'alpha.md'), 'one')
  return root
}

describe('metabolism Worker external runtime source watcher', () => {
  it('uses content and stable paths rather than mtimes', () => {
    const root = fixture()
    const first = fingerprintMetabolismWorkerExternalRuntimeSources(root)
    fs.utimesSync(path.join(root, 'strategies', 'alpha.md'), new Date(), new Date())
    expect(fingerprintMetabolismWorkerExternalRuntimeSources(root)).toBe(first)
    fs.writeFileSync(path.join(root, 'strategies', 'alpha.md'), 'two')
    expect(fingerprintMetabolismWorkerExternalRuntimeSources(root)).not.toBe(first)
  })

  it('detects strategy and credential replacement once and can acknowledge IPC-owned changes', () => {
    vi.useFakeTimers()
    const root = fixture()
    const changed = vi.fn()
    const watcher = watchMetabolismWorkerExternalRuntimeSources(root, changed, 100)
    fs.writeFileSync(path.join(root, 'strategies', 'alpha.md'), 'two')
    watcher.poll()
    watcher.poll()
    expect(changed).toHaveBeenCalledTimes(1)

    fs.writeFileSync(path.join(root, 'vertex-credentials.json'), '{"project_id":"p"}')
    watcher.acknowledgeCurrent()
    watcher.poll()
    expect(changed).toHaveBeenCalledTimes(1)

    fs.writeFileSync(path.join(root, 'vertex-credentials.json'), '{"project_id":"q"}')
    watcher.poll()
    expect(changed).toHaveBeenCalledTimes(2)
    watcher.close()
  })
})
