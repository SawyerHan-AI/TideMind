import path from 'node:path'
import { clipboard, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import type { AgentIntegrationService } from '../agent-integration/service.js'
import type {
  AgentIntegrationComponentKey,
  AgentIntegrationCustomRequestDto,
} from '../../src/lib/api-contract.js'
import type { IpcValidationError, ValidationResult } from './_schemas.js'
import { getAppLanguage, type AppLanguage } from '../app-language.js'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const PLAN_HASH_RE = /^[a-f0-9]{64}$/u

type CustomPathKind = 'config_root' | 'config_file' | 'client_executable'

const CUSTOM_PATH_DIALOG_COPY: Record<AppLanguage, {
  configRootTitle: string
  configFileTitle: string
  executableTitle: string
  jsonFilterName: string
}> = {
  en: {
    configRootTitle: 'Select the local Agent configuration folder',
    configFileTitle: 'Select the local Agent JSON configuration file',
    executableTitle: 'Select the local Agent executable',
    jsonFilterName: 'JSON / JSONC configuration',
  },
  'zh-CN': {
    configRootTitle: '选择本机 Agent 配置文件夹',
    configFileTitle: '选择本机 Agent JSON 配置文件',
    executableTitle: '选择本机 Agent 可执行文件',
    jsonFilterName: 'JSON / JSONC 配置',
  },
  'zh-TW': {
    configRootTitle: '選擇本機 Agent 設定資料夾',
    configFileTitle: '選擇本機 Agent JSON 設定檔',
    executableTitle: '選擇本機 Agent 執行檔',
    jsonFilterName: 'JSON / JSONC 設定',
  },
  ja: {
    configRootTitle: 'ローカル Agent の設定フォルダを選択',
    configFileTitle: 'ローカル Agent の JSON 設定ファイルを選択',
    executableTitle: 'ローカル Agent の実行ファイルを選択',
    jsonFilterName: 'JSON / JSONC 設定',
  },
  ko: {
    configRootTitle: '로컬 Agent 구성 폴더 선택',
    configFileTitle: '로컬 Agent JSON 구성 파일 선택',
    executableTitle: '로컬 Agent 실행 파일 선택',
    jsonFilterName: 'JSON / JSONC 구성',
  },
  fr: {
    configRootTitle: 'Sélectionner le dossier de configuration de l’Agent local',
    configFileTitle: 'Sélectionner le fichier de configuration JSON de l’Agent local',
    executableTitle: 'Sélectionner l’exécutable de l’Agent local',
    jsonFilterName: 'Configuration JSON / JSONC',
  },
  es: {
    configRootTitle: 'Seleccionar la carpeta de configuración del Agent local',
    configFileTitle: 'Seleccionar el archivo de configuración JSON del Agent local',
    executableTitle: 'Seleccionar el ejecutable del Agent local',
    jsonFilterName: 'Configuración JSON / JSONC',
  },
  de: {
    configRootTitle: 'Konfigurationsordner des lokalen Agents auswählen',
    configFileTitle: 'JSON-Konfigurationsdatei des lokalen Agents auswählen',
    executableTitle: 'Ausführbare Datei des lokalen Agents auswählen',
    jsonFilterName: 'JSON-/JSONC-Konfiguration',
  },
  'pt-BR': {
    configRootTitle: 'Selecionar a pasta de configuração do Agent local',
    configFileTitle: 'Selecionar o arquivo de configuração JSON do Agent local',
    executableTitle: 'Selecionar o executável do Agent local',
    jsonFilterName: 'Configuração JSON / JSONC',
  },
  ru: {
    configRootTitle: 'Выберите папку конфигурации локального Agent',
    configFileTitle: 'Выберите файл конфигурации JSON локального Agent',
    executableTitle: 'Выберите исполняемый файл локального Agent',
    jsonFilterName: 'Конфигурация JSON / JSONC',
  },
  it: {
    configRootTitle: 'Seleziona la cartella di configurazione dell’Agent locale',
    configFileTitle: 'Seleziona il file di configurazione JSON dell’Agent locale',
    executableTitle: 'Seleziona l’eseguibile dell’Agent locale',
    jsonFilterName: 'Configurazione JSON / JSONC',
  },
  tr: {
    configRootTitle: 'Yerel Agent yapılandırma klasörünü seçin',
    configFileTitle: 'Yerel Agent JSON yapılandırma dosyasını seçin',
    executableTitle: 'Yerel Agent yürütülebilir dosyasını seçin',
    jsonFilterName: 'JSON / JSONC yapılandırması',
  },
}

export function customPathDialogOptions(kind: CustomPathKind): OpenDialogOptions {
  const copy = CUSTOM_PATH_DIALOG_COPY[getAppLanguage()]
  return {
    title: kind === 'config_root'
      ? copy.configRootTitle
      : kind === 'config_file'
        ? copy.configFileTitle
        : copy.executableTitle,
    properties: kind === 'config_root' ? ['openDirectory'] : ['openFile'],
    ...(kind === 'config_file'
      ? { filters: [{ name: copy.jsonFilterName, extensions: ['json', 'jsonc'] }] }
      : {}),
  }
}

type AgentIntegrationServicePort = Pick<AgentIntegrationService,
  | 'snapshot'
  | 'scan'
  | 'previewConnect'
  | 'applyConnect'
  | 'startApplyConnect'
  | 'getApplyTask'
  | 'listApplyTasks'
  | 'onApplyTaskProgress'
  | 'inbox'
  | 'pause'
  | 'resume'
  | 'previewResetAutoRestore'
  | 'resetAutoRestore'
  | 'previewDisconnect'
  | 'disconnect'
  | 'detail'
  | 'listEvents'
  | 'markEventRead'
  | 'markInstallationEventsRead'
  | 'componentTargetPath'
  | 'supportCatalog'
  | 'previewClaudeCoworkSetup'
  | 'prepareClaudeCoworkSetup'
  | 'previewCustomInstallation'
  | 'prepareCustomConnect'
  | 'customMcpConfiguration'
  | 'reviewCodexHookTrust'
  | 'confirmCodexHookTrust'
  | 'reviewGuidedRemoval'
  | 'confirmGuidedRemoval'
>

interface InvokeEventLike {
  senderFrame?: { url?: string } | null
  sender?: {
    isDestroyed?(): boolean
    send(channel: string, ...args: unknown[]): void
  } | null
}

function trustedRendererUrl(rawUrl: string | undefined, expectedUrl: string | undefined): boolean {
  if (!rawUrl || !expectedUrl) return false
  try {
    const actual = new URL(rawUrl)
    const expected = new URL(expectedUrl)
    if (expected.protocol === 'http:' || expected.protocol === 'https:') {
      return actual.origin === expected.origin
    }
    // HashRouter changes only the document fragment. Trust the exact packaged
    // renderer document (including any query), while allowing its in-document
    // route to vary. Path suffix matches are deliberately not accepted.
    return actual.protocol === 'file:'
      && expected.protocol === 'file:'
      && actual.host === expected.host
      && actual.pathname === expected.pathname
      && actual.search === expected.search
  } catch {
    return false
  }
}

function requireTrustedRenderer<T>(
  event: InvokeEventLike,
  expectedRendererUrl: string | undefined,
  action: () => T,
): T | IpcValidationError {
  return trustedRendererUrl(event.senderFrame?.url, expectedRendererUrl)
    ? action()
    : {
        success: false,
        error: 'invalid_arguments',
        details: ['request did not originate from the Tide Mind renderer'],
      }
}

export function registerAgentIntegrationHandlers(
  service: AgentIntegrationServicePort,
  options: {
    expectedRendererUrl?: string
    pickCustomPath?: (kind: 'config_root' | 'config_file' | 'client_executable') => Promise<string | null>
  } = {},
): void {
  const taskSubscribers = new Map<string, NonNullable<InvokeEventLike['sender']>>()
  service.onApplyTaskProgress(task => {
    const sender = taskSubscribers.get(task.id)
    if (!sender || sender.isDestroyed?.()) {
      taskSubscribers.delete(task.id)
      return
    }
    sender.send('agent-integration:task-progress', task)
    if (task.state === 'completed') taskSubscribers.delete(task.id)
  })
  const trusted = <T>(event: InvokeEventLike, action: () => T) => (
    requireTrustedRenderer(event, options.expectedRendererUrl, action)
  )
  ipcMain.handle('agent-integrations:snapshot', event => trusted(event, () => service.snapshot()))
  ipcMain.handle('agent-integrations:scan', event => trusted(event, () => service.scan()))
  ipcMain.handle('agent-integrations:preview-connect', (
    event,
    ids: unknown,
    technical?: unknown,
    frozenPlanHash?: unknown,
    options?: unknown,
  ) => trusted(event, () => {
    const parsedIds = parseInstallationIds(ids)
    if (!parsedIds.ok) return parsedIds.error
    const parsedTechnical = parseOptionalTechnical(technical)
    if (!parsedTechnical.ok) return parsedTechnical.error
    const parsedFrozenPlanHash = parseOptionalPlanHash(frozenPlanHash)
    if (!parsedFrozenPlanHash.ok) return parsedFrozenPlanHash.error
    if (parsedFrozenPlanHash.data && !parsedTechnical.data) {
      return invalid('frozenPlanHash requires technical details')
    }
    const parsedOptions = parseConnectOptions(options)
    if (!parsedOptions.ok) return parsedOptions.error
    return service.previewConnect(
      parsedIds.data,
      parsedTechnical.data,
      parsedFrozenPlanHash.data,
      parsedOptions.data,
    )
  }))
  ipcMain.handle('agent-integrations:apply-connect', (event, hash: unknown, ids: unknown) => trusted(event, () => {
    const parsedHash = parsePlanHash(hash)
    if (!parsedHash.ok) return parsedHash.error
    const parsedIds = parseInstallationIds(ids)
    if (!parsedIds.ok) return parsedIds.error
    return service.applyConnect(parsedHash.data, parsedIds.data)
  }))
  ipcMain.handle('agent-integrations:start-apply-connect', (event, hash: unknown, ids: unknown) => trusted(event, () => {
    const parsedHash = parsePlanHash(hash)
    if (!parsedHash.ok) return parsedHash.error
    const parsedIds = parseInstallationIds(ids)
    if (!parsedIds.ok) return parsedIds.error
    if (!event.sender || event.sender.isDestroyed?.()) return invalid('renderer sender is unavailable')
    const task = service.startApplyConnect(parsedHash.data, parsedIds.data)
    taskSubscribers.set(task.id, event.sender)
    return task
  }))
  ipcMain.handle('agent-integrations:get-apply-task', (event, id: unknown) => trusted(event, () => {
    const parsedId = parseId(id, 'taskId')
    if (!parsedId.ok) return parsedId.error
    const task = service.getApplyTask(parsedId.data)
    if (task.state === 'running' && event.sender && !event.sender.isDestroyed?.()) {
      taskSubscribers.set(task.id, event.sender)
    }
    return task
  }))
  ipcMain.handle('agent-integrations:list-apply-tasks', (event, request?: unknown) => trusted(event, () => {
    const parsedRequest = parseApplyTaskPageRequest(request)
    if (!parsedRequest.ok) return parsedRequest.error
    const page = service.listApplyTasks(parsedRequest.data)
    if (event.sender && !event.sender.isDestroyed?.()) {
      for (const task of page.tasks) {
        if (task.state === 'running') taskSubscribers.set(task.id, event.sender)
      }
    }
    return page
  }))
  ipcMain.handle('agent-integrations:inbox', (event, limit?: unknown) => trusted(event, () => {
    const parsedLimit = parseEventLimit(limit)
    if (!parsedLimit.ok) return parsedLimit.error
    return service.inbox(parsedLimit.data)
  }))
  ipcMain.handle('agent-integrations:pause', (event, id: unknown) => trusted(event, () => delegateId(id, value => service.pause(value))))
  ipcMain.handle('agent-integrations:resume', (event, id: unknown) => trusted(event, () => delegateId(id, value => service.resume(value))))
  ipcMain.handle('agent-integrations:preview-reset-auto-restore', (event, id: unknown) => trusted(event, () => (
    delegateId(id, value => service.previewResetAutoRestore(value))
  )))
  ipcMain.handle('agent-integrations:reset-auto-restore', (
    event,
    hash: unknown,
    id: unknown,
  ) => trusted(event, () => {
    const parsedHash = parsePlanHash(hash)
    if (!parsedHash.ok) return parsedHash.error
    const parsedId = parseInstallationId(id)
    if (!parsedId.ok) return parsedId.error
    return service.resetAutoRestore(parsedHash.data, parsedId.data)
  }))
  ipcMain.handle('agent-integrations:preview-disconnect', (event, id: unknown, technical?: unknown) => trusted(event, () => {
    const parsedId = parseInstallationId(id)
    if (!parsedId.ok) return parsedId.error
    const parsedTechnical = parseOptionalTechnical(technical)
    if (!parsedTechnical.ok) return parsedTechnical.error
    return service.previewDisconnect(parsedId.data, parsedTechnical.data)
  }))
  ipcMain.handle('agent-integrations:disconnect', (event, hash: unknown, id: unknown) => trusted(event, () => {
    const parsedHash = parsePlanHash(hash)
    if (!parsedHash.ok) return parsedHash.error
    const parsedId = parseInstallationId(id)
    if (!parsedId.ok) return parsedId.error
    return service.disconnect(parsedHash.data, parsedId.data)
  }))
  ipcMain.handle('agent-integrations:detail', (event, id: unknown, technical?: unknown) => trusted(event, () => {
    const parsedId = parseInstallationId(id)
    if (!parsedId.ok) return parsedId.error
    const parsedTechnical = parseOptionalTechnical(technical)
    if (!parsedTechnical.ok) return parsedTechnical.error
    return service.detail(parsedId.data, parsedTechnical.data)
  }))
  ipcMain.handle('agent-integrations:list-events', (
    event,
    id: unknown,
    state?: unknown,
    limit?: unknown,
  ) => trusted(event, () => {
    const parsedId = parseInstallationId(id)
    if (!parsedId.ok) return parsedId.error
    const parsedState = parseEventState(state)
    if (!parsedState.ok) return parsedState.error
    const parsedLimit = parseEventLimit(limit)
    if (!parsedLimit.ok) return parsedLimit.error
    return service.listEvents(parsedId.data, parsedState.data, parsedLimit.data)
  }))
  ipcMain.handle('agent-integrations:mark-event-read', (event, id: unknown) => trusted(event, () => {
    const parsedId = parseEventId(id)
    if (!parsedId.ok) return parsedId.error
    return service.markEventRead(parsedId.data)
  }))
  ipcMain.handle('agent-integrations:mark-installation-events-read', (event, id: unknown) => trusted(event, () => (
    delegateId(id, value => service.markInstallationEventsRead(value))
  )))
  ipcMain.handle('agent-integrations:copy-component-path', (
    event,
    id: unknown,
    componentKey: unknown,
  ) => trusted(event, () => withComponentTarget(service, id, componentKey, targetPath => {
    clipboard.writeText(targetPath)
    return true
  })))
  ipcMain.handle('agent-integrations:reveal-component-path', (
    event,
    id: unknown,
    componentKey: unknown,
  ) => trusted(event, () => withComponentTarget(service, id, componentKey, targetPath => {
    shell.showItemInFolder(targetPath)
    return true
  })))
  ipcMain.handle('agent-integrations:support-catalog', event => trusted(event, () => service.supportCatalog()))
  ipcMain.handle('agent-integrations:preview-claude-cowork-setup', event => trusted(event, () => (
    service.previewClaudeCoworkSetup()
  )))
  ipcMain.handle('agent-integrations:prepare-claude-cowork-setup', (event, preflightHash: unknown) => trusted(event, () => {
    const parsedHash = parsePlanHash(preflightHash)
    return parsedHash.ok ? service.prepareClaudeCoworkSetup(parsedHash.data) : parsedHash.error
  }))
  ipcMain.handle('agent-integrations:pick-custom-path', (event, kind: unknown) => trusted(event, async () => {
    const parsedKind = parseCustomPathKind(kind)
    if (!parsedKind.ok) return parsedKind.error
    if (options.pickCustomPath) return options.pickCustomPath(parsedKind.data)
    const result = await dialog.showOpenDialog(customPathDialogOptions(parsedKind.data))
    return result.canceled ? null : result.filePaths[0] ?? null
  }))
  ipcMain.handle('agent-integrations:preview-custom-installation', (event, request: unknown) => trusted(event, () => {
    const parsed = parseCustomRequest(request)
    return parsed.ok ? service.previewCustomInstallation(parsed.data) : parsed.error
  }))
  ipcMain.handle('agent-integrations:prepare-custom-connect', (
    event,
    preflightHash: unknown,
    technical?: unknown,
  ) => trusted(event, () => {
    const parsedHash = parsePlanHash(preflightHash)
    if (!parsedHash.ok) return parsedHash.error
    const parsedTechnical = parseOptionalTechnical(technical)
    if (!parsedTechnical.ok) return parsedTechnical.error
    return service.prepareCustomConnect(parsedHash.data, parsedTechnical.data)
  }))
  ipcMain.handle('agent-integrations:copy-custom-mcp-configuration', (
    event,
    preflightHash: unknown,
  ) => trusted(event, () => {
    const parsedHash = parsePlanHash(preflightHash)
    if (!parsedHash.ok) return parsedHash.error
    clipboard.writeText(service.customMcpConfiguration(parsedHash.data))
    return true
  }))
  ipcMain.handle('agent-integrations:review-codex-hook-trust', (event, id: unknown) => trusted(event, () => (
    delegateId(id, value => service.reviewCodexHookTrust(value))
  )))
  ipcMain.handle('agent-integrations:confirm-codex-hook-trust', (event, actionHash: unknown) => trusted(event, () => {
    const parsedHash = parsePlanHash(actionHash)
    if (!parsedHash.ok) return parsedHash.error
    return service.confirmCodexHookTrust(parsedHash.data)
  }))
  ipcMain.handle('agent-integrations:review-guided-removal', (event, id: unknown) => trusted(event, () => (
    delegateId(id, value => service.reviewGuidedRemoval(value))
  )))
  ipcMain.handle('agent-integrations:confirm-guided-removal', (event, actionHash: unknown) => trusted(event, () => {
    const parsedHash = parsePlanHash(actionHash)
    if (!parsedHash.ok) return parsedHash.error
    return service.confirmGuidedRemoval(parsedHash.data)
  }))
}

export function parseCustomPathKind(
  value: unknown,
): ValidationResult<'config_root' | 'config_file' | 'client_executable'> {
  return value === 'config_root' || value === 'config_file' || value === 'client_executable'
    ? valid(value)
    : invalid('custom path kind is invalid')
}

export function parseCustomRequest(value: unknown): ValidationResult<AgentIntegrationCustomRequestDto> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('custom Agent request must be an object')
  }
  const raw = value as Record<string, unknown>
  const displayName = parseCustomDisplayName(raw.displayName)
  if (!displayName.ok) return displayName
  if (raw.mode === 'nonstandard_config_root') {
    if (!hasExactKeys(raw, ['mode', 'displayName', 'sourceInstallationId', 'configRoot'])) {
      return invalid('nonstandard config root request contains unsupported fields')
    }
    const source = parseInstallationId(raw.sourceInstallationId)
    if (!source.ok) return source
    const root = parseAbsoluteLocalPath(raw.configRoot, 'configRoot')
    if (!root.ok) return root
    return valid({
      mode: raw.mode,
      displayName: displayName.data,
      sourceInstallationId: source.data,
      configRoot: root.data,
    })
  }
  if (raw.mode === 'manual_mcp_client') {
    const expectedKeys = [
      'mode', 'displayName', 'clientExecutablePath', 'configFilePath', 'schemaKind', 'selectorKey',
    ]
    const expectedWithLegacy = [...expectedKeys, 'legacyInstallationId']
    if (!hasExactKeys(raw, expectedKeys) && !hasExactKeys(raw, expectedWithLegacy)
      && !hasExactKeys(raw, [...expectedKeys, 'configurationOwnership'])
      && !hasExactKeys(raw, [...expectedWithLegacy, 'configurationOwnership'])) {
      return invalid('manual MCP client request contains unsupported fields')
    }
    const executable = parseAbsoluteLocalPath(raw.clientExecutablePath, 'clientExecutablePath')
    if (!executable.ok) return executable
    if (raw.configurationOwnership !== undefined && raw.configurationOwnership !== 'user'
      && raw.configurationOwnership !== 'tidemind') return invalid('invalid configuration ownership')
    const configFile = raw.configurationOwnership === 'user'
      ? valid('') : parseAbsoluteLocalPath(raw.configFilePath, 'configFilePath')
    if (!configFile.ok) return configFile
    if (raw.schemaKind !== 'standard_mcp_servers'
      && raw.schemaKind !== 'nested_mcp_servers'
      && raw.schemaKind !== 'opencode_mcp') return invalid('custom MCP schema is invalid')
    if (typeof raw.selectorKey !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(raw.selectorKey)
      || raw.selectorKey === '__proto__'
      || raw.selectorKey === 'prototype'
      || raw.selectorKey === 'constructor') {
      return invalid('selectorKey must contain only letters, numbers, underscore, or hyphen')
    }
    const legacyInstallation = raw.legacyInstallationId === undefined
      ? valid<string | undefined>(undefined)
      : parseInstallationId(raw.legacyInstallationId)
    if (!legacyInstallation.ok) return legacyInstallation
    return valid({
      mode: raw.mode,
      displayName: displayName.data,
      ...(legacyInstallation.data ? { legacyInstallationId: legacyInstallation.data } : {}),
      clientExecutablePath: executable.data,
      ...(raw.configurationOwnership === 'user' ? { configurationOwnership: 'user' as const } : {}),
      configFilePath: configFile.data,
      schemaKind: raw.schemaKind,
      selectorKey: raw.selectorKey,
    })
  }
  return invalid('custom Agent mode is invalid')
}

function parseCustomDisplayName(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') return invalid('displayName must be a string')
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (normalized.length < 1 || normalized.length > 80 || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    return invalid('displayName must contain 1 to 80 visible characters')
  }
  return valid(normalized)
}

function parseAbsoluteLocalPath(value: unknown, field: string): ValidationResult<string> {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096
    || value.includes('\0') || !path.isAbsolute(value)) return invalid(`${field} must be an absolute local path`)
  return valid(path.normalize(value))
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return JSON.stringify(actual) === JSON.stringify([...expected].sort())
}

export function parseInstallationId(value: unknown): ValidationResult<string> {
  return parseId(value, 'installationId')
}

export function parseEventId(value: unknown): ValidationResult<string> {
  return parseId(value, 'eventId')
}

export function parseInstallationIds(value: unknown): ValidationResult<string[]> {
  if (!Array.isArray(value)) return invalid('installationIds must be an array')
  if (value.length < 1 || value.length > 100) return invalid('installationIds must contain 1 to 100 items')
  const parsed: string[] = []
  for (const item of value) {
    const id = parseInstallationId(item)
    if (!id.ok) return id
    parsed.push(id.data)
  }
  if (new Set(parsed).size !== parsed.length) return invalid('installationIds must not contain duplicates')
  return valid([...parsed].sort())
}

export function parsePlanHash(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string' || !PLAN_HASH_RE.test(value)) return invalid('planHash is invalid')
  return valid(value)
}

function parseOptionalPlanHash(value: unknown): ValidationResult<string | undefined> {
  if (value === undefined) return valid(undefined)
  return parsePlanHash(value)
}

export function parseEventState(
  value: unknown,
): ValidationResult<'unread' | 'read' | 'archived' | undefined> {
  if (value === undefined) return valid(undefined)
  if (value !== 'unread' && value !== 'read' && value !== 'archived') return invalid('event state is invalid')
  return valid(value)
}

export function parseEventLimit(value: unknown): ValidationResult<number> {
  if (value === undefined) return valid(100)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000) {
    return invalid('event limit must be an integer from 1 to 1000')
  }
  return valid(value)
}

export function parseApplyTaskPageRequest(
  value: unknown,
): ValidationResult<{ limit?: number; cursor?: string }> {
  if (value === undefined) return valid({})
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('task page request must be an object')
  }
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => key !== 'limit' && key !== 'cursor')) {
    return invalid('task page request contains unsupported fields')
  }
  if (raw.limit !== undefined
    && (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit)
      || raw.limit < 1 || raw.limit > 50)) {
    return invalid('task page limit must be an integer from 1 to 50')
  }
  if (raw.cursor !== undefined
    && (typeof raw.cursor !== 'string' || raw.cursor.length === 0 || raw.cursor.length > 512)) {
    return invalid('task page cursor is invalid')
  }
  return valid({
    ...(raw.limit === undefined ? {} : { limit: raw.limit as number }),
    ...(raw.cursor === undefined ? {} : { cursor: raw.cursor as string }),
  })
}

function parseOptionalTechnical(value: unknown): ValidationResult<boolean> {
  if (value === undefined) return valid(false)
  if (typeof value !== 'boolean') return invalid('includeTechnicalDetails must be a boolean')
  return valid(value)
}

function parseConnectOptions(value: unknown): ValidationResult<{ withoutLifecycleInstallationIds?: string[] }> {
  if (value === undefined) return valid({})
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('connect options must be an object')
  }
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => key !== 'withoutLifecycleInstallationIds')) {
    return invalid('connect options contain unsupported fields')
  }
  const excluded = raw.withoutLifecycleInstallationIds
  if (excluded === undefined) return valid({})
  if (!Array.isArray(excluded) || excluded.length > 100) {
    return invalid('withoutLifecycleInstallationIds must be an array of at most 100 items')
  }
  const parsed: string[] = []
  for (const item of excluded) {
    const id = parseInstallationId(item)
    if (!id.ok) return id
    parsed.push(id.data)
  }
  if (new Set(parsed).size !== parsed.length) {
    return invalid('withoutLifecycleInstallationIds must not contain duplicates')
  }
  return valid({ withoutLifecycleInstallationIds: [...parsed].sort() })
}

function parseComponentKey(value: unknown): ValidationResult<AgentIntegrationComponentKey> {
  if (value !== 'instruction' && value !== 'memory_tools' && value !== 'lifecycle') {
    return invalid('componentKey is invalid')
  }
  return valid(value)
}

function withComponentTarget<T>(
  service: AgentIntegrationServicePort,
  installationId: unknown,
  componentKey: unknown,
  action: (targetPath: string) => T,
): T | IpcValidationError {
  const parsedId = parseInstallationId(installationId)
  if (!parsedId.ok) return parsedId.error
  const parsedComponentKey = parseComponentKey(componentKey)
  if (!parsedComponentKey.ok) return parsedComponentKey.error
  return action(service.componentTargetPath(parsedId.data, parsedComponentKey.data))
}

function parseId(value: unknown, field: string): ValidationResult<string> {
  if (typeof value !== 'string' || !ID_RE.test(value)) return invalid(`${field} is invalid`)
  return valid(value)
}

function delegateId<T>(value: unknown, action: (id: string) => T): T | IpcValidationError {
  const parsed = parseInstallationId(value)
  return parsed.ok ? action(parsed.data) : parsed.error
}

function valid<T>(data: T): ValidationResult<T> {
  return { ok: true, data }
}

function invalid(details: string): ValidationResult<never> {
  return { ok: false, error: { success: false, error: 'invalid_arguments', details: [details] } }
}
