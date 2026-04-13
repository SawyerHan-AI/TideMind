import { useState, useCallback } from 'react'

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

  const mutate = useCallback(async (...args: TArgs) => {
    setLoading(true)
    setError(null)
    try {
      const result = await mutator(...args)
      setData(result)
      return result
    } catch (err) {
      setError((err as Error).message)
      return null
    } finally {
      setLoading(false)
    }
  }, [mutator])

  const reset = useCallback(() => {
    setData(null)
    setError(null)
    setLoading(false)
  }, [])

  return { mutate, loading, error, data, reset }
}
