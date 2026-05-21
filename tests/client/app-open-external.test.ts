/**
 * parseExternalUrl https-only + dev exception (C-3)
 *
 * 默认只允许 https://;开发环境(NODE_ENV=development)对 http://localhost / 127.0.0.1
 * 例外放行,正式产物里强制 https 屏蔽降级钓鱼。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseExternalUrl } from '../../client/electron/ipc/_schemas'

describe('parseExternalUrl - https-only + dev exception', () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    // 默认按生产环境跑
    process.env.NODE_ENV = 'production'
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  })

  it('https 公网域名放行', () => {
    expect(parseExternalUrl('https://tidemind.ai/x')).toMatchObject({ ok: true })
    expect(parseExternalUrl('https://x.com')).toMatchObject({ ok: true })
  })

  it('http 公网域名被拒(默认 https-only)', () => {
    expect(parseExternalUrl('http://example.com')).toMatchObject({
      ok: false,
      error: { details: ['url protocol must be https'] },
    })
    expect(parseExternalUrl('http://tidemind.ai/x')).toMatchObject({
      ok: false,
      error: { details: ['url protocol must be https'] },
    })
  })

  it('生产环境 http://localhost 被拒', () => {
    process.env.NODE_ENV = 'production'
    expect(parseExternalUrl('http://localhost/x')).toMatchObject({
      ok: false,
      error: { details: ['url protocol must be https'] },
    })
    expect(parseExternalUrl('http://127.0.0.1/x')).toMatchObject({
      ok: false,
      error: { details: ['url protocol must be https'] },
    })
  })

  it('NODE_ENV 未设置时(空)按非 dev 处理,http://localhost 被拒', () => {
    delete process.env.NODE_ENV
    expect(parseExternalUrl('http://localhost/x')).toMatchObject({ ok: false })
    expect(parseExternalUrl('http://127.0.0.1/x')).toMatchObject({ ok: false })
  })

  it('开发环境 http://localhost 与 http://127.0.0.1 放行', () => {
    process.env.NODE_ENV = 'development'
    expect(parseExternalUrl('http://localhost/x')).toMatchObject({ ok: true })
    expect(parseExternalUrl('http://localhost:3000/api')).toMatchObject({ ok: true })
    expect(parseExternalUrl('http://127.0.0.1/x')).toMatchObject({ ok: true })
    expect(parseExternalUrl('http://127.0.0.1:8080/foo')).toMatchObject({ ok: true })
  })

  it('开发环境对非 localhost 的私网 IP 仍然拒绝(避免 SSRF)', () => {
    process.env.NODE_ENV = 'development'
    expect(parseExternalUrl('http://10.0.0.5/x')).toMatchObject({ ok: false })
    expect(parseExternalUrl('http://192.168.1.1/x')).toMatchObject({ ok: false })
    expect(parseExternalUrl('http://172.16.0.1/x')).toMatchObject({ ok: false })
    expect(parseExternalUrl('http://169.254.169.254/latest/meta-data/')).toMatchObject({ ok: false })
  })

  it('开发环境 http://my.localhost 仍被拒(只放行精确的 localhost / 127.0.0.1)', () => {
    process.env.NODE_ENV = 'development'
    expect(parseExternalUrl('http://my.localhost/x')).toMatchObject({ ok: false })
    expect(parseExternalUrl('http://service.local/x')).toMatchObject({ ok: false })
  })

  it('开发环境 https 公网域名当然也放行', () => {
    process.env.NODE_ENV = 'development'
    expect(parseExternalUrl('https://tidemind.ai/x')).toMatchObject({ ok: true })
  })

  it('开发环境 http://[::1] 不放行(只允许 localhost / 127.0.0.1 字面量)', () => {
    process.env.NODE_ENV = 'development'
    expect(parseExternalUrl('http://[::1]/x')).toMatchObject({ ok: false })
  })

  it('file:// / ftp:// / javascript: 始终被拒', () => {
    process.env.NODE_ENV = 'development'
    expect(parseExternalUrl('file:///etc/passwd')).toMatchObject({ ok: false })
    expect(parseExternalUrl('ftp://example.com')).toMatchObject({ ok: false })
    expect(parseExternalUrl('javascript:alert(1)')).toMatchObject({ ok: false })
  })

  it('credentials 始终被拒(不论协议)', () => {
    process.env.NODE_ENV = 'production'
    expect(parseExternalUrl('https://user:pw@example.com')).toMatchObject({
      ok: false,
      error: { details: ['url must not contain credentials'] },
    })
  })
})
