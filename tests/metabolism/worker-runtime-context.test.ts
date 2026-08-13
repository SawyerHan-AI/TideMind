import { afterEach, describe, expect, it } from 'vitest'
import { getConfig, getDataDir, reloadConfig } from '../../src/config.js'
import { getParam, getPrompt, loadStrategies } from '../../src/strategy/loader.js'
import {
  clearMetabolismWorkerRuntimeContext,
  getMetabolismWorkerConnectionSnapshot,
  getMetabolismWorkerVertexCredential,
  installMetabolismWorkerRuntimeContext,
} from '../../src/metabolism/worker-runtime-context.js'

afterEach(() => clearMetabolismWorkerRuntimeContext())

describe('metabolism Worker runtime context', () => {
  it('serves config, strategies and fixed connections from the installed generation', () => {
    installMetabolismWorkerRuntimeContext({
      runtimeRevision: 4,
      config: {
        general: { data_dir: '/authorized/data' },
        metabolism: { annotate_interval_minutes: 3 },
        llm: { provider: 'anthropic' },
        embedding: { provider: 'vertex', dimensions: 768 },
      },
      connectionSnapshot: { connections: [{ id: 'mc_1', name: 'test', providerType: 'anthropic', archived: false, status: 'available', statusReason: null, candidateModels: '[]', availableModels: '[]', validationFingerprint: null, authFingerprint: null, modelValidationJson: null, credentials: { api_key: 'secret' } }] },
      strategySnapshot: {
        annotate: { name: 'annotate', version: 1, status: 'active', systemPrompt: 'frozen prompt', userPrompt: null, params: { batch: 7 }, rawContent: 'frozen' },
      },
      credentials: {},
      dataDir: '/authorized/data',
    })
    expect(getDataDir()).toBe('/authorized/data')
    expect(getConfig().general.data_dir).toBe('/authorized/data')
    expect(getPrompt('annotate', 'fallback')).toBe('frozen prompt')
    expect(getParam('annotate', 'batch', 1)).toBe(7)
    expect(getMetabolismWorkerConnectionSnapshot('mc_1')).toEqual({
      id: 'mc_1', name: 'test', providerType: 'anthropic', archived: false, status: 'available', statusReason: null, candidateModels: '[]', availableModels: '[]', validationFingerprint: null, authFingerprint: null, modelValidationJson: null, credentials: { api_key: 'secret' },
    })
  })

  it('fails closed instead of reloading config or strategy files', () => {
    installMetabolismWorkerRuntimeContext({
      runtimeRevision: 1,
      config: { general: { data_dir: '/data' }, metabolism: {}, llm: {}, embedding: {} },
      connectionSnapshot: { connections: [] },
      strategySnapshot: {},
      credentials: {},
      dataDir: '/data',
    })
    expect(() => reloadConfig()).toThrow(/不可热重载/)
    expect(() => loadStrategies('/other')).toThrow(/禁止从文件/)
  })

  it('serves generation-frozen Vertex credentials without reading credential files', () => {
    installMetabolismWorkerRuntimeContext({
      runtimeRevision: 2,
      config: { general: { data_dir: '/data' }, metabolism: {}, llm: {}, embedding: {} },
      connectionSnapshot: { connections: [] },
      strategySnapshot: {},
      credentials: {
        legacyVertex: { project_id: 'legacy-project', private_key: 'legacy-key' },
        vertexFiles: { mc_vertex: { project_id: 'connection-project', private_key: 'connection-key' } },
      },
      dataDir: '/data',
    })
    expect(getMetabolismWorkerVertexCredential()).toEqual({ project_id: 'legacy-project', private_key: 'legacy-key' })
    expect(getMetabolismWorkerVertexCredential('mc_vertex')).toEqual({ project_id: 'connection-project', private_key: 'connection-key' })
    expect(getMetabolismWorkerVertexCredential('missing')).toEqual({ project_id: 'legacy-project', private_key: 'legacy-key' })
    expect(Object.isFrozen(getMetabolismWorkerVertexCredential('mc_vertex'))).toBe(true)
  })
})
