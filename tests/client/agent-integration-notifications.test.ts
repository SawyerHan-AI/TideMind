import { beforeEach, describe, expect, it, vi } from 'vitest'

const notificationMock = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  shown: false,
}))

vi.mock('electron', () => {
  const app = {
    getPath: () => '/tmp/tidemind-test-app-data',
    getVersion: () => '0.2.89-test',
    getAppPath: () => '/tmp/tidemind-test-app',
    isPackaged: false,
  }
  class Notification {
    static isSupported() { return true }
    on(event: string, callback: () => void) {
      notificationMock.listeners.set(event, callback)
      return this
    }
    show() { notificationMock.shown = true }
  }
  return { app, Notification, default: { app, Notification } }
})

vi.mock('../../src/strategy/loader.js', () => ({
  getParam: (_strategy: string, _parameter: string, fallback: number) => fallback,
  getPrompt: () => '',
  loadStrategies: () => {},
  getStrategy: () => null,
}))

import { productionNotifications } from '../../client/electron/agent-integration/production-service'

describe('production Agent integration notifications', () => {
  beforeEach(() => {
    notificationMock.listeners.clear()
    notificationMock.shown = false
  })
  it('opens the exact Installation from a safe notification click', async () => {
    const opened: string[] = []
    const notifications = productionNotifications({
      onOpenInstallation: installationId => { opened.push(installationId) },
      system: {
        isSupported: () => true,
        create: () => ({
          on: (event: 'click', callback: () => void) => {
            notificationMock.listeners.set(event, callback)
          },
          show: () => { notificationMock.shown = true },
        }),
      },
    })

    await notifications.deliver({
      title: 'Agent configuration restored',
      body: 'Tide Mind restored a configuration.',
      level: 'info',
      eventId: 'event-1',
      installationId: 'installation-1',
      actions: ['view_details', 'disconnect'],
    })

    expect(notificationMock.shown).toBe(true)
    notificationMock.listeners.get('click')?.()
    expect(opened).toEqual(['installation-1'])
  })

  it('uses the in-app channel while active and when system notifications are unavailable', async () => {
    const delivered: string[] = []
    const input = {
      title: 'Agent configuration restored',
      body: 'Tide Mind restored a configuration.',
      level: 'info' as const,
      eventId: 'event-1',
      installationId: 'installation-1',
      actions: ['view_details' as const],
    }
    const active = productionNotifications({
      isAppActive: () => true,
      onInAppNotification: notification => { delivered.push(notification.eventId) },
      system: {
        isSupported: () => true,
        create: () => ({ on: () => {}, show: () => { notificationMock.shown = true } }),
      },
    })
    await active.deliver(input)
    expect(delivered).toEqual(['event-1'])
    expect(notificationMock.shown).toBe(false)

    const unsupported = productionNotifications({
      isAppActive: () => false,
      onInAppNotification: notification => { delivered.push(notification.eventId) },
      system: {
        isSupported: () => false,
        create: () => ({ on: () => {}, show: () => { notificationMock.shown = true } }),
      },
    })
    await unsupported.deliver({ ...input, eventId: 'event-2' })
    expect(delivered).toEqual(['event-1', 'event-2'])
    expect(notificationMock.shown).toBe(false)
  })
})
