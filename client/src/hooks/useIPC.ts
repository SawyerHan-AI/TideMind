import { useState, useEffect, useCallback, useRef } from 'react'
import { useMountedRef } from './useMountedRef'

/**
 * 异步数据获取 hook。组件挂载时自动调用 `fetcher`,并在 `fetcher` 引用变化时
 * 重新执行。返回 `{ data, loading, error, refetch }`。
 *
 * **caller 必须用 `useCallback` 把 `fetcher` 包好,并显式列全所有捕获的变量。**
 * 旧签名 `useIPC(fetcher, deps)` 把 deps 单独传入,容易漏列 fetcher 内部捕获的
 * 变量(eslint react-hooks/exhaustive-deps 检查不到 hook 内部的 deps 参数),
 * 触发 stale closure 类 bug。新签名直接把 deps 检查权交还给 React 编译器/eslint,
 * 漏列的 caller 在 lint 阶段就会被打回来,而不是在线上被用户撞到。
 *
 * 示例:
 * ```typescript
 * const fetchData = useCallback(
 *   () => window.api.list({ filter, rev }),
 *   [filter, rev],
 * )
 * const { data } = useIPC(fetchData)
 * ```
 *
 * 实现说明:所有 setState 都加 mounted 守卫(2026-05-21 HIGH 修复),避免组件
 * unmount 后 React 警告 + 内存泄漏。
 */
export function useIPC<T>(fetcher: () => Promise<T>): {
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

  useEffect(() => {
    void execute(true)
    return () => {
      requestSequence.current += 1
    }
  }, [execute])

  return { data, loading, error, refetch }
}
