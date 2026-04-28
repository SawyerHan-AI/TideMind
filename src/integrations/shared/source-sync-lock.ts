export class SourceSyncLock {
  private readonly active = new Set<string>();

  constructor(private readonly defaultSourceId = '__default__') {}

  key(sourceId?: string): string {
    return sourceId ?? this.defaultSourceId;
  }

  isActive(sourceId?: string): boolean {
    return this.active.has(this.key(sourceId));
  }

  tryAcquire(sourceId?: string): boolean {
    const key = this.key(sourceId);
    if (this.active.has(key)) return false;
    this.active.add(key);
    return true;
  }

  release(sourceId?: string): void {
    this.active.delete(this.key(sourceId));
  }
}
