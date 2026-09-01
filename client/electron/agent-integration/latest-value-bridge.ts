/**
 * Delivers live values immediately and retains only the latest value while no
 * subscriber exists.  Used for renderer navigation intent, where replaying an
 * old click after a newer click would be incorrect.
 */
export class LatestValueBridge<T> {
  private readonly subscribers = new Set<(value: T) => void>()
  private pending: T | undefined

  publish(value: T): void {
    if (this.subscribers.size === 0) {
      this.pending = value
      return
    }
    for (const subscriber of this.subscribers) subscriber(value)
  }

  subscribe(subscriber: (value: T) => void): () => void {
    this.subscribers.add(subscriber)
    if (this.pending !== undefined) {
      const pending = this.pending
      this.pending = undefined
      subscriber(pending)
    }
    return () => { this.subscribers.delete(subscriber) }
  }
}
