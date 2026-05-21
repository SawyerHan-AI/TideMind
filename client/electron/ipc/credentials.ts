import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../../../src/utils/logger.js'

const log = createLogger('credentials-ipc')

/**
 * 把 Vertex AI 凭证 JSON 内容写到目标路径,**强制** 0o600。
 *
 * 抽成 export 函数有两个理由:
 *   1. 测试可以直接调,不用塞 ipcMain / dialog mocks。
 *   2. 后面如果有第二种凭证文件(Anthropic / OpenAI keyfile)可以复用同一段
 *      "unlink-or-warn + writeFileSync mode + chmod 兜底"逻辑。
 *
 * 错误处理:
 *   - 写入失败(磁盘满 / 权限不足) → 抛错给 caller。这是真正的失败,不能吞。
 *   - chmod 失败(Windows / 异常 FS) → 仅记 log,不阻断 —— Windows 默认 ACL 已经
 *     不公开,POSIX mode 不适用;真正的 Unix 系统下 chmod 几乎不会失败。
 */
export function writeVertexCredentials(destPath: string, content: string): void {
  // 复制到数据目录;强制 0o600 防止 Service Account 密钥世界可读。
  // 修复 M30(2026-05-09):原 copyFileSync + chmodSync 之间存在短窗口
  // 文件以默认 0644 模式落盘可读;改用 writeFileSync({mode:0o600})
  // 一次性原子创建受限权限文件,无短窗口。
  // 加固(2026-05-10):writeFileSync 的 mode 选项仅在创建新文件时应用,
  // 目标文件已存在时 truncate 不变更 mode。先 unlink 再写,确保旧的 0644
  // 文件升级后真的变成 0600。
  // 加固(2026-05-21,HIGH):unlinkSync 可能因 EBUSY / EACCES 失败而被
  // 空 catch 吞掉,然后 writeFileSync 在现有 0644 文件上 truncate,mode 选项
  // 不生效 —— GCP Service Account 私钥仍然世界可读。改为 unlink-or-warn +
  // 一定调用 chmodSync 兜底:即便 mode 选项失效,chmod 是显式调用,会真改权限。
  // 注:Windows 上 chmod/mode 选项被忽略不抛错(NTFS 没有 POSIX mode),
  // 不影响安全 —— Windows 的访问控制走 ACL,文件默认就不是世界可读。
  try {
    fs.unlinkSync(destPath)
  } catch (err) {
    // ENOENT 是预期的(首次配置);其他错误 log 出来,但不放弃后续 write + chmod 兜底。
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`unlink ${destPath} failed (${(err as Error).message}); will rely on chmod fallback`)
    }
  }
  fs.writeFileSync(destPath, content, { mode: 0o600 })
  // **强制确认** 0o600。覆盖三种 unlink 失败的兜底场景:
  //   1) unlinkSync 抛 EBUSY(另一个进程持有句柄):writeFileSync truncate 不改 mode
  //   2) unlinkSync 抛 EACCES(父目录没 write 权限):同上
  //   3) 平台/FS 差异导致 mode 选项被忽略
  try {
    fs.chmodSync(destPath, 0o600)
  } catch (err) {
    // chmod 失败极少见(主要发生在 Windows / 网络盘 / 异常 FS),已知 Windows
    // 不支持 POSIX mode 但默认 ACL 也不公开;log 出来给排查用,但不阻断流程。
    log.warn(`chmod ${destPath} failed: ${(err as Error).message}`)
  }
}

export function registerCredentialHandlers(dataDir: string): void {
  // 通过系统文件选择器上传 Vertex AI Service Account 凭证
  ipcMain.handle('credentials:pick-vertex-file', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '选择 Google Cloud Service Account JSON 文件',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      })

      if (result.canceled || !result.filePaths[0]) {
        return { success: false }
      }

      const sourcePath = result.filePaths[0]
      // F9 (audit-9): 真实 GCP Service Account JSON 一般 ~2-3 KB,1MB 已远超合理上限。
      // 防御用户误选 / 拖了一个 巨型文件进来导致 readFileSync 阻塞主进程几秒甚至 OOM。
      try {
        const stat = fs.statSync(sourcePath)
        if (stat.size > 1_000_000) {
          return { success: false, error: '文件过大(>1MB),不是合法的 Service Account 凭证' }
        }
      } catch (e) {
        return { success: false, error: `无法访问文件: ${(e as Error).message}` }
      }
      const content = fs.readFileSync(sourcePath, 'utf-8')

      let parsed: any
      try {
        parsed = JSON.parse(content)
      } catch {
        return { success: false, error: '文件不是合法的 JSON' }
      }

      if (parsed.type !== 'service_account') {
        return { success: false, error: '不是 Service Account 类型的凭证文件' }
      }

      const destPath = path.join(dataDir, 'vertex-credentials.json')
      writeVertexCredentials(destPath, content)

      // 记录到时间线
      try {
        const { getClientDb } = await import('../db.js')
        const db = getClientDb()
        db.prepare(`
          INSERT INTO timeline_events (type, subtype, title, detail, important, actor, created)
          VALUES ('config', 'settings_change', ?, ?, 0, 'user', datetime('now'))
        `).run(
          '上传了 Vertex AI 凭证',
          JSON.stringify({ section: 'credentials', action: 'upload', type: 'vertex_sa' }),
        )
      } catch {}

      return {
        success: true,
        projectId: parsed.project_id ?? '',
      }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  })

  // 检查 Vertex 凭证文件状态
  ipcMain.handle('credentials:vertex-status', () => {
    const credPath = path.join(dataDir, 'vertex-credentials.json')
    if (!fs.existsSync(credPath)) {
      return { configured: false }
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(credPath, 'utf-8'))
      return {
        configured: true,
        projectId: parsed.project_id ?? '',
      }
    } catch {
      return { configured: false }
    }
  })
}
