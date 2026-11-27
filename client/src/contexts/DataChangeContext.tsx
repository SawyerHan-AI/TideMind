/**
 * 数据变更 Context
 *
 * 监听主进程推送的 'data-changed' 事件，
 * 提供 useDataRevision() hook 让页面组件自动感知后端数据变更。
 */

import { createContext, useContext, useEffect, useState } from 'react'

export interface DataChangeState {
  /** 每次后端数据变更时递增 */
  revision: number
  /** 每个范围最近一次变更时的 revision */
  scopeRevisions: Record<string, number>
}

export const INITIAL_DATA_CHANGE_STATE: DataChangeState = Object.freeze({
  revision: 0,
  scopeRevisions: Object.freeze({}),
}) as DataChangeState

/**
 * 记录一次变更。每个范围各自记下这次的 revision,而不是只保存最后一次事件的范围:
 * 两次事件被合并进同一次渲染时,先到的相关事件不会被后到的无关事件盖掉。
 */
export function applyDataChange(state: DataChangeState, scopes: string[]): DataChangeState {
  const revision = state.revision + 1
  const scopeRevisions = { ...state.scopeRevisions }
  for (const scope of scopes) scopeRevisions[scope] = revision
  return { revision, scopeRevisions }
}

/** 取所订阅范围里最新的 revision;不传范围时取总 revision。 */
export function selectDataRevision(state: DataChangeState, scopes?: string[]): number {
  if (!scopes) return state.revision
  let latest = 0
  for (const scope of scopes) {
    const scopeRevision = state.scopeRevisions[scope] ?? 0
    if (scopeRevision > latest) latest = scopeRevision
  }
  return latest
}

const DataChangeContext = createContext<DataChangeState>(INITIAL_DATA_CHANGE_STATE)

export function DataChangeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DataChangeState>(INITIAL_DATA_CHANGE_STATE)

  useEffect(() => {
    const cleanup = window.api.onDataChanged(({ scopes }) => {
      setState(prev => applyDataChange(prev, scopes))
    })
    return cleanup
  }, [])

  return (
    <DataChangeContext.Provider value={state}>
      {children}
    </DataChangeContext.Provider>
  )
}

/**
 * 返回一个 revision 数字，每次后端数据变更时递增。
 * 把它作为 useIPC 的第二个参数传入即可实现自动刷新。
 *
 * 返回值直接由 context 算出:组件挂载时拿到的就是当前值,不会在挂载后再跳一次。
 *
 * @param scopes 可选，只在指定范围变化时才递增（如 ['nodes', 'links']）
 */
export function useDataRevision(scopes?: string[]): number {
  return selectDataRevision(useContext(DataChangeContext), scopes)
}
