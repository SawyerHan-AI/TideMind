import { Bot, ChevronRight } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFormatters } from '../../../hooks/useFormatters'
import {
  componentLabelKey,
  componentSummaryPresentation,
  connectionSubtitleKey,
  isTemporaryManagementBlock,
  managementUnavailableHelpKey,
  primaryInstallation,
  managementStatusPresentation,
  statusReasonKey,
} from './presentation'
import { ComponentFact, StatusBadge } from './ManagedPrimitives'
import type { ManagedSnapshotDto } from './types'
import { connectionFamilies, installationsForFamily } from './types'

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
  // Hosts that can only be detected are listed after real connections, under their own heading.
  const allFamilies = connectionFamilies(snapshot)
  const detectOnlyIds = new Set(allFamilies.filter(family => family.connection!.statusGroup !== 'needs_attention'
    && installationsForFamily(family, snapshot).every(installation => !installation.manageable
      && installation.desiredState === 'unmanaged' && installation.statusReason !== 'legacy_callable_unmanaged'
      && !isTemporaryManagementBlock(installation.statusReason))).map(family => family.id))
  const families = [...allFamilies.filter(family => !detectOnlyIds.has(family.id)), ...allFamilies.filter(family => detectOnlyIds.has(family.id))]
  const firstDetectOnlyId = families.find(family => detectOnlyIds.has(family.id))?.id
  const containerRef = useRef<HTMLDivElement>(null)
  const [wideTableLayout, setWideTableLayout] = useState(false)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const update = (width: number) => setWideTableLayout(width >= 560)
    update(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => update(entries[0]?.contentRect.width ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={containerRef}
      data-agent-family-list
      className="glass-card min-w-0 rounded-xl"
    >
      <div className={`${wideTableLayout ? 'grid grid-cols-[minmax(120px,1fr)_minmax(150px,.9fr)_minmax(180px,1.15fr)_24px]' : 'hidden'} gap-3 border-b border-white/[0.06] px-3 py-2 text-xs font-medium text-gray-400`}>
        <span>{t('agent.managed.table.agent')}</span>
        <span>{t('agent.managed.table.currentStatus')}</span>
        <span>{t('agent.managed.table.components')} · {t('agent.managed.activityLabel')}</span>
        <span />
      </div>
      {families.map(family => {
        const installations = installationsForFamily(family, snapshot)
        const primary = primaryInstallation(family, snapshot)
        const activityAt = family.connection!.lastRealUseAt
        const selected = selectedFamilyId === family.id
        const connection = family.connection!
        const needsAction = connection.statusGroup === 'needs_attention'
        const detectOnly = installations.every(installation => !installation.manageable)
        const badgeReason = detectOnly && !needsAction ? primary.statusReason : connection.statusReason
        const bridgeStopped = installations.length > 0 && installations.every(installation => installation.deactivation?.bridge === 'stopped')
        const maintenancePaused = installations.some(installation => installation.desiredState === 'disabled')
        const statusLabel = t(managementStatusPresentation(needsAction ? 'needs_attention' : family.statusGroup, badgeReason, detectOnly, bridgeStopped).labelKey)
        const issueReason = needsAction || connection.actionInstallationIds.length > 0
          ? t(statusReasonKey(connection.issue?.reason ?? connection.attentionReason ?? connection.statusReason))
          : null
        const unavailableDetail = installations.every(installation => !installation.manageable)
          ? t(managementUnavailableHelpKey(primary.statusReason))
          : null
        const subtitleKey = detectOnly ? null : connectionSubtitleKey(needsAction ? 'needs_attention' : family.statusGroup, badgeReason, Boolean(activityAt), bridgeStopped)
        // Several entry points of one product: say which one was used when.
        const entryUse = installations.filter(installation => installation.lastRealUseAt)
        const componentSummary = connection.components.map(component =>
          `${t(componentLabelKey(component.key))}：${t(componentSummaryPresentation(component.state, maintenancePaused).labelKey)}`,
        ).join(' · ')
        const summaryId = `agent-family-summary-${family.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
        return (
          <Fragment key={family.id}>
          {family.id === firstDetectOnlyId && (
            <div data-agent-detect-only-heading className="border-b border-white/[0.05] bg-white/[0.015] px-3 py-1.5 text-xs text-gray-500">
              {t('agent.managed.supportMode.detectable')}
            </div>
          )}
          <div
            data-agent-family-row={connection.familyId}
            data-agent-connection-row={connection.id}
            className={`group relative border-b border-white/[0.05] px-3 py-2.5 last:border-b-0 ${selected ? 'bg-indigo-400/[0.07]' : 'hover:bg-white/[0.025]'}`}
          >
            <button
              type="button"
              data-agent-family-trigger={connection.familyId}
              data-agent-connection-trigger={connection.id}
              onClick={event => onSelect(family.id, event.currentTarget)}
              aria-label={t('agent.managed.viewDetailsFor', { name: family.displayName })}
              aria-describedby={summaryId}
              aria-current={selected ? 'true' : undefined}
              className="absolute inset-0 z-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400/60"
            />
            <span id={summaryId} className="sr-only">
              {statusLabel}. {issueReason ? `${issueReason} ` : ''}{unavailableDetail ? `${unavailableDetail}. ` : ''}{componentSummary}. {t('agent.managed.activityLabel')}: {activityAt ? timeAgo(activityAt) : t('agent.managed.noActivity')}
            </span>
            <div className={`pointer-events-none relative z-[1] grid min-w-0 items-center ${wideTableLayout ? 'grid-cols-[minmax(120px,1fr)_minmax(150px,.9fr)_minmax(180px,1.15fr)_24px] gap-3' : 'gap-2'}`}>
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.04] text-indigo-300">
                  <Bot size={14} aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-gray-200">{family.displayName}</span>

                  <span className="block truncate text-xs text-gray-400">
                    {installations.length === 1
                      ? `${installations[0].variantLabel} · ${installations[0].profileLabel ?? t('agent.managed.defaultProfile')}`
                      : t('agent.managed.installationCount', { count: installations.length })}
                  </span>
                </span>
              </div>
              <div className={`${wideTableLayout ? 'space-y-1' : 'flex flex-wrap items-center gap-x-3 gap-y-1 pl-9'} min-w-0`}>
                <StatusBadge
                  group={needsAction ? 'needs_attention' : family.statusGroup}
                  reason={badgeReason}
                  bridgeStopped={bridgeStopped}
                  compact
                  detectOnly={detectOnly}
                />
                {issueReason && (
                  <p className="text-xs leading-relaxed text-amber-300" data-agent-current-issue={connection.id}>
                    {issueReason}
                  </p>
                )}
              </div>
              <div className={`${wideTableLayout ? 'space-y-1' : 'flex flex-wrap items-center gap-x-3 gap-y-1 pl-9'} min-w-0`}>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {connection.components.map(component => <ComponentFact key={component.key} componentKey={component.key} status={component.state} summary maintenancePaused={maintenancePaused} showStatusLabel onInspect={event => onSelect(family.id, event.currentTarget)} />)}
                </div>
                {connection.components.some(component => component.evidenceScope === 'configuration_domain') && (
                  <p className="text-xs text-gray-400">{t('agent.managed.antigravity.sharedEvidence')}</p>
                )}
                {/* In the table layout this wraps: several entry points or a long subtitle must not widen the list. */}
                <p className={`${wideTableLayout ? 'min-w-0 break-words' : 'whitespace-nowrap'} text-xs text-gray-400`}>
                  <span className="mr-1 whitespace-nowrap">{t('agent.managed.activityLabel')}:</span>
                  {entryUse.length > 1 && new Set(entryUse.map(item => item.lastRealUseAt)).size > 1
                    ? entryUse.map(item => `${item.variantLabel} ${timeAgo(item.lastRealUseAt!)}`).join(' · ')
                    : activityAt ? timeAgo(activityAt) : t(subtitleKey ?? 'agent.managed.noActivity')}
                  {activityAt && subtitleKey ? ` · ${t(subtitleKey)}` : ''}
                </p>
              </div>
              <span className={`${wideTableLayout ? '' : 'absolute right-3 top-1/2 -translate-y-1/2'} justify-self-end text-gray-400 transition-colors group-hover:text-gray-200`}>
                <ChevronRight size={15} aria-hidden />
              </span>
            </div>
          </div>
          </Fragment>
        )
      })}
    </div>
  )
}
