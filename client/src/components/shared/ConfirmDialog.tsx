/**
 * Confirm dialog with overlay backdrop.
 * Used for destructive or significant actions (toggle cloud sync, delete account, etc.)
 */

import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { brand, btnText } from '../../lib/tokens'
import { acquireModalInert } from '../../lib/modal-inert'

interface ConfirmDialogProps {
  open: boolean
  onConfirm: () => void
  onCancel: () => void
  title: string
  description?: string
  children?: React.ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  title,
  description,
  children,
  confirmText,
  cancelText,
  danger = false,
}: ConfirmDialogProps) {
  const { t } = useTranslation('common')
  const resolvedConfirmText = confirmText ?? t('actions.confirm')
  const resolvedCancelText = cancelText ?? t('actions.cancel')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    if (!open) return
    return acquireModalInert(document.getElementById('root'))
  }, [open])

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      requestAnimationFrame(() => cancelRef.current?.focus())
      return
    }
    previousFocusRef.current?.focus()
    previousFocusRef.current = null
  }, [open])

  useEffect(() => {
    if (!open) return
    // F16: 多个 ConfirmDialog 同时在 DOM 里(连环二次确认场景)时,默认
    // window keydown 会同时触发所有 handler,导致一次 ESC 关掉全部 dialog。
    // capture phase + stopPropagation,让最后注册(也就是最近打开 — useEffect 注册
    // 是按 open 切换顺序入栈)的 dialog 优先响应,关掉自己后阻断传播。
    // 注:这是简单版本,假设新弹出的 dialog 不会再叠开。如果将来有真正的 modal 栈
    // 场景,应改用集中式 modal stack。
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        )
        if (!focusable?.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [open, onCancel])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden
      />
      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className="relative w-full max-w-md mx-4 rounded-xl p-6 shadow-2xl border border-white/[0.08]"
        style={{ background: 'var(--theme-glass-bg, #1a1a2e)' }}
      >
        <h3 id={titleId} className="text-sm font-semibold text-gray-100 mb-2">{title}</h3>
        {description && (
          <p id={descriptionId} className="text-xs text-gray-400 mb-4 leading-relaxed">{description}</p>
        )}
        {children && <div className="mb-4">{children}</div>}
        <div className="flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-xs font-medium text-gray-300 border border-white/10 hover:border-white/20 hover:text-white transition-all"
            style={{ background: 'var(--theme-glass-bg, transparent)' }}
          >
            {resolvedCancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-xs font-medium transition-all"
            style={
              danger
                ? {
                    background: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    color: '#f87171',
                  }
                : {
                    background: brand.gradientAlpha,
                    border: `1px solid ${brand.secondary}4d`,
                    color: btnText.onBrand,
                  }
            }
          >
            {resolvedConfirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
