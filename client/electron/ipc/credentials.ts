import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

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

      // 复制到数据目录；强制 0o600 防止 Service Account 密钥世界可读
      // （copyFileSync 继承 umask，通常为 0644；SA 文件含 private_key 必须收紧）
      const destPath = path.join(dataDir, 'vertex-credentials.json')
      fs.copyFileSync(sourcePath, destPath)
      try {
        fs.chmodSync(destPath, 0o600)
      } catch {
        // Windows 上 chmod 语义不同（无 POSIX 权限位），失败忽略；
        // macOS/Linux 正常路径不会走到这里
      }

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
