import { Bot, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFormatters } from '../../../hooks/useFormatters'
import {
  accessLabelKey,
  aggregateAccess,
  aggregateComponents,
  componentLabelKey,
  componentStatusPresentation,
  primaryInstallation,
  sortProductFamilies,
} from './presentation'
import { AccessBadge, ComponentFact, StatusBadge } from './ManagedPrimitives'
import type { ManagedProductFamilyDto, ManagedSnapshotDto } from './types'
import { installationsForFamily } from './types'

function latestVerification(installations: ReturnType<typeof installationsForFamily>): string | null {
  return installations
    .map(item => item.lastVerifiedAt)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? null
}

function MixedAccess({ family, snapshot }: { family: ManagedProductFamilyDto; snapshot: ManagedSnapshotDto }) {
  const { t } = useTranslation('settings')
  const installations = installationsForFamily(family, snapshot)
  const access = aggregateAccess(installations)
  if (access.kind === 'uniform' && access.level) {
    const detail = aggregateComponents(installations).map(component => {
      const state = component.kind === 'uniform' && component.status
        ? t(componentStatusPresentation(component.status).labelKey)
        : t('agent.managed.mixed')
      return `${t(componentLabelKey(component.key))}：${state}`
    }).join(' · ')
    return <AccessBadge level={access.level} historical={access.historical} detail={detail} />
  }
  const summary = Object.entries(access.counts)
    .map(([level, count]) => `${count} ${t(accessLabelKey(level as keyof typeof access.counts, false))}`)
    .join(' · ')
  return (
    <span className="text-xs text-amber-300">
      {t('agent.managed.accessMixed')}
      <span className="mt-0.5 block text-xs text-gray-400">{summary}</span>
    </span>
  )
}

function AggregatedComponents({ family, snapshot }: { family: ManagedProductFamilyDto; snapshot: ManagedSnapshotDto }) {
  const { t } = useTranslation('settings')
  const components = aggregateComponents(installationsForFamily(family, snapshot))
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {components.map(component => {
        if (component.kind === 'uniform' && component.status) {
          return <ComponentFact key={component.key} componentKey={component.key} status={component.status} />
        }
        const summary = Object.entries(component.counts)
          .map(([state, count]) => `${count} ${t(componentStatusPresentation(state as keyof typeof component.counts).labelKey)}`)
          .join(' · ')
        return (
          <span
            key={component.key}
            className="text-xs text-amber-300"
            aria-label={`${t(componentLabelKey(component.key))}：${summary}`}
            title={summary}
          >
            <span className="block">{t(componentLabelKey(component.key))} · {t('agent.managed.mixed')}</span>
            <span className="block text-gray-400">{summary}</span>
          </span>
        )
      })}
    </div>
  )
}

export function ManagedFamilyList({
  snapshot,
  selectedFamilyId,
  onSelect,
}: {
  snapshot: ManagedSnapshotDto
  selectedFamilyId: string | null
  onSelect: (familyId: string, trigger: HTMLButtonElement) => void
}) {
  const { t } = useTranslation('settings')
  const { timeAgo } = useFormatters()
  const families = sortProductFamilies(snapshot.families, snapshot)
  const containerRef = useRef<HTMLDivElement>(null)
  const [wideTableLayout, setWideTableLayout] = useState(false)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const update = (width: number) => setWideTableLayout(width >= 680)
    update(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => update(entries[0]?.contentRect.width ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={containerRef}
      data-agent-family-list
      className="min-w-0 overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.02]"
    >
      <div className={`${wideTableLayout ? 'grid grid-cols-[minmax(150px,1.05fr)_minmax(180px,.95fr)_minmax(210px,1.25fr)_36px]' : 'hidden'} gap-4 border-b border-white/[0.06] px-4 py-2 text-xs font-medium text-gray-400`}>
        <span>{t('agent.managed.table.agent')}</span>
        <span>{t('agent.managed.table.currentStatus')} · {t('agent.managed.table.access')}</span>
        <span>{t('agent.managed.table.components')} · {t('agent.managed.table.lastVerified')}</span>
        <span />
      </div>
      {families.map(family => {
        const installations = installationsForFamily(family, snapshot)
        const primary = primaryInstallation(family, snapshot)
        const verifiedAt = latestVerification(installations)
        const selected = selectedFamilyId === family.id
        return (
          <div
            key={family.id}
            className={`border-b border-white/[0.05] px-4 py-3 last:border-b-0 ${selected ? 'bg-indigo-400/[0.07]' : 'hover:bg-white/[0.025]'}`}
          >
            <div className={`grid min-w-0 items-center ${wideTableLayout ? 'grid-cols-[minmax(150px,1.05fr)_minmax(180px,.95fr)_minmax(210px,1.25fr)_36px] gap-4' : 'gap-3'}`}>
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.04] text-indigo-300">
                  <Bot size={15} aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-gray-200">{family.displayName}</span>
                  {family.unreadEventCount > 0 && (
                    <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-sky-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden />
                      {t('agent.managed.unreadEvents', { count: family.unreadEventCount })}
                    </span>
                  )}
                  <span className="block truncate text-xs text-gray-400">
                    {installations.length === 1
                      ? `${installations[0].variantLabel} · ${installations[0].profileLabel ?? t('agent.managed.defaultProfile')}`
                      : t('agent.managed.installationCount', { count: installations.length })}
                  </span>
                </span>
              </div>
              <div className={`${wideTableLayout ? '' : 'mt-2'} min-w-0 space-y-2`}>
                {!wideTableLayout && <span className="mb-1 block text-xs text-gray-400">{t('agent.managed.table.currentStatus')} · {t('agent.managed.table.access')}</span>}
                <StatusBadge
                  group={family.statusGroup}
                  reason={primary.statusReason}
                  detectOnly={installations.every(installation => !installation.manageable)}
                />
                {family.needsAttentionCount > 0 && installations.length > 1 && (
                  <p className="mt-1 text-xs text-red-300">
                    {t('agent.managed.instancesNeedAttention', { count: family.needsAttentionCount })}
                  </p>
                )}
                <MixedAccess family={family} snapshot={snapshot} />
              </div>
              <div className={`${wideTableLayout ? '' : 'mt-2'} min-w-0 space-y-2`}>
                {!wideTableLayout && <span className="mb-1 block text-xs text-gray-400">{t('agent.managed.table.components')} · {t('agent.managed.table.lastVerified')}</span>}
                <AggregatedComponents family={family} snapshot={snapshot} />
                <p className="text-xs text-gray-400">
                  <span className="mr-1">{t('agent.managed.table.lastVerified')}：</span>
                  {verifiedAt ? timeAgo(verifiedAt) : t('agent.managed.neverVerified')}
                </p>
              </div>
              <button
                type="button"
                data-agent-family-trigger={family.id}
                onClick={event => onSelect(family.id, event.currentTarget)}
                aria-label={t('agent.managed.viewDetailsFor', { name: family.displayName })}
                className="min-h-8 min-w-8 justify-self-end rounded p-1 text-gray-400 transition-colors hover:bg-white/5 hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
              >
                <ChevronRight size={15} aria-hidden />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
