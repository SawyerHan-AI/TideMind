import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

// Exercise real React effects and deferred IPC-like promises in Chromium.
// This deliberately does not add production fault-injection IPC endpoints.
it.skipIf(process.platform !== 'darwin' && !process.env.DISPLAY)(
  'isolates delayed Cowork and batch sessions and retains narrow detail back navigation',
  async () => {
    const root = path.resolve(import.meta.dirname, '../..')
    const temp = await mkdtemp(path.join(os.tmpdir(), 'tidemind-react-races-'))
    const require = createRequire(path.join(root, 'client/package.json'))
    const electron = require('electron') as string
    try {
      const bundle = await build({
        absWorkingDir: root,
        entryPoints: ['tests/fixtures/agent-integration-ui-races.tsx'],
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
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ width: 640, height: 800, show: false,
            webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
          await window.loadFile(${JSON.stringify(path.join(temp, 'index.html'))});
          const result = await window.webContents.executeJavaScript('window.regressionResult');
          process.stdout.write('REGRESSION_RESULT=' + JSON.stringify(result) + '\\n');
          app.exit(result?.ok ? 0 : 1);
        }).catch(error => { process.stderr.write(error.stack); app.exit(1); });
      `)
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(electron, [path.join(temp, 'main.cjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
        let output = ''
        child.stdout.on('data', chunk => { output += chunk })
        child.stderr.on('data', chunk => { output += chunk })
        const timeout = setTimeout(() => { child.kill('SIGKILL') }, 20_000)
        child.on('error', error => { clearTimeout(timeout); reject(error) })
        child.on('close', code => { clearTimeout(timeout); resolve({ code, output }) })
      })
      expect(result.code, result.output).toBe(0)
      expect(result.output).toContain('"coworkDelayedSessions":true')
      expect(result.output).toContain('"narrowPendingAndFailedBackNavigation":true')
      expect(result.output).toContain('"batchDelayedSessions":true')
      expect(result.output).toContain('"customDelayedFocusAndSchema":true')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }, 30_000,
)
