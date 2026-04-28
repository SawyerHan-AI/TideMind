import { describe, expect, it } from 'vitest';
import {
  buildKnownRelPathSet,
  collectChangedProcessableFiles,
  createSourceFileScan,
  getAllKnownFiles,
  planStaleSyncStateCleanup,
  toSourceRelativePath,
} from '../../../src/integrations/shared/source-file-state.js';

describe('source file state helpers', () => {
  it('keeps dataless files in known paths for stale detection', () => {
    const scan = createSourceFileScan(
      ['/vault/pages/a.md'],
      ['/vault/pages/offline.md'],
    );

    expect(getAllKnownFiles(scan)).toEqual([
      '/vault/pages/a.md',
      '/vault/pages/offline.md',
    ]);
    expect(Array.from(buildKnownRelPathSet('/vault', scan)).sort()).toEqual([
      'pages/a.md',
      'pages/offline.md',
    ]);
  });

  it('only runs change detection for processable files', () => {
    const scan = createSourceFileScan(
      ['/vault/pages/changed.md', '/vault/pages/same.md'],
      ['/vault/pages/offline.md'],
    );
    const states = new Map([
      ['pages/changed.md', { content_hash: 'old' }],
      ['pages/same.md', { content_hash: 'same' }],
      ['pages/offline.md', { content_hash: 'old-offline' }],
    ]);
    const seen: string[] = [];

    const changed = collectChangedProcessableFiles(
      '/vault',
      scan.processableFiles,
      states,
      (filePath, state) => {
        seen.push(toSourceRelativePath('/vault', filePath));
        return state?.content_hash === 'old';
      },
    );

    expect(changed).toEqual(['/vault/pages/changed.md']);
    expect(seen).toEqual(['pages/changed.md', 'pages/same.md']);
  });

  it('normalizes source-relative paths to POSIX separators', () => {
    expect(toSourceRelativePath('/vault', '/vault/a/b.md')).toBe('a/b.md');
  });

  it('plans stale cleanup only for sync states outside the known path set', () => {
    const states = new Map([
      ['pages/a.md', { node_ids: ['node-a'] }],
      ['pages/offline.md', { node_ids: ['node-offline'] }],
      ['pages/deleted.md', { node_ids: ['node-deleted-1', 'node-deleted-2'] }],
      ['pages/empty.md', { node_ids: [] }],
    ]);
    const known = new Set(['pages/a.md', 'pages/offline.md']);

    const plan = planStaleSyncStateCleanup(states, known);

    expect(plan.staleFilePaths).toEqual(['pages/deleted.md', 'pages/empty.md']);
    expect(plan.orphanNodeIds).toEqual(['node-deleted-1', 'node-deleted-2']);
  });
});
