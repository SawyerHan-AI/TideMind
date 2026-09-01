import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electronMock.handlers.set(channel, handler)
    }),
  },
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/tmp/tidemind-app'),
  },
}))

const adapterMock = vi.hoisted(() => ({
  generate: vi.fn(),
  install: vi.fn(),
  uninstall: vi.fn(),
  getPath: vi.fn(() => null),
  getStatus: vi.fn(() => ({ exists: false })),
  clientType: 'claude-code',
}))

vi.mock('electron', () => ({ ipcMain: electronMock.ipcMain, app: electronMock.app }))
vi.mock('../../client/node_modules/electron/index.js', () => ({ ipcMain: electronMock.ipcMain, app: electronMock.app }))
vi.mock('../../client/electron/ipc/agent-plugins/registry.js', () => ({
  allAgentPluginAdapters: () => [adapterMock],
  getAgentPluginAdapter: () => adapterMock,
}))

import { registerPluginGeneratorHandlers } from '../../client/electron/ipc/plugin-generator.js'

describe('legacy Agent plugin writer cutover', () => {
  beforeEach(() => {
    electronMock.handlers.clear()
    electronMock.ipcMain.handle.mockClear()
    adapterMock.generate.mockReset()
    adapterMock.install.mockReset()
    adapterMock.uninstall.mockReset()
  })

  it('keeps every legacy mutation IPC fail-closed unless explicitly opted in', async () => {
    registerPluginGeneratorHandlers('/tmp/tidemind-managed-cutover')

    const generate = await electronMock.handlers.get('agents:generate-plugin')!(null, {
      agentId: 'eb_abcdefgh',
      agentName: 'Agent One',
      clientType: 'claude-code',
    })
    const install = await electronMock.handlers.get('agents:install-plugin')!(null, 'tidemind-eb_abcdefgh')
    const uninstall = await electronMock.handlers.get('agents:uninstall-plugin')!(null, 'eb_abcdefgh', 'claude-code')

    for (const result of [generate, install, uninstall]) {
      expect(result).toMatchObject({
        success: false,
        error: 'Legacy Agent configuration is read-only; use the managed Agent integration flow',
      })
    }
    expect(adapterMock.generate).not.toHaveBeenCalled()
    expect(adapterMock.install).not.toHaveBeenCalled()
    expect(adapterMock.uninstall).not.toHaveBeenCalled()
  })
})
