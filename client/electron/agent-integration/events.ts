import type { ComponentKey, JsonValue } from './types'

export type IntegrationEventSeverity = 'info' | 'warning' | 'error'

export interface IntegrationEvent {
  id: string
  installationId: string | null
  componentKey: ComponentKey | null
  artifactId: string | null
  kind: string
  severity: IntegrationEventSeverity
  episodeId: string | null
  dedupeKey: string | null
  payload: Readonly<Record<string, JsonValue>>
  createdAt: string
}

export interface UserNotification {
  title: string
  body: string
  level: 'info' | 'warning' | 'error'
  eventId: string
  installationId: string | null
  actions: readonly ('view_details' | 'disconnect' | 'resume_management')[]
}

export interface IntegrationEventRepositoryPort {
  recordEvent(event: IntegrationEvent): void | Promise<void>
}

export interface NotificationPort {
  deliver(notification: UserNotification): void | Promise<void>
}

export interface EventPublisherDependencies {
  repository: IntegrationEventRepositoryPort
  notifications: NotificationPort
}

export interface PublishEventResult {
  persisted: true
  notificationDelivered: boolean
  notificationError?: string
}

/**
 * Persistence always precedes delivery. Notification failures intentionally do
 * not fail a completed repair: the unread event remains the durable fallback.
 */
export async function publishIntegrationEvent(
  event: IntegrationEvent,
  notification: Omit<UserNotification, 'eventId'> | null,
  dependencies: EventPublisherDependencies,
): Promise<PublishEventResult> {
  await dependencies.repository.recordEvent(event)
  if (notification === null) return { persisted: true, notificationDelivered: false }

  try {
    await dependencies.notifications.deliver({ ...notification, eventId: event.id })
    return { persisted: true, notificationDelivered: true }
  } catch (error) {
    return {
      persisted: true,
      notificationDelivered: false,
      notificationError: error instanceof Error ? error.message : String(error),
    }
  }
}

export function autoRestoreNotification(input: {
  eventId: string
  installationId: string
  agentName: string
  componentName: string
  componentKey?: ComponentKey
  locale?: string
}): UserNotification {
  const copy = notificationCopy(input.locale)
  const component = copy.component(input.componentKey, input.componentName)
  return {
    title: copy.restoredTitle,
    body: copy.restoredBody(input.agentName, component),
    level: 'info',
    eventId: input.eventId,
    installationId: input.installationId,
    actions: ['view_details', 'disconnect'],
  }
}

export function circuitBreakerNotification(input: {
  eventId: string
  installationId: string
  agentName: string
  componentName: string
  componentKey?: ComponentKey
  locale?: string
}): UserNotification {
  const copy = notificationCopy(input.locale)
  const component = copy.component(input.componentKey, input.componentName)
  return {
    title: copy.pausedTitle,
    body: copy.pausedBody(input.agentName, component),
    level: 'warning',
    eventId: input.eventId,
    installationId: input.installationId,
    actions: ['view_details', 'resume_management', 'disconnect'],
  }
}

export function newInstallationNotification(input: {
  eventId: string
  installationId: string
  agentName: string
  locale?: string
}): UserNotification {
  const copy = discoveryNotificationCopy(input.locale)
  return {
    title: copy.title,
    body: copy.body(input.agentName),
    level: 'info',
    eventId: input.eventId,
    installationId: input.installationId,
    actions: ['view_details'],
  }
}

interface DiscoveryNotificationCopy {
  title: string
  body(agent: string): string
}

const DISCOVERY_NOTIFICATION_COPY: Record<string, DiscoveryNotificationCopy> = {
  en: { title: 'New local Agent found', body: agent => `${agent} is ready to review and connect to Tide Mind.` },
  'zh-CN': { title: '发现新的本机 Agent', body: agent => `已发现 ${agent}，查看并确认后即可连接 Tide Mind。` },
  'zh-TW': { title: '發現新的本機 Agent', body: agent => `已發現 ${agent}，檢視並確認後即可連接 Tide Mind。` },
  ja: { title: '新しいローカル Agent が見つかりました', body: agent => `${agent} を確認して Tide Mind に接続できます。` },
  ko: { title: '새 로컬 Agent를 찾았습니다', body: agent => `${agent}을 검토하고 Tide Mind에 연결할 수 있습니다.` },
  fr: { title: 'Nouvel Agent local détecté', body: agent => `${agent} peut être vérifié puis connecté à Tide Mind.` },
  es: { title: 'Nuevo Agent local detectado', body: agent => `${agent} está listo para revisarse y conectarse a Tide Mind.` },
  de: { title: 'Neuer lokaler Agent gefunden', body: agent => `${agent} kann geprüft und mit Tide Mind verbunden werden.` },
  'pt-BR': { title: 'Novo Agent local encontrado', body: agent => `${agent} está pronto para revisão e conexão com o Tide Mind.` },
  ru: { title: 'Обнаружен новый локальный Agent', body: agent => `${agent} можно проверить и подключить к Tide Mind.` },
  it: { title: 'Trovato un nuovo Agent locale', body: agent => `${agent} è pronto per la verifica e la connessione a Tide Mind.` },
  tr: { title: 'Yeni bir yerel Agent bulundu', body: agent => `${agent}, incelenip Tide Mind'a bağlanmaya hazır.` },
}

function discoveryNotificationCopy(locale = 'en'): DiscoveryNotificationCopy {
  const exact = Object.keys(DISCOVERY_NOTIFICATION_COPY).find(key => key.toLowerCase() === locale.toLowerCase())
  if (exact) return DISCOVERY_NOTIFICATION_COPY[exact]
  const language = locale.split(/[-_]/u)[0].toLowerCase()
  return DISCOVERY_NOTIFICATION_COPY[language] ?? DISCOVERY_NOTIFICATION_COPY.en
}

interface NotificationCopy {
  restoredTitle: string
  pausedTitle: string
  restoredBody(agent: string, component: string): string
  pausedBody(agent: string, component: string): string
  component(key: ComponentKey | undefined, fallback: string): string
}

function withComponents(
  copy: Omit<NotificationCopy, 'component'>,
  labels: Record<ComponentKey, string>,
): NotificationCopy {
  return { ...copy, component: (key, fallback) => key ? labels[key] : fallback }
}

const EN_COPY = withComponents({
  restoredTitle: 'Agent configuration restored',
  pausedTitle: 'Automatic restore paused',
  restoredBody: (agent, component) => `Tide Mind detected that ${agent}'s ${component} configuration was removed and restored it automatically.`,
  pausedBody: (agent, component) => `${agent}'s ${component} configuration was removed again within 24 hours. Automatic restore is paused so you can check for conflicts.`,
}, { instruction: 'Skill/instructions', memory_tools: 'MCP memory tools', lifecycle: 'lifecycle hooks' })

const NOTIFICATION_COPY: Record<string, NotificationCopy> = {
  en: EN_COPY,
  'zh-CN': withComponents({
    restoredTitle: '已自动恢复 Agent 配置', pausedTitle: '已暂停自动恢复',
    restoredBody: (agent, component) => `检测到 ${agent} 的${component}配置已被删除，Tide Mind 已自动恢复。`,
    pausedBody: (agent, component) => `${agent} 的${component}配置在 24 小时内再次被删除，已停止自动恢复，请检查冲突。`,
  }, { instruction: 'Skill/指令', memory_tools: 'MCP 记忆工具', lifecycle: '生命周期 Hook' }),
  'zh-TW': withComponents({
    restoredTitle: '已自動復原 Agent 設定', pausedTitle: '已暫停自動復原',
    restoredBody: (agent, component) => `偵測到 ${agent} 的${component}設定已被刪除，Tide Mind 已自動復原。`,
    pausedBody: (agent, component) => `${agent} 的${component}設定在 24 小時內再次被刪除，已停止自動復原，請檢查衝突。`,
  }, { instruction: 'Skill/指令', memory_tools: 'MCP 記憶工具', lifecycle: '生命週期 Hook' }),
  ja: withComponents({
    restoredTitle: 'Agent 設定を自動復元しました', pausedTitle: '自動復元を一時停止しました',
    restoredBody: (agent, component) => `${agent} の${component}設定が削除されたことを検出し、Tide Mind が自動復元しました。`,
    pausedBody: (agent, component) => `${agent} の${component}設定が 24 時間以内に再び削除されました。競合を確認できるよう自動復元を停止しました。`,
  }, { instruction: 'Skill/指示', memory_tools: 'MCP メモリーツール', lifecycle: 'ライフサイクル Hook' }),
  ko: withComponents({
    restoredTitle: 'Agent 구성을 자동 복원했습니다', pausedTitle: '자동 복원을 일시 중지했습니다',
    restoredBody: (agent, component) => `${agent}의 ${component} 구성이 삭제된 것을 감지하여 Tide Mind가 자동으로 복원했습니다.`,
    pausedBody: (agent, component) => `${agent}의 ${component} 구성이 24시간 이내에 다시 삭제되었습니다. 충돌을 확인할 수 있도록 자동 복원을 중지했습니다.`,
  }, { instruction: 'Skill/지침', memory_tools: 'MCP 메모리 도구', lifecycle: '수명 주기 Hook' }),
  fr: withComponents({
    restoredTitle: 'Configuration de l’Agent restaurée', pausedTitle: 'Restauration automatique suspendue',
    restoredBody: (agent, component) => `Tide Mind a détecté la suppression de la configuration ${component} de ${agent} et l’a restaurée automatiquement.`,
    pausedBody: (agent, component) => `La configuration ${component} de ${agent} a de nouveau été supprimée sous 24 heures. La restauration automatique est suspendue afin de vérifier les conflits.`,
  }, { instruction: 'Skill/instructions', memory_tools: 'outils de mémoire MCP', lifecycle: 'hooks de cycle de vie' }),
  es: withComponents({
    restoredTitle: 'Configuración del Agent restaurada', pausedTitle: 'Restauración automática en pausa',
    restoredBody: (agent, component) => `Tide Mind detectó que se eliminó la configuración de ${component} de ${agent} y la restauró automáticamente.`,
    pausedBody: (agent, component) => `La configuración de ${component} de ${agent} volvió a eliminarse en menos de 24 horas. La restauración automática está en pausa para revisar conflictos.`,
  }, { instruction: 'Skill/instrucciones', memory_tools: 'herramientas de memoria MCP', lifecycle: 'hooks de ciclo de vida' }),
  de: withComponents({
    restoredTitle: 'Agent-Konfiguration wiederhergestellt', pausedTitle: 'Automatische Wiederherstellung pausiert',
    restoredBody: (agent, component) => `Tide Mind hat erkannt, dass die ${component}-Konfiguration von ${agent} entfernt wurde, und sie automatisch wiederhergestellt.`,
    pausedBody: (agent, component) => `Die ${component}-Konfiguration von ${agent} wurde innerhalb von 24 Stunden erneut entfernt. Die automatische Wiederherstellung ist zur Konfliktprüfung pausiert.`,
  }, { instruction: 'Skill/Anweisungen', memory_tools: 'MCP-Speicherwerkzeuge', lifecycle: 'Lebenszyklus-Hooks' }),
  'pt-BR': withComponents({
    restoredTitle: 'Configuração do Agent restaurada', pausedTitle: 'Restauração automática pausada',
    restoredBody: (agent, component) => `O Tide Mind detectou que a configuração de ${component} do ${agent} foi removida e a restaurou automaticamente.`,
    pausedBody: (agent, component) => `A configuração de ${component} do ${agent} foi removida novamente em menos de 24 horas. A restauração automática foi pausada para verificar conflitos.`,
  }, { instruction: 'Skill/instruções', memory_tools: 'ferramentas de memória MCP', lifecycle: 'hooks de ciclo de vida' }),
  ru: withComponents({
    restoredTitle: 'Конфигурация Agent восстановлена', pausedTitle: 'Автовосстановление приостановлено',
    restoredBody: (agent, component) => `Tide Mind обнаружил удаление конфигурации «${component}» для ${agent} и автоматически восстановил её.`,
    pausedBody: (agent, component) => `Конфигурация «${component}» для ${agent} была снова удалена в течение 24 часов. Автовосстановление приостановлено для проверки конфликтов.`,
  }, { instruction: 'Skill/инструкции', memory_tools: 'инструменты памяти MCP', lifecycle: 'хуки жизненного цикла' }),
  it: withComponents({
    restoredTitle: 'Configurazione Agent ripristinata', pausedTitle: 'Ripristino automatico sospeso',
    restoredBody: (agent, component) => `Tide Mind ha rilevato la rimozione della configurazione ${component} di ${agent} e l’ha ripristinata automaticamente.`,
    pausedBody: (agent, component) => `La configurazione ${component} di ${agent} è stata rimossa di nuovo entro 24 ore. Il ripristino automatico è sospeso per verificare eventuali conflitti.`,
  }, { instruction: 'Skill/istruzioni', memory_tools: 'strumenti di memoria MCP', lifecycle: 'hook del ciclo di vita' }),
  tr: withComponents({
    restoredTitle: 'Agent yapılandırması geri yüklendi', pausedTitle: 'Otomatik geri yükleme duraklatıldı',
    restoredBody: (agent, component) => `Tide Mind, ${agent} için ${component} yapılandırmasının silindiğini algıladı ve otomatik olarak geri yükledi.`,
    pausedBody: (agent, component) => `${agent} için ${component} yapılandırması 24 saat içinde yeniden silindi. Çakışmaları kontrol edebilmeniz için otomatik geri yükleme duraklatıldı.`,
  }, { instruction: 'Skill/talimatlar', memory_tools: 'MCP bellek araçları', lifecycle: 'yaşam döngüsü hook’ları' }),
}

function notificationCopy(locale = 'zh-CN'): NotificationCopy {
  const exact = Object.keys(NOTIFICATION_COPY).find(key => key.toLowerCase() === locale.toLowerCase())
  if (exact) return NOTIFICATION_COPY[exact]
  const language = locale.split(/[-_]/u)[0].toLowerCase()
  return NOTIFICATION_COPY[language] ?? EN_COPY
}
