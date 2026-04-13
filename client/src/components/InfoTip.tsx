import { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

export function InfoTip({ content, size = 12 }: { content: string; size?: number }) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const iconRef = useRef<HTMLSpanElement>(null)

  const show = useCallback(() => {
    if (!iconRef.current) return
    const rect = iconRef.current.getBoundingClientRect()
    setPos({ x: rect.left + rect.width / 2, y: rect.top })
    setVisible(true)
  }, [])

  const hide = useCallback(() => setVisible(false), [])

  return (
    <span className="inline-flex items-center ml-1">
      <span
        ref={iconRef}
        className="text-gray-500 hover:text-gray-300 transition-colors cursor-help"
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        <Info size={size} />
      </span>
      {visible && createPortal(
        <span
          className="fixed z-[9999] w-64 px-3 py-2 rounded-lg text-xs text-gray-300 leading-relaxed pointer-events-none
            backdrop-blur-xl border"
          style={{
            left: pos.x,
            top: pos.y,
            transform: 'translate(-50%, -100%) translateY(-8px)',
            background: 'var(--theme-popup-bg)',
            borderColor: 'var(--theme-popup-border)',
            boxShadow: 'var(--theme-popup-shadow)',
          }}
        >
          {content}
          <span className="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
            <span className="block w-2 h-2 rotate-45" style={{ background: 'var(--theme-popup-bg)', borderRight: '1px solid var(--border-subtle)', borderBottom: '1px solid var(--border-subtle)' }} />
          </span>
        </span>,
        document.body,
      )}
    </span>
  )
}
