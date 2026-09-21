import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from '../../client/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../client/node_modules/react-dom/server.js'
import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
})
const i18n = (await import('../../client/src/lib/i18n.ts')).default

const { CustomResultPanel } = await import('../../client/src/components/settings/agent-integration-managed/CustomLocalAgentDialog.tsx')
const { RequiredUserActionDetail } = await import('../../client/src/components/settings/agent-integration-managed/RequiredUserActionDetail.tsx')
const { StatusBadge } = await import('../../client/src/components/settings/agent-integration-managed/ManagedPrimitives.tsx')

function render(status: 'committed' | 'awaiting_verification' | 'needs_recovery' | 'failed') {
  return renderToStaticMarkup(createElement(CustomResultPanel, {
    result: {
      planHash: 'plan',
      results: [{ installationId: 'custom', status, reason: 'internal_diagnostic_token' }],
    },
  }))
}

describe('Custom local Agent result UI', () => {
  it.each([
    ['release_entry_missing', 'releaseEntryMissing'],
    ['release_mode_detect_only', 'releaseModeDetectOnly'],
    ['release_distribution_not_accepted', 'releaseDistributionNotAccepted'],
    ['release_version_unverified', 'releaseVersionUnverified'],
    ['release_version_not_accepted', 'releaseVersionNotAccepted'],
    ['release_artifact_not_accepted', 'releaseArtifactNotAccepted'],
  ])('exposes actionable %s help from a compact unavailable badge', (reason, suffix) => {
    const markup = renderToStaticMarkup(createElement(StatusBadge, {
      group: 'disconnected',
      reason,
      compact: true,
      detectOnly: true,
    }))
    expect(markup).toContain(`title="agent.managed.reason.${suffix}"`)
    expect(markup).not.toContain('title="agent.managed.supportMode.detectableHelp"')
  })

  it('uses honest semantic state for each result class without exposing diagnostics', () => {
    const committed = render('committed')
    expect(committed).toContain('role="status"')
    expect(committed).toContain('text-emerald-300')
    expect(committed).toContain('agent.managed.custom.result.committed')

    const awaiting = render('awaiting_verification')
    expect(awaiting).toContain('role="status"')
    expect(awaiting).toContain('text-sky-300')
    expect(awaiting).toContain('agent.managed.custom.result.awaiting_verification')

    const recovery = render('needs_recovery')
    expect(recovery).toContain('role="alert"')
    expect(recovery).toContain('text-amber-300')
    expect(recovery).toContain('agent.managed.custom.result.needs_recovery')

    const failed = render('failed')
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('text-red-300')
    expect(failed).toContain('agent.managed.custom.result.failed')
    expect(failed).not.toContain('internal_diagnostic_token')
  })

  it('renders every typed manual action without exposing hashes or raw action tokens', () => {
    const english = JSON.parse(readFileSync(resolve(process.cwd(), 'client/src/locales/en/settings.json'), 'utf8'))
    i18n.addResourceBundle('en', 'settings', english, true, true)
    const imported = renderToStaticMarkup(createElement(RequiredUserActionDetail, { action: {
      kind: 'custom_mcp_import', componentKey: 'memory_tools', operation: 'connect',
      instruction: 'BACKEND_CUSTOM_INSTRUCTION', connectorName: 'tidemind-eb_custom', serverType: 'STDIO',
      command: '/Applications/Tide Mind.app/shim', args: ['mcp.js'],
      environment: { EB_AGENT_ID: 'eb_custom', EB_HOST_VARIANT: 'custom-local-mcp' },
      configurationJson: '{"env":{"EB_ACTIVITY_GENERATION_TOKEN":"activation-test"}}',
      connectorConfigurationHash: 'private-guided-hash', steps: ['BACKEND_CUSTOM_STEP'],
      usageGuide: 'Call brain_prepare, brain_recall and brain_digest when appropriate.',
    } }))
    expect(imported).toContain('You maintain these settings')
    expect(imported).toContain('brain_recall')
    expect(imported).toContain('brain_digest')
    expect(imported).toContain('EB_ACTIVITY_GENERATION_TOKEN')
    expect(imported).not.toContain('BACKEND_CUSTOM')
    expect(imported).not.toContain('private-guided-hash')
    const qwen = renderToStaticMarkup(createElement(RequiredUserActionDetail, { action: {
      kind: 'qwenwork_mcp_gui',
      componentKey: 'memory_tools',
      operation: 'connect',
      instruction: 'BACKEND_QWEN_INSTRUCTION_MUST_NOT_RENDER',
      connectorName: 'Tide Mind',
      serverType: 'STDIO',
      command: '/Applications/Tide Mind.app/mcp',
      args: ['--stdio'],
      environment: { EB_AGENT_ID: 'eb_qwen', EB_HOST_VARIANT: 'qwenwork-desktop' },
      configurationJson: JSON.stringify({
        mcpServers: {
          'Tide Mind': {
            command: '/Applications/Tide Mind.app/mcp',
            args: ['--stdio'],
            env: { EB_AGENT_ID: 'eb_qwen', EB_HOST_VARIANT: 'qwenwork-desktop' },
          },
        },
      }, null, 2),
      connectorConfigurationHash: 'private-connector-hash',
      steps: ['BACKEND_QWEN_STEP_MUST_NOT_RENDER'],
    } }))
    expect(qwen).toContain('Tide Mind')
    expect(qwen).toContain('&quot;EB_AGENT_ID&quot;: &quot;eb_qwen&quot;')
    expect(qwen).toContain('same conversation')
    expect(qwen).toContain('brain_recall')
    expect(qwen).toContain('brain_digest')
    expect(qwen).not.toContain('BACKEND_QWEN')
    expect(qwen).not.toContain('private-connector-hash')

    const activation = renderToStaticMarkup(createElement(RequiredUserActionDetail, { action: {
      kind: 'mcp_activation',
      componentKey: 'memory_tools',
      operation: 'connect',
      instruction: 'Allow this server.',
      hostVariant: 'qwen-code-cli',
      serverName: 'tidemind',
      configLabel: '~/.qwen/settings.json?token=private-token',
      reason: 'not_allowed',
    } }))
    expect(activation).toContain('tidemind')
    expect(activation).toContain('token=•••')
    expect(activation).not.toContain('private-token')

    const removal = renderToStaticMarkup(createElement(RequiredUserActionDetail, { action: {
      kind: 'manual_file_removal',
      componentKey: 'instruction',
      operation: 'disconnect',
      instruction: 'Remove the file.',
      physicalTargetLabel: '~/.agent/AGENTS.md?secret=private-secret',
      ownedFragmentHash: 'private-fragment-hash',
    } }))
    expect(removal).toContain('AGENTS.md?secret=•••')
    expect(removal).not.toContain('private-secret')
    expect(removal).not.toContain('private-fragment-hash')

    const codex = renderToStaticMarkup(createElement(RequiredUserActionDetail, { action: {
      kind: 'codex_hook_trust',
      componentKey: 'lifecycle',
      instruction: 'Trust this hook.',
      sourceLabel: '~/.codex/hooks/tidemind',
      hookKeyHash: 'private-hook-key-hash',
      ownedFragmentHash: 'private-owned-hash',
      hostCurrentHash: 'private-host-hash',
    } }))
    expect(codex).toContain('~/.codex/hooks/tidemind')
    expect(codex).not.toContain('private-hook-key-hash')
    expect(codex).not.toContain('private-owned-hash')

    const cowork = renderToStaticMarkup(createElement(RequiredUserActionDetail, { action: {
      kind: 'claude_cowork_plugin_upload',
      componentKey: 'memory_tools',
      operation: 'connect',
      instruction: 'BACKEND_COWORK_INSTRUCTION_MUST_NOT_RENDER',
      packageLabel: '~/Tide Mind/Cowork/tidemind.zip',
      packageName: 'tidemind.zip',
      packageHash: 'private-package-hash',
      steps: ['BACKEND_COWORK_STEP_MUST_NOT_RENDER'],
    } }))
    expect(cowork).toContain('tidemind.zip')
    expect(cowork).toContain('same task')
    expect(cowork).toContain('brain_recall')
    expect(cowork).toContain('brain_digest')
    expect(cowork).not.toContain('BACKEND_COWORK')
    expect(cowork).not.toContain('private-package-hash')

    const kimi = renderToStaticMarkup(createElement(RequiredUserActionDetail, { action: {
      kind: 'kimi_instruction_conflict',
      componentKey: 'instruction',
      operation: 'connect',
      reason: 'target_occupied',
      instruction: 'BACKEND_KIMI_INSTRUCTION_MUST_NOT_RENDER',
      sourceLabel: '~/.kimi-code/skills/tidemind-old/SKILL.md?token=private-token',
      targetLabel: '~/.kimi-code/skills/tidemind/SKILL.md?secret=private-secret',
      steps: ['BACKEND_KIMI_STEP_MUST_NOT_RENDER'],
    } }))
    expect(kimi).toContain('tidemind-old/SKILL.md?token=•••')
    expect(kimi).toContain('tidemind/SKILL.md?secret=•••')
    expect(kimi).toContain('run Check again.')
    expect(kimi).not.toContain('BACKEND_KIMI')
    expect(kimi).not.toContain('private-token')
    expect(kimi).not.toContain('private-secret')

    const source = readFileSync(resolve(process.cwd(), 'client/src/components/settings/agent-integration-managed/RequiredUserActionDetail.tsx'), 'utf8')
    expect(source).not.toContain('default:')
  })

  it('ships complete structured guidance for every supported renderer locale', () => {
    const english = JSON.parse(readFileSync(resolve(process.cwd(), 'client/src/locales/en/settings.json'), 'utf8'))
    const englishActions = english.agent.managed.userAction
    const englishGuidedRemoval = english.agent.managed.guidedRemoval
    const localizedActionKeys = ['qwenWorkConnect', 'qwenWorkDisconnect', 'claudeCoworkUpload', 'claudeCoworkRemove']
    for (const locale of ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt-BR', 'ru', 'tr', 'zh-CN', 'zh-TW']) {
      const settings = JSON.parse(readFileSync(resolve(process.cwd(), `client/src/locales/${locale}/settings.json`), 'utf8'))
      const guidance = settings.agent.managed.actionDetail.guidance
      for (const key of ['manageFile', 'userOwnedNotice', 'guidedConnect', 'guidedDisconnect', 'guidedImportStep', 'guidedVerifyStep', 'guidedRemoveStep']) {
        expect(settings.agent.managed.custom[key], `${locale}.custom.${key}`).toBeTruthy()
        if (locale !== 'en') expect(settings.agent.managed.custom[key], `${locale}.custom.${key} must be localized`).not.toBe(english.agent.managed.custom[key])
      }
      expect(settings.agent.managed.currentRequiredAction).toBeTruthy()
      expect(settings.agent.managed.openCurrentRequiredAction).toBeTruthy()
      expect(Object.keys(guidance.claudeCowork.connect)).toHaveLength(4)
      expect(Object.keys(guidance.claudeCowork.disconnect)).toHaveLength(3)
      expect(Object.keys(guidance.qwenWork.connect)).toHaveLength(4)
      expect(Object.keys(guidance.qwenWork.disconnect)).toHaveLength(3)
      expect(Object.keys(guidance.kimiConflict)).toHaveLength(3)
      expect(JSON.stringify(guidance)).toContain('brain_recall')
      expect(JSON.stringify(guidance)).toContain('brain_digest')
      expect(guidance.qwenWork.disconnect.step2).toContain('{{connector}}')
      expect(settings.agent.managed.guidedRemoval.title).toContain('{{connector}}')
      expect(settings.agent.managed.guidedRemoval.confirm).toContain('Qwen Work')
      expect(settings.agent.managed.guidedRemoval.userConfirmedNotice).toBeTruthy()
      expect(settings.agent.managed.guidedRemoval.notReady).toContain('Skill')
      expect(settings.agent.managed.event.userConfirmedGuidedRemoval).toBeTruthy()
      if (locale !== 'en') {
        for (const key of localizedActionKeys) {
          expect(settings.agent.managed.userAction[key], `${locale}.${key} must be localized`).not.toBe(englishActions[key])
        }
        expect(`${settings.agent.managed.userAction.qwenWorkConnect} ${settings.agent.managed.userAction.qwenWorkDisconnect}`).toContain('Qwen Work')
        expect(`${settings.agent.managed.userAction.qwenWorkConnect} ${settings.agent.managed.userAction.qwenWorkDisconnect}`).toContain('Tide Mind')
        expect(`${settings.agent.managed.userAction.qwenWorkConnect} ${settings.agent.managed.userAction.qwenWorkDisconnect}`).toContain('MCP')
        expect(`${settings.agent.managed.userAction.claudeCoworkUpload} ${settings.agent.managed.userAction.claudeCoworkRemove}`).toContain('Claude Cowork')
        expect(`${settings.agent.managed.userAction.claudeCoworkUpload} ${settings.agent.managed.userAction.claudeCoworkRemove}`).toContain('Tide Mind')
        expect(settings.agent.managed.guidedRemoval.confirm, `${locale}.guidedRemoval.confirm must be localized`)
          .not.toBe(englishGuidedRemoval.confirm)
        expect(settings.agent.managed.guidedRemoval.userConfirmedNotice, `${locale}.guidedRemoval.userConfirmedNotice must be localized`)
          .not.toBe(englishGuidedRemoval.userConfirmedNotice)
      }
    }
  })

  it('renders the Qwen Work same-conversation requirement in Chinese through renderer i18n', async () => {
    const chinese = JSON.parse(readFileSync(resolve(process.cwd(), 'client/src/locales/zh-CN/settings.json'), 'utf8'))
    i18n.addResourceBundle('zh-CN', 'settings', chinese, true, true)
    await i18n.changeLanguage('zh-CN')
    const markup = renderToStaticMarkup(createElement(RequiredUserActionDetail, { action: {
      kind: 'qwenwork_mcp_gui', componentKey: 'memory_tools', operation: 'connect',
      instruction: 'BACKEND_CHINESE_SENTINEL', connectorName: 'Tide Mind', serverType: 'STDIO',
      command: '/Applications/Tide Mind.app/mcp', args: ['--stdio'],
      environment: { EB_AGENT_ID: 'eb_qwen', EB_HOST_VARIANT: 'qwenwork-desktop' },
      configurationJson: '{"mcpServers":{}}', connectorConfigurationHash: 'hash',
      steps: ['BACKEND_STEP_SENTINEL'],
    } }))
    expect(markup).toContain('同一对话')
    expect(markup).toContain('brain_recall')
    expect(markup).toContain('brain_digest')
    expect(markup).not.toContain('BACKEND_')
    await i18n.changeLanguage('en')
  })
})
