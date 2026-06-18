/**
 * G1 注入预算安全网测试（src/hook-session-format.ts）
 *
 * Claude Code 对 hook 输出有 10,000 字符硬上限,超限整体落盘为 persisted-output、
 * 模型只见前 2KB 预览。assembleSessionContext 保证注入不超预算。
 * 见 docs/design/hook-injection-overflow-fix-2026-06-11.md §4.5。
 *
 * 本模块是纯函数、零副作用(IO 留在 hook-session-start.ts),可直接 import 测试。
 */
import { describe, it, expect } from 'vitest';
import {
  assembleSessionContext,
  formatProfileSection,
  formatRestSections,
  INJECT_BUDGET_CHARS,
  HARD_CAP_CHARS,
} from '../src/hook-session-format.js';
import type { PrepareOutput } from '../src/types.js';

function makeOutput(patch: Partial<PrepareOutput> = {}): PrepareOutput {
  return {
    profile: { text: '', generated_at: '2026-06-11T00:00:00Z' },
    keystones: [],
    tags: [],
    crystals: { highlighted: [], others: [] },
    recent: [],
    ...patch,
  };
}

describe('assembleSessionContext - 规则 1：未超预算原样输出', () => {
  it('正常体积 → 含全部段落,长度不变', () => {
    const profileSection = formatProfileSection(makeOutput({
      profile: { text: '用户是星海科技的产品负责人。', generated_at: '2026-06-11T00:00:00Z' },
    }));
    const restSection = formatRestSections(makeOutput({
      keystones: [{ id: 'k1', title: 'DataPilot', type: 'fact', link_count: 100 }],
    }));
    const out = assembleSessionContext({ skillContent: '使用指南正文', profileSection, restSection });

    expect(out.length).toBeLessThanOrEqual(INJECT_BUDGET_CHARS);
    expect(out).toContain('## 使用指南');
    expect(out).toContain('用户是星海科技');
    expect(out).toContain('DataPilot');
    expect(out).toContain('brain_recall');
    expect(out).not.toContain('已截断');
  });

  it('/clear、错误 fallback 等静态短文本(profileSection 为空)→ 原样', () => {
    const out = assembleSessionContext({
      skillContent: '指南',
      profileSection: '',
      restSection: '（/clear 已执行，用户上下文已在本 session 内保留，无需重新加载）',
    });
    expect(out).toContain('/clear 已执行');
    expect(out.length).toBeLessThanOrEqual(INJECT_BUDGET_CHARS);
  });
});

describe('assembleSessionContext - 规则 2：超预算只截画像段', () => {
  it('超长画像 → 总长回到预算内、含截断标记、其余段完整', () => {
    const hugeProfile = '## 用户画像\n' + Array.from({ length: 500 }, (_, i) => `这是画像的第 ${i} 段，包含大量描述用户特征的文字内容用于撑大体积，确保整体远超注入预算上限。`).join('\n\n');
    const restSection = formatRestSections(makeOutput({
      keystones: [{ id: 'k1', title: 'DataPilot 枢纽', type: 'fact', link_count: 100 }],
      guidance: '行为指导：多用 recall。',
    }));
    const out = assembleSessionContext({ skillContent: '使用指南', profileSection: hugeProfile, restSection });

    expect(out.length).toBeLessThanOrEqual(INJECT_BUDGET_CHARS);
    expect(out).toContain('画像过长已截断');
    // 其余段没被动
    expect(out).toContain('DataPilot 枢纽');
    expect(out).toContain('行为指导：多用 recall。');
    // 画像头部保留
    expect(out).toContain('## 用户画像');
    expect(out).toContain('这是画像的第 0 段');
  });
});

describe('assembleSessionContext - 规则 3：极端膨胀走硬截断', () => {
  it('其余段本身就超 HARD_CAP → 整体硬截断 + 标记,不超 HARD_CAP', () => {
    // restSection 单独就远超预算(模拟索引区异常膨胀),画像截到 floor 也救不回
    const massiveRest = Array.from({ length: 2000 }, (_, i) => `- 枢纽 ${i}（id: k${i}）`).join('\n');
    const out = assembleSessionContext({
      skillContent: '指南',
      profileSection: '## 用户画像\n' + '画像内容。'.repeat(300),
      restSection: massiveRest,
    });

    expect(out.length).toBeLessThanOrEqual(HARD_CAP_CHARS);
    expect(out).toContain('上下文过长已截断');
  });

  it('画像为空但 rest 巨大 → 走硬截断,不超 HARD_CAP', () => {
    const massiveRest = Array.from({ length: 3000 }, (_, i) => `- 标签 ${i}（id: t${i}）`).join('\n');
    const out = assembleSessionContext({ skillContent: '指南', profileSection: '', restSection: massiveRest });
    expect(out.length).toBeLessThanOrEqual(HARD_CAP_CHARS);
    expect(out).toContain('上下文过长已截断');
  });

  it('skillContent 单独就超 HARD_CAP → 仍不超 HARD_CAP', () => {
    const out = assembleSessionContext({
      skillContent: '指'.repeat(12000),
      profileSection: '## 用户画像\n画像。',
      restSection: '## 行为指导\n多用 recall。',
    });
    expect(out.length).toBeLessThanOrEqual(HARD_CAP_CHARS);
  });
});

describe('assembleSessionContext - 边界:截断后含 emoji 仍不超上界', () => {
  it('画像含大量 emoji、落在硬截断边界 → 长度仍 ≤ HARD_CAP(代理对不会反弹超界)', () => {
    const out = assembleSessionContext({
      skillContent: '指南',
      profileSection: '## 用户画像\n' + '🚀'.repeat(6000),
      restSection: Array.from({ length: 1500 }, (_, i) => `- 枢纽 ${i}（id: k${i}）`).join('\n'),
    });
    expect(out.length).toBeLessThanOrEqual(HARD_CAP_CHARS);
  });
});
