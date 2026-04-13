import { Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function SearchInput({ value, onChange, placeholder }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const { t } = useTranslation()
  const resolvedPlaceholder = placeholder ?? t('search.placeholder')
  return (
    <div className="relative">
      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={resolvedPlaceholder}
        className="w-full pl-9 pr-8 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-400/40 focus:ring-1 focus:ring-indigo-400/15 focus:bg-white/[0.06] transition-all"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-gray-500 hover:text-gray-300 transition-colors"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}
