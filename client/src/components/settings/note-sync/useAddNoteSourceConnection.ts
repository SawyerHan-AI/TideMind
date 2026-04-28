import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppleNotesAccount,
  NoteSourceTestResult,
  PermissionCheckResult,
} from './types'
import { getToolLabel, TOOL_TYPES } from './toolTypes'

export function useAddNoteSourceConnection(step: number) {
  const [toolType, setToolType] = useState('logseq')
  const [name, setName] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [testResult, setTestResult] = useState<NoteSourceTestResult | null>(null)
  const [testing, setTesting] = useState(false)

  const [permissionResult, setPermissionResult] = useState<PermissionCheckResult | null>(null)
  const [checkingPermission, setCheckingPermission] = useState(false)
  const [appleAccounts, setAppleAccounts] = useState<AppleNotesAccount[]>([])
  const [selectedAccountZpks, setSelectedAccountZpks] = useState<Set<number>>(new Set())
  const [loadingAccounts, setLoadingAccounts] = useState(false)

  // 切换工具类型 / 路径时自增。in-flight 请求拍照 seq，回调时若 seq 已变则丢弃。
  // 防止用户在 test/check 进行中切换 toolType 后旧请求的结果误写入新 toolType 的状态。
  const requestSeqRef = useRef(0)

  useEffect(() => {
    if (!name) {
      setName(getToolLabel(toolType))
    }
  }, [name, toolType])

  const selectToolType = useCallback((nextToolType: string) => {
    requestSeqRef.current += 1
    setToolType(nextToolType)
    setSelectedPath('')
    setTestResult(null)
    setTesting(false)
    setPermissionResult(null)
    setCheckingPermission(false)
    setAppleAccounts([])
    setSelectedAccountZpks(new Set())
    setLoadingAccounts(false)

    if (!name || TOOL_TYPES.some(item => item.label === name)) {
      setName(getToolLabel(nextToolType))
    }
  }, [name])

  const checkAppleNotesPermission = useCallback(async () => {
    const seq = ++requestSeqRef.current
    setCheckingPermission(true)
    setPermissionResult(null)
    try {
      const result = await window.api.noteSources.appleNotesCheckPermission()
      if (requestSeqRef.current !== seq) return
      setPermissionResult(result)
      if (result.accessible) {
        setLoadingAccounts(true)
        try {
          const accounts = await window.api.noteSources.appleNotesListAccounts()
          if (requestSeqRef.current !== seq) return
          setAppleAccounts(accounts)
          setSelectedAccountZpks(new Set(accounts.map(account => account.zpk)))
        } finally {
          if (requestSeqRef.current === seq) setLoadingAccounts(false)
        }
      }
    } catch (err) {
      if (requestSeqRef.current !== seq) return
      setPermissionResult({ accessible: false, path: '', error: (err as Error).message })
    } finally {
      if (requestSeqRef.current === seq) setCheckingPermission(false)
    }
  }, [])

  useEffect(() => {
    if (step === 1 && toolType === 'apple-notes' && !permissionResult && !checkingPermission) {
      checkAppleNotesPermission()
    }
  }, [step, toolType, permissionResult, checkingPermission, checkAppleNotesPermission])

  const toggleAccount = useCallback((zpk: number) => {
    setSelectedAccountZpks(current => {
      const next = new Set(current)
      if (next.has(zpk)) {
        next.delete(zpk)
      } else {
        next.add(zpk)
      }
      return next
    })
  }, [])

  const selectFolderAndTest = useCallback(async () => {
    const folder = await window.api.config.selectFolder()
    if (!folder) return
    const seq = ++requestSeqRef.current
    setSelectedPath(folder)
    setTestResult(null)
    setTesting(true)
    try {
      const result = await window.api.noteSources.test(toolType, folder)
      if (requestSeqRef.current !== seq) return
      setTestResult(result)
    } catch {
      if (requestSeqRef.current !== seq) return
      setTestResult({ accessible: false, fileCount: 0 })
    } finally {
      if (requestSeqRef.current === seq) setTesting(false)
    }
  }, [toolType])

  const setNotionToken = useCallback((token: string) => {
    const value = token.trim()
    requestSeqRef.current += 1
    setSelectedPath(value.startsWith('notion://') ? value : `notion://${value}`)
    setTestResult(null)
  }, [])

  const testNotionToken = useCallback(async () => {
    const seq = ++requestSeqRef.current
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.noteSources.test('notion', selectedPath)
      if (requestSeqRef.current !== seq) return
      setTestResult(result)
    } finally {
      if (requestSeqRef.current === seq) setTesting(false)
    }
  }, [selectedPath])

  const canProceed = useMemo(() => {
    if (toolType === 'apple-notes') {
      return !!permissionResult?.accessible && selectedAccountZpks.size > 0
    }
    return !!testResult?.accessible
  }, [permissionResult?.accessible, selectedAccountZpks.size, testResult?.accessible, toolType])

  const buildFinalPath = useCallback(() => {
    if (toolType === 'apple-notes' && permissionResult?.accessible) {
      const accountsParam = Array.from(selectedAccountZpks).join(',')
      return `${permissionResult.path}?accounts=${accountsParam}`
    }
    return selectedPath
  }, [permissionResult, selectedAccountZpks, selectedPath, toolType])

  return {
    toolType,
    name,
    selectedPath,
    testResult,
    testing,
    permissionResult,
    checkingPermission,
    appleAccounts,
    selectedAccountZpks,
    loadingAccounts,
    canProceed,
    setName,
    selectToolType,
    setNotionToken,
    testNotionToken,
    selectFolderAndTest,
    checkAppleNotesPermission,
    toggleAccount,
    buildFinalPath,
  }
}
