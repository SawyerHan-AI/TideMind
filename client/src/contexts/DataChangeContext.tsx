/**
 * 数据变更 Context
 *
 * 监听主进程推送的 'data-changed' 事件，
 * 提供 useDataRevision() hook 让页面组件自动感知后端数据变更。
 */

import { createContext, useContext, useEffect, useState, useRef } from 'react'

interface DataChangeState {
  /** 每次后端数据变更时递增 */
  revision: number
  /** 最近一次变更涉及的范围 */
  lastScopes: string[]
}

const DataChangeContext = createContext<DataChangeState>({ revision: 0, lastScopes: [] })

export function DataChangeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DataChangeState>({ revision: 0, lastScopes: [] })

  useEffect(() => {
    const cleanup = window.api.onDataChanged(({ scopes }) => {
      setState(prev => ({ revision: prev.revision + 1, lastScopes: scopes }))
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
 * 将其加入 useIPC 的 deps 数组即可实现自动刷新。
 *
 * @param scopes 可选，只在指定范围变化时才递增（如 ['nodes', 'links']）
 */
export function useDataRevision(scopes?: string[]): number {
  const { revision, lastScopes } = useContext(DataChangeContext)
  const stableRevision = useRef(0)

  // 有 scope 过滤 → 只在相关范围变化时更新稳定值；无 scope 过滤时每次变更都更新
  const relevant = !scopes || lastScopes.length === 0 || lastScopes.some(s => scopes.includes(s))

  useEffect(() => {
    if (relevant) {
      stableRevision.current = revision
    }
  }, [relevant, revision])

  // 无 scope 过滤 → 直接返回原始 revision（始终最新）
  // 有 scope 过滤 → 返回稳定值（仅在相关范围变化时递增）
  if (!scopes) return revision
  return stableRevision.current
}
