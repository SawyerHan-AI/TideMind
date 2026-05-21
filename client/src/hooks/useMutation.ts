import { useState, useCallback } from 'react'
import { useMountedRef } from './useMountedRef'

export function useMutation<TResult, TArgs extends unknown[] = []>(
  mutator: (...args: TArgs) => Promise<TResult>,
): {
  mutate: (...args: TArgs) => Promise<TResult | null>
  loading: boolean
  error: string | null
  data: TResult | null
  reset: () => void
} {
  const [data, setData] = useState<TResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // F11: mutate 后调用方可能已经 unmount(navigate / 父组件条件渲染切换),
  // 所有 setState 都加 mounted 守卫,避免 React 警告 + 内存泄漏。
  const mountedRef = useMountedRef()

  const mutate = useCallback(async (...args: TArgs) => {
    if (mountedRef.current) {
      setLoading(true)
      setError(null)
    }
    try {
      const result = await mutator(...args)
      if (mountedRef.current) setData(result)
      return result
    } catch (err) {
      if (mountedRef.current) setError((err as Error).message)
      return null
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [mutator, mountedRef])

  const reset = useCallback(() => {
    if (!mountedRef.current) return
    setData(null)
    setError(null)
    setLoading(false)
  }, [mountedRef])

  return { mutate, loading, error, data, reset }
}
