import type Database from 'better-sqlite3'
import { BrowserWindow } from 'electron'
import { createLogger } from '@server/utils/logger.js'
import { clearFirstRegisteredAt, resetDeviceRegistration } from './device.js'
import { evaluateLocalRole } from './primary-device.js'
import { startCloudSyncIfConfigured } from './startup.js'
import { destroySyncClient } from './sync-client.js'
import { clearDeferredUploads, discardUploadRelease } from './upload-deferral.js'
import { refreshDesktopVectorRuntime } from './vector-runtime.js'

const log = createLogger('cloud-session')

/** 通知界面云端状态有变化(登录状态、设备注册状态)。 */
export function notifyCloudChanged(): void { notifyRenderer() }

function notifyRenderer(): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('data-changed', { scopes: ['cloud'] })
    }
  } catch { /* 没有窗口时无需通知 */ }
}

/**
 * 本机已不再登录之后的全部清理。主动登出与被动登出（凭据被云端拒绝）共用，可重复调用。
 *
 * 被动登出原先只重新求值角色，同步客户端留在原地；之后重新登录时发现“已有实例”就不再
 * 启动，设备注册被跳过，本机停在不承担整理。
 */
export function handleSignedOut(db: Database.Database): void {
  destroySyncClient()
  resetDeviceRegistration()
  clearDeferredUploads()
  if (db.open) {
    clearFirstRegisteredAt(db)
    discardUploadRelease(db)
    evaluateLocalRole(db)
    void refreshDesktopVectorRuntime(db).catch((error) => log.warn(`vector runtime refresh failed: ${String(error)}`))
  }
  notifyRenderer()
}

/**
 * 登录成功后重新建立同步。先销毁已有的同步客户端并丢弃上一次的注册结果：
 * 设备注册与角色同步在同步客户端的启动流程里，只有重新启动才会执行。
 */
export async function restartCloudSyncAfterSignIn(db: Database.Database): Promise<void> {
  destroySyncClient()
  resetDeviceRegistration()
  // 可能换了账号:上一个账号的首次注册时间与推迟记录都不再适用。
  clearDeferredUploads()
  if (db.open) { clearFirstRegisteredAt(db); discardUploadRelease(db) }
  await startCloudSyncIfConfigured(db)
}
