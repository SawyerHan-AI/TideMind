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
