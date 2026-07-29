import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestDb } from '../helpers/test-db.js'

type Handler = (_event: unknown, ...args: unknown[]) => unknown

const { handlers, electronMock } = vi.hoisted(() => {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    electronMock: {
      ipcMain: {
        handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      },
    },
  }
})

vi.mock('electron', () => electronMock)
vi.mock('../../client/node_modules/electron/index.js', () => electronMock)

import { registerStatsHandlers } from '../../client/electron/ipc/stats.js'

describe('LLM 用量统计的连接与来源分解', () => {
  beforeEach(() => handlers.clear())

  it('总 token 只计算 input + output，不重复加入 thinking/reasoning', () => {
    const db = setupTestDb()
    db.prepare(`
      INSERT INTO llm_usage_log (
        model, operation, input_tokens, output_tokens, thinking_tokens,
        cached_input_tokens, reasoning_tokens, estimated_cost,
        provider_type, connection_id, connection_name_snapshot,
        source_type, billing_mode, estimated_cost_kind, created
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'gpt-test',
      'digest',
      100,
      20,
      15,
      30,
      10,
      0.12,
      'codex-cli',
      'mc_abcdef01',
      'Local Codex',
      'local_subscription',
      'account_cli',
      'api_equivalent',
      new Date().toISOString(),
    )
    registerStatsHandlers(db)

    const result = handlers.get('stats:token-usage')!(null) as {
      byConnectionAndSource: Array<{ total_tokens: number }>
    }

    expect(result.byConnectionAndSource).toHaveLength(1)
    expect(result.byConnectionAndSource[0].total_tokens).toBe(120)
  })
})
