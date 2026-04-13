import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export function registerStreamHandlers(dataDir: string): void {
  const streamDir = path.join(dataDir, 'stream')

  ipcMain.handle('stream:dates', () => {
    if (!fs.existsSync(streamDir)) return []
    return fs.readdirSync(streamDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''))
      .sort()
      .reverse()
  })

  ipcMain.handle('stream:get', (_e, date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ''
    const filePath = path.join(streamDir, `${date}.md`)
    if (!fs.existsSync(filePath)) return ''
    return fs.readFileSync(filePath, 'utf-8')
  })
}
