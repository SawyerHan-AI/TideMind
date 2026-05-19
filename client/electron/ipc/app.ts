/**
 * App-level IPC handlers: version check, external links, etc.
 */

import { ipcMain, shell, app } from 'electron'
import crypto from 'node:crypto'
import { createLogger } from '@server/utils/logger.js'
import { getConfig } from '@server/config.js'
import { parseExternalUrl } from './_schemas.js'

const log = createLogger('ipc-app')

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  releaseUrl: string | null
  releaseNotes: string | null
  publishedAt: string | null
  /** 'verified' = 签名验签通过 | 'unsigned' = 服务端未下发签名 | 'invalid' = 签名验签失败,客户端拒绝此更新 */
  signatureStatus?: 'verified' | 'unsigned' | 'invalid'
}

/**
 * 内置公钥(ed25519, PEM SPKI 格式)。
 *
 * 启用于 2026-05-19。配对私钥保管在韩思远 1Password "TideMind Release Signing" 条目。
 * 生成命令:`node scripts/gen-signing-keypair.mjs`(scripts/gen-signing-keypair.mjs)
 *
 * 启用后行为:
 *   - 服务端 /api/v1/update/latest 必须返回 signatureUrl 才接受更新
 *   - 签名不匹配 → 拒绝该更新(safe fail)
 *   - 现网老客户端(v0.2.61 及更早,没有验签代码)继续接受未签名更新 — 升级到带验签
 *     代码 + 公钥的版本后才真正受保护
 *
 * 警告:启用后所有发版必须签名。SIGNING_PRIVATE_KEY 未设时 release.mjs 强制
 * 报错 + 必须显式 --allow-unsigned 才放行(scripts/release.mjs:signReleaseAssets)。
 *
 * 应急/轮换:私钥泄漏时,(1) 立刻生成新 keypair, (2) 改这里嵌入新公钥, (3) 发新版客户端,
 * (4) 等所有用户升级后才能切到新私钥签名。当前实现单 key,无 fallback——双 key 轮换
 * 在 backlog "release signing 双 key 应急轮换"(2026-05-19 起)。
 */
const UPDATE_PUBLIC_KEY_PEM = process.env.TIDEMIND_UPDATE_PUBLIC_KEY ?? `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWcIC4xPD18+eGpgaJSxV6MF1vUD0zPEp7T4wFxKWjXQ=
-----END PUBLIC KEY-----
`

/**
 * 验证更新清单签名。signature 是对 `${version}\n${url}` 的 ed25519 签名(base64)。
 * 公钥未配置 → 'unsigned'(允许更新);签名缺失 → 'unsigned';签名不匹配 → 'invalid'(拒绝)。
 */
async function verifyUpdateSignature(
  signatureUrl: string | null,
  version: string,
  url: string,
): Promise<'verified' | 'unsigned' | 'invalid'> {
  if (!UPDATE_PUBLIC_KEY_PEM) return 'unsigned' // 未启用签名
  if (!signatureUrl) {
    log.warn('update has no signatureUrl but public key is configured — refusing update')
    return 'invalid'
  }
  try {
    const sigResp = await fetch(signatureUrl, { signal: AbortSignal.timeout(10_000) })
    if (!sigResp.ok) return 'invalid'
    const sigText = (await sigResp.text()).trim()
    const sigBuf = Buffer.from(sigText, 'base64')
    const message = Buffer.from(`${version}\n${url}`, 'utf8')
    const publicKey = crypto.createPublicKey(UPDATE_PUBLIC_KEY_PEM)
    // ed25519 verify:第一参数 algorithm=null (ed25519 自带 hash)
    const ok = crypto.verify(null, message, publicKey, sigBuf)
    return ok ? 'verified' : 'invalid'
  } catch (err) {
    log.error(`update signature verify error: ${(err as Error).message}`)
    return 'invalid'
  }
}

function getUpdateEndpoint(): string {
  const cloudUrl = getConfig().cloud?.server_url ?? 'https://cloud.tidemind.ai'
  return `${cloudUrl}/api/v1/update/latest`
}

export function registerAppHandlers(): void {
  ipcMain.handle('app:get-version', () => app.getVersion())

  ipcMain.handle('app:open-external', async (_event, url: unknown) => {
    const parsed = parseExternalUrl(url)
    if (!parsed.ok) return parsed.error

    await shell.openExternal(parsed.data)
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
        signatureUrl?: string | null
        releaseDate: string | null
        releaseNotes: string | null
        releaseUrl?: string
      }
      const hasUpdate = !!data.url
      // 验签:启用了公钥但签名不匹配 → 拒绝此更新,避免恶意 release 推到全量用户。
      let signatureStatus: 'verified' | 'unsigned' | 'invalid' = 'unsigned'
      if (hasUpdate && data.url) {
        signatureStatus = await verifyUpdateSignature(data.signatureUrl ?? null, data.version, data.url)
        if (signatureStatus === 'invalid') {
          log.warn(`update ${data.version} REJECTED: signature invalid`)
          return {
            hasUpdate: false,
            currentVersion,
            latestVersion: data.version,
            releaseUrl: data.releaseUrl ?? data.url,
            releaseNotes: data.releaseNotes?.slice(0, 500) ?? null,
            publishedAt: data.releaseDate ?? null,
            signatureStatus,
          }
        }
      }
      return {
        hasUpdate,
        currentVersion,
        latestVersion: data.version,
        releaseUrl: data.releaseUrl ?? data.url,
        releaseNotes: data.releaseNotes?.slice(0, 500) ?? null,
        publishedAt: data.releaseDate ?? null,
        signatureStatus,
      }
    } catch (err) {
      log.error(`check update failed: ${(err as Error).message}`)
      throw err
    }
  })
}
