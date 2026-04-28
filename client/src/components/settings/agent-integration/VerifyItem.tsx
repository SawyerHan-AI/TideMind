import { CheckCircle, XCircle } from 'lucide-react'

export function VerifyItem({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 bg-white/[0.02] rounded-lg">
      {ok ? (
        <CheckCircle size={14} className="text-emerald-400 mt-0.5 flex-shrink-0" />
      ) : (
        <XCircle size={14} className="text-gray-500 mt-0.5 flex-shrink-0" />
      )}
      <div>
        <span className={`text-xs ${ok ? 'text-gray-200' : 'text-gray-400'}`}>{label}</span>
        {hint && <p className="text-[10px] text-gray-500 mt-0.5">{hint}</p>}
      </div>
    </div>
  )
}
