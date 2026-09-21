import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMock.handlers.set(channel, handler)
    }),
  },
  clipboard: { writeText: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

vi.mock('electron', () => electronMock)
vi.mock('../../client/node_modules/electron/index.js', () => electronMock)

import {
  parseEventLimit,
  parseEventState,
  parseApplyTaskPageRequest,
  parseInstallationIds,
  parsePlanHash,
  parseCustomRequest,
  customPathDialogOptions,
  registerAgentIntegrationHandlers,
} from '../../client/electron/ipc/agent-integrations.js'
import { setAppLanguage, SUPPORTED_APP_LANGUAGES } from '../../client/electron/app-language.js'

const trustedEvent = { senderFrame: { url: 'file:///Applications/Tide%20Mind.app/Contents/Resources/renderer/index.html' } }
const trustedOptions = { expectedRendererUrl: trustedEvent.senderFrame.url }
let taskListener: ((task: Record<string, unknown>) => void) | null = null

function serviceMock() {
  return {
    snapshot: vi.fn(() => ({ families: [] })),
    scan: vi.fn(() => ({ detectedCount: 0 })),
    previewConnect: vi.fn(() => ({ planHash: 'a'.repeat(64) })),
    applyConnect: vi.fn(() => ({ results: [] })),
    startApplyConnect: vi.fn(() => ({
      id: 'agent_apply_1', planHash: 'a'.repeat(64), installationIds: ['installation-1'],
      pendingInstallationIds: ['installation-1'], results: [], state: 'running',
      startedAt: '2026-08-26T00:00:00.000Z', completedAt: null,
    })),
    getApplyTask: vi.fn(() => ({ id: 'agent_apply_1', state: 'running' })),
    listApplyTasks: vi.fn(() => ({
      tasks: [{ id: 'agent_apply_1', state: 'running' }],
      attentionCount: 1,
      activeCount: 1,
      totalCount: 1,
      startIndex: 0,
      hasMore: false,
      hasPrevious: false,
      nextCursor: null,
      previousCursor: null,
    })),
    onApplyTaskProgress: vi.fn((listener: (task: Record<string, unknown>) => void) => {
      taskListener = listener
      return () => { taskListener = null }
    }),
    inbox: vi.fn(() => ({
      unreadCount: 0,
      actionableUnreadCount: 0,
      startupUnreadCount: 0,
      events: [],
      startupEvents: [],
    })),
    pause: vi.fn(() => ({ id: 'installation-1' })),
    resume: vi.fn(() => ({ id: 'installation-1' })),
    previewResetAutoRestore: vi.fn(() => ({ planHash: 'c'.repeat(64) })),
    resetAutoRestore: vi.fn(() => ({ id: 'installation-1' })),
    previewDisconnect: vi.fn(() => ({ planHash: 'b'.repeat(64) })),
    disconnect: vi.fn(() => ({ results: [] })),
    detail: vi.fn(() => ({ installation: { id: 'installation-1' } })),
    listEvents: vi.fn(() => []),
    markEventRead: vi.fn(() => true),
    markInstallationEventsRead: vi.fn(() => 1),
    componentTargetPath: vi.fn(() => '/Users/test/.zcode/skills/tidemind'),
    supportCatalog: vi.fn(() => []),
    previewCustomInstallation: vi.fn(() => ({ preflightHash: 'd'.repeat(64) })),
    prepareCustomConnect: vi.fn(() => ({ planHash: 'e'.repeat(64) })),
    customMcpConfiguration: vi.fn(() => '{"mcpServers":{}}\n'),
    reviewCodexHookTrust: vi.fn(() => ({ installationId: 'installation-1', status: 'action_required' })),
    confirmCodexHookTrust: vi.fn(() => ({ installationId: 'installation-1', status: 'trust_recorded' })),
    reviewGuidedRemoval: vi.fn(() => ({ installationId: 'installation-1', status: 'action_required' })),
    confirmGuidedRemoval: vi.fn(() => ({ installationId: 'installation-1', status: 'removal_confirmed' })),
  }
}

describe('agent integrations IPC contract', () => {
  beforeEach(() => {
    electronMock.handlers.clear()
    electronMock.ipcMain.handle.mockClear()
    electronMock.clipboard.writeText.mockClear()
    electronMock.shell.showItemInFolder.mockClear()
    taskListener = null
    setAppLanguage('en')
  })

  it('maps native Custom Agent path dialogs from the main-process app locale', async () => {
    for (const language of SUPPORTED_APP_LANGUAGES) {
      setAppLanguage(language)
      const folder = customPathDialogOptions('config_root')
      const config = customPathDialogOptions('config_file')
      const executable = customPathDialogOptions('client_executable')
      expect(folder.title, language).not.toBe('')
      expect(folder.properties).toEqual(['openDirectory'])
      expect(config.title, language).not.toBe('')
      expect(config.properties).toEqual(['openFile'])
      expect(config.filters?.[0]?.name, language).not.toBe('')
      expect(config.filters?.[0]?.extensions).toEqual(['json', 'jsonc'])
      expect(executable.title, language).not.toBe('')
      expect(executable.properties).toEqual(['openFile'])
    }
    setAppLanguage('zh-CN')
    expect(customPathDialogOptions('config_root').title).toBe('选择本机 Agent 配置文件夹')
    expect(customPathDialogOptions('config_file').filters?.[0]?.name).toBe('JSON / JSONC 配置')

    electronMock.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    registerAgentIntegrationHandlers(serviceMock() as never, trustedOptions)
    const pickPath = electronMock.handlers.get('agent-integrations:pick-custom-path')!
    expect(await pickPath(trustedEvent, 'config_file')).toBeNull()
    expect(electronMock.dialog.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '选择本机 Agent JSON 配置文件',
      filters: [{ name: 'JSON / JSONC 配置', extensions: ['json', 'jsonc'] }],
    }))
    electronMock.dialog.showOpenDialog.mockClear()
    expect(await pickPath(trustedEvent, 'renderer supplied title')).toMatchObject({
      success: false,
      error: 'invalid_arguments',
    })
    expect(electronMock.dialog.showOpenDialog).not.toHaveBeenCalled()
  })

  it('registers the complete frozen renderer channel surface', () => {
    registerAgentIntegrationHandlers(serviceMock() as never, trustedOptions)
    expect([...electronMock.handlers.keys()].sort()).toEqual([
      'agent-integrations:apply-connect',
      'agent-integrations:confirm-codex-hook-trust',
      'agent-integrations:confirm-guided-removal',
      'agent-integrations:copy-component-path',
      'agent-integrations:copy-custom-mcp-configuration',
      'agent-integrations:detail',
      'agent-integrations:disconnect',
      'agent-integrations:get-apply-task',
      'agent-integrations:inbox',
      'agent-integrations:list-apply-tasks',
      'agent-integrations:list-events',
      'agent-integrations:mark-event-read',
      'agent-integrations:mark-installation-events-read',
      'agent-integrations:pause',
      'agent-integrations:pick-custom-path',
      'agent-integrations:prepare-claude-cowork-setup',
      'agent-integrations:prepare-custom-connect',
      'agent-integrations:preview-claude-cowork-setup',
      'agent-integrations:preview-connect',
      'agent-integrations:preview-custom-installation',
      'agent-integrations:preview-disconnect',
      'agent-integrations:preview-reset-auto-restore',
      'agent-integrations:reset-auto-restore',
      'agent-integrations:resume',
      'agent-integrations:reveal-component-path',
      'agent-integrations:review-codex-hook-trust',
      'agent-integrations:review-guided-removal',
      'agent-integrations:scan',
      'agent-integrations:snapshot',
      'agent-integrations:start-apply-connect',
      'agent-integrations:support-catalog',
    ])
  })

  it('strictly validates Custom local Agent requests and never accepts remote or shell-shaped input', async () => {
    expect(parseCustomRequest({
      mode: 'manual_mcp_client', configurationOwnership: 'user', displayName: 'Import client',
      clientExecutablePath: '/Applications/Client.app/Contents/MacOS/Client', configFilePath: '',
      schemaKind: 'standard_mcp_servers', selectorKey: 'tidemind',
    })).toMatchObject({ ok: true, data: { configurationOwnership: 'user', configFilePath: '' } })
    expect(parseCustomRequest({
      mode: 'manual_mcp_client', configurationOwnership: 'user', displayName: 'Remote client',
      clientExecutablePath: 'https://example.test/client', configFilePath: '',
      schemaKind: 'standard_mcp_servers', selectorKey: 'tidemind',
    }).ok).toBe(false)
    expect(parseCustomRequest({
      mode: 'nonstandard_config_root',
      displayName: 'Work profile',
      sourceInstallationId: 'installation-1',
      configRoot: '/Users/test/.agent-work',
    })).toMatchObject({ ok: true })
    expect(parseCustomRequest({
      mode: 'manual_mcp_client',
      displayName: 'Local client',
      clientExecutablePath: '/Applications/Client.app/Contents/MacOS/Client',
      configFilePath: '/Users/test/.client/config.json',
      schemaKind: 'standard_mcp_servers',
      selectorKey: 'tidemind-work',
    })).toMatchObject({ ok: true })
    expect(parseCustomRequest({
      mode: 'manual_mcp_client',
      displayName: 'Legacy client',
      clientExecutablePath: '/Applications/Client.app/Contents/MacOS/Client',
      configFilePath: '/Users/test/.client/config.json',
      schemaKind: 'nested_mcp_servers',
      selectorKey: 'tidemind-legacy',
      legacyInstallationId: 'installation_legacy_01',
    })).toEqual({ ok: true, data: expect.objectContaining({ legacyInstallationId: 'installation_legacy_01' }) })
    expect(parseCustomRequest({
      mode: 'manual_mcp_client',
      displayName: 'Remote',
      clientExecutablePath: 'https://example.test/agent',
      configFilePath: '/Users/test/config.json',
      schemaKind: 'standard_mcp_servers',
      selectorKey: 'tidemind',
    }).ok).toBe(false)
    expect(parseCustomRequest({
      mode: 'manual_mcp_client', displayName: 'Reserved',
      clientExecutablePath: '/usr/local/bin/client', configFilePath: '/Users/test/config.jsonc',
      schemaKind: 'standard_mcp_servers', selectorKey: '__proto__',
    }).ok).toBe(false)
    expect(parseCustomRequest({
      mode: 'manual_mcp_client',
      displayName: 'Shell',
      clientExecutablePath: '/bin/sh',
      configFilePath: '/Users/test/config.json',
      schemaKind: 'unknown',
      selectorKey: '$(touch bad)',
      command: 'sh -c anything',
    }).ok).toBe(false)

    const service = serviceMock()
    registerAgentIntegrationHandlers(service as never, trustedOptions)
    const valid = {
      mode: 'manual_mcp_client',
      displayName: 'Local client',
      clientExecutablePath: '/usr/local/bin/client',
      configFilePath: '/Users/test/.client/config.json',
      schemaKind: 'nested_mcp_servers',
      selectorKey: 'tidemind',
    }
    await electronMock.handlers.get('agent-integrations:preview-custom-installation')!(trustedEvent, valid)
    expect(service.previewCustomInstallation).toHaveBeenCalledWith(valid)

    await electronMock.handlers.get('agent-integrations:prepare-custom-connect')!(trustedEvent, 'e'.repeat(64), true)
    expect(service.prepareCustomConnect).toHaveBeenCalledWith('e'.repeat(64), true)

    await electronMock.handlers.get('agent-integrations:copy-custom-mcp-configuration')!(trustedEvent, 'd'.repeat(64))
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('{"mcpServers":{}}\n')
  })

  it('rejects malformed renderer parameters before delegating to the service', async () => {
    const service = serviceMock()
    registerAgentIntegrationHandlers(service as never, trustedOptions)

    const preview = electronMock.handlers.get('agent-integrations:preview-connect')!
    expect(await preview(trustedEvent, ['../escape'], 'yes')).toMatchObject({
      success: false,
      error: 'invalid_arguments',
    })
    expect(service.previewConnect).not.toHaveBeenCalled()

    const apply = electronMock.handlers.get('agent-integrations:apply-connect')!
    expect(await apply(trustedEvent, 'not-a-hash', ['installation-1'])).toMatchObject({
      success: false,
      error: 'invalid_arguments',
    })
    expect(service.applyConnect).not.toHaveBeenCalled()
  })

  it('normalizes valid parameters and delegates without performing configuration writes', async () => {
    const service = serviceMock()
    registerAgentIntegrationHandlers(service as never, trustedOptions)
    const hash = 'a'.repeat(64)

    await electronMock.handlers.get('agent-integrations:preview-connect')!(
      trustedEvent,
      ['installation-2', 'installation-1'],
      true,
      hash,
    )
    expect(service.previewConnect).toHaveBeenCalledWith(['installation-1', 'installation-2'], true, hash, {})

    await electronMock.handlers.get('agent-integrations:apply-connect')!(trustedEvent, hash, ['installation-1'])
    expect(service.applyConnect).toHaveBeenCalledWith(hash, ['installation-1'])

    await electronMock.handlers.get('agent-integrations:list-events')!(trustedEvent, 'installation-1', 'unread', 25)
    expect(service.listEvents).toHaveBeenCalledWith('installation-1', 'unread', 25)

    await electronMock.handlers.get('agent-integrations:preview-reset-auto-restore')!(trustedEvent, 'installation-1')
    expect(service.previewResetAutoRestore).toHaveBeenCalledWith('installation-1')

    await electronMock.handlers.get('agent-integrations:reset-auto-restore')!(trustedEvent, hash, 'installation-1')
    expect(service.resetAutoRestore).toHaveBeenCalledWith(hash, 'installation-1')

    await electronMock.handlers.get('agent-integrations:mark-installation-events-read')!(trustedEvent, 'installation-1')
    expect(service.markInstallationEventsRead).toHaveBeenCalledWith('installation-1')

    await electronMock.handlers.get('agent-integrations:review-codex-hook-trust')!(trustedEvent, 'installation-1')
    expect(service.reviewCodexHookTrust).toHaveBeenCalledWith('installation-1')

    await electronMock.handlers.get('agent-integrations:confirm-codex-hook-trust')!(trustedEvent, hash)
    expect(service.confirmCodexHookTrust).toHaveBeenCalledWith(hash)

    await electronMock.handlers.get('agent-integrations:review-guided-removal')!(trustedEvent, 'installation-1')
    expect(service.reviewGuidedRemoval).toHaveBeenCalledWith('installation-1')

    await electronMock.handlers.get('agent-integrations:confirm-guided-removal')!(trustedEvent, hash)
    expect(service.confirmGuidedRemoval).toHaveBeenCalledWith(hash)
  })

  it('streams real task progress only to the trusted invoking renderer', async () => {
    const service = serviceMock()
    registerAgentIntegrationHandlers(service as never, trustedOptions)
    const sender = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    const event = { ...trustedEvent, sender }
    const hash = 'a'.repeat(64)

    await electronMock.handlers.get('agent-integrations:start-apply-connect')!(event, hash, ['installation-1'])
    taskListener?.({ id: 'agent_apply_1', state: 'running', results: [{ installationId: 'installation-1' }] })
    expect(sender.send).toHaveBeenCalledWith(
      'agent-integration:task-progress',
      expect.objectContaining({ id: 'agent_apply_1' }),
    )
  })

  it('re-subscribes a remounted trusted renderer to enumerated running tasks', async () => {
    const service = serviceMock()
    registerAgentIntegrationHandlers(service as never, trustedOptions)
    const sender = { send: vi.fn(), isDestroyed: vi.fn(() => false) }
    const event = { ...trustedEvent, sender }

    await electronMock.handlers.get('agent-integrations:list-apply-tasks')!(event, { limit: 20 })
    expect(service.listApplyTasks).toHaveBeenCalledWith({ limit: 20 })
    taskListener?.({ id: 'agent_apply_1', state: 'completed', results: [] })
    expect(sender.send).toHaveBeenCalledWith(
      'agent-integration:task-progress',
      expect.objectContaining({ id: 'agent_apply_1', state: 'completed' }),
    )
  })

  it('validates bounded task-feed page requests and opaque cursors', () => {
    expect(parseApplyTaskPageRequest(undefined)).toEqual({ ok: true, data: {} })
    expect(parseApplyTaskPageRequest({ limit: 50, cursor: 'opaque-cursor' })).toEqual({
      ok: true,
      data: { limit: 50, cursor: 'opaque-cursor' },
    })
    expect(parseApplyTaskPageRequest(20).ok).toBe(false)
    expect(parseApplyTaskPageRequest({ limit: 51 }).ok).toBe(false)
    expect(parseApplyTaskPageRequest({ limit: 0 }).ok).toBe(false)
    expect(parseApplyTaskPageRequest({ cursor: '' }).ok).toBe(false)
    expect(parseApplyTaskPageRequest({ cursor: 'a'.repeat(513) }).ok).toBe(false)
    expect(parseApplyTaskPageRequest({ limit: 20, unexpected: true }).ok).toBe(false)
  })

  it('resolves component paths in main and never returns the raw path to the renderer', async () => {
    const service = serviceMock()
    registerAgentIntegrationHandlers(service as never, trustedOptions)

    const copyResult = await electronMock.handlers.get('agent-integrations:copy-component-path')!(
      trustedEvent,
      'installation-1',
      'instruction',
    )
    expect(copyResult).toBe(true)
    expect(service.componentTargetPath).toHaveBeenCalledWith('installation-1', 'instruction')
    expect(electronMock.clipboard.writeText).toHaveBeenCalledWith('/Users/test/.zcode/skills/tidemind')

    const invalid = await electronMock.handlers.get('agent-integrations:reveal-component-path')!(
      trustedEvent,
      'installation-1',
      '../escape',
    )
    expect(invalid).toMatchObject({ success: false, error: 'invalid_arguments' })
    expect(electronMock.shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('rejects calls from an untrusted or missing renderer frame', async () => {
    const service = serviceMock()
    registerAgentIntegrationHandlers(service as never, trustedOptions)

    const snapshot = electronMock.handlers.get('agent-integrations:snapshot')!
    expect(await snapshot({ senderFrame: { url: 'https://attacker.invalid/' } })).toMatchObject({
      success: false,
      error: 'invalid_arguments',
    })
    expect(await snapshot({
      senderFrame: { url: 'file:///tmp/attacker/renderer/index.html' },
    })).toMatchObject({ success: false, error: 'invalid_arguments' })
    expect(await snapshot({})).toMatchObject({ success: false, error: 'invalid_arguments' })
    expect(service.snapshot).not.toHaveBeenCalled()
  })

  it('accepts HashRouter routes only for the exact packaged renderer document', async () => {
    const service = serviceMock()
    registerAgentIntegrationHandlers(service as never, trustedOptions)
    const snapshot = electronMock.handlers.get('agent-integrations:snapshot')!

    expect(await snapshot({
      senderFrame: { url: `${trustedEvent.senderFrame.url}#/settings?tab=agent` },
    })).toEqual({ families: [] })
    expect(await snapshot({
      senderFrame: { url: 'file:///tmp/fake/index.html#/settings' },
    })).toMatchObject({ success: false, error: 'invalid_arguments' })
  })

  it('validates hashes, bounded lists, event state and event limit', () => {
    expect(parsePlanHash('a'.repeat(64))).toEqual({ ok: true, data: 'a'.repeat(64) })
    expect(parsePlanHash('A'.repeat(64)).ok).toBe(false)
    expect(parseInstallationIds([]).ok).toBe(false)
    expect(parseInstallationIds(['installation-1', 'installation-1']).ok).toBe(false)
    expect(parseEventState('archived')).toEqual({ ok: true, data: 'archived' })
    expect(parseEventState('deleted').ok).toBe(false)
    expect(parseEventLimit(1_001).ok).toBe(false)
  })
})
