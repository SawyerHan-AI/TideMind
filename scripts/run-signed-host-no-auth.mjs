#!/usr/bin/env node
/** Real signed renderer IPC operator. Outputs observations, never acceptance assertions. */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import os from 'node:os'
import { parse as parseToml } from 'smol-toml'
import { observeOwnedCas } from './signed-host-cas-observation.mjs'
import { protectedRealAgentPaths } from './agent-integration-ui-e2e-home-guard.mjs'
import crypto from 'node:crypto'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { inspectHistoricalUpgradeApp } from './historical-upgrade-apps.mjs'
import { inspectPhysicalTideMindCandidateApp } from './tidemind-candidate-app-identity.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const inside = (root, value) => value === root || value.startsWith(root + path.sep)
export function historicalDesktopRecipe(version, catalog) {
  if (!['0.2.89','0.2.91','0.2.92'].includes(version)) throw new Error('unknown historical Desktop version')
  if (catalog === 'claude-desktop-legacy') return 'desktop-legacy'
  if (catalog === 'codex-desktop') return 'codex-legacy'
  if (catalog === 'claude-cowork-local') return version === '0.2.92' ? 'cowork-guided' : 'unsupported-cowork'
  throw new Error('unknown historical Desktop target')
}
export function parseOperatorArgs(args) {
  const allowed = new Set(['candidate-app', 'candidate-bundle-sha256', 'source-commit', 'workspace', 'capture-nonce', 'catalog-id', 'output-dir', 'distribution-id', 'app-version', 'mode', 'capture-purpose'])
  const out = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '')
    if (!args[i]?.startsWith('--') || !allowed.has(key) || out[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('unknown, duplicate or missing argument')
    out[key] = args[i + 1]
  }
  for (const key of ['candidate-app', 'candidate-bundle-sha256', 'source-commit', 'workspace', 'capture-nonce', 'output-dir']) if (!out[key]) throw new Error('missing --' + key)
  if (!/^[a-f0-9]{40}$/.test(out['source-commit']) || !/^[a-f0-9]{64}$/.test(out['candidate-bundle-sha256'])) throw new Error('invalid candidate binding')
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(out['capture-nonce'])) throw new Error('invalid capture nonce')
  out.mode ??= 'lifecycle'; out['app-version'] ??= '0.2.93'
  if (!['lifecycle', 'snapshot-only', 'historical-upgrade-snapshot', 'historical-upgrade-baseline', 'historical-upgrade-prime', 'upgrade-observe'].includes(out.mode) || !/^0\.2\.\d+$/.test(out['app-version'])) throw new Error('invalid mode/version')
  if (out.mode === 'upgrade-observe' && (out['app-version'] !== '0.2.93' || !['codex-desktop','claude-cowork-local','claude-desktop-legacy'].includes(out['catalog-id']))) throw new Error('upgrade observation requires current candidate and a reviewed Desktop target')
  if (out.mode === 'lifecycle' && (!out['catalog-id'] || out['app-version'] !== '0.2.93')) throw new Error('lifecycle requires 0.2.93 catalog target')
  if (out.mode.startsWith('historical-upgrade-') && !['0.2.89','0.2.91','0.2.92'].includes(out['app-version'])) throw new Error('historical mode requires frozen historical version')
  if (out.mode === 'historical-upgrade-baseline' && !['claude-desktop-legacy','codex-desktop','claude-cowork-local'].includes(out['catalog-id'])) throw new Error('historical baseline supports only the three frozen Desktop recipes')
  out['capture-purpose'] ??= 'candidate_no_auth'
  if (!['candidate_no_auth', 'operator_self_check_old_candidate'].includes(out['capture-purpose']) || (out['capture-purpose'] === 'operator_self_check_old_candidate' && out.mode !== 'snapshot-only')) throw new Error('invalid capture purpose')
  return out
}
export function isolatedOperatorEnv(workspace, inherited = process.env) {
  const home = path.join(workspace, 'home'), tmp = path.join(workspace, 'tmp')
  // Deliberately no inherited PATH, GH tokens, API keys, auth homes, audit flags or NODE_OPTIONS.
  const env = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: home,
    TMPDIR: tmp + '/', TMP: tmp, TEMP: tmp, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share') }
  for (const key of ['LANG', 'LC_ALL', '__CF_USER_TEXT_ENCODING']) if (inherited[key]) env[key] = inherited[key]
  return env
}
function safeDirectory(value) {
  const absolute = path.resolve(value)
  let cursor = path.parse(absolute).root
  for (const piece of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, piece)
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 })
    const stat = fs.lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe directory: ' + cursor)
  }
  return absolute
}
// These exact argv shapes come from the production Claude/Gemini local-plugin adapters.
// Human instructions are not inspected/executed; only frozen mutation commands appear here.
export function validateIsolatedProfilePaths(home) {
  for (const relative of ['Downloads', '.claude', '.codex', '.codex/config.toml', '.codex/hooks.json', '.codex/skills', '.agents', '.config', 'Library/Application Support/Claude', '.tidemind', '.tidemind/config.toml', '.tidemind/graph', '.tidemind/graph/brain.sqlite', '.tidemind/graph/brain.sqlite-wal', '.tidemind/graph/brain.sqlite-shm', 'Library/Application Support/TideMind']) {
    let cursor = home
    for (const piece of relative.split('/')) {
      cursor = path.join(cursor, piece)
      try { const stat = fs.lstatSync(cursor); if (stat.isSymbolicLink() || !inside(home, fs.realpathSync(cursor))) throw new Error('isolated profile contains symlink or escaped path: ' + cursor) }
      catch (error) { if (error.code === 'ENOENT') break; throw error }
    }
  }
  const configPath = path.join(home, '.tidemind/config.toml')
  if (fs.existsSync(configPath)) {
    const stat = fs.lstatSync(configPath)
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('invalid isolated configuration file')
    const config = parseToml(fs.readFileSync(configPath, 'utf8'))
    const dataDir = config.general?.data_dir
    // The operator requires an explicit exact task data_dir for its fixed database observation contract.
    if (dataDir !== undefined && (typeof dataDir !== 'string' || dataDir !== path.join(home, '.tidemind'))) throw new Error('isolated config data_dir must equal task HOME/.tidemind')
  }
}
export function assertNoAuthSchedulerGuard(home) {
  validateIsolatedProfilePaths(home)
  const config = parseToml(fs.readFileSync(path.join(home, '.tidemind/config.toml'), 'utf8'))
  if (config.cloud?.enabled !== false || config.cloud?.sync_enabled !== false || config.cloud?.metabolism_enabled !== true) throw new Error('existing no-auth profile must have local scheduler paused and cloud disabled before App startup')
}
export function validateLegacySnippet(snippet, agentId, home, app) {
  if (!snippet || JSON.stringify(Object.keys(snippet)) !== JSON.stringify(['mcpServers'])
    || JSON.stringify(Object.keys(snippet.mcpServers ?? {})) !== JSON.stringify(['tidemind'])) throw new Error('historical MCP snippet shape mismatch')
  const server = snippet.mcpServers.tidemind
  if (JSON.stringify(Object.keys(server).sort()) !== JSON.stringify(['args','command','env'])
    || !Array.isArray(server.args) || server.args.length !== 1
    || JSON.stringify(server.env) !== JSON.stringify({ EB_AGENT_ID: agentId })) throw new Error('historical MCP server shape mismatch')
  for (const file of [server.command, ...server.args]) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('historical MCP path is not absolute')
    const canonical = fs.realpathSync(file)
    if (!inside(home, canonical) && !inside(app, canonical)) throw new Error('historical MCP path escapes signed App and isolated HOME')
    if (!fs.statSync(canonical).isFile()) throw new Error('historical MCP path is not a file')
  }
  return snippet
}
export function reviewedNoAuthCommand(command) {
  const a = command.args
  if (!Array.isArray(a) || a.some(value => typeof value !== 'string')) return false
  const local = value => typeof value === 'string' && value.startsWith('~/') && !value.split('/').includes('..')
  const name = value => typeof value === 'string' && /^tidemind[-a-zA-Z0-9_@.]*$/.test(value)
  const eq = expected => JSON.stringify(a) === JSON.stringify(expected)
  if (command.commandCategory === 'host_cli') return (
    (local(a[3]) && eq(['plugin', 'marketplace', 'add', a[3], '--scope', 'user']))
    || (name(a[3]) && eq(['plugin', 'marketplace', 'remove', a[3]]))
    || (name(a[2]) && eq(['extensions', 'enable', a[2], '--scope', 'user'])))
  if (command.commandCategory === 'plugin_install') return (
    (name(a[2]) && eq(['plugin', 'install', a[2], '--scope', 'user', '--yes']))
    || (name(a[2]) && eq(['plugin', 'uninstall', a[2], '--scope', 'user']))
    || (local(a[2]) && eq(['extensions', 'install', a[2], '--consent', '--skip-settings']))
    || (name(a[2]) && eq(['extensions', 'uninstall', a[2]])))
  return false
}
export function validateNoAuthPlan(preview, home) {
  if (!preview || !/^[a-f0-9]{64}$/.test(preview.planHash) || !Array.isArray(preview.installations)) throw new Error('invalid preview')
  const files = new Set()
  for (const item of preview.installations) for (const target of item.targets ?? []) {
    const commands = target.commands ?? (target.args ? [target] : [])
    if (!['none', 'file_write'].includes(target.commandCategory) && (commands.length === 0 || commands.some(command => !reviewedNoAuthCommand(command)))) throw new Error('unreviewed no-auth host command: ' + target.commandCategory)
    if (commands.some(command => !['none', 'file_write'].includes(command.commandCategory) && !reviewedNoAuthCommand(command))) throw new Error('unreviewed frozen command')
    if ((target.action === 'invoke' && commands.length === 0) || target.scope !== 'user' || target.risk === 'high') throw new Error('preview exceeds isolated user-file scope')
    const label = target.targetLabel
    if (typeof label !== 'string' || !label.startsWith('~/')) throw new Error('preview target is not isolated HOME-relative')
    const resolved = path.resolve(home, label.slice(2))
    if (!inside(home, resolved)) throw new Error('preview path escapes HOME')
    let cursor = resolved
    while (!fs.existsSync(cursor)) { const parent = path.dirname(cursor); if (parent === cursor) throw new Error('missing path root'); cursor = parent }
    if (!inside(fs.realpathSync(home), fs.realpathSync(cursor))) throw new Error('preview symlink escapes HOME')
    files.add(resolved)
  }
  return [...files]
}
export function fileObservations(files, home) {
  if (!home) throw new Error("configuration observation requires isolated HOME")
  return files.map(file => {
    try {
      if (!inside(fs.realpathSync(home), fs.realpathSync(file))) throw new Error("configuration observation escapes HOME")
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) return { path: file, kind: stat.isDirectory() ? 'directory' : 'nonregular', mode: stat.mode & 0o777 }
      if (stat.size > 8 * 1024 * 1024) throw new Error('configuration file exceeds observation bound')
      return { path: file, kind: 'file', bytes: stat.size, mode: stat.mode & 0o777, sha256: sha(fs.readFileSync(file)) }
    } catch (error) { if (error.code === 'ENOENT') return { path: file, kind: 'absent' }; throw error }
  })
}
class Cdp {
  constructor(socket) { this.socket = socket; this.next = 0; this.pending = new Map(); socket.addEventListener('message', event => { const value = JSON.parse(String(event.data)); if (!value.id) return; const item = this.pending.get(value.id); if (!item) return; this.pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result) }); socket.addEventListener('close', () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP closed')) } this.pending.clear() }) }
  static async open(url, signal) { const socket = new WebSocket(url); await new Promise((resolve, reject) => { const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) { socket.close(); reject(error) } else resolve() }; const abort = () => finish(new Error('operator cancelled')); const timer = setTimeout(() => finish(new Error('CDP handshake timeout')), 10000); socket.addEventListener('open', () => finish(), { once: true }); socket.addEventListener('error', () => finish(new Error('CDP handshake failed')), { once: true }); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort() }); return new Cdp(socket) }
  call(method, params = {}, timeout = 30000) { const id = ++this.next; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, timeout); this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params })) }) }
  async evaluate(expression) { const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 120000); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result?.value }
  close() { this.socket.close() }
}
async function reservePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
async function renderer(port, app, child, signal) {
  for (let i = 0; i < 120; i++) {
    if (signal.aborted) throw new Error('operator cancelled')
    if (child.exitCode !== null) throw new Error('candidate exited before renderer')
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(700) })).json()
      const pages = list.filter(item => { try { const url = new URL(item.url); return item.type === 'page' && url.protocol === 'file:' && inside(app, fileURLToPath(url)) } catch { return false } })
      if (pages.length === 1) { const ws = new URL(pages[0].webSocketDebuggerUrl); if (ws.hostname !== '127.0.0.1' || ws.port !== String(port)) throw new Error('unexpected CDP endpoint'); return Cdp.open(ws.href, signal) }
    } catch { /* bounded startup polling */ }
    await delay(500)
  }
  throw new Error('no unique packaged renderer')
}
function groupAlive(pid) { try { process.kill(-pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function stop(child) {
  const methods = []
  if (!child?.pid) return methods
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!groupAlive(child.pid)) break
    try { process.kill(-child.pid, signal); methods.push(signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
    for (let i = 0; i < 40 && groupAlive(child.pid); i++) await delay(100)
  }
  if (groupAlive(child.pid)) throw new Error('candidate process group survived termination')
  return methods
}
function assertDatabaseUnused(database) {
  if (!fs.existsSync(database)) return
  const result = spawnSync('/usr/sbin/lsof', ['-t', database], { encoding: 'utf8' })
  if (result.error || ![0, 1].includes(result.status) || result.stdout.trim()) throw new Error('isolated database is still open or lsof check failed')
}
function dbObservation(workspace) {
  const database = path.join(workspace, 'home/.tidemind/graph/brain.sqlite')
  if (!fs.existsSync(database)) throw new Error('candidate did not create expected isolated database')
  if (fs.lstatSync(database).isSymbolicLink() || !inside(workspace, fs.realpathSync(database))) throw new Error('database escapes workspace')
  validateIsolatedProfilePaths(path.join(workspace, 'home'))
  assertDatabaseUnused(database)
  const sqlitePath = !fs.existsSync(database + '-wal') ? pathToFileURL(database).href + '?immutable=1' : database
  const query = sql => JSON.parse(execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', sqlitePath, sql], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) || '[]')
  const tables = new Set(query("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name))
  const projection = {}
  for (const [table, columns] of Object.entries({ agents: ['id', 'name', 'tool_type', 'archived'], agent_installations: ['id', 'host_variant', 'distribution_id', 'agent_id', 'desired_state', 'health_state', 'status_reason', 'reconcile_state'], installation_components: ['installation_id', 'component_key', 'desired_state', 'verification_status', 'artifact_id'], managed_artifacts: ['id', 'state', 'owned_fragment_hash', 'observed_fragment_hash'], reconcile_runs: ['id', 'installation_id', 'operation_type', 'state', 'failure_code', 'failure_stage'] })) {
    if (!tables.has(table)) continue
    const actual = new Set(query(`PRAGMA table_info(${table})`).map(row => row.name)), selected = columns.filter(column => actual.has(column))
    if (selected.length) projection[table] = query(`SELECT ${selected.join(',')} FROM ${table} ORDER BY 1`)
  }
  return { database, projection }
}
export async function runOperator(options) {
  options = parseOperatorArgs(Object.entries(options).flatMap(([key, value]) => ['--' + key, String(value)]))
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('operator requires macOS ARM64')
  const requestedWorkspace = path.resolve(options.workspace), actualHome = os.userInfo().homedir
  const requestedApp = path.resolve(options['candidate-app'])
  if (inside(requestedApp, requestedWorkspace) || inside(requestedApp, path.resolve(options['output-dir']))) throw new Error('operator output/profile must not be inside signed candidate App')
  if (requestedWorkspace === actualHome || inside(requestedWorkspace, actualHome)) throw new Error('workspace overlaps daily home root')
  const workspace = safeDirectory(requestedWorkspace), home = safeDirectory(path.join(workspace, 'home'))
  validateIsolatedProfilePaths(home)
  safeDirectory(path.join(workspace, 'tmp'))
  const output = path.resolve(options['output-dir'])
  if (fs.existsSync(output)) throw new Error('output directory must be new')
  safeDirectory(output)
  if (workspace === os.userInfo().homedir || inside(home, os.userInfo().homedir)) throw new Error('workspace overlaps daily home')
  const marker = path.join(workspace, '.tidemind-upgrade-profile')
  if (!fs.existsSync(marker) && [path.join(home, '.tidemind'), path.join(home, 'Library/Application Support/TideMind')].some(file => fs.existsSync(file))) throw new Error('existing profile lacks operator marker')
  if (fs.existsSync(marker) && (!fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink())) throw new Error('workspace marker must be a regular file')
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') !== 'isolated-tidemind-upgrade-v1\n') throw new Error('workspace marker mismatch')
  fs.writeFileSync(marker, 'isolated-tidemind-upgrade-v1\n', { mode: 0o600 })
  const existingDatabase = fs.existsSync(path.join(home, '.tidemind/graph/brain.sqlite'))
  if (options.mode === 'historical-upgrade-prime' && existingDatabase) throw new Error('no-auth priming requires a new empty profile')
  if (options.mode === 'historical-upgrade-baseline' && !existingDatabase) throw new Error('historical baseline requires the completed prime phase')
  if (existingDatabase) assertNoAuthSchedulerGuard(home)
  assertDatabaseUnused(path.join(home, '.tidemind/graph/brain.sqlite'))
  const lock = path.join(workspace, '.signed-host-operator.lock')
  const observations = { schemaVersion: 1, evidenceClass: 'raw_signed_host_no_auth_observations', captureNonce: options['capture-nonce'], capturePurpose: options['capture-purpose'], sourceCommit: options['source-commit'], catalogId: options['catalog-id'] ?? null, host: { platform: process.platform, architecture: process.arch }, mode: options.mode, startedAt: new Date().toISOString(), observations: [], omitted: ['login', 'real_model_calls', 'host_runtime_activation', 'full_acceptance_assertions'] }
  // Metadata-only daily configuration guard: never read daily credential/config contents.
  const dailyMetadata = () => protectedRealAgentPaths(os.userInfo().homedir).map(file => { try { const stat = fs.lstatSync(file); return { path: file, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } } catch (error) { if (error.code === 'ENOENT') return { path: file, absent: true }; throw error } })
  const dailyBefore = dailyMetadata()
  const lockFd = fs.openSync(lock, 'wx', 0o600)
  let child, cdp, cancellationStop, pendingCasRestore
  const cancellation = new AbortController()
  const onSignal = signal => {
    observations.cancelled = signal
    try { cancellation.abort(); cdp?.close() } catch (error) { observations.cleanupError = error.message }
    if (child?.pid && !cancellationStop) cancellationStop = stop(child).catch(error => { observations.cleanupError = error.message; return ['cleanup_error'] })
  }
  const sigint = () => onSignal('SIGINT'), sigterm = () => onSignal('SIGTERM')
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm)
  const record = (step, value) => { observations.observations.push({ step, at: new Date().toISOString(), value }); fs.writeFileSync(path.join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n', { mode: 0o600 }); return value }
  try {
    const app = fs.realpathSync(options['candidate-app'])
    const identity = options.mode.startsWith('historical-upgrade-') ? inspectHistoricalUpgradeApp(app, options['app-version']) : inspectPhysicalTideMindCandidateApp(app, options['app-version'], options['source-commit'], 'arm64')
    if (identity.bundleSha256 !== options['candidate-bundle-sha256']) throw new Error('physical candidate bundle differs from staged binding')
    record('physical_candidate_identity', identity)
    const executableName = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
    const port = await reservePort(), userData = safeDirectory(path.join(home, 'Library/Application Support/TideMind'))
    validateIsolatedProfilePaths(home)
    if (cancellation.signal.aborted) throw new Error('operator cancelled before launch')
    child = spawn(path.join(app, 'Contents/MacOS', executableName), [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--remote-allow-origins=http://127.0.0.1:${port}`, `--user-data-dir=${userData}`, '--no-first-run'], { cwd: workspace, detached: true, env: isolatedOperatorEnv(workspace), stdio: ['ignore', fs.openSync(path.join(output, 'app.stdout.log'), 'wx', 0o600), fs.openSync(path.join(output, 'app.stderr.log'), 'wx', 0o600)] })
    child.on('error', error => { observations.launchError = error.message })
    cdp = await renderer(port, app, child, cancellation.signal)
    for (let i = 0; i < 100; i++) { if (await cdp.evaluate('document.readyState === "complete" && !!document.querySelector("#root")?.children.length')) break; await delay(200) }
    if (!await cdp.evaluate('document.readyState === "complete" && !!document.querySelector("#root")?.children.length')) throw new Error('renderer did not finish mounting')
    record('renderer_document', await cdp.evaluate('({href:location.href,readyState:document.readyState,title:document.title})'))
    const version = await cdp.evaluate('window.api.app.getVersion()')
    record('renderer_version', version)
    if (version !== options['app-version']) throw new Error('renderer version mismatch')
    const invoke = async (method, ...args) => { if (cancellation.signal.aborted) throw new Error('operator cancelled before IPC'); const value = record(method, await cdp.evaluate(`window.api.agentIntegrations[${JSON.stringify(method)}](...${JSON.stringify(args)})`)); if (value?.success === false) throw new Error('production IPC rejected ' + method + ': ' + JSON.stringify(value)); return value }
    const captureUi = async phase => {
      const dom = await cdp.evaluate('({href:location.href,title:document.title,text:document.body.innerText.slice(0,65536),controls:Array.from(document.querySelectorAll("button,input,select,a")).slice(0,500).map(element=>({tag:element.tagName,text:element.tagName==="INPUT"?null:element.innerText,type:element.getAttribute("type"),ariaLabel:element.getAttribute("aria-label"),disabled:!!element.disabled}))})')
      record('renderer_dom_' + phase, { ...dom, interactionClass: 'DOM observation; business operations use actual preload IPC, not button clicks' })
      const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' })
      const bytes = Buffer.from(screenshot.data, 'base64'), filename = 'renderer-' + phase + '.png'
      fs.writeFileSync(path.join(output, filename), bytes, { mode: 0o600, flag: 'wx' })
      record('renderer_screenshot_' + phase, { file: filename, sha256: sha(bytes), bytes: bytes.length })
    }
    await captureUi('initial')
    if (!existingDatabase && ['historical-upgrade-prime', 'lifecycle'].includes(options.mode)) {
        const patch = { cloud: { enabled: false, sync_enabled: false, metabolism_enabled: true } }
        const updated = record('no_auth_scheduler_settings_update', await cdp.evaluate('window.api.config.update(' + JSON.stringify(patch) + ')'))
        if (updated?.success !== true) throw new Error('production no-auth scheduler settings update failed')
        const flags = record('no_auth_scheduler_settings_readback', await cdp.evaluate('(async()=>{const config=await window.api.config.get();return {enabled:config.cloud?.enabled,sync_enabled:config.cloud?.sync_enabled,metabolism_enabled:config.cloud?.metabolism_enabled}})()'))
        if (flags.enabled !== false || flags.sync_enabled !== false || flags.metabolism_enabled !== true) throw new Error('no-auth scheduler settings readback failed')
        assertNoAuthSchedulerGuard(home)
      }
    const available = await cdp.evaluate('typeof window.api.agentIntegrations?.snapshot === "function"')
    if (options.mode !== 'lifecycle') {
      if (available) await invoke('snapshot')
      else record('legacy_api_presence', await cdp.evaluate('({agentsList:typeof window.api.agents?.list,agentsStats:typeof window.api.agents?.stats})'))
      if (options.mode === 'upgrade-observe') {
        if (!available) throw new Error('candidate lacks automatic upgrade observation API')
        const scan = await invoke('scan')
        for (const installation of scan.snapshot.installations.filter(item => item.hostVariant === options['catalog-id'])) await invoke('detail', installation.id, true)
        record('upgrade_agents', await cdp.evaluate('window.api.agents.list(true)'))
        record('upgrade_agent_stats', await cdp.evaluate('window.api.agents.stats()'))
        record('upgrade_usage', await cdp.evaluate('window.api.stats.usage()'))
        record('upgrade_token_usage', await cdp.evaluate('window.api.stats.tokenUsage()'))
        await captureUi('upgrade-observe')
      }
      if (options.mode === 'historical-upgrade-baseline') {
        const catalog = options['catalog-id'], recipe = historicalDesktopRecipe(options['app-version'], catalog)
        record('historical_recipe', { catalogId: catalog, appVersion: options['app-version'], recipe, acceptanceStatus: 'not_evaluated' })
        if (recipe === 'cowork-guided' || recipe === 'unsupported-cowork') {
          if (recipe === 'unsupported-cowork') {
            // Verified official .89/.91 ASAR: old `cowork` is Desktop Legacy, not this target.
            record('unsupported_historical_capability', { catalogId: catalog, appVersion: options['app-version'], supported: false, reason: 'official historical App has no real Cowork guided setup adapter/API; no Agent or installation fabricated', evidence: 'docs/Codex-guides/historical-desktop-baseline-api-evidence.md' })
          } else {
            const preflight = await invoke('previewClaudeCoworkSetup')
            const prepared = await invoke('prepareClaudeCoworkSetup', preflight.preflightHash)
            const id = prepared.installationId
            if (typeof id !== 'string') throw new Error('historical Cowork preparation did not return real installation')
            const preview = await invoke('previewConnect', [id], true), files = validateNoAuthPlan(preview, home)
            record('historical_cowork_config_before', fileObservations(files, home))
            let task = await invoke('startApplyConnect', preview.planHash, [id])
            for (let i = 0; task.state === 'running' && i < 120; i++) { await delay(500); task = await invoke('getApplyTask', task.id) }
            if (task.state !== 'completed' || !Array.isArray(task.results) || task.results.length !== 1 || task.results[0].installationId !== id || !['committed','awaiting_verification'].includes(task.results[0].status)) throw new Error('historical Cowork setup did not complete local configuration')
            const detail = record('historical_cowork_active_checkpoint', await invoke('detail', id, true))
            if (typeof detail.technical?.agentId !== 'string' || detail.installation?.desiredState !== 'managed') throw new Error('historical Cowork baseline has no real managed Agent identity')
            record('historical_baseline_identity', { catalogId: catalog, agentId: detail.technical.agentId, installationId: id, configurationPaths: files, supported: true })
            record('historical_cowork_config_after', fileObservations(files, home))
          }
        } else {
          const codex = recipe === 'codex-legacy', toolType = codex ? 'codex' : 'cowork'
          // These aliases and generatePlugin handlers were read from each official old ASAR.
          const configPath = codex ? path.join(home, '.codex/config.toml') : path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json')
          safeDirectory(path.dirname(configPath)); validateIsolatedProfilePaths(home)
          if (fs.existsSync(configPath) || (codex && fs.existsSync(path.join(home, '.codex/hooks.json')))) throw new Error('historical baseline requires new isolated host configuration')
          const name = 'TideMind upgrade corpus ' + options['app-version'] + ' ' + catalog
          const before = record('historical_agents_before_baseline', await cdp.evaluate('window.api.agents.list(true)'))
          if (!Array.isArray(before) || before.some(agent => agent.name === name)) throw new Error('historical baseline Agent already exists or list failed')
          if (cancellation.signal.aborted) throw new Error('operator cancelled before historical baseline')
          const agent = record('historical_agent_created', await cdp.evaluate('window.api.agents.create(' + JSON.stringify({ name, tool_type: toolType }) + ')'))
          if (!agent || typeof agent.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(agent.id) || agent.name !== name || agent.tool_type !== toolType) throw new Error('historical production Agent creation failed')
          if (codex) {
            if (cancellation.signal.aborted) throw new Error('operator cancelled before historical plugin generation')
            const generated = record('historical_codex_generated', await cdp.evaluate('window.api.agents.generatePlugin(' + JSON.stringify({ agentId: agent.id, agentName: name, clientType: 'codex' }) + ')'))
            if (generated?.success !== true) throw new Error('historical Codex production configuration generation failed')
            const status = record('historical_codex_plugin_status', await cdp.evaluate('window.api.agents.pluginStatus(' + JSON.stringify(agent.id) + ',"codex")'))
            if (!status?.exists || !status.codexConfigWritten || !status.hooksConfigured) throw new Error('historical Codex configuration readback failed')
            const files = [configPath, path.join(home, '.codex/hooks.json'), generated.pluginDir]
            record('historical_codex_files', fileObservations(files, home))
            record('historical_baseline_identity', { catalogId: catalog, agentId: agent.id, installationId: null, configurationPaths: files, supported: true })
          } else {
            const snippet = record('historical_mcp_snippet', await cdp.evaluate('window.api.agents.mcpSnippet(' + JSON.stringify(agent.id) + ')'))
            validateLegacySnippet(snippet, agent.id, home, app)
            if (cancellation.signal.aborted) throw new Error('operator cancelled before historical config write')
            validateIsolatedProfilePaths(home)
            const bytes = JSON.stringify(snippet, null, 2) + '\n', fd = fs.openSync(configPath, 'wx', 0o600)
            try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
            record('historical_legacy_config_created', { agentId: agent.id, writeMode: 'new-only', files: fileObservations([configPath], home), source: 'actual historical agents.mcpSnippet IPC' })
            record('historical_baseline_identity', { catalogId: catalog, agentId: agent.id, installationId: null, configurationPaths: [configPath], supported: true })
          }
        }
        await captureUi('historical-baseline')
      }
      if (options.mode.startsWith('historical-upgrade-')) {
        for (const [key, expression] of [['historical_agents', 'window.api.agents.list(true)'], ['historical_agent_stats', 'window.api.agents.stats()'], ['historical_usage', 'window.api.stats.usage()'], ['historical_token_usage', 'window.api.stats.tokenUsage()']]) { const value = record(key, await cdp.evaluate(expression)); if (value?.success === false) throw new Error('historical read-only IPC rejected: ' + key) }
      }
    } else {
      if (!available) throw new Error('candidate lacks production integration API')
      let scanned = await invoke('scan'), snapshot = scanned.snapshot
      if (options['catalog-id'] === 'claude-cowork-local' && !snapshot.installations?.some(item => item.hostVariant === 'claude-cowork-local')) {
        const preflight = await invoke('previewClaudeCoworkSetup')
        await invoke('prepareClaudeCoworkSetup', preflight.preflightHash)
        snapshot = await invoke('snapshot')
      }
      if (snapshot.fixtureMode || snapshot.releasePolicy?.mode !== 'active') throw new Error('fixture or inactive release policy')
      let candidates = snapshot.installations.filter(item => item.hostVariant === options['catalog-id'])
      if (options['distribution-id']) { const filtered = []; for (const item of candidates) { const detail = await invoke('detail', item.id, true); if (detail.technical?.distributionId === options['distribution-id']) filtered.push(item) } candidates = filtered }
      if (candidates.length !== 1) throw new Error('expected exactly one discovered target, observed ' + candidates.length)
      const selected = candidates[0], id = selected.id
      if (['rejected','pending','confirmation_required'].includes(selected.sourceVerification?.state)) throw new Error('source verification blocks observation completion')
      if (options['catalog-id'] === 'claude-desktop-legacy') {
        record('legacy_static_only', { reason: 'Legacy uses migration semantics; ordinary connect/pause/disconnect intentionally not executed', detail: await invoke('detail', id, true) })
        record('owned_cas_action_scope', { applicable: false, reason: 'Legacy has no disconnect operation; its historical configuration preservation is observed by the migration chain' })
        await captureUi('legacy-static')
      } else {
      if (!selected.manageable || !['trusted', 'user_managed'].includes(selected.sourceVerification?.state)) throw new Error('source verification or manageability blocks connection')
      const connect = async () => {
        const plan = await invoke('previewConnect', [id], true), files = validateNoAuthPlan(plan, home)
        record('configuration_before_connect', fileObservations(files, home))
        let task = await invoke('startApplyConnect', plan.planHash, [id])
        for (let i = 0; task.state === 'running' && i < 120; i++) { await delay(500); task = await invoke('getApplyTask', task.id) }
        if (task.state !== 'completed' || !Array.isArray(task.results) || task.results.length !== 1 || task.results[0].installationId !== id || task.results.some(result => !['committed', 'awaiting_verification'].includes(result.status))) throw new Error('connection incomplete or failed; inspect raw task')
        record('configuration_after_connect', fileObservations(files, home))
        const detail = await invoke('detail', id, true)
        if (detail.installation.desiredState !== 'managed') throw new Error('connection did not retain managed intent')
      }
      await connect()
      const paused = await invoke('pause', id); await invoke('detail', id, true)
      if (paused.desiredState !== 'disabled') throw new Error('pause intent did not persist')
      const resumed = await invoke('resume', id); await invoke('detail', id, true)
      if (resumed.desiredState !== 'managed') throw new Error('resume intent did not persist')
      const casDetail = await invoke('detail', id, true), casPreview = await invoke('previewDisconnect', id, true)
      validateNoAuthPlan(casPreview, home)
      await observeOwnedCas({ catalogId: options['catalog-id'], home, detail: casDetail, preview: casPreview, nonce: options['capture-nonce'], output, submit: (hash, installationId) => invoke('disconnect', hash, installationId), record, signal: cancellation.signal, deferRestore: restore => { pendingCasRestore = restore } })
      await invoke('scan')
      const removal = await invoke('previewDisconnect', id, true), removalFiles = validateNoAuthPlan(removal, home)
      const removed = await invoke('disconnect', removal.planHash, id)
      record('configuration_after_disconnect', fileObservations(removalFiles, home))
      record('disconnect_detail', await invoke('detail', id, true))
      if (!Array.isArray(removed?.results) || removed.results.length !== 1 || removed.results.some(result => !['committed', 'awaiting_verification'].includes(result.status))) throw new Error('disconnect failed or requires manual action')
      await connect()
      record('active_checkpoint', await invoke('detail', id, true))
      await captureUi('active-checkpoint')
      }
    }
  } catch (error) { observations.error = { message: error.message }; throw error }
  finally {
    try { cdp?.close() } catch (error) { observations.cleanupError = error.message }
    try { record('process_termination', await (cancellationStop ?? stop(child))); if (child?.pid && groupAlive(child.pid)) throw new Error('candidate process group still alive before readback/restoration'); if (pendingCasRestore) { pendingCasRestore(); pendingCasRestore = undefined } if (child?.pid) record('database_after_process_exit', dbObservation(workspace)) } catch (error) { observations.cleanupError = error.message }
    try { const dailyAfter = dailyMetadata(); record('daily_configuration_metadata_guard', { comparison: JSON.stringify(dailyBefore) === JSON.stringify(dailyAfter) ? 'unchanged' : 'changed', limitations: 'top-level metadata only; no daily file contents read; not a content-integrity acceptance assertion' }); if (JSON.stringify(dailyBefore) !== JSON.stringify(dailyAfter)) observations.cleanupError = 'daily configuration metadata changed' } catch (error) { observations.cleanupError = error.message }
    try { const fresh = options.mode.startsWith('historical-upgrade-') ? inspectHistoricalUpgradeApp(options['candidate-app'], options['app-version']) : inspectPhysicalTideMindCandidateApp(options['candidate-app'], options['app-version'], options['source-commit'], 'arm64'); if (fresh.bundleSha256 !== options['candidate-bundle-sha256']) throw new Error('candidate changed during observation'); record('physical_candidate_identity_after', fresh) } catch (error) { observations.cleanupError = error.message }
    observations.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n', { mode: 0o600 })
    fs.closeSync(lockFd); fs.unlinkSync(lock)
    process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm)
  }
  if (cancellation.signal.aborted) throw new Error('operator cancelled: ' + observations.cancelled)
  if (observations.cleanupError) throw new Error(observations.cleanupError)
  return { outputDirectory: output, rawObservations: path.join(output, 'observations.json'), captureNonce: observations.captureNonce, acceptanceStatus: 'not_evaluated' }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runOperator(parseOperatorArgs(process.argv.slice(2))))) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
