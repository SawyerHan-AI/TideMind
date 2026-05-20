/**
 * 查询 cloud-server update manifest + ed25519 验签。
 *
 * 复用 ipc/app.ts 已 export 的 verifyUpdateSignature 和 getUpdateEndpoint —
 * 与"手动检查更新"路径共用同一套信任锚点(嵌入公钥),避免双份维护导致漂移。
 *
 * 返回值语义:
 *   - 'no-update': 端点说没有新版本
 *   - 'verified':  有新版本且签名验签通过
 *   - 'unsigned':  有新版本但服务端未下发签名(向后兼容老 release)
 *   - 'invalid':   签名验签失败 — 拒绝此更新
 *   - 'fetch-error': 端点不可达 / 超时 / 返回错误
 */

import { createLogger } from '@server/utils/logger.js'
import { app } from 'electron'
import { verifyUpdateSignature, getUpdateEndpoint } from '../ipc/app.js'
import { getUpdateChannel } from './channel.js'
import { compareSemver } from '@server/utils/semver-compare.js'

const log = createLogger('updater-verifier')

export interface ManifestResult {
  status: 'no-update' | 'verified' | 'unsigned' | 'invalid' | 'fetch-error'
  version?: string
  url?: string
  releaseUrl?: string
  releaseNotes?: string
  mandatory?: boolean
  stagingPercentage?: number | null
}

export async function queryAndVerifyManifest(): Promise<ManifestResult> {
  const currentVersion = app.getVersion()
  const channel = getUpdateChannel()

  try {
    const endpoint = getUpdateEndpoint()
    const params = new URLSearchParams({
      platform: process.platform,
      arch: process.arch,
      version: currentVersion,
      channel,
    })

    const resp = await fetch(`${endpoint}?${params}`, {
      signal: AbortSignal.timeout(10_000),
    })

    if (!resp.ok) {
      log.warn(`endpoint returned ${resp.status}`)
      return { status: 'fetch-error' }
    }

    const data = await resp.json() as {
      version: string
      url: string | null
      signatureUrl?: string | null
      secondarySignatureUrl?: string | null
      releaseDate: string | null
      releaseNotes: string | null
      releaseUrl?: string
      mandatory?: boolean
      stagingPercentage?: number | null
    }

    if (!data.url) {
      return { status: 'no-update', version: data.version }
    }

    // 修复(2026-05-20 Audit D-2):downgrade guard。
    // 服务端理论上不会下发比客户端旧的版本(routes.ts 已做 compareVersions > 0 检查),
    // 但如果 cloud-server 被入侵 / Railway env 配错(STAGING_PERCENTAGE_STABLE 老 manifest
    // 缓存被推),恶意/错误的旧版本 manifest 会绕过服务端门控。客户端再做一次硬校验,
    // 双层防御。原 .sig 是对 ${version}\n${url} 的签名,攻击者重放老 .sig 也合法,
    // 所以必须靠版本数字比较挡。
    if (compareSemver(data.version, currentVersion) <= 0) {
      log.warn(`update REJECTED: server returned ${data.version} which is not newer than current ${currentVersion}`)
      return { status: 'no-update', version: currentVersion }
    }

    const sigStatus = await verifyUpdateSignature(
      data.signatureUrl ?? null,
      data.version,
      data.url,
      data.secondarySignatureUrl ?? null,
    )

    if (sigStatus === 'invalid') {
      log.warn(`update ${data.version} REJECTED: signature invalid`)
      return { status: 'invalid', version: data.version, releaseUrl: data.releaseUrl ?? data.url }
    }

    if (sigStatus === 'unreachable') {
      // 修复(2026-05-20 Audit D-3):区分网络抖动与真签名失败。
      // 这条更新当前无法验签(网络问题/GitHub Pages 暂时不可达),不算拒绝,
      // 当成 fetch-error 让下次 30s 轮询自然重试,UI 不显示阻塞性"签名异常"banner。
      log.warn(`update ${data.version} signature unreachable — will retry next cycle`)
      return { status: 'fetch-error' }
    }

    return {
      status: sigStatus === 'verified' ? 'verified' : 'unsigned',
      version: data.version,
      url: data.url,
      releaseUrl: data.releaseUrl ?? data.url,
      releaseNotes: data.releaseNotes?.slice(0, 500) ?? undefined,
      mandatory: data.mandatory ?? false,
      stagingPercentage: data.stagingPercentage ?? null,
    }
  } catch (err) {
    log.error(`query manifest failed: ${(err as Error).message}`)
    return { status: 'fetch-error' }
  }
}
