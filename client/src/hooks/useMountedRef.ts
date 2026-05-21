import { useEffect, useRef } from 'react'

/**
 * 返回一个 ref,在组件挂载期间为 true,unmount 后为 false。
 *
 * F11: 用于异步操作完成后判断是否还应 setState,避免 React 18+ 在
 * dev mode StrictMode 下 "Can't perform a React state update on an
 * unmounted component" 警告以及对应的内存泄漏。
 *
 * 用法:
 *   const mountedRef = useMountedRef()
 *   // ...
 *   const data = await fetch(...)
 *   if (mountedRef.current) setState(data)
 */
export function useMountedRef() {
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  return mountedRef
}
