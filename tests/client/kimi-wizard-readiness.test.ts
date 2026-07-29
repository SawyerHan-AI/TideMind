import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WIZARD_PATH = path.resolve(__dirname, '../../client/src/components/settings/agent-integration/AgentWizard.tsx')
const STEP_PATH = path.resolve(__dirname, '../../client/src/components/settings/agent-integration/AgentWizardPluginStep.tsx')

describe('Kimi Code wizard readiness wiring', () => {
  it('probes the kimi CLI and does not show auto-ready when it is unavailable', () => {
    const wizard = fs.readFileSync(WIZARD_PATH, 'utf-8')
    const step = fs.readFileSync(STEP_PATH, 'utf-8')

    expect(wizard).toContain("window.api.agents.checkCli('kimi')")
    expect(wizard).toContain('setKimiAvailable(kimiCheck.available)')
    expect(wizard).toContain('kimiAvailable={kimiAvailable}')
    expect(step).toContain('kimiAvailable ? (')
    expect(step).toContain("t('agent.wizard.kimi.cliMissingTitle')")
    expect(step).toContain("t('agent.wizard.kimi.cliMissingNote')")
  })
})
