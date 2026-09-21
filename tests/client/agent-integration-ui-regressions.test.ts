import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function luminance(hex: string): number {
  const channels = hex.match(/[a-f\d]{2}/giu)?.map(value => Number.parseInt(value, 16) / 255) ?? []
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrast(left: string, right: string): number {
  const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('managed Agent UI regressions', () => {
  it('keeps normal-size light-theme semantic status colors above WCAG AA contrast', () => {
    const css = source('client/src/global.css')
    const selectors = ['emerald-300', 'amber-300', 'amber-400', 'sky-300', 'green-300', 'green-400']

    for (const selector of selectors) {
      const match = css.match(new RegExp(`\\[data-theme="light"\\] \\.text-${selector} \\{ color: (#[a-f\\d]{6}) !important; \\}`, 'iu'))
      expect(match, `${selector} must have an explicit light-theme color`).not.toBeNull()
      expect(contrast(match![1], '#ffffff'), `${selector} contrast`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps every managed-flow primary action above WCAG AA in both themes', () => {
    const css = source('client/src/global.css')
    const confirm = source('client/src/components/shared/ConfirmDialog.tsx')
    const managedPrimaryActions = [
      source('client/src/components/settings/AgentIntegration.tsx'),
      source('client/src/components/settings/agent-integration-managed/BatchConnectDialog.tsx'),
      source('client/src/components/settings/agent-integration-managed/CustomLocalAgentDialog.tsx'),
    ]
    const darkBlock = css.slice(css.indexOf(':root {'), css.indexOf('[data-theme="light"]'))
    const lightStart = css.indexOf('[data-theme="light"]')
    const lightBlock = css.slice(lightStart, css.indexOf('/* ============================================================', lightStart))

    for (const [theme, block] of [['dark', darkBlock], ['light', lightBlock]] as const) {
      const background = block.match(/--theme-confirm-primary-bg:\s*(#[a-f\d]{6});/iu)?.[1]
      const foreground = block.match(/--theme-confirm-primary-fg:\s*(#[a-f\d]{6});/iu)?.[1]
      expect(background, `${theme} confirm background token`).toBeDefined()
      expect(foreground, `${theme} confirm foreground token`).toBeDefined()
      expect(contrast(background!, foreground!), `${theme} ConfirmDialog contrast`)
        .toBeGreaterThanOrEqual(4.5)
    }
    expect(confirm).toContain("'theme-confirm-primary'")
    expect(confirm).not.toContain('gradientAlpha')
    for (const component of managedPrimaryActions) {
      expect(component).toContain('theme-confirm-primary')
      expect(component).not.toMatch(/bg-indigo-500[^\n"]*text-white|text-white[^\n"]*bg-indigo-500/u)
    }
  })

  it('waits for the prepared Cowork Installation to exist in the refreshed snapshot', () => {
    const component = source('client/src/components/settings/AgentIntegration.tsx')

    expect(component).toContain('setPendingCoworkInstallationId(installationId)')
    expect(component).toContain('snapshot?.installations.some(item => item.id === pendingCoworkInstallationId)')
    expect(component).toContain('setRequestedInstallationIds([pendingCoworkInstallationId])')
    expect(component).not.toMatch(/onCoworkPrepared=\{installationId => \{[\s\S]{0,240}openBatch\(\[installationId\]\)/u)
  })

  it('clears transient Cowork preview authority whenever the support dialog opens or closes', () => {
    const component = source('client/src/components/settings/AgentIntegration.tsx')

    expect(component).toContain('const resetCoworkFlow = useCallback(() => {')
    expect(component).toMatch(/const close = useCallback\(\(\) => \{\s*resetCoworkFlow\(\)\s*onClose\(\)/u)
    expect(component).toMatch(/if \(!open\) return\s*resetCoworkFlow\(\)/u)
    expect(component).toContain('onClick={close} aria-hidden')
  })

  it('provides at least 24px hit targets for compact information and component actions', () => {
    const primitives = source('client/src/components/settings/agent-integration-managed/ManagedPrimitives.tsx')
    const detail = source('client/src/components/settings/agent-integration-managed/ManagedAgentDetail.tsx')

    expect(primitives).toMatch(/aria-controls=\{id\}[\s\S]{0,500}min-h-6 min-w-6/u)
    expect(detail.match(/min-h-6 min-w-6/g)).toHaveLength(2)
  })
})
