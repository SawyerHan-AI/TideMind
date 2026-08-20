import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_TASKS } from '../../src/metabolism/tasks.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('metabolism Worker Phase 0 inventory', () => {
  it('固定完整task顺序和关键跨线程边界', () => {
    expect(ALL_TASKS.map(task => task.id)).toEqual([
      'digest-retry',
      'annotate',
      'link-evaluate',
      'pending-link-gc',
      'link-discover',
      'synaptic-decay',
      'keystone-enrich',
      'tag-promote',
      'divergent-scan',
      'crystal-emerge',
      'temporal-crystal',
      'profile-synthesize',
      'learning2',
      'learning3',
      'structure-holes-precompute',
    ]);

    const byId = new Map(ALL_TASKS.map(task => [task.id, task]));
    expect(byId.get('digest-retry')).toMatchObject({ requiresLLM: true, requiresEmbedding: true });
    expect(byId.get('pending-link-gc')).toMatchObject({ requiresLLM: false });
    expect(byId.get('link-discover')).toMatchObject({ requiresEmbedding: true });
    expect(byId.get('divergent-scan')).toMatchObject({ requiresLLM: true, requiresEmbedding: true });
    expect(byId.get('structure-holes-precompute')).toMatchObject({ requiresLLM: false });
  });

  it('在Worker结果产生前冻结candidate gate schema', () => {
    const artifactPath = path.join(
      repoRoot,
      'scripts/metabolism-worker-candidate-thresholds.json',
    );
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;

    expect(artifact).toMatchObject({
      protocolVersion: 2,
      status: 'refrozen-before-external-cpu-fix-results',
      correctness: {
        unexpectedSqliteBusyOrLockedMax: 0,
        concurrentSchedulerPassesMax: 1,
        mainThreadSchedulerTaskExecutionsMax: 0,
        orphanCliProcessGroupsAfterShutdownMax: 0,
      },
    });
    expect(artifact.requiredWorkloads).toEqual([
      'focused-renderer-ipc-writes',
      'note-source-writes',
      'cloud-outbox-writes',
      'background-full-backlog',
      'foreground-single-attempt',
      'suspend-resume',
      'worker-owner-terminate-reacquire',
    ]);
  });
});
