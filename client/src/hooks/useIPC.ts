import { useState, useEffect, useCallback, useRef } from 'react'
import { useMountedRef } from './useMountedRef'

/**
 * 异步数据获取 hook。返回 `{ data, loading, error, refetch }`。
 *
 * 两种变化分开处理:
 * - `fetcher` 引用变化:查询对象变了(换筛选、翻页、切换节点)。清空已有数据并
 *   进入 loading,不让上一个对象的数据短暂留在界面上。
 * - `refreshKey` 变化:同一个查询的数据更新了(后台同步、Agent 写入)。静默重取,
 *   已有数据保留到新数据到达,不显示 loading。
 * 两者在同一次渲染里都变时按前者处理,只请求一次。
 *
 * **caller 必须用 `useCallback` 把 `fetcher` 包好,并显式列全所有捕获的变量。**
 * 数据版本号(`useDataRevision` 的返回值)不要放进 `useCallback` 的依赖,而是作为
 * `refreshKey` 传入;放进依赖会让每次后台数据更新都被当成查询对象变化,页面退回
 * 骨架屏再重新挂载。`refreshKey` 必须是 string / number 这类原始值。
 *
 * 示例:
 * ```typescript
 * const rev = useDataRevision(['nodes'])
 * const fetchData = useCallback(
 *   () => window.api.list({ filter }),
 *   [filter],
 * )
 * const { data } = useIPC(fetchData, rev)
 * ```
 *
 * 实现说明:所有 setState 都加 mounted 守卫(2026-05-21 HIGH 修复),避免组件
 * unmount 后 React 警告 + 内存泄漏。
 */
export function useIPC<T>(fetcher: () => Promise<T>, refreshKey?: string | number): {
  data: T | null
  loading: boolean
  error: string | null
  refetch: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const hasData = useRef(false)
  const requestSequence = useRef(0)
  const lastExecute = useRef<((resetForFetcherChange: boolean) => Promise<void>) | null>(null)
  const mountedRef = useMountedRef()

  const execute = useCallback(async (resetForFetcherChange: boolean) => {
    const sequence = ++requestSequence.current
    if (resetForFetcherChange && mountedRef.current) {
      hasData.current = false
      setData(null)
      setLoading(true)
    }
    // 已有数据时静默刷新（不显示 loading 骨架屏）
    if (mountedRef.current && !hasData.current) setLoading(true)
    if (mountedRef.current) setError(null)
    try {
      const result = await fetcher()
      if (mountedRef.current && requestSequence.current === sequence) {
        setData(result)
        hasData.current = true
      }
    } catch (err) {
      if (mountedRef.current && requestSequence.current === sequence) {
        setError((err as Error).message)
      }
    } finally {
      if (mountedRef.current && requestSequence.current === sequence) setLoading(false)
    }
    // mountedRef 是 ref(身份稳定),deps 只列 fetcher。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher])

  const refetch = useCallback(() => {
    void execute(false)
  }, [execute])

  // 单个 effect 同时响应两种变化,在内部判断这次是不是 fetcher 变了。拆成两个
  // effect 的话,"两者同时变化只请求一次"要靠 effect 的声明顺序来保证。
  useEffect(() => {
    const fetcherChanged = lastExecute.current !== execute
    lastExecute.current = execute
    void execute(fetcherChanged)
    return () => {
      requestSequence.current += 1
    }
  }, [execute, refreshKey])

  return { data, loading, error, refetch }
}
