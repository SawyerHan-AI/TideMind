interface VisibilityEventTarget extends EventTarget {
  readonly visibilityState: DocumentVisibilityState
}

/**
 * Reconcile the durable inbox whenever the renderer can become visible again.
 * Background system notifications intentionally do not enter the renderer, so
 * focus/visibility are the read-back boundary for the unread badge.
 */
export function subscribeAgentIntegrationInboxRefresh(
  windowTarget: EventTarget,
  documentTarget: VisibilityEventTarget,
  refresh: () => void,
): () => void {
  const onRefresh = () => refresh()
  const onVisibility = () => {
    if (documentTarget.visibilityState === 'visible') refresh()
  }
  windowTarget.addEventListener('focus', onRefresh)
  windowTarget.addEventListener('agent-integration-inbox-changed', onRefresh)
  documentTarget.addEventListener('visibilitychange', onVisibility)
  return () => {
    windowTarget.removeEventListener('focus', onRefresh)
    windowTarget.removeEventListener('agent-integration-inbox-changed', onRefresh)
    documentTarget.removeEventListener('visibilitychange', onVisibility)
  }
}
