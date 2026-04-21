/**
 * Confirm dialog with overlay backdrop.
 * Used for destructive or significant actions (toggle cloud sync, delete account, etc.)
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { brand, btnText } from '../../lib/tokens'

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

  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onCancel])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
      />
      {/* Dialog */}
      <div
        className="relative w-full max-w-md mx-4 rounded-xl p-6 shadow-2xl border border-white/[0.08]"
        style={{ background: 'var(--theme-glass-bg, #1a1a2e)' }}
      >
        <h3 className="text-sm font-semibold text-gray-100 mb-2">{title}</h3>
        {description && (
          <p className="text-xs text-gray-400 mb-4 leading-relaxed">{description}</p>
        )}
        {children && <div className="mb-4">{children}</div>}
        <div className="flex justify-end gap-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-xs font-medium text-gray-300 border border-white/10 hover:border-white/20 hover:text-white transition-all"
            style={{ background: 'var(--theme-glass-bg, transparent)' }}
          >
            {resolvedCancelText}
          </button>
          <button
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
