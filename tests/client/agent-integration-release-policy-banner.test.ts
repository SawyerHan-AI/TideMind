import { createElement } from '../../client/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../client/node_modules/react-dom/server.js'

type ReleasePolicyBanner = typeof import(
  '../../client/src/components/settings/AgentIntegration'
)['AgentIntegrationReleasePolicyBanner']

let AgentIntegrationReleasePolicyBanner: ReleasePolicyBanner

beforeAll(async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    },
  })
  AgentIntegrationReleasePolicyBanner = (
    await import('../../client/src/components/settings/AgentIntegration')
  ).AgentIntegrationReleasePolicyBanner
}, 30_000)

function render(
  mode: 'active' | 'emergency_read_only' | 'invalid_manifest' | undefined,
): string {
  return renderToStaticMarkup(createElement(AgentIntegrationReleasePolicyBanner, {
    mode,
    title: 'Policy title',
    description: 'Policy description',
  }))
}

describe('AgentIntegrationReleasePolicyBanner', () => {
  it('does not render for the normal active policy or an absent policy', () => {
    expect(render('active')).toBe('')
    expect(render(undefined)).toBe('')
  })

  it('renders emergency read-only mode as an announced, non-interactive status', () => {
    const html = render('emergency_read_only')

    expect(html).toContain('data-agent-release-policy="emergency_read_only"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-atomic="true"')
    expect(html).toContain('aria-labelledby="agent-release-policy-emergency_read_only-title"')
    expect(html).toContain('aria-describedby="agent-release-policy-emergency_read_only-description"')
    expect(html).toContain('glass-card')
    expect(html).toContain('border-amber-400/30')
    expect(html).toContain('Policy title')
    expect(html).toContain('Policy description')
    expect(html).not.toContain('tabindex=')
  })

  it('renders an invalid manifest as a higher-priority alert with a visible error tone', () => {
    const html = render('invalid_manifest')

    expect(html).toContain('data-agent-release-policy="invalid_manifest"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-live="assertive"')
    expect(html).toContain('border-red-400/30')
    expect(html).toContain('text-red-400')
  })
})
