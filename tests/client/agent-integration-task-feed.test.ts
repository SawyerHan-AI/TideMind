import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository.js'
import { ensureSchema } from '../../src/db/schema.js'

const T0 = '2026-08-26T00:00:00.000Z'

function setup() {
  const db = new Database(':memory:')
  ensureSchema(db)
  const repository = new AgentIntegrationRepository(db)
  repository.upsertDiscoveredInstallation({
    id: 'installation-1', family: 'cursor', hostVariant: 'cursor-desktop',
    installKey: 'cursor:feed', provenance: 'test', displayName: 'Cursor',
    supportedCapability: 4, lastDetectedAt: T0,
  })
  return { db, repository }
}

function seedTasks(
  db: Database.Database,
  count: number,
  options: { executionPlanHash?: string; interrupted?: boolean } = {},
): void {
  const feedTriggers = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'trg_agent_%_feed_%'
    ORDER BY name
  `).all() as Array<{ name: string; sql: string }>
  if (feedTriggers.length !== 9 || feedTriggers.some(trigger => !/^trg_agent_[a-z_]+$/u.test(trigger.name))) {
    throw new Error('task-feed fixture requires the complete authoritative trigger set')
  }
  const task = db.prepare(`
    WITH digits(d) AS (
      VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
    ), sequence(value) AS (
      SELECT d0.d + 10*d1.d + 100*d2.d + 1000*d3.d + 10000*d4.d
      FROM digits d0
      CROSS JOIN digits d1
      CROSS JOIN digits d2
      CROSS JOIN digits d3
      CROSS JOIN digits d4
      WHERE d0.d + 10*d1.d + 100*d2.d + 1000*d3.d + 10000*d4.d < ?
    )
    INSERT INTO agent_integration_apply_tasks (
      id, plan_hash, operation_type, state, started_at, completed_at, updated_at
    )
    SELECT printf('task-%06d', value), printf('plan-%d', value),
           'connect', 'completed', ?, ?, ?
    FROM sequence
  `)
  const item = db.prepare(`
    INSERT INTO agent_integration_apply_task_items (
      task_id, installation_id, ordinal, execution_plan_hash, state,
      result_json, started_at, completed_at, updated_at
    )
    SELECT id, 'installation-1', 0,
           CASE WHEN ? IS NULL THEN printf('execution-%d', CAST(substr(id, 6) AS INTEGER)) ELSE ? END,
           ?, ?, ?, ?, ?
    FROM agent_integration_apply_tasks
    WHERE id LIKE 'task-%'
  `)
  db.transaction(() => {
    // These rows represent a pre-existing durable history. Loading 200k rows
    // through per-row cursor triggers blocks the Vitest worker RPC without
    // exercising the read path under test. Preserve and restore the exact
    // schema-owned trigger SQL, then publish one revision for the bulk load.
    for (const trigger of feedTriggers) db.exec(`DROP TRIGGER ${trigger.name}`)
    task.run(count, T0, T0, T0)
    const interrupted = options.interrupted === true
    item.run(
      options.executionPlanHash ?? null,
      options.executionPlanHash ?? null,
      interrupted ? 'interrupted' : 'terminal',
      JSON.stringify(interrupted
        ? { installationId: 'installation-1', status: 'interrupted' }
        : { installationId: 'installation-1', status: 'failed', reason: 'fixture' }),
      T0,
      T0,
      T0,
    )
    db.prepare(`
      UPDATE agent_integration_apply_task_feed_state
      SET revision = revision + 1 WHERE singleton = 1
    `).run()
    db.exec(`${feedTriggers.map(trigger => trigger.sql).join(';\n')};`)
  }).immediate()
}

function traverse(repository: AgentIntegrationRepository, limit: number) {
  const keys: string[] = []
  let cursor: string | undefined
  let firstPage: ReturnType<AgentIntegrationRepository['listApplyTaskFeedPage']> | undefined
  do {
    const page = repository.listApplyTaskFeedPage({ limit, cursor, nowMs: Date.parse(T0) + 60_000 })
    firstPage ??= page
    expect(page.entries.length).toBeLessThanOrEqual(limit)
    expect(page.startIndex).toBe(keys.length)
    keys.push(...page.entries.map(entry => entry.key))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return { keys, firstPage: firstPage! }
}

describe('Agent Integration bounded versioned task feed', () => {
  it('pages 10k attention tasks without gaps, duplicates, or full DTO pages', { timeout: 60_000 }, () => {
    const { db, repository } = setup()
    seedTasks(db, 10_000)

    const startedAt = performance.now()
    const { keys, firstPage } = traverse(repository, 50)
    const elapsedMs = performance.now() - startedAt

    expect(firstPage.attentionCount).toBe(10_000)
    expect(firstPage.activeCount).toBe(0)
    expect(firstPage.totalCount).toBe(10_000)
    expect(firstPage.hasPrevious).toBe(false)
    expect(firstPage.hasMore).toBe(true)
    expect(keys).toHaveLength(10_000)
    expect(new Set(keys).size).toBe(10_000)
    expect(keys.every(key => key.startsWith('task:'))).toBe(true)
    // A generous regression ceiling: this measures the main-process path,
    // including global authority classification and 200 physical page reads.
    expect(elapsedMs).toBeLessThan(30_000)
  })

  it('keeps 10k ambiguous legacy tasks and every candidate run page-addressable', { timeout: 60_000 }, () => {
    const { db, repository } = setup()
    seedTasks(db, 10_000, { executionPlanHash: 'ambiguous-execution', interrupted: true })
    for (const [id, offset] of [['run-ambiguous-a', 20_000], ['run-ambiguous-b', 20_001]] as const) {
      repository.createReconcileRun({
        id, installationId: 'installation-1', operationType: 'connect',
        executionPlanHash: 'ambiguous-execution', recoveryStrategy: 'resume',
        createdAt: new Date(Date.parse(T0) + offset).toISOString(),
      })
    }

    const { keys, firstPage } = traverse(repository, 50)
    expect(firstPage.attentionCount).toBe(10_002)
    expect(firstPage.activeCount).toBe(0)
    expect(firstPage.totalCount).toBe(10_002)
    expect(keys).toHaveLength(10_002)
    expect(new Set(keys).size).toBe(10_002)
    expect(keys).toContain('run:run-ambiguous-a')
    expect(keys).toContain('run:run-ambiguous-b')
  })

  it('keeps the 100k lightweight authority/ref build bounded before page DTO hydration', { timeout: 60_000 }, () => {
    const { db, repository } = setup()
    seedTasks(db, 100_000)
    const rssBefore = process.memoryUsage().rss
    const startedAt = performance.now()
    const page = repository.listApplyTaskFeedPage({ limit: 50, nowMs: Date.parse(T0) + 60_000 })
    const elapsedMs = performance.now() - startedAt
    const rssDeltaBytes = Math.max(0, process.memoryUsage().rss - rssBefore)
    console.info(JSON.stringify({ metric: 'agent_task_feed_100k', elapsedMs, rssDeltaBytes }))

    expect(page.totalCount).toBe(100_000)
    expect(page.attentionCount).toBe(100_000)
    expect(page.activeCount).toBe(0)
    expect(page.entries).toHaveLength(50)
    expect(elapsedMs).toBeLessThan(15_000)
    expect(rssDeltaBytes).toBeLessThan(512 * 1024 * 1024)
  })

  it('keeps the page statement count and hydrated DTO cardinality independent of total rows', () => {
    const measureStatements = (taskCount: number) => {
      const statements: string[] = []
      const db = new Database(':memory:', { verbose: statement => statements.push(statement) })
      ensureSchema(db)
      const repository = new AgentIntegrationRepository(db)
      repository.upsertDiscoveredInstallation({
        id: 'installation-1', family: 'cursor', hostVariant: 'cursor-desktop',
        installKey: 'cursor:feed', provenance: 'test', displayName: 'Cursor',
        supportedCapability: 4, lastDetectedAt: T0,
      })
      seedTasks(db, taskCount)
      statements.length = 0
      const page = repository.listApplyTaskFeedPage({ limit: 10, nowMs: Date.parse(T0) })
      return {
        statementCount: statements.length,
        entryCount: page.entries.length,
        hydratedItemCount: page.entries.flatMap(entry => 'task' in entry ? entry.task.items : []).length,
      }
    }
    expect(measureStatements(10)).toEqual(measureStatements(10_000))
    expect(measureStatements(10_000)).toEqual({
      statementCount: expect.any(Number),
      entryCount: 10,
      hydratedItemCount: 10,
    })
  })

  it('binds cursors to the exact decimal revision and rejects stale revisions', () => {
    const { db, repository } = setup()
    seedTasks(db, 2)
    db.prepare(`
      UPDATE agent_integration_apply_task_feed_state
      SET revision = 9007199254740993 WHERE singleton = 1
    `).run()
    const page = repository.listApplyTaskFeedPage({ limit: 1, nowMs: Date.parse(T0) })
    expect(page.nextCursor).not.toBeNull()
    const cursorPayload = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString('utf8'))
    expect(cursorPayload.revision).toBe('9007199254740993')
    expect(cursorPayload.snapshotAtMs).toBe(Date.parse(T0))

    db.prepare(`UPDATE agent_integration_apply_tasks SET updated_at = ? WHERE id = ?`)
      .run('2026-08-26T00:01:00.000Z', 'task-000000')
    expect(() => repository.listApplyTaskFeedPage({
      limit: 1,
      cursor: page.nextCursor!,
      nowMs: Date.parse(T0),
    })).toThrow('stale_task_feed_cursor')
  })

  it('round-trips previous and next keyset pages in the exact total order', () => {
    const { db, repository } = setup()
    seedTasks(db, 120)
    const input = { limit: 50, nowMs: Date.parse(T0) }
    const first = repository.listApplyTaskFeedPage(input)
    const second = repository.listApplyTaskFeedPage({ ...input, cursor: first.nextCursor! })
    const third = repository.listApplyTaskFeedPage({ ...input, cursor: second.nextCursor! })
    const previous = repository.listApplyTaskFeedPage({ ...input, cursor: third.previousCursor! })

    expect(first.startIndex).toBe(0)
    expect(second.startIndex).toBe(50)
    expect(third.startIndex).toBe(100)
    expect(third.entries).toHaveLength(20)
    expect(previous.startIndex).toBe(50)
    expect(previous.entries.map(entry => entry.key)).toEqual(second.entries.map(entry => entry.key))
  })

  it('freezes the presentation clock across a cursor traversal', () => {
    const { repository } = setup()
    for (let index = 0; index < 60; index += 1) {
      const id = `run-recent-${String(index).padStart(2, '0')}`
      repository.createReconcileRun({
        id, installationId: 'installation-1', operationType: 'connect',
        executionPlanHash: `execution-${index}`, recoveryStrategy: 'resume', createdAt: T0,
      })
      repository.transitionRunState(id, 'planned', 'committed', T0)
    }
    const first = repository.listApplyTaskFeedPage({ limit: 50, nowMs: Date.parse(T0) + 1_000 })
    const second = repository.listApplyTaskFeedPage({
      limit: 50,
      cursor: first.nextCursor!,
      nowMs: Date.parse(T0) + 7 * 24 * 60 * 60 * 1_000,
    })
    expect(first.totalCount).toBe(60)
    expect(second.totalCount).toBe(60)
    expect(second.startIndex).toBe(50)
    expect(second.entries).toHaveLength(10)
  })

  it('revalidates a pinned run against exact and unique legacy owners', () => {
    const { db, repository } = setup()
    repository.createReconcileRun({
      id: 'run-pinned', installationId: 'installation-1', operationType: 'connect',
      executionPlanHash: 'pin-execution', recoveryStrategy: 'resume', createdAt: T0,
    })
    expect(repository.getApplyTaskFeedRun('run-pinned', Date.parse(T0))).toMatchObject({ id: 'run-pinned' })

    const task = db.prepare(`
      INSERT INTO agent_integration_apply_tasks (
        id, plan_hash, operation_type, state, started_at, completed_at, updated_at
      ) VALUES ('legacy-owner', 'legacy-owner', 'connect', 'completed', ?, ?, ?)
    `)
    const item = db.prepare(`
      INSERT INTO agent_integration_apply_task_items (
        task_id, installation_id, ordinal, execution_plan_hash, state,
        result_json, started_at, completed_at, updated_at
      ) VALUES ('legacy-owner', 'installation-1', 0, 'pin-execution', 'interrupted', ?, ?, ?, ?)
    `)
    task.run(T0, T0, T0)
    item.run(JSON.stringify({ installationId: 'installation-1', status: 'interrupted' }), T0, T0, T0)
    expect(repository.getApplyTaskFeedRun('run-pinned', Date.parse(T0))).toBeUndefined()

    db.prepare(`DELETE FROM agent_integration_apply_tasks WHERE id = 'legacy-owner'`).run()
    repository.createApplyTask({
      id: 'exact-owner', planHash: 'exact-owner', startedAt: T0,
      items: [{ installationId: 'installation-1', executionPlanHash: 'pin-execution' }],
    })
    db.prepare(`UPDATE agent_integration_apply_task_items SET run_id = ? WHERE task_id = ?`)
      .run('run-pinned', 'exact-owner')
    expect(repository.getApplyTaskFeedRun('run-pinned', Date.parse(T0))).toBeUndefined()
  })

  it('overlays every unique legacy run in a multi-Installation durable task', () => {
    const { db, repository } = setup()
    repository.upsertDiscoveredInstallation({
      id: 'installation-2', family: 'cursor', hostVariant: 'cursor-desktop',
      installKey: 'cursor:feed-2', provenance: 'test', displayName: 'Cursor 2',
      supportedCapability: 4, lastDetectedAt: T0,
    })
    db.prepare(`
      INSERT INTO agent_integration_apply_tasks (
        id, plan_hash, operation_type, state, started_at, completed_at, updated_at
      ) VALUES ('legacy-batch', 'legacy-batch', 'connect', 'completed', ?, ?, ?)
    `).run(T0, T0, T0)
    const item = db.prepare(`
      INSERT INTO agent_integration_apply_task_items (
        task_id, installation_id, ordinal, execution_plan_hash, state,
        result_json, started_at, completed_at, updated_at
      ) VALUES ('legacy-batch', ?, ?, ?, 'interrupted', ?, ?, ?, ?)
    `)
    item.run('installation-1', 0, 'execution-a', JSON.stringify({
      installationId: 'installation-1', status: 'interrupted',
    }), T0, T0, T0)
    item.run('installation-2', 1, 'execution-b', JSON.stringify({
      installationId: 'installation-2', status: 'interrupted',
    }), T0, T0, T0)
    for (const [id, installationId, executionPlanHash] of [
      ['run-a', 'installation-1', 'execution-a'],
      ['run-b', 'installation-2', 'execution-b'],
    ] as const) {
      repository.createReconcileRun({
        id, installationId, operationType: 'connect', executionPlanHash,
        recoveryStrategy: 'resume', createdAt: T0,
      })
      repository.transitionRunState(id, 'planned', 'committed', T0)
    }

    const page = repository.listApplyTaskFeedPage({ limit: 50, nowMs: Date.parse(T0) })
    expect(page.totalCount).toBe(1)
    expect(page.entries).toEqual([
      expect.objectContaining({
        key: 'task:legacy-batch',
        overlayRuns: [expect.objectContaining({ id: 'run-a' }), expect.objectContaining({ id: 'run-b' })],
      }),
    ])
    expect(repository.getApplyTaskFeedTask('legacy-batch')).toEqual(expect.objectContaining({
      task: expect.objectContaining({ id: 'legacy-batch' }),
      overlayRuns: [expect.objectContaining({ id: 'run-a' }), expect.objectContaining({ id: 'run-b' })],
    }))
  })

  it('keeps a forged exact-run payload in attention instead of sorting it as success', () => {
    const { db, repository } = setup()
    repository.createReconcileRun({
      id: 'run-exact', installationId: 'installation-1', operationType: 'connect',
      executionPlanHash: 'execution-exact', recoveryStrategy: 'resume', createdAt: T0,
    })
    repository.transitionRunState('run-exact', 'planned', 'committed', T0)
    repository.createApplyTask({
      id: 'task-forged', planHash: 'task-forged', startedAt: T0,
      items: [{ installationId: 'installation-1', executionPlanHash: 'execution-exact' }],
    })
    db.prepare(`
      UPDATE agent_integration_apply_task_items
      SET run_id = 'run-exact', state = 'terminal', result_json = ?, completed_at = ?, updated_at = ?
      WHERE task_id = 'task-forged'
    `).run(JSON.stringify({
      installationId: 'installation-1', status: 'committed', runId: 'forged-run',
    }), T0, T0)
    repository.completeApplyTask('task-forged', T0)

    const page = repository.listApplyTaskFeedPage({ limit: 50, nowMs: Date.parse(T0) })
    expect(page.attentionCount).toBe(1)
    expect(page.entries).toEqual([expect.objectContaining({ key: 'task:task-forged', priority: 1 })])
  })

  it('keeps a running durable ledger first even when its exact run already committed', () => {
    const { db, repository } = setup()
    repository.createReconcileRun({
      id: 'run-committed-before-task', installationId: 'installation-1', operationType: 'connect',
      executionPlanHash: 'execution-barrier', recoveryStrategy: 'resume', createdAt: T0,
    })
    repository.transitionRunState('run-committed-before-task', 'planned', 'committed', T0)
    repository.createApplyTask({
      id: 'task-still-running', planHash: 'task-still-running', startedAt: T0,
      items: [{ installationId: 'installation-1', executionPlanHash: 'execution-barrier' }],
    })
    db.prepare(`
      UPDATE agent_integration_apply_task_items
      SET run_id = 'run-committed-before-task', state = 'terminal', result_json = ?,
          started_at = ?, completed_at = ?, updated_at = ?
      WHERE task_id = 'task-still-running'
    `).run(JSON.stringify({
      installationId: 'installation-1', status: 'committed', runId: 'run-committed-before-task',
    }), T0, T0, T0)

    const page = repository.listApplyTaskFeedPage({ limit: 50, nowMs: Date.parse(T0) })
    expect(page.entries).toEqual([
      expect.objectContaining({ key: 'task:task-still-running', priority: 0 }),
    ])
    expect(page.attentionCount).toBe(0)
    expect(page.activeCount).toBe(1)
  })
})
