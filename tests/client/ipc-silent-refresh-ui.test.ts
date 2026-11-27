import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

// Exercise useIPC and the Dashboard with real React effects in Chromium: a data
// revision bump must refresh in place, a query change must still reset.
// Scenario names are listed in tests/fixtures/ipc-silent-refresh-ui.tsx.
const EXPECTED_SCENARIOS = [
  'ipcInitialMountFetchesOnce',
  'ipcRefreshKeyKeepsData',
  'ipcFetcherChangeResets',
  'ipcBothChangeFetchesOnce',
  'ipcRefreshDuringInitialLoad',
  'ipcOutOfOrderRefresh',
  'ipcSilentRefreshFailureKeepsData',
  'ipcWithoutRefreshKeyIsUnchanged',
  'dashboardIgnoresCloudHeartbeat',
  'dashboardNodesChangeRefreshesInPlace',
  'dashboardTimelineChangeRefreshesDiscoveries',
  'dashboardOllamaMissingRechecksModels',
  'dashboardRefreshesWhenUtcDayChanges',
]

it.skipIf(process.platform !== 'darwin' && !process.env.DISPLAY)(
  'refreshes data in place when only the data revision changes and resets when the query changes',
  async () => {
    const root = path.resolve(import.meta.dirname, '../..')
    const temp = await mkdtemp(path.join(os.tmpdir(), 'tidemind-ipc-silent-refresh-'))
    const require = createRequire(path.join(root, 'client/package.json'))
    const electron = require('electron') as string
    try {
      const bundle = await build({
        absWorkingDir: root,
        entryPoints: ['tests/fixtures/ipc-silent-refresh-ui.tsx'],
        loader: { '.png': 'dataurl' },
        bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
        jsxImportSource: path.join(root, 'client/node_modules/react'),
        define: { 'process.env.NODE_ENV': '"development"' },
        plugins: [{ name: 'test-locale-bootstrap', setup(builder) {
          builder.onLoad({ filter: /client\/src\/lib\/i18n\.ts$/ }, () => ({
            contents: 'import i18n from "i18next"; export default i18n',
            resolveDir: path.join(root, 'client/src/lib'),
          }))
        } }],
      })
      await writeFile(path.join(temp, 'bundle.js'), bundle.outputFiles[0].contents)
      await writeFile(path.join(temp, 'index.html'), '<!doctype html><div id="root"></div><script src="bundle.js"></script>')
      await writeFile(path.join(temp, 'main.cjs'), `
        const { app, BrowserWindow } = require('electron');
        app.setPath('userData', ${JSON.stringify(path.join(temp, 'profile'))});
        const startedAt = Date.now();
        const phase = name => process.stderr.write('REGRESSION_PHASE=' + name + ':' + (Date.now() - startedAt) + '\\n');
        app.whenReady().then(async () => {
          phase('ready');
          const window = new BrowserWindow({ width: 640, height: 800, show: false,
            webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
          await window.loadFile(${JSON.stringify(path.join(temp, 'index.html'))});
          phase('loaded');
          const result = await window.webContents.executeJavaScript('window.regressionResult');
          phase('result');
          window.destroy();
          phase('window-destroyed');
          await new Promise(resolve => process.stdout.write('REGRESSION_RESULT=' + JSON.stringify(result) + '\\n', resolve));
          phase('stdout-flushed');
          app.exit(result?.ok ? 0 : 1);
        }).catch(error => { process.stderr.write(error.stack); app.exit(1); });
      `)
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(electron, [path.join(temp, 'main.cjs')], { detached: process.platform !== 'win32', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
        let output = ''
        const spawnedAt = Date.now()
        child.on('exit', (code, signal) => { output += `\nREGRESSION_EXIT=${code}:${signal}:${Date.now() - spawnedAt}ms\n` })
        child.stdout.on('data', chunk => { output += chunk })
        child.stderr.on('data', chunk => { output += chunk })
        // This is a lifecycle watchdog, not a performance assertion. Heavy native
        // Electron tests share CI CPU; phase/exit markers distinguish slow startup
        // from teardown failures. Kill the whole isolated process group on timeout.
        const timeout = setTimeout(() => {
          output += `\nREGRESSION_TIMEOUT=${Date.now() - spawnedAt}ms\n`
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
            else child.kill('SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') output += String(error)
          }
        }, 45_000)
        child.on('error', error => { clearTimeout(timeout); reject(error) })
        child.on('close', code => { clearTimeout(timeout); resolve({ code, output }) })
      })
      if (process.env.TIDEMIND_UI_RACE_DIAGNOSTICS === '1') {
        process.stdout.write(result.output.split('\n').filter(line => /^REGRESSION_(PHASE|EXIT|TIMEOUT)=/.test(line)).join('\n') + '\n')
      }
      const line = result.output.split('\n').find(entry => entry.startsWith('REGRESSION_RESULT='))
      expect(line, result.output).toBeDefined()
      const report = JSON.parse(line!.slice('REGRESSION_RESULT='.length)) as { ok: boolean; passed: string[]; failures: Record<string, string> }
      expect(report.failures).toEqual({})
      expect(report.passed).toEqual(expect.arrayContaining(EXPECTED_SCENARIOS))
      expect(result.code, result.output).toBe(0)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }, 60_000,
)
