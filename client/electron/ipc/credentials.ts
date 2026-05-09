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

      // 复制到数据目录;强制 0o600 防止 Service Account 密钥世界可读。
      // 修复 M30(2026-05-09):原 copyFileSync + chmodSync 之间存在短窗口
      // 文件以默认 0644 模式落盘可读;改用 writeFileSync({mode:0o600})
      // 一次性原子创建受限权限文件,无短窗口。
      // 加固(2026-05-10):writeFileSync 的 mode 选项仅在创建新文件时应用,
      // 目标文件已存在时 truncate 不变更 mode。先 unlink 再写,确保旧的 0644
      // 文件升级后真的变成 0600。
      // 注:Windows 上 mode 选项被忽略不抛错,与原 chmodSync catch 行为一致。
      const destPath = path.join(dataDir, 'vertex-credentials.json')
      try { fs.unlinkSync(destPath) } catch { /* 文件不存在或无权限,writeFileSync 会再次尝试 */ }
      fs.writeFileSync(destPath, content, { mode: 0o600 })

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
