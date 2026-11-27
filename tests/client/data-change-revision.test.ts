import { describe, expect, it } from 'vitest'
import {
  INITIAL_DATA_CHANGE_STATE,
  applyDataChange,
  selectDataRevision,
} from '../../client/src/contexts/DataChangeContext.tsx'

describe('data change revision bookkeeping', () => {
  it('keeps a relevant change visible after an unrelated change follows it', () => {
    const afterNodes = applyDataChange(INITIAL_DATA_CHANGE_STATE, ['nodes'])
    const nodesRevision = selectDataRevision(afterNodes, ['nodes'])
    expect(nodesRevision).toBeGreaterThan(selectDataRevision(INITIAL_DATA_CHANGE_STATE, ['nodes']))

    const afterCloud = applyDataChange(afterNodes, ['cloud'])
    expect(selectDataRevision(afterCloud, ['nodes'])).toBe(nodesRevision)
    expect(selectDataRevision(afterCloud, ['cloud'])).toBeGreaterThan(nodesRevision)
  })

  it('returns the newest revision among the subscribed scopes', () => {
    let state = applyDataChange(INITIAL_DATA_CHANGE_STATE, ['nodes'])
    state = applyDataChange(state, ['timeline'])
    state = applyDataChange(state, ['cloud'])
    expect(selectDataRevision(state, ['nodes', 'links', 'timeline'])).toBe(2)
    expect(selectDataRevision(state, ['links'])).toBe(0)
  })

  it('returns 0 before any change arrives', () => {
    expect(selectDataRevision(INITIAL_DATA_CHANGE_STATE, ['nodes'])).toBe(0)
    expect(selectDataRevision(INITIAL_DATA_CHANGE_STATE)).toBe(0)
  })

  it('records one revision on every scope carried by a single change', () => {
    const state = applyDataChange(
      applyDataChange(INITIAL_DATA_CHANGE_STATE, ['cloud']),
      ['cloud', 'nodes', 'links'],
    )
    expect(selectDataRevision(state, ['nodes'])).toBe(2)
    expect(selectDataRevision(state, ['links'])).toBe(2)
    expect(selectDataRevision(state, ['cloud'])).toBe(2)
  })

  it('advances on every change when no scope is given', () => {
    let state = applyDataChange(INITIAL_DATA_CHANGE_STATE, ['cloud'])
    expect(selectDataRevision(state)).toBe(1)
    state = applyDataChange(state, ['structure-holes'])
    expect(selectDataRevision(state)).toBe(2)
  })

  it('does not mutate the previous state', () => {
    const first = applyDataChange(INITIAL_DATA_CHANGE_STATE, ['nodes'])
    applyDataChange(first, ['nodes'])
    expect(selectDataRevision(first, ['nodes'])).toBe(1)
    expect(INITIAL_DATA_CHANGE_STATE.scopeRevisions).toEqual({})
  })
})
