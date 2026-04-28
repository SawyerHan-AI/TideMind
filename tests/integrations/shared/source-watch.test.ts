import { describe, expect, it } from 'vitest';
import { MAX_WATCHER_LOCK_RETRIES, decideWatcherChange } from '../../../src/integrations/shared/source-watch.js';

describe('decideWatcherChange', () => {
  it('skips inactive sources and missing files', () => {
    expect(decideWatcherChange({ sourceActive: false, fileExists: true, sourceLocked: false })).toBe('skip');
    expect(decideWatcherChange({ sourceActive: true, fileExists: false, sourceLocked: false })).toBe('skip');
  });

  it('retries when the source is locked', () => {
    expect(decideWatcherChange({ sourceActive: true, fileExists: true, sourceLocked: true })).toBe('retry');
  });

  it('processes active existing files when the source is unlocked', () => {
    expect(decideWatcherChange({ sourceActive: true, fileExists: true, sourceLocked: false })).toBe('process');
  });

  it('keeps retrying below the cap', () => {
    expect(decideWatcherChange({
      sourceActive: true, fileExists: true, sourceLocked: true,
      attempts: MAX_WATCHER_LOCK_RETRIES - 1,
    })).toBe('retry');
  });

  it('drops the event after the retry cap is reached', () => {
    expect(decideWatcherChange({
      sourceActive: true, fileExists: true, sourceLocked: true,
      attempts: MAX_WATCHER_LOCK_RETRIES,
    })).toBe('drop');
    expect(decideWatcherChange({
      sourceActive: true, fileExists: true, sourceLocked: true,
      attempts: MAX_WATCHER_LOCK_RETRIES + 5,
    })).toBe('drop');
  });
});
