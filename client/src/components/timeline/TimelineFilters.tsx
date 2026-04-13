import { EVENT_TYPE_COLORS, EVENT_TYPE_LABELS, ACTOR_LABELS, ACTOR_COLORS } from '../../lib/constants'

const EVENT_TYPES = ['memory', 'think_associate', 'think_emerge', 'output', 'evolution', 'config'] as const
const ACTORS = ['user', 'agent', 'brain'] as const

function TogglePill({
  isActive,
  activeClass,
  onClick,
  children,
}: {
  isActive: boolean
  activeClass: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded-md text-[11px] font-medium transition-all duration-150 ${
        isActive
          ? `${activeClass}`
          : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.05]'
      }`}
    >
      {children}
    </button>
  )
}

export function TimelineFilters({
  activeTypes,
  onToggleType,
  activeActors,
  onToggleActor,
}: {
  activeTypes: string[]
  onToggleType: (type: string) => void
  activeActors: string[]
  onToggleActor: (actor: string) => void
}) {
  return (
    <div className="flex items-center gap-1">
      {EVENT_TYPES.map(type => (
        <TogglePill
          key={type}
          isActive={activeTypes.includes(type)}
          activeClass={EVENT_TYPE_COLORS[type]}
          onClick={() => onToggleType(type)}
        >
          {EVENT_TYPE_LABELS[type]}
        </TogglePill>
      ))}

      <div className="w-px h-4 mx-1.5" style={{ background: 'var(--border-subtle)' }} />

      {ACTORS.map(actor => (
        <TogglePill
          key={actor}
          isActive={activeActors.includes(actor)}
          activeClass={ACTOR_COLORS[actor]}
          onClick={() => onToggleActor(actor)}
        >
          {ACTOR_LABELS[actor]}
        </TogglePill>
      ))}
    </div>
  )
}
