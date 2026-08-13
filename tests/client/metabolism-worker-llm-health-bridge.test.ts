import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ensureSchema } from '../../src/db/schema.js'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  setMainActiveListener: vi.fn(),
  degradedReason: null as string | null,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
  },
}))
vi.mock('../../src/llm/connection-health.js', () => ({
  listConnectionHealth: () => [],
  resetConnectionHealth: vi.fn(),
  setConnectionHealthChangeListener: vi.fn(),
}))
vi.mock('../../src/llm/invocation-context.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/llm/invocation-context.js')>()
  return { ...original, setActiveLLMTaskListener: mocks.setMainActiveListener }
})
vi.mock('../../src/llm/client.js', () => ({ clearClientCache: vi.fn() }))
vi.mock('../../client/electron/daemon.js', () => ({
  restartMetabolismWorkerAndTriggerImmediate: vi.fn(async () => undefined),
  getMetabolismWorkerDegradedReason: () => mocks.degradedReason,
}))

const bridge = await import('../../client/electron/ipc/llm-health.js')
let db: Database.Database

beforeAll(() => {
  db = new Database(':memory:')
  ensureSchema(db)
})
afterAll(() => db.close())

describe('metabolism Worker LLM health bridge', () => {
  it('projects Worker active task details and clears only that generation', () => {
    bridge.applyMetabolismWorkerStatusMessage(db, {
      protocolVersion: 1,
      lifecycleGeneration: 4,
      kind: 'active_llm_task_started',
      taskId: 'annotate:item-1',
      origin: 'scheduler-worker',
      purpose: 'llm',
      tier: 'standard',
      connectionId: 'mc_12345678',
    })
    expect(bridge.readLLMHealthSnapshot(db).activeTask).toEqual({
      taskId: 'annotate:item-1',
      tier: 'standard',
      connectionId: 'mc_12345678',
    })
    bridge.clearMetabolismWorkerGenerationStatus(db, 3)
    expect(bridge.readLLMHealthSnapshot(db).activeTask?.taskId).toBe('annotate:item-1')
    bridge.clearMetabolismWorkerGenerationStatus(db, 4)
    expect(bridge.readLLMHealthSnapshot(db).activeTask).toBeNull()
  })

  it('rereads durable health without trusting Worker payload on health_changed', () => {
    mocks.send.mockClear()
    bridge.applyMetabolismWorkerStatusMessage(db, {
      protocolVersion: 1,
      lifecycleGeneration: 5,
      kind: 'health_changed',
      scope: 'embedding',
    })
    expect(bridge.readLLMHealthSnapshot(db)).toMatchObject({ activeTask: null, errors: [] })
  })

  it('includes the sanitized Worker degraded state in the renderer snapshot', () => {
    mocks.degradedReason = 'worker_exit_without_stopped'
    expect(bridge.readLLMHealthSnapshot(db).metabolismWorkerDegradedReason).toBe('worker_exit_without_stopped')
    mocks.degradedReason = null
  })
})
