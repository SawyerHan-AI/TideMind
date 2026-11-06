import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ensureSchema } from '../../src/db/schema.js'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  setMainActiveListener: vi.fn(),
  degradedReason: null as string | null,
  health: [] as any[],
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
  },
}))
vi.mock('../../src/llm/connection-health.js', () => ({
  listConnectionHealth: () => mocks.health,
  resetConnectionHealth: vi.fn(),
  setConnectionHealthChangeListener: vi.fn(),
}))
vi.mock('../../src/llm/invocation-context.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/llm/invocation-context.js')>()
  return { ...original, setActiveLLMTaskListener: mocks.setMainActiveListener }
})
vi.mock('../../src/config.js', () => ({ getConfig: () => ({llm:{light_connection:'mc_healthtest', standard_connection:'mc_healthtest',heavy_connection:'other',light_model:'default',standard_model:'default',heavy_model:'default'}}) }))
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

it('shows unresolved connection state even when health only contains an old success', () => {
  db.prepare("INSERT INTO model_connections(id,name,provider_type,status,created) VALUES ('mc_healthtest','Codex','codex-cli','ambiguous','2026-11-06')").run()
  mocks.health=[{connectionId:'mc_healthtest',providerType:'codex-cli',circuitState:'closed',lastErrorKind:null,lastErrorMessage:null,lastSuccessAt:1}]
  try {
    const snapshot=bridge.readLLMHealthSnapshot(db)
    expect(snapshot.errors).toContainEqual(expect.objectContaining({connectionId:'mc_healthtest',kind:'ambiguous',affectedTiers:['light','standard']}))
  } finally { mocks.health=[];db.prepare("DELETE FROM model_connections WHERE id='mc_healthtest'").run() }
})
it('shows affected routes for an open connection circuit even when models are otherwise admitted', () => {
  db.prepare("INSERT INTO model_connections(id,name,provider_type,status,created) VALUES ('mc_healthtest','Gemini','gemini','online','2026-11-06')").run()
  mocks.health=[{connectionId:'mc_healthtest',providerType:'gemini',circuitState:'open',lastErrorKind:'quota',lastErrorMessage:'quota',needsUserAction:false}]
  try {
    expect(bridge.readLLMHealthSnapshot(db).errors[0].affectedTiers).toEqual(['light','standard'])
  } finally { mocks.health=[];db.prepare("DELETE FROM model_connections WHERE id='mc_healthtest'").run() }
})
