import { clipboard, ipcMain, shell } from 'electron'
import type { AgentIntegrationService } from '../agent-integration/service.js'
import type { AgentIntegrationComponentKey } from '../../src/lib/api-contract.js'
import type { IpcValidationError, ValidationResult } from './_schemas.js'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const PLAN_HASH_RE = /^[a-f0-9]{64}$/u

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
  options: { expectedRendererUrl?: string } = {},
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
