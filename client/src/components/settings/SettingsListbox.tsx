import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export interface SettingsListboxOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

export interface SettingsListboxGroup {
  label: string
  options: SettingsListboxOption[]
}

interface SettingsListboxProps {
  value: string
  onChange: (value: string) => void
  groups: SettingsListboxGroup[]
  placeholder: string
  disabled?: boolean
  ariaLabel: string
}

export function SettingsListbox({
  value,
  onChange,
  groups,
  placeholder,
  disabled = false,
  ariaLabel,
}: SettingsListboxProps) {
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const options = useMemo(
    () => groups.flatMap(group => group.options.map(option => ({ ...option, group: group.label }))),
    [groups],
  )
  const enabledOptions = options.filter(option => !option.disabled)
  const selected = options.find(option => option.value === value)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (!open) return
    const selectedIndex = enabledOptions.findIndex(option => option.value === value)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
  }, [open, value, enabledOptions.length])

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const selectActive = () => {
    const option = enabledOptions[activeIndex]
    if (!option) return
    onChange(option.value)
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabled || enabledOptions.length === 0) return
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      setOpen(true)
      return
    }
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(index => Math.min(index + 1, enabledOptions.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(index => Math.max(index - 1, 0))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(enabledOptions.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      selectActive()
    }
  }

  let enabledCursor = -1
  return (
    <div ref={rootRef} className="relative min-w-0" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        role="combobox"
        aria-autocomplete="none"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && enabledOptions[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
        className="w-full min-w-0 flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/5 hover:bg-white/[0.07] focus:outline-none focus:border-indigo-400/50 focus:ring-2 focus:ring-indigo-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <span className={`truncate text-sm ${selected ? 'text-gray-200' : 'text-gray-500'}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown size={14} className={`shrink-0 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className="glass-popup absolute z-50 left-0 right-0 mt-1.5 max-h-64 overflow-y-auto rounded-lg border border-white/10 p-1 shadow-xl"
        >
          {groups.map(group => (
            <div key={group.label}>
              <div className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wide text-gray-500">
                {group.label}
              </div>
              {group.options.map(option => {
                if (!option.disabled) enabledCursor += 1
                const optionIndex = enabledCursor
                const active = !option.disabled && optionIndex === activeIndex
                const checked = option.value === value
                return (
                  <div
                    key={option.value}
                    id={!option.disabled ? `${listboxId}-${optionIndex}` : undefined}
                    role="option"
                    aria-selected={checked}
                    aria-disabled={option.disabled || undefined}
                    onMouseEnter={() => { if (!option.disabled) setActiveIndex(optionIndex) }}
                    onClick={() => {
                      if (option.disabled) return
                      onChange(option.value)
                      setOpen(false)
                      requestAnimationFrame(() => triggerRef.current?.focus())
                    }}
                    className={`w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                      active ? 'bg-white/[0.08]' : 'hover:bg-white/[0.05]'
                    } ${option.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-gray-200">{option.label}</span>
                      {option.description && (
                        <span className="block truncate text-[10px] text-gray-500 mt-0.5">{option.description}</span>
                      )}
                    </span>
                    {checked && <Check size={13} className="shrink-0 text-indigo-300" />}
                  </div>
                )
              })}
            </div>
          ))}
          {options.length === 0 && <div className="px-3 py-3 text-xs text-gray-500">{placeholder}</div>}
        </div>
      )}
    </div>
  )
}
