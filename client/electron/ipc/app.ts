/**
 * App-level IPC handlers: version check, external links, etc.
 */

import { ipcMain, shell, app } from 'electron'
import { createLogger } from '@server/utils/logger.js'
import { getConfig } from '@server/config.js'

const log = createLogger('ipc-app')

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  releaseUrl: string | null
  releaseNotes: string | null
  publishedAt: string | null
}

function getUpdateEndpoint(): string {
  const cloudUrl = getConfig().cloud?.server_url ?? 'https://cloud.tidemind.ai'
  return `${cloudUrl}/api/v1/update/latest`
}

export function registerAppHandlers(): void {
  ipcMain.handle('app:get-version', () => app.getVersion())

  ipcMain.handle('app:open-external', async (_event, url: string) => {
    if (typeof url !== 'string' || (!url.startsWith('https://') && !url.startsWith('http://'))) {
      throw new Error('Invalid URL')
    }
    await shell.openExternal(url)
  })

  ipcMain.handle('app:check-update', async (): Promise<UpdateInfo> => {
    const currentVersion = app.getVersion()
    try {
      const endpoint = getUpdateEndpoint()
      const params = new URLSearchParams({
        platform: process.platform,
        arch: process.arch,
        version: currentVersion,
      })
      const resp = await fetch(`${endpoint}?${params}`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (!resp.ok) {
        log.warn(`update endpoint returned ${resp.status}`)
        return { hasUpdate: false, currentVersion, latestVersion: currentVersion, releaseUrl: null, releaseNotes: null, publishedAt: null }
      }
      const data = await resp.json() as {
        version: string
        url: string | null
        releaseDate: string | null
        releaseNotes: string | null
        releaseUrl?: string
      }
      const hasUpdate = !!data.url
      return {
        hasUpdate,
        currentVersion,
        latestVersion: data.version,
        releaseUrl: data.releaseUrl ?? data.url,
        releaseNotes: data.releaseNotes?.slice(0, 500) ?? null,
        publishedAt: data.releaseDate ?? null,
      }
    } catch (err) {
      log.error(`check update failed: ${(err as Error).message}`)
      throw err
    }
  })
}
