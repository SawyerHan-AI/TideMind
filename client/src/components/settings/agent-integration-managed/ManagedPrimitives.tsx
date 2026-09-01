import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Info,
  MinusCircle,
  PauseCircle,
  ShieldAlert,
  Wrench,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  accessInfoKey,
  accessLabelKey,
  componentLabelKey,
  componentStatusPresentation,
  managementUnavailableHelpKey,
  statusPresentation,
  statusReasonKey,
} from './presentation'
import type {
  ManagedAccessLevel,
  ManagedComponentKey,
  ManagedComponentStatus,
  ManagedInstallationDto,
  ManagedStatusGroup,
} from './types'

const TONE_CLASSES = {
  green: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  amber: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
  red: 'border-red-400/20 bg-red-400/10 text-red-300',
  blue: 'border-sky-400/20 bg-sky-400/10 text-sky-300',
  gray: 'border-white/10 bg-white/[0.04] text-gray-400',
  violet: 'border-violet-400/20 bg-violet-400/10 text-violet-300',
} as const

function StatusIcon({ group, size = 12 }: { group: ManagedStatusGroup; size?: number }) {
  if (group === 'available') return <CheckCircle2 size={size} aria-hidden />
  if (group === 'needs_attention') return <ShieldAlert size={size} aria-hidden />
  if (group === 'paused') return <PauseCircle size={size} aria-hidden />
  if (group === 'processing') return <Wrench size={size} aria-hidden />
  if (group === 'awaiting_connection' || group === 'awaiting_verification') {
    return <CircleDashed size={size} aria-hidden />
  }
  if (group === 'limited') return <AlertCircle size={size} aria-hidden />
  return <MinusCircle size={size} aria-hidden />
}

export function StatusBadge({
  group,
  reason,
  compact = false,
  detectOnly = false,
}: {
  group: ManagedStatusGroup
  reason: string
  compact?: boolean
  detectOnly?: boolean
}) {
  const { t } = useTranslation('settings')
  const token = statusPresentation(group)
  if (detectOnly) {
    const helpKey = managementUnavailableHelpKey(reason)
    return (
      <div className="min-w-0">
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium ${TONE_CLASSES.gray}`}>
          <MinusCircle size={12} aria-hidden />
          {t('agent.managed.supportMode.detectable')}
        </span>
        {!compact && (
          <p className="mt-1 truncate text-xs text-gray-400" title={t(helpKey)}>
            {t(helpKey)}
          </p>
        )}
      </div>
    )
  }
  return (
    <div className="min-w-0">
      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium ${TONE_CLASSES[token.tone]}`}>
        <StatusIcon group={group} />
        {t(token.labelKey)}
      </span>
      {!compact && (
        <p className="mt-1 truncate text-xs text-gray-400" title={t(statusReasonKey(reason))}>
          {t(statusReasonKey(reason))}
        </p>
      )}
    </div>
  )
}

export function AccessibleInfo({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean; width: number } | null>(null)
  const open = hovered || focused || pinned

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(256, Math.max(200, window.innerWidth - 16))
      const half = width / 2
      const left = Math.min(window.innerWidth - half - 8, Math.max(half + 8, rect.left + rect.width / 2))
      const roomBelow = window.innerHeight - rect.bottom
      const above = roomBelow < 150 && rect.top > roomBelow
      setPosition({ left, top: above ? rect.top - 8 : rect.bottom + 8, above, width })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setPinned(false)
      setHovered(false)
      setFocused(false)
      buttonRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={open ? id : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={() => setPinned(value => !value)}
        className="rounded p-0.5 text-gray-500 transition-colors hover:text-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
      >
        <Info size={12} aria-hidden />
      </button>
      {open && position && createPortal(
        <span
          id={id}
          role="tooltip"
          className="fixed z-[70] rounded-lg border border-white/10 bg-[#171728] p-3 text-left text-xs font-normal leading-relaxed text-gray-300 shadow-2xl"
          style={{
            left: position.left,
            top: position.top,
            width: position.width,
            transform: position.above ? 'translate(-50%, -100%)' : 'translateX(-50%)',
          }}
        >
          {children}
        </span>,
        document.body,
      )}
    </span>
  )
}

export function AccessBadge({
  level,
  historical,
  detail,
}: {
  level: ManagedAccessLevel
  historical: boolean
  detail?: string
}) {
  const { t } = useTranslation('settings')
  const label = t(accessLabelKey(level, historical))
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-xs text-gray-300">
      <span className="truncate font-medium">{label}</span>
      <AccessibleInfo label={t('agent.managed.accessInfoLabel', { level: label })}>
        <span className="block">{t(accessInfoKey(level))}</span>
        {detail && <span className="mt-1 block text-gray-400">{detail}</span>}
      </AccessibleInfo>
    </span>
  )
}

function ComponentIcon({ status }: { status: ManagedComponentStatus }) {
  if (status === 'verified') return <CheckCircle2 size={12} aria-hidden />
  if (status === 'configured') return <Clock3 size={12} aria-hidden />
  if (status === 'missing' || status === 'conflict') return <AlertCircle size={12} aria-hidden />
  if (status === 'new_session' || status === 'confirmation_required' || status === 'verification_stale') {
    return <CircleDashed size={12} aria-hidden />
  }
  return <MinusCircle size={12} aria-hidden />
}

export function ComponentFact({
  componentKey,
  status,
  showStatusLabel = false,
}: {
  componentKey: ManagedComponentKey
  status: ManagedComponentStatus
  showStatusLabel?: boolean
}) {
  const { t } = useTranslation('settings')
  const token = componentStatusPresentation(status)
  const label = t(componentLabelKey(componentKey))
  const stateLabel = t(token.labelKey)
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${TONE_CLASSES[token.tone].split(' ').at(-1)}`}
      aria-label={`${label}：${stateLabel}`}
      title={`${label}：${stateLabel}`}
    >
      <ComponentIcon status={status} />
      <span className="text-gray-400">{label}</span>
      {showStatusLabel && <span>{stateLabel}</span>}
    </span>
  )
}

export function InstallationComponentFacts({
  installation,
  showStatusLabel = false,
}: {
  installation: ManagedInstallationDto
  showStatusLabel?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {(['instruction', 'memory_tools', 'lifecycle'] as const).map(key => (
        <ComponentFact
          key={key}
          componentKey={key}
          status={installation.components.find(component => component.key === key)?.state ?? 'unsupported'}
          showStatusLabel={showStatusLabel}
        />
      ))}
    </div>
  )
}
