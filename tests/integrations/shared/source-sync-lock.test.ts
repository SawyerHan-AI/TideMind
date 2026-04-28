import { describe, expect, it } from 'vitest';
import { SourceSyncLock } from '../../../src/integrations/shared/source-sync-lock.js';

describe('SourceSyncLock', () => {
  it('uses a default source key when sourceId is omitted', () => {
    const lock = new SourceSyncLock();

    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isActive()).toBe(true);
    expect(lock.tryAcquire()).toBe(false);

    lock.release();
    expect(lock.isActive()).toBe(false);
  });

  it('locks each source independently', () => {
    const lock = new SourceSyncLock();

    expect(lock.tryAcquire('a')).toBe(true);
    expect(lock.tryAcquire('a')).toBe(false);
    expect(lock.tryAcquire('b')).toBe(true);
    expect(lock.isActive('a')).toBe(true);
    expect(lock.isActive('b')).toBe(true);

    lock.release('a');
    expect(lock.tryAcquire('a')).toBe(true);
  });
});
