import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { AgentIntegrationRepository } from '../../client/electron/agent-integration/repository'
import { resolveClientDataDir } from '../../client/electron/db'
import {
  createUiAuditAgentIntegrationOptions,
  resolveUiAuditDataDir,
  resolveUiAuditRoot,
  uiAuditMarker,
} from '../../client/electron/ui-audit'
import { ensureSchema } from '../../src/db/schema.js'

describe('isolated Electron UI audit mode', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function auditRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-ui-audit-'))
    roots.push(root)
    fs.mkdirSync(path.join(root, 'home'), { recursive: true })
    fs.mkdirSync(path.join(root, 'home', '.tidemind'))
    fs.mkdirSync(path.join(root, 'user-data'))
    const marker = uiAuditMarker()
    fs.writeFileSync(path.join(root, marker.name), marker.content)
    return root
  }

  it('requires an explicit absolute root, isolated HOME and exact marker', () => {
    const root = auditRoot()
    expect(resolveUiAuditRoot({
      TIDEMIND_UI_AUDIT: '1',
      TIDEMIND_UI_AUDIT_ROOT: root,
      HOME: path.join(root, 'home'),
    })).toBe(fs.realpathSync(root))
    expect(() => resolveUiAuditRoot({
      TIDEMIND_UI_AUDIT: '1',
      TIDEMIND_UI_AUDIT_ROOT: root,
      HOME: os.homedir(),
    })).toThrow(/isolation invariant/)
    fs.writeFileSync(path.join(root, uiAuditMarker().name), 'wrong\n')
    expect(() => resolveUiAuditRoot({
      TIDEMIND_UI_AUDIT: '1',
      TIDEMIND_UI_AUDIT_ROOT: root,
      HOME: path.join(root, 'home'),
    })).toThrow(/marker/)
  })

  it('rejects a HOME symlink even when the lexical HOME value matches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-ui-audit-'))
    roots.push(root)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-ui-audit-outside-'))
    roots.push(outside)
    fs.mkdirSync(path.join(outside, '.tidemind'))
    fs.symlinkSync(outside, path.join(root, 'home'), 'dir')
    fs.mkdirSync(path.join(root, 'user-data'))
    const marker = uiAuditMarker()
    fs.writeFileSync(path.join(root, marker.name), marker.content)
    expect(() => resolveUiAuditRoot({
      TIDEMIND_UI_AUDIT: '1',
      TIDEMIND_UI_AUDIT_ROOT: root,
      HOME: path.join(root, 'home'),
    })).toThrow(/marker|canonical isolation/)
  })

  it('rejects a userData symlink that escapes the isolated root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-ui-audit-'))
    roots.push(root)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-ui-audit-outside-'))
    roots.push(outside)
    fs.mkdirSync(path.join(root, 'home'))
    fs.mkdirSync(path.join(root, 'home', '.tidemind'))
    fs.symlinkSync(outside, path.join(root, 'user-data'), 'dir')
    const marker = uiAuditMarker()
    fs.writeFileSync(path.join(root, marker.name), marker.content)
    expect(() => resolveUiAuditRoot({
      TIDEMIND_UI_AUDIT: '1', TIDEMIND_UI_AUDIT_ROOT: root, HOME: path.join(root, 'home'),
    })).toThrow(/marker|userData/)
  })

  it('rejects an audit data directory symlink that escapes the isolated root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-ui-audit-'))
    roots.push(root)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-ui-audit-outside-'))
    roots.push(outside)
    fs.mkdirSync(path.join(root, 'home'))
    fs.mkdirSync(path.join(root, 'user-data'))
    fs.symlinkSync(outside, path.join(root, 'home', '.tidemind'), 'dir')
    const marker = uiAuditMarker()
    fs.writeFileSync(path.join(root, marker.name), marker.content)
    expect(() => resolveUiAuditRoot({
      TIDEMIND_UI_AUDIT: '1', TIDEMIND_UI_AUDIT_ROOT: root, HOME: path.join(root, 'home'),
    })).toThrow(/marker|dataDir/)
    expect(() => resolveUiAuditDataDir(fs.realpathSync(root))).toThrow(/dataDir/)
  })

  it('rejects fixture config roots that escape through a symlink ancestor', async () => {
    const root = auditRoot()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-ui-audit-outside-'))
    roots.push(outside)
    fs.symlinkSync(outside, path.join(root, 'home', 'escaped'), 'dir')
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    repository.upsertDiscoveredInstallation({
      id: 'escaped-cursor', family: 'cursor', hostVariant: 'cursor-desktop',
      installKey: 'cursor:escaped', distributionId: 'com.todesktop.230313mzl4w4u92',
      provenance: 'fixture', displayName: 'Cursor',
      configRoot: path.join(root, 'home', 'escaped', '.cursor'), agentId: 'eb_escaped',
      lastDetectedAt: '2026-08-25T00:00:00.000Z',
    })
    const options = createUiAuditAgentIntegrationOptions(db, fs.realpathSync(root))
    await expect(options.scanner!.scan()).rejects.toThrow(/escaped isolated HOME|symlink/)
    db.close()
  })

  it('replays only fixture DB Installations and starts no managed runtime', async () => {
    const root = auditRoot()
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    repository.upsertDiscoveredInstallation({
      id: 'fixture-cursor', family: 'cursor', hostVariant: 'cursor-desktop',
      installKey: 'cursor:fixture', distributionId: 'com.todesktop.230313mzl4w4u92',
      provenance: 'fixture', displayName: 'Cursor',
      configRoot: path.join(root, 'home', '.cursor'), agentId: 'eb_fixture',
      lastDetectedAt: '2026-08-25T00:00:00.000Z',
    })

    const options = createUiAuditAgentIntegrationOptions(db, fs.realpathSync(root))
    expect(options).toMatchObject({
      observeOnly: false,
      autoRestore: false,
      startRuntime: false,
      fixtureMode: 'isolated_ui_audit',
    })
    const report = await options.scanner!.scan()
    expect(report.installations).toHaveLength(1)
    expect(report.installations[0]).toMatchObject({
      catalogId: 'cursor-desktop',
      identity: { installKey: 'cursor:fixture' },
      provenance: ['isolated_ui_audit_fixture'],
    })
    db.close()
  })

  it('binds ZCode audit trust to the fake executable and every strong fixture identity field', async () => {
    const root = auditRoot()
    const appPath = path.join(root, 'apps', 'ZCode.app')
    const executablePath = path.join(appPath, 'Contents', 'MacOS', 'ZCode')
    fs.mkdirSync(path.dirname(executablePath), { recursive: true })
    fs.writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const canonicalAppPath = fs.realpathSync(appPath)
    const canonicalExecutable = fs.realpathSync(executablePath)
    const db = new Database(':memory:')
    ensureSchema(db)
    const repository = new AgentIntegrationRepository(db)
    const exactDistribution = {
      distributionId: 'dev.zcode.app',
      executableRealpath: canonicalExecutable,
      packageProvenance: 'signed_app:dev.zcode.app:8A5X4JJ39T',
      capabilityFingerprint: 'app-surface:zcode-desktop',
    }
    const upsert = (distribution: Record<string, string>) => repository.upsertDiscoveredInstallation({
      id: 'fixture-zcode', family: 'zcode', hostVariant: 'zcode-desktop',
      installKey: 'zcode-desktop:fixture-zcode', distributionId: 'dev.zcode.app',
      provenance: 'isolated_ui_audit_fixture', displayName: 'ZCode',
      configRoot: path.join(root, 'home', '.zcode-default'),
      executablePath: canonicalExecutable, appPath: canonicalAppPath,
      agentId: 'eb_fixture_zcode', lastDetectedAt: '2026-08-25T00:00:00.000Z',
      metadata: { distribution },
    })
    const manageable = () => {
      const options = createUiAuditAgentIntegrationOptions(db, fs.realpathSync(root))
      return options.canManageInstallation!(repository.getInstallation('fixture-zcode')!)
    }
    const attest = () => {
      const options = createUiAuditAgentIntegrationOptions(db, fs.realpathSync(root))
      return options.liveTrustAttestor!(repository.getInstallation('fixture-zcode')!)
    }
    try {
      upsert(exactDistribution)
      expect(manageable()).toBe(true)
      const firstProof = await attest()
      expect(firstProof).toMatch(/^[a-f0-9]{64}$/)

      fs.writeFileSync(executablePath, '#!/bin/sh\necho changed\n')
      expect(await attest()).toMatch(/^[a-f0-9]{64}$/)
      expect(await attest()).not.toBe(firstProof)
      fs.chmodSync(executablePath, 0o600)
      expect(await attest()).toBeNull()
      fs.chmodSync(executablePath, 0o700)

      for (const field of Object.keys(exactDistribution)) {
        const missing = { ...exactDistribution }
        delete missing[field as keyof typeof missing]
        upsert(missing)
        expect(manageable(), `${field} missing`).toBe(false)

        upsert({ ...exactDistribution, [field]: `${exactDistribution[field as keyof typeof exactDistribution]}-tampered` })
        expect(manageable(), `${field} tampered`).toBe(false)
      }
    } finally {
      db.close()
    }
  })

  it('resolves a forced audit database directory without consulting config.toml', () => {
    const root = auditRoot()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tidemind-ui-audit-outside-'))
    roots.push(outside)
    const dataDir = path.join(root, 'home', '.tidemind')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'config.toml'), `[general]\ndata_dir = "${outside}"\n`)
    expect(resolveClientDataDir(dataDir)).toBe(path.resolve(dataDir))
    expect(resolveClientDataDir(dataDir)).not.toBe(path.resolve(outside))
  })
})
