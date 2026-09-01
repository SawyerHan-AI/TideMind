import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Json } from '../../client/electron/agent-integration/fingerprint'
import {
  applyJsonProjection,
  inspectJsonProjection,
  planJsonProjection,
} from '../../client/electron/agent-integration/json-projection'

describe('selector-level managed JSON projection', () => {
  let root: string
  let target: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-json-projection-'))
    target = path.join(root, 'config.json')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates only the approved selector and preserves unrelated fields', () => {
    fs.writeFileSync(target, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other' } } }))
    const desired = { command: '/app/tm-node', args: ['/app/mcp.cjs'], env: { EB_AGENT_ID: 'eb_1' } }
    const plan = planJsonProjection({
      targetPath: target,
      selector: ['mcpServers', 'tidemind-eb_1'],
      desiredFragment: desired,
      ownedFragmentHash: null,
    })

    expect(plan.action).toBe('create')
    applyJsonProjection(plan)
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({
      theme: 'dark',
      mcpServers: { other: { command: 'other' }, 'tidemind-eb_1': desired },
    })
  })

  it('refuses to adopt an occupied selector without ownership evidence', () => {
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { tidemind: { command: 'someone-else' } } }))
    const plan = planJsonProjection({
      targetPath: target,
      selector: ['mcpServers', 'tidemind'],
      desiredFragment: { command: '/managed' },
      ownedFragmentHash: null,
    })
    expect(plan).toMatchObject({ action: 'conflict', conflictReason: 'selector_already_occupied' })
    expect(() => applyJsonProjection(plan)).toThrow(/selector_already_occupied/)
  })

  it('does not adopt an identical fragment based on content coincidence alone', () => {
    const desired = { command: '/managed' }
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { tidemind: desired } }))
    expect(planJsonProjection({
      targetPath: target,
      selector: ['mcpServers', 'tidemind'],
      desiredFragment: desired,
      ownedFragmentHash: null,
    })).toMatchObject({
      action: 'conflict',
      conflictReason: 'matching_selector_has_no_ownership_evidence',
    })
  })

  it('updates only when the live fragment still matches the owned hash', () => {
    const old = { command: '/old' }
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { tidemind: old }, keep: true }))
    const plan = planJsonProjection({
      targetPath: target,
      selector: ['mcpServers', 'tidemind'],
      desiredFragment: { command: '/new' },
      ownedFragmentHash: sha256Json(old),
    })
    expect(plan.action).toBe('update')
    expect(applyJsonProjection(plan).fragmentHash).toBe(sha256Json({ command: '/new' }))
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).keep).toBe(true)
  })

  it('fails closed when the user modifies the owned fragment', () => {
    const original = { command: '/old' }
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { tidemind: { command: '/user-edit' } } }))
    expect(planJsonProjection({
      targetPath: target,
      selector: ['mcpServers', 'tidemind'],
      desiredFragment: { command: '/new' },
      ownedFragmentHash: sha256Json(original),
    })).toMatchObject({ action: 'conflict', conflictReason: 'owned_fragment_modified' })
  })

  it('re-checks the whole container before apply and preserves a concurrent edit', () => {
    fs.writeFileSync(target, JSON.stringify({ mcpServers: {}, value: 1 }))
    const plan = planJsonProjection({
      targetPath: target,
      selector: ['mcpServers', 'tidemind'],
      desiredFragment: { command: '/managed' },
      ownedFragmentHash: null,
    })
    fs.writeFileSync(target, JSON.stringify({ mcpServers: {}, value: 2 }))

    expect(() => applyJsonProjection(plan)).toThrow(/container_precondition_changed/)
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).value).toBe(2)
  })

  it('removes an exact owned fragment and keeps sibling servers', () => {
    const managed = { command: '/managed' }
    fs.writeFileSync(target, JSON.stringify({ mcpServers: { tidemind: managed, other: { command: '/other' } } }))
    const plan = planJsonProjection({
      targetPath: target,
      selector: ['mcpServers', 'tidemind'],
      desiredFragment: undefined,
      ownedFragmentHash: sha256Json(managed),
    })
    expect(plan.action).toBe('remove')
    applyJsonProjection(plan)
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ mcpServers: { other: { command: '/other' } } })
  })

  it('rejects malformed containers and prototype-polluting selectors', () => {
    fs.writeFileSync(target, '{')
    expect(() => inspectJsonProjection(target, ['mcpServers', 'tidemind'])).toThrow(/malformed/)
    expect(() => inspectJsonProjection(target, ['__proto__'])).toThrow(/invalid_json_selector/)
  })
})
