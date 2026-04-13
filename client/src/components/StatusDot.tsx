export function StatusDot({ online, label }: { online: boolean | null; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${
        online === null ? 'bg-gray-500' : online ? 'bg-emerald-400' : 'bg-red-400'
      }`} />
      <span className="text-xs text-gray-400">{label}</span>
    </div>
  )
}
