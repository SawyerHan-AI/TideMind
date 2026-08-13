#!/usr/bin/env node
/* global process, setImmediate */

/**
 * 本地代谢 Phase 0 可复跑基线。
 *
 * 只使用内存数据库和合成节点，不读取用户 data_dir，也不发起 LLM/网络请求。
 * 运行前由 package script 构建 dist：npm run measure:metabolism。
 */
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createTestDb } from '../dist/db/connection.js';
import {
  runSynapticScaling,
  runSynapticScalingCooperatively,
} from '../dist/metabolism/synaptic.js';
import { runKeystoneIdentification } from '../dist/metabolism/divergent.js';

const NODE_COUNT = 10_000;
const REPEATS = 3;
const WARMUP_RUNS = 1;
const checkFlagIndex = process.argv.indexOf('--check');
const thresholdPath = checkFlagIndex >= 0 ? process.argv[checkFlagIndex + 1] : null;
if (checkFlagIndex >= 0 && !thresholdPath) {
  throw new Error('--check requires a threshold JSON path');
}

function createFixture() {
  const db = createTestDb();
  const insert = db.prepare(`
    INSERT INTO nodes (
      id, type, content, heat, refinement, connectivity, independence, created, updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    const timestamp = new Date(0).toISOString();
    for (let index = 0; index < NODE_COUNT; index++) {
      insert.run(
        `node-${index}`,
        'fact',
        `synthetic node ${index}`,
        0.5 + (index % 50) / 100,
        0.3,
        (index % 1000) / 1000,
        0.2,
        timestamp,
        timestamp,
      );
    }
  })();
  return db;
}

function forceGcBetweenFixtures() {
  globalThis.gc?.();
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(sortedValues, percentileValue) {
  return sortedValues[Math.min(
    sortedValues.length - 1,
    Math.ceil(sortedValues.length * percentileValue) - 1,
  )];
}

for (let run = 0; run < WARMUP_RUNS; run++) {
  forceGcBetweenFixtures();
  const db = createFixture();
  runSynapticScaling(db);
  db.close();
}

const synchronousRunsMs = [];
const synchronousEventLoopTurns = [];
for (let run = 0; run < REPEATS; run++) {
  forceGcBetweenFixtures();
  const db = createFixture();
  let monitoringTurns = true;
  let turns = 0;
  const countTurn = () => {
    if (!monitoringTurns) return;
    turns++;
    setImmediate(countTurn);
  };
  setImmediate(countTurn);
  const startedAt = performance.now();
  runSynapticScaling(db);
  synchronousRunsMs.push(performance.now() - startedAt);
  monitoringTurns = false;
  synchronousEventLoopTurns.push(turns);
  db.close();
}

const cooperativeRunsMs = [];
const cooperativeSliceGapsMs = [];
for (let run = 0; run < REPEATS; run++) {
  forceGcBetweenFixtures();
  const db = createFixture();
  let previousTurnAt = performance.now();
  const startedAt = previousTurnAt;
  await runSynapticScalingCooperatively(db, () => new Promise((resolve) => {
    setImmediate(() => {
      const currentTurnAt = performance.now();
      cooperativeSliceGapsMs.push(currentTurnAt - previousTurnAt);
      previousTurnAt = currentTurnAt;
      resolve();
    });
  }));
  cooperativeRunsMs.push(performance.now() - startedAt);
  db.close();
}

const keystoneRunsMs = [];
for (let run = 0; run < REPEATS; run++) {
  forceGcBetweenFixtures();
  const db = createFixture();
  const startedAt = performance.now();
  runKeystoneIdentification(db);
  keystoneRunsMs.push(performance.now() - startedAt);
  db.close();
}

const sortedSliceGaps = [...cooperativeSliceGapsMs].sort((left, right) => left - right);
const synchronousMedianMs = median(synchronousRunsMs);
const cooperativeMedianMs = median(cooperativeRunsMs);
const result = {
  protocolVersion: 1,
  measuredAt: new Date().toISOString(),
  baseCommit: execFileSync('git', ['merge-base', 'HEAD', 'main'], { encoding: 'utf8' }).trim(),
  machine: {
    cpu: os.cpus()[0]?.model ?? 'unknown',
    memoryBytes: os.totalmem(),
    os: `${os.type()} ${os.release()}`,
    arch: process.arch,
    nodeVersion: process.version,
  },
  fixture: {
    source: 'synthetic-memory-db',
    nodeCount: NODE_COUNT,
    linkCount: 0,
    repeats: REPEATS,
    warmupRuns: WARMUP_RUNS,
  },
  synapticDecaySynchronous: {
    runsMs: synchronousRunsMs,
    medianMs: synchronousMedianMs,
    eventLoopTurnsDuringTask: synchronousEventLoopTurns,
  },
  synapticDecayCooperative: {
    runsMs: cooperativeRunsMs,
    medianMs: cooperativeMedianMs,
    relativeRuntimeOverhead: (cooperativeMedianMs / synchronousMedianMs) - 1,
    yieldCountPerRun: cooperativeSliceGapsMs.length / REPEATS,
    sliceGapMs: {
      p50: percentile(sortedSliceGaps, 0.5),
      p95: percentile(sortedSliceGaps, 0.95),
      p99: percentile(sortedSliceGaps, 0.99),
      max: percentile(sortedSliceGaps, 1),
    },
  },
  keystoneIdentification: {
    runsMs: keystoneRunsMs,
    medianMs: median(keystoneRunsMs),
  },
  scope: {
    validated: '10k-node, zero-link, in-memory synaptic node-stage cooperative slicing',
    notValidated: [
      'real Electron responsiveness',
      'startup time',
      'multi-task backlog',
      'synaptic link-stage latency',
      'full scheduler hotspot ranking',
    ],
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (thresholdPath) {
  const thresholds = JSON.parse(readFileSync(thresholdPath, 'utf8'));
  const expectedFixture = {
    nodeCount: NODE_COUNT,
    linkCount: 0,
    repeats: REPEATS,
    warmupRuns: WARMUP_RUNS,
  };
  if (thresholds.protocolVersion !== result.protocolVersion) {
    throw new Error('metabolism benchmark threshold protocol mismatch');
  }
  if (JSON.stringify(thresholds.fixture) !== JSON.stringify(expectedFixture)) {
    throw new Error('metabolism benchmark threshold fixture mismatch');
  }
  const gate = thresholds.synapticDecayCooperative;
  const failures = [];
  if (result.synapticDecaySynchronous.medianMs > gate.maxSynchronousMedianMs) {
    failures.push('synchronous median runtime');
  }
  if (result.synapticDecayCooperative.relativeRuntimeOverhead > gate.maxRelativeMedianRuntime - 1) {
    failures.push('relative median runtime overhead');
  }
  if (result.synapticDecayCooperative.sliceGapMs.p95 > gate.maxSliceGapP95Ms) {
    failures.push('slice gap p95');
  }
  if (result.synapticDecayCooperative.sliceGapMs.max > gate.maxSliceGapMaxMs) {
    failures.push('slice gap max');
  }
  if (result.synapticDecayCooperative.yieldCountPerRun < gate.requiredMinimumYieldCount) {
    failures.push('yield count');
  }
  if (failures.length > 0) {
    throw new Error(`metabolism benchmark thresholds failed: ${failures.join(', ')}`);
  }
}
