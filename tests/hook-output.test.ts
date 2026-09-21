import { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { ensureSchema } from '../src/db/schema'
import { recordHookActivityEvidence } from '../src/db/agent-host-activity'
import { sha256Json } from '../client/electron/agent-integration/fingerprint'
import {
  formatHookOutput,
  writeHookOutput,
  writeHookOutputBeforeEvidence,
  writeSerializedHookOutputBeforeEvidence,
} from '../src/hook-output'

const ACTIVITY_TOKEN = 'hook-output-generation'
const AGENT_ID = 'eb_hook_output'

function lifecycleEvidenceDb(): Database.Database {
  const db = new Database(':memory:')
  ensureSchema(db)
  const createdAt = '2026-09-05T00:00:00.000Z'
  db.prepare(`INSERT INTO agents (id, name, tool_type, archived, created)
    VALUES (?, 'Hook output fixture', 'opencode', 0, ?)`).run(AGENT_ID, createdAt)
  db.prepare(`INSERT INTO agent_installations (
      id, family, host_variant, runtime_realm, profile_id, install_key,
      provenance, display_name, detected_version, agent_id, desired_state,
      supported_capability, desired_capability, health_state, created_at, updated_at
    ) VALUES (
      'installation-hook-output', 'opencode', 'opencode-v1-cli', 'local_macos',
      'default', 'opencode:hook-output', 'fixture', 'OpenCode', '1.18.28', ?,
      'managed', 4, 4, 'discovered', ?, ?
    )`).run(AGENT_ID, createdAt, createdAt)
  db.prepare(`INSERT INTO managed_artifacts (
      id, component_type, target_path, ownership_key, mutation_domain,
      projection_version, selector_schema_version, owned_fragment_hash,
      observed_fragment_hash, state, created_at, updated_at
    ) VALUES (
      'artifact-hook-output', 'hook', '/fixture/hook-output', 'document',
      'local_macos:file:/fixture/hook-output:document', '1', '1',
      'owned-hash', 'owned-hash', 'healthy', ?, ?
    )`).run(createdAt, createdAt)
  db.prepare(`INSERT INTO installation_components (
      installation_id, component_key, desired_state, desired_capability,
      delivery_mode, verification_status, artifact_id, visibility_state,
      created_at, updated_at
    ) VALUES (
      'installation-hook-output', 'lifecycle', 'managed', 4, 'managed',
      'unverified', 'artifact-hook-output', 'dedicated', ?, ?
    )`).run(createdAt, createdAt)
  db.prepare(`INSERT INTO artifact_consumers (
      artifact_id, installation_id, component_key, required_capability,
      desired_state, discover_reachability, state, added_at, updated_at
    ) VALUES (
      'artifact-hook-output', 'installation-hook-output', 'lifecycle', 4,
      'managed', 'dedicated', 'active', ?, ?
    )`).run(createdAt, createdAt)
  db.prepare(`INSERT INTO reconcile_runs (
      id, installation_id, operation_type, execution_plan_hash, state,
      recovery_strategy, adapter_version, catalog_version, projection_version,
      selector_schema_version, prepared_plan_json, desired_capability,
      created_at, updated_at
    ) VALUES (
      'run-hook-output', 'installation-hook-output', 'connect', 'plan-hash', 'committed',
      'readback_before_replay', '1+1+1', '1', '1', '1', ?, 4, ?, ?
    )`).run(JSON.stringify({
      componentKeys: ['lifecycle'],
      activityGenerationToken: ACTIVITY_TOKEN,
      executionPlan: { activityGenerationTokenHash: sha256Json(ACTIVITY_TOKEN) },
    }), createdAt, createdAt)
  return db
}

describe('formatHookOutput', () => {
  it('returns plain text for Claude Code (default)', () => {
    expect(formatHookOutput('hello', 'claude-code')).toBe('hello')
  })

  it('returns plain text for an unknown tool (forward-compatible default)', () => {
    expect(formatHookOutput('something', 'unknown-tool')).toBe('something')
  })

  it.each(['codex', 'gemini'])('wraps content as JSON for %s', (tool) => {
    expect(JSON.parse(formatHookOutput('hello world', tool))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'hello world',
      },
    })
  })

  it.each(['codex', 'gemini'])('%s output is pure JSON (no leading/trailing text)', (tool) => {
    const output = formatHookOutput('x', tool)
    expect(output.startsWith('{')).toBe(true)
    expect(output.endsWith('}')).toBe(true)
    expect(() => JSON.parse(output)).not.toThrow()
  })

  it.each(['codex', 'gemini'])('escapes special characters in %s JSON output', (tool) => {
    const parsed = JSON.parse(formatHookOutput('quotes "x" and\nnewline', tool))
    expect(parsed.hookSpecificOutput.additionalContext).toBe('quotes "x" and\nnewline')
  })
})

class FixtureWriter extends EventEmitter {
  readonly chunks: string[] = []
  callback: ((error?: Error | null) => void) | null = null
  accepted = true

  write(chunk: string, callback: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk)
    this.callback = callback
    return this.accepted
  }
}

describe('hook stdout completion', () => {
  it('preserves bespoke serialized bytes and waits for callback plus drain before evidence', async () => {
    const writer = new FixtureWriter()
    writer.accepted = false
    const recordEvidence = vi.fn()
    const exactPayload = '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}\n'
    const pending = writeSerializedHookOutputBeforeEvidence(exactPayload, recordEvidence, writer)

    expect(writer.chunks).toEqual([exactPayload])
    writer.callback?.()
    await Promise.resolve()
    expect(recordEvidence).not.toHaveBeenCalled()
    writer.emit('drain')
    await pending
    expect(recordEvidence).toHaveBeenCalledOnce()
  })

  it('does not resolve before the exact write callback completes', async () => {
    const writer = new FixtureWriter()
    const completed = vi.fn()
    const pending = writeHookOutput('context', 'opencode', 'SessionStart', writer)
      .then(completed)

    await Promise.resolve()
    expect(writer.chunks).toEqual(['context'])
    expect(completed).not.toHaveBeenCalled()

    writer.callback?.()
    await pending
    expect(completed).toHaveBeenCalledOnce()
  })

  it('waits for drain after backpressure and rejects asynchronous EPIPE', async () => {
    const writer = new FixtureWriter()
    writer.accepted = false
    const completed = vi.fn()
    const pending = writeHookOutput('context', 'opencode', 'SessionStart', writer)
      .then(completed)

    writer.callback?.()
    await Promise.resolve()
    expect(completed).not.toHaveBeenCalled()
    writer.emit('drain')
    await pending
    expect(completed).toHaveBeenCalledOnce()

    const broken = new FixtureWriter()
    const recordEvidence = vi.fn()
    const failure = writeHookOutput('context', 'opencode', 'SessionStart', broken)
      .then(recordEvidence)
    broken.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
    await expect(failure).rejects.toMatchObject({ code: 'EPIPE' })
    expect(recordEvidence).not.toHaveBeenCalled()
    broken.callback?.()
  })

  it('rejects a write callback failure', async () => {
    const writer = new FixtureWriter()
    const failure = writeHookOutput('context', 'opencode', 'SessionStart', writer)
    writer.callback?.(Object.assign(new Error('async write failed'), { code: 'EIO' }))
    await expect(failure).rejects.toMatchObject({ code: 'EIO' })
  })

  it.each(['PreCompact', 'PostCompact'] as const)(
    'does not persist %s SQLite evidence when stdout fails asynchronously',
    async (eventName) => {
      const evidenceDb = lifecycleEvidenceDb()
      const writer = new FixtureWriter()
      const attempted = writeHookOutputBeforeEvidence('context', 'opencode', eventName, () => {
        const result = recordHookActivityEvidence(evidenceDb, {
          agentId: AGENT_ID,
          tool: 'opencode',
          signalName: eventName === 'PreCompact' ? 'pre_compact' : 'post_compact',
          tideMindVersion: '0.2.91',
          activityGenerationToken: ACTIVITY_TOKEN,
        })
        expect(result.status).toBe('recorded')
      }, writer)

      writer.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
      await expect(attempted).rejects.toMatchObject({ code: 'EPIPE' })
      expect(evidenceDb.prepare('SELECT signal_name FROM agent_host_activity_evidence').all()).toEqual([])
      evidenceDb.close()
    },
  )
})
