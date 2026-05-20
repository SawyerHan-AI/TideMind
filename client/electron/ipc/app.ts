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
// 修复(2026-05-20 Audit D-5):用 `||` 而不是 `??`。
// `??` 只在 env 是 undefined/null 时 fallback,如果有人在 CI/Docker 把
// TIDEMIND_UPDATE_PUBLIC_KEY 设成空字符串(常见的"清空 env 但忘删 key"操作),
// 整个 const 会变成空串 → verifyUpdateSignature 第一行 `if (!UPDATE_PUBLIC_KEY_PEM)`
// 返回 'unsigned' → 静默关闭整套验签。`||` 把空串也算 falsy 触发 fallback。
const UPDATE_PUBLIC_KEY_PEM = process.env.TIDEMIND_UPDATE_PUBLIC_KEY || `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWcIC4xPD18+eGpgaJSxV6MF1vUD0zPEp7T4wFxKWjXQ=
-----END PUBLIC KEY-----
`

/**
 * 备用公钥(双 key 轮换支持)。默认空 = 不启用双 key 验证,行为与单 key 完全相同。
 *
 * Why: 主私钥泄漏时需要立即换 key,但已发布的客户端只信任主公钥,无法验证新版的
 * 新签名。备用 key 让"新旧两个版本的 release"都能被同一客户端验证 → 平滑切换。
 * How to apply: 紧急轮换流程:
 *   1. 生成新 keypair,把新公钥填到这里 SECONDARY 位置 → 立即发版
 *   2. 等用户大面积升级到含 SECONDARY 公钥的版本(~1 个月)
 *   3. 切换发版用的私钥:旧的退役、新的成为主签名
 *   4. 下下个版本:把 SECONDARY 提升到主位置,SECONDARY 清空,完成轮换
 *
 * 服务端 /api/v1/update/latest 优先下发 .sig(主),verify 失败再尝试 .sig.secondary。
 */
const UPDATE_PUBLIC_KEY_PEM_SECONDARY = process.env.TIDEMIND_UPDATE_PUBLIC_KEY_SECONDARY ?? ''

/**
 * 用单个公钥验证一个 .sig。失败返回 false,异常返回 null(用于区分"明确不匹配"
 * 与"PEM 损坏 / 网络错误"等不应触发"切到 secondary"的硬错)。
 */
export function verifyWithPublicKey(
  publicKeyPem: string,
  message: Buffer,
  sigBuf: Buffer,
): boolean {
  try {
    const publicKey = crypto.createPublicKey(publicKeyPem)
    return crypto.verify(null, message, publicKey, sigBuf)
  } catch (err) {
    log.error(`verify with public key failed: ${(err as Error).message}`)
    return false
  }
}

/**
 * 用主或备用公钥验证签名。任一通过即认为合法(双 key 轮换支持)。
 *
 * Why: 紧急换 key 期间,新签名可能用主或 secondary 私钥签的,客户端需要两边都试。
 * Pure 函数:无 IO,无 mutate,易测试。
 * How to apply: verifyUpdateSignature 拿到 sigBuf 后调本函数判定。
 */
export function verifyWithEitherKey(
  primaryPem: string,
  secondaryPem: string,
  message: Buffer,
  sigBuf: Buffer,
): boolean {
  if (primaryPem && verifyWithPublicKey(primaryPem, message, sigBuf)) return true
  if (secondaryPem && verifyWithPublicKey(secondaryPem, message, sigBuf)) return true
  return false
}

/**
 * 验证更新清单签名。signature 是对 `${version}\n${url}` 的 ed25519 签名(base64)。
 * 公钥未配置 → 'unsigned'(允许更新);签名缺失 → 'unsigned';签名不匹配 → 'invalid'(拒绝);
 * 签名 URL 拿不到(网络错误 / 服务端 500)→ 'unreachable'(应该重试,不拒绝更新)。
 *
 * 修复(2026-05-20 Audit D-3):原实现把"网络错误"和"签名不匹配"都返回 'invalid',
 * 用户日志看到"签名异常"既可能是真攻击也可能只是 GitHub 网络抖动。同口径久而久之
 * 训练用户忽略警告。区分后,UI 层对 'invalid' 显示阻塞性 banner,对 'unreachable'
 * 提示"网络重试中"。
 *
 * 双 key 轮换:主签名失败 → 尝试 secondary 签名(如果 secondary 公钥已配置且服务端
 * 提供了 .sig.secondary URL)。任意一边验证通过即认为合法。
 */
export type SignatureVerdict = 'verified' | 'unsigned' | 'invalid' | 'unreachable'

export async function verifyUpdateSignature(
  signatureUrl: string | null,
  version: string,
  url: string,
  secondarySignatureUrl: string | null = null,
): Promise<SignatureVerdict> {
  if (!UPDATE_PUBLIC_KEY_PEM) return 'unsigned' // 未启用签名
  if (!signatureUrl) {
    log.warn('update has no signatureUrl but public key is configured — refusing update')
    return 'invalid'
  }
  const message = Buffer.from(`${version}\n${url}`, 'utf8')

  // 区分"网络失败"(应重试)与"签名不匹配"(应拒绝)。anyReachable 标记
  // 至少一个 .sig URL 成功拉到正文,即便内容验签失败也是真有签名不对。
  let anyReachable = false
  try {
    // 主签名 + 主公钥
    const sigResp = await fetch(signatureUrl, { signal: AbortSignal.timeout(10_000) })
    if (sigResp.ok) {
      anyReachable = true
      const sigText = (await sigResp.text()).trim()
      const sigBuf = Buffer.from(sigText, 'base64')
      if (verifyWithEitherKey(UPDATE_PUBLIC_KEY_PEM, UPDATE_PUBLIC_KEY_PEM_SECONDARY, message, sigBuf)) {
        return 'verified'
      }
    } else {
      log.warn(`signature URL returned ${sigResp.status} — treated as unreachable`)
    }

    // 服务端下发了 secondary signature URL → 尝试 secondary .sig
    if (secondarySignatureUrl) {
      const sigResp2 = await fetch(secondarySignatureUrl, { signal: AbortSignal.timeout(10_000) })
      if (sigResp2.ok) {
        anyReachable = true
        const sig2Text = (await sigResp2.text()).trim()
        const sig2Buf = Buffer.from(sig2Text, 'base64')
        if (verifyWithEitherKey(UPDATE_PUBLIC_KEY_PEM, UPDATE_PUBLIC_KEY_PEM_SECONDARY, message, sig2Buf)) {
          return 'verified'
        }
      } else {
        log.warn(`secondary signature URL returned ${sigResp2.status}`)
      }
    }

    // 区分:拉到了正文但内容不匹配 = invalid;两个 URL 都没拉到 = unreachable
    return anyReachable ? 'invalid' : 'unreachable'
  } catch (err) {
    log.error(`update signature verify error: ${(err as Error).message}`)
    // fetch 抛异常(超时 / DNS / TCP reset)= 网络问题,不是签名问题
    return anyReachable ? 'invalid' : 'unreachable'
  }
}

export function getUpdateEndpoint(): string {
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
      // 修复(2026-05-20 Audit B-2):带上当前 channel,避免 Beta 用户在 About 面板
      // 看到 stable 版本的"最新版本"信息(legacy 路径 + 新 updater 状态机两套 UI
      // 同时 show 不同版本 → 用户困惑)。
      const { getUpdateChannel } = await import('../updater/channel.js')
      const params = new URLSearchParams({
        platform: process.platform,
        arch: process.arch,
        version: currentVersion,
        channel: getUpdateChannel(),
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
        secondarySignatureUrl?: string | null
        releaseDate: string | null
        releaseNotes: string | null
        releaseUrl?: string
      }
      const hasUpdate = !!data.url
      // 验签:启用了公钥但签名不匹配 → 拒绝此更新,避免恶意 release 推到全量用户。
      // Audit D-3:'unreachable' 时把对外 signatureStatus 折叠成 'unsigned' 让 UI
      // 不显示"签名异常"红字 banner(本路径是 about 面板 manual check,不是
      // autoUpdate flow,先告诉用户"未签名"等下次重试)。
      let signatureStatus: 'verified' | 'unsigned' | 'invalid' = 'unsigned'
      if (hasUpdate && data.url) {
        const verdict = await verifyUpdateSignature(
          data.signatureUrl ?? null,
          data.version,
          data.url,
          data.secondarySignatureUrl ?? null,
        )
        if (verdict === 'invalid') {
          log.warn(`update ${data.version} REJECTED: signature invalid`)
          return {
            hasUpdate: false,
            currentVersion,
            latestVersion: data.version,
            releaseUrl: data.releaseUrl ?? data.url,
            releaseNotes: data.releaseNotes?.slice(0, 500) ?? null,
            publishedAt: data.releaseDate ?? null,
            signatureStatus: 'invalid',
          }
        }
        signatureStatus = verdict === 'unreachable' ? 'unsigned' : verdict
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
