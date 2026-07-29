import { describe, expect, it } from 'vitest';
import {
  __testing,
  trackBackgroundWork,
  waitForBackgroundWork,
} from '../../src/utils/background-work.js';

describe('background work shutdown barrier', () => {
  it('等待已登记的 fire-and-forget 工作 settle 后才放行', async () => {
    let release: (() => void) | undefined;
    const work = new Promise<void>(resolve => { release = resolve; });
    trackBackgroundWork(work);

    let drained = false;
    const drain = waitForBackgroundWork().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(__testing.size()).toBe(1);

    release?.();
    await drain;
    expect(drained).toBe(true);
    expect(__testing.size()).toBe(0);
  });
});
