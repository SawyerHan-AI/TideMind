#!/usr/bin/env node
/* global AbortSignal, Buffer, WebSocket, clearTimeout, fetch, process, setTimeout */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  protectedRealAgentPaths,
  runWithRealHomeGuard,
} from './agent-integration-ui-e2e-home-guard.mjs'
import {
  captureAgentIntegrationGateProvenance,
  sameAgentIntegrationGateProvenance,
} from './agent-integration-gate-provenance.mjs'
import { writeAgentIntegrationUiE2eEvidence } from './agent-integration-ui-e2e-evidence.mjs'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const clientRoot = path.join(projectRoot, 'client')
const electronMain = path.join(clientRoot, 'out', 'main', 'index.js')
const clientRequire = createRequire(path.join(clientRoot, 'package.json'))
const electronBin = clientRequire('electron')
const tsxBin = path.join(projectRoot, 'node_modules', '.bin', 'tsx')
const fixtureScript = path.join(scriptDir, 'create-agent-integration-ui-audit-fixture.ts')
const runnerScript = fileURLToPath(import.meta.url)
const IS_GUARD_CHILD = process.argv.includes('--real-home-guard-child')
const KEEP_ROOT = process.argv.includes('--keep') || process.env.TIDEMIND_UI_E2E_KEEP === '1'
const HARD_TIMEOUT_MS = Number(process.env.TIDEMIND_UI_E2E_TIMEOUT_MS ?? 90_000)
const RECEIPT_PATH = optionPath('--receipt')
const EVIDENCE_DIR = optionPath('--evidence-dir')

function optionPath(option) {
  const indexes = process.argv.flatMap((argument, index) => argument === option ? [index] : [])
  if (indexes.length === 0) return null
  if (indexes.length !== 1 || !process.argv[indexes[0] + 1]
    || process.argv[indexes[0] + 1].startsWith('--')) {
    throw new Error(`${option} requires exactly one output path`)
  }
  return path.resolve(process.argv[indexes[0] + 1])
}

function forwardedArguments() {
  const forwarded = []
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]
    if (argument === '--real-home-guard-child') continue
    if (argument === '--receipt') {
      index += 1
      continue
    }
    forwarded.push(argument)
  }
  return forwarded
}

if (typeof WebSocket !== 'function') {
  throw new Error(`Node ${process.version} does not provide the global WebSocket required by this runner`)
}
for (const required of [electronMain, electronBin, tsxBin, fixtureScript]) {
  if (!fs.existsSync(required)) throw new Error(`required UI E2E input is missing: ${required}`)
}

const canonicalTemp = fs.realpathSync(os.tmpdir())
const root = IS_GUARD_CHILD ? fs.mkdtempSync(path.join(canonicalTemp, 'tidemind-ui-audit-')) : ''
const home = root ? path.join(root, 'home') : ''
const artifactsDir = root ? path.join(root, 'artifacts') : ''
const tmpDir = root ? path.join(root, 'tmp') : ''
const dbPath = home ? path.join(home, '.tidemind', 'graph', 'brain.sqlite') : ''
let electron = null
let cdp = null
let captureTail = ''
let fixtureBaselineScanAt = null

async function main() {
  const hardTimeout = setTimeout(() => {
    process.stderr.write(`UI E2E exceeded hard timeout (${HARD_TIMEOUT_MS}ms)\n`)
    if (electron) signalElectronTree(electron, 'SIGKILL')
    process.exit(124)
  }, HARD_TIMEOUT_MS)
  hardTimeout.unref()
  try {
    createFixture()
    fixtureBaselineScanAt = readFixtureLastScanAt()
    fs.mkdirSync(artifactsDir)
    fs.mkdirSync(tmpDir)

    const port = await reserveLoopbackPort()
    electron = spawn(electronBin, [
      electronMain,
      `--remote-debugging-port=${port}`,
      `--remote-allow-origins=http://127.0.0.1:${port}`,
      '--no-first-run',
    ], {
      cwd: clientRoot,
      detached: true,
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: tmpDir,
        TMP: tmpDir,
        TEMP: tmpDir,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        TIDEMIND_UI_AUDIT: '1',
        TIDEMIND_UI_AUDIT_ROOT: root,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const logs = captureLogs(electron)
    const target = await waitForRendererTarget(port, electron, logs)
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.bringToFront')

    await waitFor(cdp, `(() => document.readyState === 'complete'
    && location.hash.includes('/settings?tab=external&sub=agent')
    && document.querySelector('[role="note"]')?.textContent?.includes('UI Audit Fixture')
    && document.body.textContent.includes('ZCode'))()`, 'Agent Integration fixture renderer')
    await waitFor(cdp, 'document.hasFocus() === true', 'focused Electron renderer')
    assert.equal(await value(cdp, 'typeof window.api?.agentIntegrations?.snapshot'), 'function', 'preload API was not exposed')
    assert.equal(await value(cdp, 'document.querySelectorAll(\'[role="alert"]\').length'), 0, 'renderer reported an error')
    const initialScan = await waitForExactInitialScan(cdp)
    const startupNotification = await exerciseStartupNotification(cdp)
    const interruptedRestart = await exerciseInterruptedRestartTask(cdp)
    await screenshot(cdp, path.join(artifactsDir, '01-wide-agent-list.png'))

    const accessInfo = await exerciseAccessInfo(cdp, artifactsDir)
    await assertSubtabKeyboardNavigation(cdp)
    const batchFocus = await openAndExerciseConnectDialog(cdp, artifactsDir)
    const liveTaskAdvancement = await exerciseLiveTaskAdvancement(cdp, artifactsDir)
    const modalInert = await exerciseSupportCatalogModal(cdp)
    await exerciseNarrowLayout(cdp, artifactsDir)
    const responsive = await exerciseResponsiveBreakpoints(cdp, artifactsDir)
    const history = await exerciseConnectionHistory(cdp, artifactsDir)

    await stopElectron(electron)
    electron = null
    cdp.close()
    cdp = null

    const verification = verifyPhysicalState()
    const report = {
      ok: true,
      auditRoot: root,
      screenshots: fs.readdirSync(artifactsDir).sort().map(name => path.join(artifactsDir, name)),
      uiAssertions: {
        initialScan,
        accessInfo,
        startupNotification,
        interruptedRestart,
        liveTaskAdvancement,
        modalInert,
        batchFocus,
        responsive,
        history,
      },
      verification,
    }
    fs.writeFileSync(path.join(root, 'ui-e2e-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (EVIDENCE_DIR) {
      writeAgentIntegrationUiE2eEvidence({
        auditRoot: root,
        artifactsDir,
        report,
        evidenceDir: EVIDENCE_DIR,
      })
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } catch (error) {
    const suffix = electron ? `\nElectron log tail:\n${captureTail}` : ''
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}${suffix}\n`)
    process.exitCode = 1
  } finally {
    clearTimeout(hardTimeout)
    cdp?.close()
    if (electron) await stopElectron(electron).catch(() => electron.kill('SIGKILL'))
    if (!KEEP_ROOT && process.exitCode !== 1) fs.rmSync(root, { recursive: true, force: true })
    else process.stderr.write(`UI E2E audit root preserved at ${root}\n`)
  }
}

function createFixture() {
  const fixture = spawnSync(tsxBin, ['--tsconfig', path.join(clientRoot, 'tsconfig.node.json'), fixtureScript, root], {
    cwd: projectRoot,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })
  if (fixture.status !== 0) {
    throw new Error(`fixture creation failed: ${fixture.stderr || fixture.stdout}`)
  }
  assert.equal(fs.realpathSync(fixture.stdout.trim()), fs.realpathSync(root))
}

function readFixtureLastScanAt() {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.prepare(`
      SELECT value FROM metadata WHERE key = 'agent_integration_last_successful_scan_at'
    `).pluck().get() ?? null
  } finally {
    db.close()
  }
}

async function waitForExactInitialScan(client) {
  const baseline = JSON.stringify(fixtureBaselineScanAt)
  await waitFor(client, `(async () => {
    const snapshot = await window.api.agentIntegrations.snapshot()
    const scanAt = snapshot.lastScanAt
    const zcode = snapshot.installations.find(item => item.id === 'zcode-default')
    return typeof scanAt === 'string'
      && scanAt !== ${baseline}
      && snapshot.installations.length > 0
      && snapshot.installations.every(item => item.lastDetectedAt === scanAt)
      && zcode?.hostVariant === 'zcode-desktop'
      && zcode.manageable === true
      && zcode.desiredState === 'unmanaged'
      && zcode.statusGroup === 'awaiting_connection'
  })()`, 'exact initial scan generation and trusted ZCode projection')
  const snapshot = await value(client, `window.api.agentIntegrations.snapshot()`)
  assert.equal(snapshot.installations.every(item => item.lastDetectedAt === snapshot.lastScanAt), true,
    `renderer snapshot mixed scan generations: ${JSON.stringify(snapshot)}`)
  return {
    baselineLastScanAt: fixtureBaselineScanAt,
    completedLastScanAt: snapshot.lastScanAt,
    exactGeneration: true,
    zcodeStrongIdentityManageable: snapshot.installations.find(item => item.id === 'zcode-default')?.manageable === true,
  }
}

function captureLogs(child) {
  const entries = []
  const append = chunk => {
    entries.push(String(chunk))
    if (entries.length > 80) entries.shift()
    captureTail = entries.join('').slice(-12_000)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  return () => entries.join('').slice(-12_000)
}

async function exerciseStartupNotification(client) {
  await waitFor(client, `(() => {
    const toast = [...document.querySelectorAll('[role="status"]')]
      .find(element => element.querySelector('button') && element.textContent.includes('Agent'))
    return Boolean(toast && document.querySelector('#settings-tab-external .bg-red-400'))
  })()`, 'startup Agent notification and Settings unread dot')
  const point = await value(client, `(() => {
    const toast = [...document.querySelectorAll('[role="status"]')]
      .find(element => element.querySelector('button') && element.textContent.includes('Agent'))
    const button = toast?.querySelector('button')
    if (!(button instanceof HTMLButtonElement)) throw new Error('startup notification detail action missing')
    button.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(client, point)
  await waitFor(client, `document.querySelector('#components-opencode-conflict') !== null`, 'notification exact Installation detail')
  await waitFor(client, `!document.querySelector('#settings-tab-external .bg-red-400')`, 'ordinary info does not keep the Settings action dot')
  const inbox = await value(client, `window.api.agentIntegrations.inbox(10)`)
  assert.ok(inbox.unreadCount > 0, `expected the ordinary unread fixture event to remain: ${JSON.stringify(inbox)}`)
  assert.equal(inbox.actionableUnreadCount, 0, `ordinary info was still actionable: ${JSON.stringify(inbox)}`)
  return {
    toastVisible: true,
    unreadDotVisible: true,
    exactInstallationOpened: 'opencode-conflict',
    ordinaryInfoDidNotKeepDot: true,
  }
}

async function exerciseInterruptedRestartTask(client) {
  await waitFor(client, `(() => {
    const task = [...document.querySelectorAll('[role="status"]')]
      .find(element => /中断|interrupted/iu.test(element.textContent ?? ''))
    const action = [...(task?.querySelectorAll('button') ?? [])]
      .find(button => /生成新方案|generate a new plan/iu.test(button.textContent ?? ''))
    const recheck = [...(task?.querySelectorAll('button') ?? [])]
      .find(button => /不可用|no longer available/iu.test(button.textContent ?? ''))
    return Boolean(task && action
      && recheck
      && task.getAttribute('data-tone') === 'attention'
      && getComputedStyle(task).color === 'rgb(253, 230, 138)'
      && getComputedStyle(task).color !== 'rgb(167, 243, 208)')
  })()`, 'interrupted restart task amber attention card')
  const actionPoint = await value(client, `(() => {
    const task = [...document.querySelectorAll('[role="status"]')]
      .find(element => /中断|interrupted/iu.test(element.textContent ?? ''))
    const action = [...(task?.querySelectorAll('button') ?? [])]
      .find(button => /生成新方案|generate a new plan/iu.test(button.textContent ?? ''))
    if (!(action instanceof HTMLButtonElement)) throw new Error('interrupted fresh-preview action missing')
    globalThis.__tidemindInterruptedTaskTrigger = action
    action.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = action.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(client, actionPoint)
  await waitFor(client, `(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const labels = [...(dialog?.querySelectorAll('label') ?? [])]
    const zcodeName = [...(dialog?.querySelectorAll('label span') ?? [])]
      .find(candidate => candidate.textContent?.trim() === 'ZCode')
    const zcodeInput = zcodeName?.closest('label')?.querySelector('input[type="checkbox"]')
    const otherAgent = labels.some(candidate => /Cursor|Kimi Code|OpenCode|Codex/iu.test(candidate.textContent ?? ''))
    return dialog?.getAttribute('aria-busy') === 'false'
      && zcodeInput instanceof HTMLInputElement
      && !otherAgent
  })()`, 'fresh preview for exact interrupted Installation')
  await key(client, 'Escape', 27)
  await waitFor(client, `document.querySelector('[role="dialog"]') === null`, 'interrupted fresh preview Escape close')
  const taskPage = await value(client, `window.api.agentIntegrations.listApplyTasks({ limit: 20 })`)
  const tasks = taskPage.tasks
  const recovered = tasks.find(task => task.id === 'audit-interrupted-restart-task')
  assert.deepEqual(recovered?.results?.map(result => ({
    installationId: result.installationId,
    status: result.status,
  })), [
    { installationId: 'zcode-default', status: 'interrupted' },
    { installationId: 'claude-history', status: 'interrupted' },
  ],
  `interrupted task did not remain exact after fresh preview cancellation: ${JSON.stringify(tasks)}`)
  return {
    amberAttention: true,
    stableAttentionTone: 'rgb(253, 230, 138)',
    exactInstallationIds: ['zcode-default'],
    unavailableInstallationIds: ['claude-history'],
    freshPreviewOnly: true,
    oldPlanNotReplayed: true,
  }
}

async function waitForRendererTarget(port, child, logs) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode}): ${logs()}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(750) })
      if (response.ok) {
        const targets = await response.json()
        const page = targets.find(target => target.type === 'page' && /settings|index\.html/u.test(target.url))
          ?? targets.find(target => target.type === 'page')
        if (page?.webSocketDebuggerUrl) return page
      }
    } catch { /* renderer is still starting */ }
    await delay(100)
  }
  throw new Error(`timed out waiting for Electron renderer target: ${logs()}`)
}

async function exerciseAccessInfo(client, artifactRoot) {
  const triggerPoint = await value(client, `(() => {
    const section = document.querySelector('section[aria-labelledby="managed-local-agents-title"]')
    const button = [...(section?.querySelectorAll('button[aria-expanded][aria-controls]') ?? [])]
      .find(candidate => candidate.querySelector('svg.lucide-info'))
    if (!(button instanceof HTMLButtonElement)) throw new Error('capability access info trigger missing')
    globalThis.__tidemindUiE2eAccessInfoTrigger = button
    globalThis.__tidemindUiE2eAccessInfoTooltipId = button.getAttribute('aria-controls')
    button.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(client, triggerPoint)
  try {
    await waitFor(client, `(() => {
      const trigger = globalThis.__tidemindUiE2eAccessInfoTrigger
      const tooltipId = globalThis.__tidemindUiE2eAccessInfoTooltipId
      const tooltip = tooltipId ? document.getElementById(tooltipId) : null
      if (!(trigger instanceof HTMLButtonElement) || !(tooltip instanceof HTMLElement)) return false
      const rect = tooltip.getBoundingClientRect()
      const style = getComputedStyle(tooltip)
      return document.activeElement === trigger
        && trigger.getAttribute('aria-expanded') === 'true'
        && trigger.getAttribute('aria-describedby') === tooltipId
        && tooltip.getAttribute('role') === 'tooltip'
        && tooltip.textContent.trim().length >= 10
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0
        && rect.width > 0
        && rect.height > 0
        && rect.left >= -1
        && rect.right <= window.innerWidth + 1
        && rect.top >= -1
        && rect.bottom <= window.innerHeight + 1
    })()`, 'visible capability access explanation')
  } catch (error) {
    const state = await accessInfoDiagnostic(client)
    throw new Error(`${error.message}; accessInfo=${JSON.stringify(state)}`, { cause: error })
  }

  const opened = await value(client, `(() => {
    const trigger = globalThis.__tidemindUiE2eAccessInfoTrigger
    const tooltip = document.getElementById(globalThis.__tidemindUiE2eAccessInfoTooltipId)
    return {
      triggerLabel: trigger?.getAttribute('aria-label') ?? null,
      tooltipText: tooltip?.textContent?.replace(/\\s+/gu, ' ').trim() ?? null,
      sameTriggerFocusedWhenOpen: document.activeElement === trigger,
    }
  })()`)
  await screenshot(client, path.join(artifactRoot, '02-access-info.png'))

  await key(client, 'Escape', 27)
  try {
    await waitFor(client, `(() => {
      const trigger = globalThis.__tidemindUiE2eAccessInfoTrigger
      const tooltipId = globalThis.__tidemindUiE2eAccessInfoTooltipId
      return trigger instanceof HTMLButtonElement
        && trigger.isConnected
        && document.activeElement === trigger
        && trigger.getAttribute('aria-expanded') === 'false'
        && trigger.getAttribute('aria-describedby') === null
        && document.getElementById(tooltipId) === null
    })()`, 'capability access explanation Escape close and exact focus restoration')
  } catch (error) {
    const state = await accessInfoDiagnostic(client)
    throw new Error(`${error.message}; accessInfo=${JSON.stringify(state)}`, { cause: error })
  }
  return {
    ...opened,
    closedWithEscape: true,
    sameTriggerFocusedAfterClose: true,
  }
}

async function accessInfoDiagnostic(client) {
  return value(client, `(() => {
    const trigger = globalThis.__tidemindUiE2eAccessInfoTrigger
    const tooltipId = globalThis.__tidemindUiE2eAccessInfoTooltipId
    const tooltip = tooltipId ? document.getElementById(tooltipId) : null
    return {
      documentFocused: document.hasFocus(),
      triggerConnected: trigger?.isConnected ?? false,
      triggerExpanded: trigger?.getAttribute?.('aria-expanded') ?? null,
      triggerDescribedBy: trigger?.getAttribute?.('aria-describedby') ?? null,
      active: document.activeElement?.outerHTML?.slice(0, 800) ?? null,
      sameTriggerFocused: document.activeElement === trigger,
      tooltipId,
      tooltipPresent: Boolean(tooltip),
      tooltipText: tooltip?.textContent?.replace(/\\s+/gu, ' ').trim() ?? null,
    }
  })()`).catch(() => ({ rendererUnavailable: true }))
}

async function assertSubtabKeyboardNavigation(client) {
  await client.evaluate(`(() => {
    const tab = document.querySelector('#external-tab-agent')
    if (!(tab instanceof HTMLElement)) throw new Error('Agent subtab missing')
    tab.focus()
    return document.activeElement?.id
  })()`)
  // Home on the first roving tab is a real keyboard path that must preserve
  // selection/focus without mounting audit-forbidden sibling settings APIs.
  await key(client, 'Home', 36)
  await waitFor(client, `document.querySelector('#external-tab-agent')?.getAttribute('aria-selected') === 'true'
    && document.activeElement?.id === 'external-tab-agent'`, 'Home subtab focus')
}

async function exerciseSupportCatalogModal(client) {
  const triggerPoint = await value(client, `(() => {
    const trigger = [...document.querySelectorAll('button')]
      .find(button => /支持|support/iu.test(button.textContent ?? ''))
    if (!(trigger instanceof HTMLButtonElement)) throw new Error('support catalog trigger missing')
    globalThis.__tidemindSupportTrigger = trigger
    trigger.focus()
    const rect = trigger.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(client, triggerPoint)
  await waitFor(client, `Boolean(document.querySelector('#support-catalog-title')
    && document.querySelector('#root')?.inert
    && document.querySelector('[role="dialog"]')?.contains(document.activeElement))`, 'support catalog inert modal')
  assert.equal(await value(client, `(() => {
    globalThis.__tidemindSupportTrigger?.focus()
    return document.querySelector('[role="dialog"]')?.contains(document.activeElement) === true
  })()`), true, 'programmatic focus escaped the inert application root')
  const closePoint = await value(client, `(() => {
    const close = document.querySelector('[role="dialog"] header button')
    if (!(close instanceof HTMLButtonElement)) throw new Error('support catalog close button missing')
    const rect = close.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(client, closePoint)
  await waitFor(client, `!document.querySelector('#support-catalog-title')
    && document.querySelector('#root')?.inert === false
    && document.activeElement === globalThis.__tidemindSupportTrigger`, 'support catalog inert and focus restoration')
  return { rootInert: true, programmaticFocusContained: true, closeRestoredRootAndFocus: true }
}

async function openAndExerciseConnectDialog(client, artifactRoot) {
  // The renderer mounts from the durable snapshot before its mandatory first
  // discovery scan finishes. Wait for that scan to publish the actionable
  // pending Installation instead of racing the button on faster/slower hosts.
  await waitFor(client, `Boolean(document.querySelector('section[aria-labelledby="managed-attention-title"] button'))`,
    'review-and-connect action after initial scan')
  const pendingDetailPoint = await value(client, `(() => {
    const button = document.querySelector('[data-agent-family-trigger="zcode"]')
    if (!(button instanceof HTMLButtonElement)) throw new Error('pending ZCode detail trigger missing')
    button.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(client, pendingDetailPoint)
  await waitFor(client, `document.querySelector('#components-zcode-default') !== null`, 'pending ZCode detail')
  assert.equal(await value(client, `(() => {
    const panel = document.querySelector('#components-zcode-default')?.closest('.overflow-hidden')
    const labels = [...(panel?.querySelectorAll('button') ?? [])].map(button => button.textContent?.trim() ?? '')
    return labels.some(label => /review and connect|查看并连接/iu.test(label))
      && !labels.some(label => /^(disconnect|断开)$/iu.test(label))
  })()`), true, 'unmanaged pending detail exposed a disconnect action instead of approval')
  const reviewPoint = await value(client, `(() => {
    const button = document.querySelector('section[aria-labelledby="managed-attention-title"] button')
    if (!(button instanceof HTMLButtonElement)) throw new Error('review-and-connect button missing')
    button.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(client, reviewPoint)
  await waitFor(client, `(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return dialog && dialog.getAttribute('aria-busy') === 'false'
      && dialog.querySelectorAll('input[type="checkbox"]').length > 0
  })()`, 'connect dialog preview')
  try {
    await waitFor(client, `document.querySelector('[role="dialog"]')?.contains(document.activeElement) === true`, 'connect dialog initial focus')
  } catch (error) {
    const state = await value(client, `(() => ({
      documentFocused: document.hasFocus(),
      active: document.activeElement?.outerHTML?.slice(0, 800) ?? null,
      dialogBusy: document.querySelector('[role="dialog"]')?.getAttribute('aria-busy') ?? null,
    }))()`)
    throw new Error(`${error.message}; initialFocus=${JSON.stringify(state)}`, { cause: error })
  }
  assert.equal(await value(client, `document.querySelector('[role="dialog"]')?.contains(document.activeElement)`), true, 'dialog did not receive focus')
  await waitFor(client, `document.activeElement === document.querySelector('[role="dialog"] header button')`,
    'connect dialog stable first control focus before tab-trap assertion')

  // The close button is first in the trap. Shift+Tab must wrap to the last
  // control, and Tab from there must wrap back to the close button.
  await key(client, 'Tab', 9, { shift: true })
  await waitFor(client, `(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const first = dialog?.querySelector('header button')
    return dialog?.contains(document.activeElement) === true && document.activeElement !== first
  })()`, 'Shift+Tab wrapped to the final dialog control')
  await key(client, 'Tab', 9)
  await waitFor(client, `document.activeElement === document.querySelector('[role="dialog"] header button')`,
    'Tab trap wrapped to first control')

  const zcodeSelection = await value(client, `(() => {
    const name = [...document.querySelectorAll('[role="dialog"] label span')]
      .find(candidate => candidate.textContent?.trim() === 'ZCode')
    const label = name?.closest('label')
    const input = label?.querySelector('input[type="checkbox"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('ZCode connection checkbox missing')
    if (input.checked) return { checked: true }
    // Use the checkbox's standards-based activation behavior. Pointer
    // coordinates are separately exercised throughout this audit and proved
    // flaky here when the scroll container settles between CDP round-trips.
    input.click()
    return { checked: false }
  })()`)
  if (!zcodeSelection.checked) {
    await waitFor(client, `(() => {
      const name = [...document.querySelectorAll('[role="dialog"] label span')]
        .find(candidate => candidate.textContent?.trim() === 'ZCode')
      const input = name?.closest('label')?.querySelector('input[type="checkbox"]')
      return input instanceof HTMLInputElement && input.checked
    })()`, 'ZCode selection state committed before confirmation')
  }
  await screenshot(client, path.join(artifactRoot, '03-connect-selection.png'))
  await clickDialogPrimary(client)
  await waitFor(client, `document.querySelector('[role="dialog"] button[aria-expanded]') !== null`, 'confirmed connection preview')
  await waitFor(client, `(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return dialog?.contains(document.activeElement)
      && document.activeElement?.getAttribute('tabindex') === '-1'
  })()`, 'preview step committed focus inside dialog')
  await clickDialogPrimary(client)
  await waitFor(client, `(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return dialog?.contains(document.activeElement)
      && document.activeElement?.getAttribute('tabindex') === '-1'
  })()`, 'execute step committed focus inside dialog')
  try {
    await waitFor(client, `(() => {
      const dialog = document.querySelector('[role="dialog"]')
      return dialog?.getAttribute('aria-busy') === 'false'
        && dialog.querySelector('input[type="checkbox"]') === null
        && dialog.querySelector('button[aria-expanded]') === null
        && dialog.querySelector('[aria-live="polite"]') !== null
        && dialog.querySelectorAll('footer button').length > 0
    })()`, 'connection execution result', 30_000)
  } catch (error) {
    const state = await value(client, `(() => {
      const dialog = document.querySelector('[role="dialog"]')
      return dialog ? {
        busy: dialog.getAttribute('aria-busy'),
        text: dialog.textContent.slice(0, 1500),
        footer: [...dialog.querySelectorAll('footer button')].map(button => button.textContent),
      } : { missing: true }
    })()`).catch(() => ({ rendererUnavailable: true }))
    throw new Error(`${error.message}; dialog=${JSON.stringify(state)}`, { cause: error })
  }
  await screenshot(client, path.join(artifactRoot, '04-post-connect.png'))
  await clickDialogPrimary(client)
  await waitFor(client, `document.querySelector('[role="dialog"]') === null`, 'connect dialog close')
  await waitFor(client, `document.activeElement?.id === 'managed-local-agents-title'`,
    'connect dialog stable fallback focus after its trigger disappears')
  await waitForZCodeAwaitingHostRecognition(client)
  await waitFor(client, `(() => {
    const task = [...document.querySelectorAll('[role="status"]')]
      .find(element => /中断|interrupted/iu.test(element.textContent ?? ''))
    const previous = task?.querySelector('button svg.lucide-chevron-left')?.closest('button')
    const next = task?.querySelector('button svg.lucide-chevron-right')?.closest('button')
    return Boolean(task && previous?.disabled && next && !next.disabled)
  })()`, 'interrupted attention remains ahead of awaiting-verification task with queue navigation')
  return {
    focusInsideAfterPreviewCommit: true,
    focusInsideAfterExecuteCommit: true,
    focusRestoredAfterTriggerRemoval: true,
    backgroundTaskReportedRealResults: true,
    projectionAppliedAwaitingHostRecognition: true,
    attentionPrecedesAwaitingAfterCompletion: true,
    taskQueueNavigationVisible: true,
  }
}

async function waitForZCodeAwaitingHostRecognition(client) {
  // The dialog only reports that the durable background task was accepted.
  // Keep Electron alive until the exact ZCode Installation has applied its
  // projection and is explicitly waiting for host recognition. The physical
  // verifier later binds both committed mutation receipts to this current run.
  await waitFor(client, `(async () => {
    const snapshot = await window.api.agentIntegrations.snapshot()
    const zcode = snapshot.installations.find(item => item.id === 'zcode-default')
    return zcode?.desiredState === 'managed'
      && zcode.statusGroup === 'awaiting_verification'
      && zcode.statusReason === 'unverified'
  })()`, 'ZCode projection applied and awaiting host recognition before Electron shutdown', 30_000)
}

async function exerciseLiveTaskAdvancement(client, artifactRoot) {
  const taskId = 'audit-live-progress-task'
  const runId = 'audit-live-progress-run'
  const executionPlanHash = crypto.createHash('sha256').update(taskId).digest('hex')
  const pagingStartedAtMs = Date.now()
  // Keep the exact task older than every attention fixture. Even if the
  // background recovery loop advances its run before the test does, the task
  // remains on page two instead of moving ahead of newer attention records.
  const createdAt = new Date(pagingStartedAtMs - 60 * 60 * 1_000).toISOString()
  const pagingTaskIds = Array.from({ length: 25 }, (_, index) => `audit-paging-task-${String(index).padStart(2, '0')}`)
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  const insertPagingTask = db.prepare(`
    INSERT INTO agent_integration_apply_tasks (
      id, plan_hash, operation_type, state, started_at, completed_at, updated_at
    ) VALUES (?, ?, 'connect', 'completed', ?, ?, ?)
  `)
  const insertPagingItem = db.prepare(`
    INSERT INTO agent_integration_apply_task_items (
      task_id, installation_id, ordinal, execution_plan_hash, state,
      result_json, started_at, completed_at, updated_at
    ) VALUES (?, 'zcode-default', 0, ?, 'terminal', ?, ?, ?, ?)
  `)
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO reconcile_runs (
          id, installation_id, operation_type, execution_plan_hash, state,
          recovery_strategy, writer_fence_snapshot_json, prepared_plan_json,
          desired_capability, created_at, completed_at, updated_at
        ) VALUES (?, 'zcode-default', 'connect', ?, 'applied_unverified',
          'readback_before_replay', '{}', '{}', 0, ?, ?, ?)
      `).run(runId, executionPlanHash, createdAt, createdAt, createdAt)
      db.prepare(`
        INSERT INTO agent_integration_apply_tasks (
          id, plan_hash, operation_type, state, started_at, completed_at, updated_at
        ) VALUES (?, ?, 'connect', 'completed', ?, ?, ?)
      `).run(taskId, executionPlanHash, createdAt, createdAt, createdAt)
      db.prepare(`
        INSERT INTO agent_integration_apply_task_items (
          task_id, installation_id, run_id, ordinal, execution_plan_hash, state,
          result_json, started_at, completed_at, updated_at
        ) VALUES (?, 'zcode-default', ?, 0, ?, 'terminal', ?, ?, ?, ?)
      `).run(
        taskId,
        runId,
        executionPlanHash,
        JSON.stringify({
          installationId: 'zcode-default',
          status: 'awaiting_verification',
          runId,
        }),
        createdAt,
        createdAt,
        createdAt,
      )
      pagingTaskIds.forEach((pagingTaskId, index) => {
        const timestamp = new Date(pagingStartedAtMs - index).toISOString()
        insertPagingTask.run(pagingTaskId, pagingTaskId, timestamp, timestamp, timestamp)
        insertPagingItem.run(
          pagingTaskId,
          `${pagingTaskId}-execution`,
          JSON.stringify({ installationId: 'zcode-default', status: 'failed', reason: 'isolated-e2e' }),
          timestamp,
          timestamp,
          timestamp,
        )
      })
    }).immediate()

    const pagination = await value(client, `(async () => {
      const expected = new Set(${JSON.stringify(pagingTaskIds)})
      const seen = new Set()
      let cursor
      let pageCount = 0
      let previousCursorObserved = false
      let progressStartIndex = -1
      do {
        const page = await window.api.agentIntegrations.listApplyTasks({ limit: 20, ...(cursor ? { cursor } : {}) })
        if (page.tasks.length > 20) throw new Error('task page exceeded the renderer DTO bound')
        for (const task of page.tasks) {
          if (seen.has(task.feedKey)) throw new Error('duplicate task feed key across pages')
          seen.add(task.feedKey)
          expected.delete(task.id)
          if (task.id === ${JSON.stringify(taskId)}) progressStartIndex = page.startIndex
        }
        pageCount += 1
        previousCursorObserved ||= page.hasPrevious && typeof page.previousCursor === 'string'
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return { missing: [...expected], pageCount, previousCursorObserved, seenCount: seen.size, progressStartIndex }
    })()`)
    assert.deepEqual(pagination.missing, [], 'Electron task-feed traversal dropped a cross-page task')
    assert.ok(pagination.pageCount >= 2, 'Electron task-feed fixture did not cross a page boundary')
    assert.equal(pagination.previousCursorObserved, true, 'Electron task feed did not expose reverse navigation')
    assert.ok(pagination.progressStartIndex >= 20,
      `awaiting progress fixture was not placed beyond page one: ${JSON.stringify(pagination)}`)

    // Existing awaiting work keeps the mounted renderer polling. Once the new
    // revision reaches it, walk the actual queue across the page boundary and
    // pin the exact page-two task before its coordinator run advances.
    await waitFor(client, `document.querySelector('[data-task-feed-key]') !== null`, 'task feed card')
    await waitFor(client, `Number(document.querySelector('[data-task-feed-key]')
      ?.getAttribute('data-task-feed-total')) >= ${pagination.seenCount}`,
    'mounted renderer refreshes the cross-page revision', 10_000)
    // Normalize the visible selection to the last item on page one even when
    // a previously pinned task currently lives on page two.
    for (let index = 0; index < 100; index += 1) {
      const selected = await value(client, `document.querySelector('[data-task-feed-key]')?.getAttribute('data-task-feed-key')`)
      const selectedPage = await value(client, `(() => {
        const card = document.querySelector('[data-task-feed-key]')
        return {
          startIndex: Number(card?.getAttribute('data-task-feed-start-index')),
          pageIndex: Number(card?.getAttribute('data-task-feed-page-index')),
        }
      })()`)
      if (selectedPage.startIndex === 0 && selectedPage.pageIndex === 19) break
      const direction = selectedPage.startIndex > 0 && selectedPage.pageIndex >= 0 ? 'left' : 'right'
      const point = await value(client, `(() => {
        const card = document.querySelector('[data-task-feed-key]')
        const button = [...(card?.querySelectorAll('button') ?? [])]
          .find(candidate => !candidate.disabled && candidate.querySelector(
            ${JSON.stringify(`svg.lucide-chevron-${direction}`)}))
        if (!(button instanceof HTMLButtonElement)) return null
        button.scrollIntoView({ block: 'center', inline: 'center' })
        const rect = button.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })()`)
      assert.ok(point, 'task queue could not normalize to the first-page boundary')
      await mouseClick(client, point)
      await waitFor(client, `document.querySelector('[data-task-feed-key]')
        ?.getAttribute('data-task-feed-key') !== ${JSON.stringify(selected)}`,
      'task queue normalizes one bounded item', 5_000)
    }
    const firstPageBoundary = await value(client, `(() => {
      const card = document.querySelector('[data-task-feed-key]')
      return {
        key: card?.getAttribute('data-task-feed-key'),
        startIndex: Number(card?.getAttribute('data-task-feed-start-index')),
        pageIndex: Number(card?.getAttribute('data-task-feed-page-index')),
      }
    })()`)
    assert.deepEqual({ startIndex: firstPageBoundary.startIndex, pageIndex: firstPageBoundary.pageIndex },
      { startIndex: 0, pageIndex: 19 }, 'task queue did not reach the first-page boundary')

    // Break only the isolated fixture's feed-state table for one cursor
    // request. This is a real main-process SQLite/IPC failure, not a renderer
    // mock, and verifies retained content, visible retry, and initiating focus.
    db.exec(`ALTER TABLE agent_integration_apply_task_feed_state
      RENAME TO agent_integration_apply_task_feed_state_ui_blocked`)
    const failingNextPoint = await value(client, `(() => {
      const card = document.querySelector('[data-task-feed-key]')
      const button = [...(card?.querySelectorAll('button') ?? [])]
        .find(candidate => !candidate.disabled && candidate.querySelector('svg.lucide-chevron-right'))
      if (!(button instanceof HTMLButtonElement)) return null
      button.focus()
      const rect = button.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    assert.ok(failingNextPoint, 'first-page boundary did not expose the next-page request')
    await mouseClick(client, failingNextPoint)
    await waitFor(client, `(() => [...document.querySelectorAll('[role="alert"]')].some(alert =>
      [...alert.querySelectorAll('button')].some(button =>
        /重试加载后台任务|Retry loading background tasks/iu.test(button.textContent ?? ''))))()` ,
    'non-stale task page failure remains visible with retry', 5_000)
    assert.equal(await value(client, `document.querySelector('[data-task-feed-key]')?.getAttribute('data-task-feed-key')`),
      firstPageBoundary.key, 'failed page request replaced the retained task card')
    assert.equal(await value(client, `Boolean(document.activeElement instanceof HTMLButtonElement
      && document.activeElement.querySelector('svg.lucide-chevron-right'))`), true,
    'failed page request did not restore keyboard focus to the initiating arrow')
    await screenshot(client, path.join(artifactRoot, '05-task-page-error.png'))
    db.exec(`ALTER TABLE agent_integration_apply_task_feed_state_ui_blocked
      RENAME TO agent_integration_apply_task_feed_state`)
    const retryPoint = await value(client, `(() => {
      const alert = [...document.querySelectorAll('[role="alert"]')].find(candidate =>
        [...candidate.querySelectorAll('button')].some(button =>
          /重试加载后台任务|Retry loading background tasks/iu.test(button.textContent ?? '')))
      const button = [...(alert?.querySelectorAll('button') ?? [])].find(candidate =>
        /重试加载后台任务|Retry loading background tasks/iu.test(candidate.textContent ?? ''))
      if (!(button instanceof HTMLButtonElement)) return null
      const rect = button.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    assert.ok(retryPoint, 'task page failure did not expose an actionable retry button')
    await mouseClick(client, retryPoint)
    await waitFor(client, `![...document.querySelectorAll('[role="alert"]')].some(alert =>
      [...alert.querySelectorAll('button')].some(button =>
        /重试加载后台任务|Retry loading background tasks/iu.test(button.textContent ?? '')))`,
    'task page retry succeeds after the isolated database fault clears', 5_000)
    await waitFor(client, `(() => {
      const card = document.querySelector('[data-task-feed-key]')
      const next = [...(card?.querySelectorAll('button') ?? [])]
        .find(button => button.querySelector('svg.lucide-chevron-right'))
      return Boolean(next && next.getAttribute('aria-busy') !== 'true' && !next.disabled)
    })()`, 'task page retry finishes and restores navigation', 5_000)

    for (let index = 0; index < 100; index += 1) {
      const selected = await value(client, `document.querySelector('[data-task-feed-key]')?.getAttribute('data-task-feed-key')`)
      if (selected === `task:${taskId}`) break
      const point = await value(client, `(() => {
        const card = document.querySelector('[data-task-feed-key]')
        const button = [...(card?.querySelectorAll('button') ?? [])]
          .find(candidate => !candidate.disabled && candidate.querySelector('svg.lucide-chevron-right'))
        if (!(button instanceof HTMLButtonElement)) return null
        const rect = button.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })()`)
      if (!point) {
        const state = await value(client, `(async () => {
          const card = document.querySelector('[data-task-feed-key]')
          const first = await window.api.agentIntegrations.listApplyTasks({ limit: 20 })
          const second = first.nextCursor
            ? await window.api.agentIntegrations.listApplyTasks({ limit: 20, cursor: first.nextCursor })
            : null
          return {
            key: card?.getAttribute('data-task-feed-key'),
            total: card?.getAttribute('data-task-feed-total'),
            startIndex: card?.getAttribute('data-task-feed-start-index'),
            pageIndex: card?.getAttribute('data-task-feed-page-index'),
            firstKeys: first.tasks.map(task => task.feedKey),
            secondKeys: second?.tasks.map(task => task.feedKey),
            buttons: [...(card?.querySelectorAll('button') ?? [])].map(button => ({
              disabled: button.disabled, text: button.textContent,
              left: Boolean(button.querySelector('svg.lucide-chevron-left')),
              right: Boolean(button.querySelector('svg.lucide-chevron-right')),
            })),
          }
        })()`)
        assert.fail(`task queue could not reach the page-two awaiting task: ${JSON.stringify(state)}`)
      }
      await mouseClick(client, point)
      await waitFor(client, `document.querySelector('[data-task-feed-key]')
        ?.getAttribute('data-task-feed-key') !== ${JSON.stringify(selected)}`,
      'task queue advances one bounded item', 5_000)
    }
    assert.equal(await value(client, `document.querySelector('[data-task-feed-key]')?.getAttribute('data-task-feed-key')`),
      `task:${taskId}`, 'renderer did not pin the exact page-two awaiting task')

    db.transaction(() => {
      db.prepare(`
        UPDATE reconcile_runs
        SET state = 'needs_recovery', failure_code = 'ui_e2e_progression',
            failure_stage = 'verification', completed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'applied_unverified'
      `).run(createdAt, createdAt, runId)
      // Keep one first-page task active. After the renderer leaves the exact
      // off-page pin, its polling cadence must not let the stale pin ref take
      // selection back from the task the user deliberately chose.
      db.prepare(`
        UPDATE agent_integration_apply_tasks
        SET state = 'running', completed_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(createdAt, pagingTaskIds[0])
    }).immediate()

    await waitFor(client, `(async () => {
      const task = await window.api.agentIntegrations.getApplyTask('task:${taskId}')
      return task?.results.some(result => result.runId === ${JSON.stringify(runId)}
        && result.status === 'needs_recovery')
    })()`, 'authoritative task progression visible through IPC', 10_000)

    // The revision invalidates page two, so the controlled refresh returns to
    // page one while retaining one exact pinned task. Its 5s cadence must still
    // advance that off-page pin without a remount or a live task event.
    await waitFor(client, `(() => {
      const card = document.querySelector('[data-task-feed-key="task:${taskId}"]')
      return Boolean(card && card.getAttribute('data-task-feed-page-index') === '-1'
        && [...card.querySelectorAll('button')].some(button =>
        /重新检查并生成新方案|Review and generate a new plan/iu.test(button.textContent ?? '')))
    })()`, 'page-two pinned task progression without remount', 12_000)
    assert.equal(await value(client, `document.querySelector('[data-tone]')?.getAttribute('data-tone')`), 'critical')
    await screenshot(client, path.join(artifactRoot, '05-live-task-needs-recovery.png'))

    const leavePinnedPoint = await value(client, `(() => {
      const card = document.querySelector('[data-task-feed-key="task:${taskId}"]')
      const button = [...(card?.querySelectorAll('button') ?? [])]
        .find(candidate => !candidate.disabled && candidate.hasAttribute('aria-label')
          && candidate.querySelector('svg.lucide-chevron-right'))
      if (!(button instanceof HTMLButtonElement)) return null
      button.focus()
      const rect = button.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    assert.ok(leavePinnedPoint, 'off-page pin did not expose a return-to-page action')
    await mouseClick(client, leavePinnedPoint)
    await waitFor(client, `document.querySelector('[data-task-feed-key]')
      ?.getAttribute('data-task-feed-key') !== 'task:${taskId}'`,
    'user leaves the exact off-page pin', 5_000)
    await new Promise(resolve => setTimeout(resolve, 250))
    const focusAfterLeaving = await value(client, `(() => ({
      right: Boolean(document.activeElement instanceof HTMLButtonElement
        && document.activeElement.querySelector('svg.lucide-chevron-right')),
      tag: document.activeElement?.tagName,
      className: document.activeElement?.getAttribute('class'),
      disabled: document.activeElement instanceof HTMLButtonElement ? document.activeElement.disabled : null,
      nav: [...(document.querySelector('[data-task-feed-key]')?.querySelectorAll('button[aria-label]') ?? [])]
        .map(button => ({ label: button.getAttribute('aria-label'), busy: button.getAttribute('aria-busy'), disabled: button.disabled })),
    }))()`)
    assert.equal(focusAfterLeaving.right, true,
      `return-from-pin arrow did not receive focus: ${JSON.stringify(focusAfterLeaving)}`)
    const selectedAfterLeavingPin = await value(client,
      `document.querySelector('[data-task-feed-key]')?.getAttribute('data-task-feed-key')`)
    await new Promise(resolve => setTimeout(resolve, 3_500))
    assert.equal(await value(client,
      `document.querySelector('[data-task-feed-key]')?.getAttribute('data-task-feed-key')`),
    selectedAfterLeavingPin, 'background polling stole selection back to the stale off-page pin')
    const focusAfterPolling = await value(client, `(() => ({
      right: Boolean(document.activeElement instanceof HTMLButtonElement
        && document.activeElement.querySelector('svg.lucide-chevron-right')),
      tag: document.activeElement?.tagName,
      className: document.activeElement?.getAttribute('class'),
      disabled: document.activeElement instanceof HTMLButtonElement ? document.activeElement.disabled : null,
    }))()`)
    assert.equal(focusAfterPolling.right, true,
      `returning from an off-page pin did not preserve navigation focus through polling: ${JSON.stringify(focusAfterPolling)}`)
  } finally {
    db.transaction(() => {
      for (const pagingTaskId of pagingTaskIds) {
        db.prepare('DELETE FROM agent_integration_apply_tasks WHERE id = ?').run(pagingTaskId)
      }
      db.prepare('DELETE FROM agent_integration_apply_tasks WHERE id = ?').run(taskId)
      db.prepare('DELETE FROM reconcile_runs WHERE id = ?').run(runId)
    }).immediate()
    db.close()
  }
  await waitFor(client, `(async () => {
    const page = await window.api.agentIntegrations.listApplyTasks({ limit: 20 })
    return !page.tasks.some(task => task.id === ${JSON.stringify(taskId)})
  })()`, 'temporary live progression fixture cleanup')
  return {
    sameRendererSession: true,
    exactTaskId: taskId,
    exactRunId: runId,
    progressedTo: 'needs_recovery',
    freshPreviewCtaVisible: true,
    crossPageTraversal: true,
    pageTwoPinnedProgression: true,
    leavingPinnedSelectionStableThroughPolling: true,
    nonStalePageErrorVisible: true,
    failedPageFocusPreserved: true,
    boundedPageLimit: 20,
  }
}

async function exerciseNarrowLayout(client, artifactRoot) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 680,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await waitFor(client, 'window.innerWidth === 680', 'narrow viewport')
  const geometry = await value(client, `(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    panelWidth: document.querySelector('#external-panel-agent')?.getBoundingClientRect().width ?? 0,
  }))()`)
  assert.ok(geometry.panelWidth > 0 && geometry.panelWidth <= geometry.viewport, `agent panel overflows narrow viewport: ${JSON.stringify(geometry)}`)
  assert.ok(geometry.documentWidth <= geometry.viewport + 1, `document overflows narrow viewport: ${JSON.stringify(geometry)}`)

  const hasCurrentDetail = await value(client, `Boolean([...document.querySelectorAll('[id^="components-"]')]
    .find(heading => heading instanceof HTMLElement && heading.offsetParent !== null))`)
  if (hasCurrentDetail) {
    await waitFor(client, `document.activeElement instanceof HTMLButtonElement
      && Boolean(document.activeElement.querySelector('svg.lucide-arrow-left'))`, 'narrow detail back focus')
    const focusedBackPoint = await value(client, `(() => {
      const rect = document.activeElement.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    await mouseClick(client, focusedBackPoint)
    await waitFor(client, `document.querySelector('[data-agent-family-trigger="zcode"]')?.offsetParent !== null`, 'narrow list before detail selection')
  }

  const detailPoint = await value(client, `(() => {
    const button = document.querySelector('[data-agent-family-trigger="zcode"]')
    if (!(button instanceof HTMLButtonElement)) throw new Error('ZCode detail trigger missing')
    globalThis.__tidemindUiE2eDetailTrigger = button
    button.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(client, detailPoint)
  try {
    await waitFor(client, `(() => {
      const panel = document.querySelector('[id^="components-zcode-default"]')?.closest('.overflow-hidden')
      return Boolean(panel && getComputedStyle(panel).display !== 'none')
    })()`, 'narrow detail panel')
  } catch (error) {
    const state = await value(client, `(() => ({
      active: document.activeElement?.outerHTML?.slice(0, 500) ?? null,
      triggerVisible: document.querySelector('[data-agent-family-trigger="zcode"]')?.offsetParent !== null,
      triggerRect: document.querySelector('[data-agent-family-trigger="zcode"]')?.getBoundingClientRect().toJSON(),
      headings: [...document.querySelectorAll('[id^="components-"]')].map(element => element.id),
      body: document.body.textContent.slice(0, 1500),
    }))()`)
    throw new Error(`${error.message}; narrow=${JSON.stringify(state)}`, { cause: error })
  }
  await screenshot(client, path.join(artifactRoot, '05-narrow-detail.png'))
  const backPoint = await value(client, `(() => {
    const heading = document.querySelector('#components-zcode-default')
    const detail = heading?.closest('.overflow-hidden')
    const button = detail?.querySelector('button')
    if (!(button instanceof HTMLButtonElement) || !button.querySelector('svg.lucide-arrow-left')) {
      throw new Error('back-to-list button missing')
    }
    button.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(client, backPoint)
  try {
    await waitFor(client, `document.activeElement === globalThis.__tidemindUiE2eDetailTrigger`, 'narrow detail focus restoration')
  } catch (error) {
    const state = await value(client, `(() => ({
      active: document.activeElement?.outerHTML?.slice(0, 800) ?? null,
      triggerConnected: globalThis.__tidemindUiE2eDetailTrigger?.isConnected ?? false,
      triggerVisible: globalThis.__tidemindUiE2eDetailTrigger
        ? getComputedStyle(globalThis.__tidemindUiE2eDetailTrigger).display !== 'none'
        : false,
      sameElement: document.activeElement === globalThis.__tidemindUiE2eDetailTrigger,
      detailOpen: document.querySelector('#components-zcode-default') !== null,
    }))()`).catch(() => ({ rendererUnavailable: true }))
    throw new Error(`${error.message}; focus=${JSON.stringify(state)}`, { cause: error })
  }
}

async function exerciseResponsiveBreakpoints(client, artifactRoot) {
  const results = []
  for (const width of [900, 1200, 1399, 1400]) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await waitFor(client, `window.innerWidth === ${width}`, `${width}px viewport`)
    if (width === 900) {
      const point = await value(client, `(() => {
        const button = document.querySelector('[data-agent-family-trigger="zcode"]')
        if (!(button instanceof HTMLButtonElement)) throw new Error('ZCode family trigger missing')
        button.scrollIntoView({ block: 'center', inline: 'center' })
        const rect = button.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })()`)
      await mouseClick(client, point)
      await waitFor(client, `document.querySelector('#components-zcode-default') !== null`, 'responsive detail selection')
    }
    const availableWidth = await value(client, `(() => {
      const section = document.querySelector('section[aria-labelledby="managed-local-agents-title"]')
      const root = section?.parentElement
      return root?.getBoundingClientRect().width ?? 0
    })()`)
    const shouldSplit = availableWidth >= 900
    await waitFor(client, `(() => {
      const trigger = document.querySelector('[data-agent-family-trigger="zcode"]')
      const detail = document.querySelector('#components-zcode-default')
      return (trigger instanceof HTMLElement && trigger.offsetParent !== null) === ${shouldSplit}
        && detail instanceof HTMLElement && detail.offsetParent !== null
    })()`, `${width}px available-width layout`)
    const geometry = await value(client, `(() => {
      const section = document.querySelector('section[aria-labelledby="managed-local-agents-title"]')
      const root = section?.parentElement
      const list = section?.querySelector('[data-agent-family-list]')
      const trigger = document.querySelector('[data-agent-family-trigger="zcode"]')
      const detail = document.querySelector('#components-zcode-default')
      const visibleTriggers = [...(list?.querySelectorAll('[data-agent-family-trigger]') ?? [])]
        .filter(candidate => candidate instanceof HTMLElement && candidate.offsetParent !== null)
      const listRect = list?.getBoundingClientRect()
      const detailPane = list?.parentElement?.parentElement?.children[1]
      const detailPaneRect = detailPane?.getBoundingClientRect()
      const detailHitCoveredByList = Boolean(detailPaneRect) && visibleTriggers.some(candidate => {
        const rowRect = candidate.getBoundingClientRect()
        const left = Math.max(rowRect.left, detailPaneRect.left)
        const right = Math.min(rowRect.right, detailPaneRect.right)
        const top = Math.max(rowRect.top, detailPaneRect.top)
        const bottom = Math.min(rowRect.bottom, detailPaneRect.bottom)
        if (left >= right || top >= bottom) return false
        return Boolean(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)?.closest('[data-agent-family-trigger]'))
      })
      return {
        viewport: window.innerWidth,
        availableWidth: root?.getBoundingClientRect().width ?? 0,
        listVisible: trigger instanceof HTMLElement && trigger.offsetParent !== null,
        detailVisible: detail instanceof HTMLElement && detail.offsetParent !== null,
        listClientWidth: list?.clientWidth ?? 0,
        listScrollWidth: list?.scrollWidth ?? 0,
        rowsInsideList: Boolean(listRect) && visibleTriggers.every(candidate => candidate.getBoundingClientRect().right <= listRect.right + 1),
        detailHitCoveredByList,
      }
    })()`)
    geometry.shouldSplit = shouldSplit
    if (shouldSplit) {
      assert.equal(geometry.rowsInsideList, true, `${width}px family row escaped its own container: ${JSON.stringify(geometry)}`)
      assert.ok(geometry.listScrollWidth <= geometry.listClientWidth + 1, `${width}px family list overflowed: ${JSON.stringify(geometry)}`)
      assert.equal(geometry.detailHitCoveredByList, false, `${width}px detail hit target was covered by a family row: ${JSON.stringify(geometry)}`)
    }
    results.push(geometry)
    await screenshot(client, path.join(artifactRoot, `06-responsive-${width}.png`))
  }
  assert.equal(results[0].shouldSplit, false, `900px viewport should remain a secondary detail view: ${JSON.stringify(results)}`)
  assert.equal(results.at(-1).shouldSplit, true, `1400px viewport should have at least 900px available content: ${JSON.stringify(results)}`)
  return results
}

async function exerciseConnectionHistory(client, artifactRoot) {
  const advancedPoint = await value(client, `(() => {
    const button = document.querySelector('button[aria-controls="agent-advanced-connections"]')
    if (!(button instanceof HTMLButtonElement)) throw new Error('advanced connections trigger missing')
    button.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, expanded: button.getAttribute('aria-expanded') }
  })()`)
  if (advancedPoint.expanded !== 'true') await mouseClick(client, advancedPoint)
  await waitFor(client, `document.querySelector('[data-agent-history-trigger="claude-history"]') !== null`, 'confirmed-uninstalled history fixture')
  const historyPoint = await value(client, `(() => {
    const button = document.querySelector('[data-agent-history-trigger="claude-history"]')
    if (!(button instanceof HTMLButtonElement)) throw new Error('history Installation trigger missing')
    globalThis.__tidemindUiE2eHistoryTrigger = button
    button.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(client, historyPoint)
  await waitFor(client, `document.querySelector('#components-claude-history') !== null`, 'history detail')
  assert.equal(await value(client, `document.querySelector('#management-claude-history') === null`), true, 'history exposed management controls')
  await client.evaluate(`document.querySelector('#components-claude-history')?.scrollIntoView({ block: 'start' })`)
  await screenshot(client, path.join(artifactRoot, '07-confirmed-uninstalled-history.png'))
  const backPoint = await value(client, `(() => {
    const detail = document.querySelector('#components-claude-history')?.closest('.overflow-hidden')
    const button = [...(detail?.querySelectorAll('button') ?? [])].find(candidate => candidate.querySelector('svg.lucide-arrow-left'))
    if (!(button instanceof HTMLButtonElement)) throw new Error('history back button missing')
    button.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(client, backPoint)
  await waitFor(client, `document.activeElement === globalThis.__tidemindUiE2eHistoryTrigger`, 'history focus restoration')
  return { exactHistoryInstallation: 'claude-history', readOnly: true, focusRestored: true }
}

async function clickDialogPrimary(client) {
  const point = await value(client, `(() => {
    const buttons = document.querySelectorAll('[role="dialog"] footer button')
    const button = buttons[buttons.length - 1]
    if (!(button instanceof HTMLButtonElement) || button.disabled) throw new Error('dialog primary action unavailable')
    button.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = button.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  await mouseClick(client, point)
}

function verifyPhysicalState() {
  assert.ok(fs.existsSync(dbPath), 'physical fixture SQLite database is missing')
  const skillPath = path.join(home, '.zcode', 'skills', 'tidemind', 'SKILL.md')
  const mcpPath = path.join(home, '.zcode-default', 'config.json')
  assert.match(fs.readFileSync(skillPath, 'utf8'), /name: tidemind/u)
  const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'))
  assert.ok(mcp?.mcp?.servers && Object.keys(mcp.mcp.servers).length === 1, 'ZCode MCP projection was not written')

  const db = new Database(dbPath, { readonly: true })
  try {
    const installation = db.prepare(`
      SELECT desired_state, reconcile_state, verification_summary, status_reason, consent_envelope_id
      FROM agent_installations WHERE id = 'zcode-default'
    `).get()
    assert.equal(installation.desired_state, 'managed')
    assert.equal(installation.reconcile_state, 'idle', `unexpected post-connect state: ${JSON.stringify(installation)}`)
    assert.equal(installation.status_reason, 'awaiting_host_verification')
    assert.equal(installation.verification_summary, 'unverified')
    assert.ok(installation.consent_envelope_id)
    const currentRun = db.prepare(`
      SELECT id, state, operation_type
      FROM reconcile_runs
      WHERE installation_id = 'zcode-default'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get()
    assert.ok(currentRun, 'current ZCode coordinator run is missing')
    assert.equal(currentRun.operation_type, 'connect')
    assert.equal(currentRun.state, 'applied_unverified')
    const mutations = db.prepare(`
      SELECT run_id, target, state
      FROM projection_mutations
      WHERE run_id = ?
      ORDER BY target, id
    `).all(currentRun.id)
    assert.equal(mutations.length, 2, `expected exactly two current-run mutations, got ${JSON.stringify(mutations)}`)
    assert.deepEqual(
      mutations.map(row => row.target).sort(),
      [skillPath, mcpPath].sort(),
      `current-run mutation targets do not match the two ZCode projections: ${JSON.stringify(mutations)}`,
    )
    assert.equal(
      mutations.every(row => row.run_id === currentRun.id && row.state === 'committed'),
      true,
      `current ZCode run has an uncommitted or foreign mutation: ${JSON.stringify(mutations)}`,
    )
    const taskItems = db.prepare(`
      SELECT task_id, run_id, state, result_json
      FROM agent_integration_apply_task_items
      WHERE installation_id = 'zcode-default'
      ORDER BY updated_at, task_id
    `).all()
    const interruptedItem = taskItems.find(item => item.task_id === 'audit-interrupted-restart-task')
    assert.equal(interruptedItem?.run_id, null, `old interrupted plan unexpectedly replayed: ${JSON.stringify(taskItems)}`)
    assert.equal(interruptedItem?.state, 'interrupted', `old task lost interrupted state: ${JSON.stringify(taskItems)}`)
    const currentTaskItem = taskItems.find(item => item.run_id === currentRun.id)
    assert.equal(currentTaskItem?.state, 'terminal', `current task is not exactly bound to its run: ${JSON.stringify(taskItems)}`)
    const oldTaskItems = db.prepare(`
      SELECT installation_id, run_id, state
      FROM agent_integration_apply_task_items
      WHERE task_id = 'audit-interrupted-restart-task'
      ORDER BY ordinal
    `).all()
    assert.deepEqual(oldTaskItems, [
      { installation_id: 'zcode-default', run_id: null, state: 'interrupted' },
      { installation_id: 'claude-history', run_id: null, state: 'interrupted' },
    ], `old interrupted task ownership changed: ${JSON.stringify(oldTaskItems)}`)
    const targets = db.prepare('SELECT target_path FROM managed_artifacts').all().map(row => row.target_path)
    const configRoots = db.prepare('SELECT config_root FROM agent_installations WHERE config_root IS NOT NULL').all().map(row => row.config_root)
    for (const target of [...targets, ...mutations.map(row => row.target), ...configRoots]) assertInsideRoot(target)
    return {
      installation,
      currentRun,
      mutationCount: mutations.length,
      mutationStates: [...new Set(mutations.map(row => row.state))].sort(),
      applyTaskCorrelation: {
        interruptedTaskUnbound: interruptedItem?.run_id === null,
        currentTaskRunId: currentTaskItem?.run_id ?? null,
      },
      managedTargets: targets.sort(),
      configRoots: configRoots.sort(),
      skillPath,
      mcpPath,
    }
  } finally {
    db.close()
  }
}

function assertInsideRoot(candidate) {
  assert.ok(path.isAbsolute(candidate), `managed target is not absolute: ${candidate}`)
  const relative = path.relative(fs.realpathSync(root), path.resolve(candidate))
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `managed target escaped audit root: ${candidate}`)
  let ancestor = path.resolve(candidate)
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  assert.ok(!fs.lstatSync(ancestor).isSymbolicLink(), `managed target has a symlink ancestor: ${candidate}`)
}

async function screenshot(client, target) {
  assertInsideRoot(target)
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'))
  assert.ok(fs.statSync(target).size > 10_000, `empty or suspicious screenshot: ${target}`)
}

async function key(client, keyName, windowsVirtualKeyCode, { shift = false } = {}) {
  await assertDocumentFocused(client)
  const modifiers = shift ? 8 : 0
  const code = keyName === ' ' ? 'Space' : keyName
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: keyName, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers,
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: keyName, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers,
  })
}

async function mouseClick(client, { x, y }) {
  await assertDocumentFocused(client)
  assert.ok(Number.isFinite(x) && Number.isFinite(y), `invalid click point: ${JSON.stringify({ x, y })}`)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  })
}

async function assertDocumentFocused(client) {
  if (await value(client, 'document.hasFocus()') !== true) {
    throw new Error('Electron renderer lost document focus; UI E2E environment is invalid')
  }
}

async function waitFor(client, expression, description, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    try {
      if (await value(client, expression)) return
    } catch (error) {
      lastError = error
    }
    await delay(75)
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`)
}

async function value(client, expression) {
  const result = await client.evaluate(expression)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

async function reserveLoopbackPort() {
  const net = await import('node:net')
  const server = net.createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function stopElectron(child) {
  signalElectronTree(child, 'SIGTERM')
  await Promise.race([waitForChildExit(child), delay(2_000)])
  // Electron helpers share this detached process group. Kill the group even
  // if the main process already exited, otherwise inherited stdout pipes can
  // keep this Node runner alive indefinitely.
  signalElectronTree(child, 'SIGKILL')
  await Promise.race([waitForChildExit(child), delay(2_000)])
}

function signalElectronTree(child, signal) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => child.once('exit', resolve))
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.sequence = 0
    this.pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`))
      else pending.resolve(message.result ?? {})
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'))
      this.pending.clear()
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error(`failed to connect CDP WebSocket: ${url}`)), { once: true })
    })
    return new CdpClient(socket)
  }

  send(method, params = {}) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: CDP command timed out`))
      }, 5_000)
      this.pending.set(id, {
        method,
        resolve: result => { clearTimeout(timer); resolve(result) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  evaluate(expression) {
    return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  }

  close() {
    this.socket.close()
  }
}

if (IS_GUARD_CHILD) {
  await main()
} else {
  if (Boolean(RECEIPT_PATH) !== Boolean(EVIDENCE_DIR)) {
    throw new Error('--receipt and --evidence-dir must be provided together')
  }
  if (RECEIPT_PATH && fs.existsSync(RECEIPT_PATH)) throw new Error(`receipt already exists: ${RECEIPT_PATH}`)
  if (RECEIPT_PATH && !fs.existsSync(path.dirname(RECEIPT_PATH))) {
    throw new Error(`receipt directory does not exist: ${path.dirname(RECEIPT_PATH)}`)
  }
  if (EVIDENCE_DIR && fs.existsSync(EVIDENCE_DIR)) throw new Error(`evidence directory already exists: ${EVIDENCE_DIR}`)
  if (EVIDENCE_DIR && !fs.existsSync(path.dirname(EVIDENCE_DIR))) {
    throw new Error(`evidence parent directory does not exist: ${path.dirname(EVIDENCE_DIR)}`)
  }
  const expectedCommit = process.env.TIDEMIND_CI_SOURCE_HEAD ?? null
  const provenanceBefore = RECEIPT_PATH
    ? captureAgentIntegrationGateProvenance({ repoRoot: projectRoot, expectedCommit })
    : null
  const startedAt = new Date().toISOString()
  const forwarded = forwardedArguments()
  const result = runWithRealHomeGuard({
    command: process.execPath,
    args: [runnerScript, '--real-home-guard-child', ...forwarded],
    protectedPaths: protectedRealAgentPaths(os.homedir()),
    timeoutMs: HARD_TIMEOUT_MS + 15_000,
  })
  if (result.error) {
    process.stderr.write(`UI E2E guard child failed: ${result.error.message}\n`)
    process.exitCode = result.error.code === 'ETIMEDOUT' ? 124 : 1
  } else if (result.status !== 0) {
    process.exitCode = result.status ?? 1
  } else if (RECEIPT_PATH && provenanceBefore) {
    const provenanceAfter = captureAgentIntegrationGateProvenance({ repoRoot: projectRoot, expectedCommit })
    if (!sameAgentIntegrationGateProvenance(provenanceBefore, provenanceAfter)) {
      throw new Error('Agent Integration source or build artifacts changed during UI E2E')
    }
    const manifestPath = path.join(EVIDENCE_DIR, 'evidence-manifest.json')
    const manifestStat = fs.lstatSync(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error('Agent Integration UI evidence manifest is not an ordinary file')
    }
    const evidenceManifestSha256 = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex')
    fs.writeFileSync(RECEIPT_PATH, `${JSON.stringify({
      protocolVersion: 1,
      gate: 'agent-integration-electron-ui-e2e',
      status: 'passed',
      startedAt,
      completedAt: new Date().toISOString(),
      isolation: 'temporary-home-physical-sqlite-real-electron',
      writesRealAgentConfiguration: false,
      evidenceManifestSha256,
      provenance: provenanceAfter,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
}
