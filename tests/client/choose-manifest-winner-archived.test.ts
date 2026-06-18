/**
 * 审计 HIGH 修复回归:chooseManifestWinner 的 archived 维度从纯 tombstone 改为按 edit_seq 比较
 * (对齐 server decideNodeUpsert)。守护跨设备 unarchive 不被 reconcile 兜底重归档 + 防 ping-pong。
 */

import { describe, it, expect } from 'vitest';
import { chooseManifestWinner } from '../../client/electron/cloud/reconciler-utils.js';

const e = (o: Partial<{ archived: boolean; edit_seq: number; updated: string }>) =>
  ({ id: 'n', updated: '2026-01-01T00:00:00Z', ...o });

describe('chooseManifestWinner archived × edit_seq(M5/审计 HIGH)', () => {
  it('跨设备 unarchive:local active(edit_seq 高)vs server archived(低)→ local(恢复不被重归档)', () => {
    expect(chooseManifestWinner(e({ archived: false, edit_seq: 7 }), e({ archived: true, edit_seq: 3 }))).toBe('local');
  });
  it('过时 active:local active(edit_seq 低)vs server archived(高)→ server(tombstone,不复活)', () => {
    expect(chooseManifestWinner(e({ archived: false, edit_seq: 3 }), e({ archived: true, edit_seq: 7 }))).toBe('server');
  });
  it('archive:local archived(edit_seq 高)vs server active(低)→ local(归档赢)', () => {
    expect(chooseManifestWinner(e({ archived: true, edit_seq: 7 }), e({ archived: false, edit_seq: 3 }))).toBe('local');
  });
  it('防 ping-pong:local archived(edit_seq 低)vs server active(高)→ server(active 赢)', () => {
    expect(chooseManifestWinner(e({ archived: true, edit_seq: 3 }), e({ archived: false, edit_seq: 7 }))).toBe('server');
  });
  it('edit_seq 相等(旧数据双 0)→ tombstone 优先(归档侧赢),与 M5 前行为一致', () => {
    expect(chooseManifestWinner(e({ archived: true, edit_seq: 0 }), e({ archived: false, edit_seq: 0 }))).toBe('local');
    expect(chooseManifestWinner(e({ archived: false, edit_seq: 0 }), e({ archived: true, edit_seq: 0 }))).toBe('server');
  });
});
