/**
 * Hook 文案纯函数测试:formatBriefContext
 *
 * 来源:src/hook-post-compact.ts。该函数在 PostCompact hook 中被调用,
 * 把 prepare() 输出拼成体积受控的精简画像(每类 ≤ 3 条),防止压缩后
 * 立刻又吞掉大量 token。
 *
 * 测试只覆盖纯函数边界:
 *   - 各字段为空 / 缺失 / 单值 / 超量
 *   - profile.text 多段时只取第一段
 *   - keystones / recent 超过 3 时截断
 *   - crystals.highlighted 不足 3 时补 others;>= 3 时不补
 *   - keystones / crystals.others 缺 title 时用 id 兜底
 *   - crystals.highlighted 缺 title 时用 snippet 兜底
 *
 * 整 hook 流程(DB + prepare + outputHook)需要 subprocess + Better-SQLite + LLM
 * mock,不在 unit 层覆盖,见报告 "无法 unit 测必须 subprocess/integration" 区。
 */
import { describe, it, expect, vi } from 'vitest';

// hook-post-compact.ts 在模块顶层调用 main()(脚本入口设计),import 即执行。
// 测试只需 formatBriefContext 这个纯函数,因此:
//   1. 用 vi.mock 把所有 IO 依赖替换成 no-op(hoisted,所以在 import 前生效)
//   2. 在 ../src/config.js mock 内部"顺手"改 process.argv,让 main() parseArgs 走通
//      —— ESM import 被 hoist 到所有 top-level 语句之前,直接在测试文件顶层
//      赋值 process.argv 会赶不上 hook-post-compact 的求值。把 argv 注入塞进 mock
//      工厂内即可,因为 config.js 的 mock 工厂在 hook-post-compact 求值过程中
//      会被先取到。
vi.mock('../src/config.js', () => {
  if (!process.argv.includes('--agent-id')) {
    process.argv = [process.argv[0] ?? 'node', 'hook-post-compact.js', '--agent-id', 'eb_test', '--tool', 'claude-code'];
  }
  return {
    loadConfig: () => undefined,
    ensureDataDirs: () => undefined,
  };
});
vi.mock('../src/db/connection.js', () => ({
  getDb: () => { throw new Error('test: DB not available'); },
  closeDb: () => undefined,
}));
vi.mock('../src/db/sqlite-repository.js', () => ({
  SqliteRepository: class { constructor() { /* no-op */ } },
}));
vi.mock('../src/db/agents.js', () => ({
  touchAgent: () => undefined,
}));
vi.mock('../src/tools/prepare.js', () => ({
  prepare: async () => { throw new Error('test: prepare not invoked'); },
}));
vi.mock('../src/utils/migrate-data-dir.js', () => ({
  migrateDataDirIfNeeded: () => undefined,
}));
vi.mock('../src/hook-output.js', () => ({
  writeHookOutput: () => undefined,        // 抑制 stdout 噪声
  formatHookOutput: (s: string) => s,
}));

import { formatBriefContext } from '../src/hook-post-compact.js';
import type { PrepareOutput } from '../src/types.js';

// Helper:构造空骨架 PrepareOutput
function makeOutput(patch: Partial<PrepareOutput> = {}): PrepareOutput {
  return {
    profile: { text: '', generated_at: '2026-05-21T00:00:00Z' },
    keystones: [],
    tags: [],
    crystals: { highlighted: [], others: [] },
    recent: [],
    ...patch,
  };
}

describe('formatBriefContext (hook-post-compact)', () => {
  it('全空 → 返回空字符串', () => {
    expect(formatBriefContext(makeOutput())).toBe('');
  });

  it('只有 profile.text → 输出仅 "## 用户画像" 一段', () => {
    const out = formatBriefContext(
      makeOutput({
        profile: { text: '用户喜欢简洁工具', generated_at: '2026-05-21T00:00:00Z' },
      }),
    );
    expect(out).toBe('## 用户画像\n用户喜欢简洁工具');
    expect(out).not.toContain('## 关键枢纽');
    expect(out).not.toContain('## 近期结晶');
    expect(out).not.toContain('## 最近活跃');
  });

  it('profile.text 含多段(\\n\\n 分隔)→ 只取第一段', () => {
    const out = formatBriefContext(
      makeOutput({
        profile: {
          text: '第一段画像\n\n第二段(不应出现)\n\n第三段(不应出现)',
          generated_at: '2026-05-21T00:00:00Z',
        },
      }),
    );
    expect(out).toContain('第一段画像');
    expect(out).not.toContain('第二段');
    expect(out).not.toContain('第三段');
  });

  it('profile.text 为空字符串 → 不输出 "## 用户画像" 段', () => {
    const out = formatBriefContext(
      makeOutput({
        profile: { text: '', generated_at: '2026-05-21T00:00:00Z' },
      }),
    );
    expect(out).not.toContain('## 用户画像');
  });

  it('profile.text 全是空白 → 不输出 "## 用户画像" 段', () => {
    const out = formatBriefContext(
      makeOutput({
        profile: { text: '   \n\t\n  ', generated_at: '2026-05-21T00:00:00Z' },
      }),
    );
    expect(out).not.toContain('## 用户画像');
  });

  it('keystones 多于 3 个 → 截断到前 3', () => {
    const out = formatBriefContext(
      makeOutput({
        keystones: [
          { id: 'n1', title: 'A', type: 'idea', link_count: 5 },
          { id: 'n2', title: 'B', type: 'idea', link_count: 3 },
          { id: 'n3', title: 'C', type: 'idea', link_count: 2 },
          { id: 'n4', title: 'D', type: 'idea', link_count: 2 },
          { id: 'n5', title: 'E', type: 'idea', link_count: 1 },
        ],
      }),
    );
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toContain('C');
    expect(out).not.toContain('D');
    expect(out).not.toContain('E');
    // id: n4/n5 也不应泄漏
    expect(out).not.toMatch(/id: n4/);
    expect(out).not.toMatch(/id: n5/);
  });

  it('keystones 缺 title 时用 id 兜底', () => {
    const out = formatBriefContext(
      makeOutput({
        keystones: [
          { id: 'node_xyz', title: null, type: 'idea', link_count: 5 },
        ],
      }),
    );
    expect(out).toContain('- node_xyz（id: node_xyz）');
  });

  it('crystals.highlighted 不足 3 时,补 others 到 3 条', () => {
    const out = formatBriefContext(
      makeOutput({
        crystals: {
          highlighted: [
            { id: 'h1', title: '高亮1', snippet: 's1', heat: 0.9 },
          ],
          others: [
            { id: 'o1', title: '其他1' },
            { id: 'o2', title: '其他2' },
            { id: 'o3', title: '其他3' },
            { id: 'o4', title: '其他4' },
          ],
        },
      }),
    );
    // 1 个 highlighted + 2 个 others = 3 条总数
    expect(out).toContain('高亮1');
    expect(out).toContain('其他1');
    expect(out).toContain('其他2');
    expect(out).not.toContain('其他3');
    expect(out).not.toContain('其他4');
  });

  it('crystals.highlighted >= 3 时不补 others', () => {
    const out = formatBriefContext(
      makeOutput({
        crystals: {
          highlighted: [
            { id: 'h1', title: '高亮1', snippet: 's1', heat: 0.9 },
            { id: 'h2', title: '高亮2', snippet: 's2', heat: 0.8 },
            { id: 'h3', title: '高亮3', snippet: 's3', heat: 0.7 },
            { id: 'h4', title: '高亮4', snippet: 's4', heat: 0.6 },
          ],
          others: [
            { id: 'o1', title: '其他1' },
          ],
        },
      }),
    );
    expect(out).toContain('高亮1');
    expect(out).toContain('高亮2');
    expect(out).toContain('高亮3');
    expect(out).not.toContain('高亮4');     // highlighted 超 3 也截断
    expect(out).not.toContain('其他1');     // others 一概不补
  });

  it('crystals.highlighted 缺 title 时用 snippet 兜底', () => {
    const out = formatBriefContext(
      makeOutput({
        crystals: {
          highlighted: [
            { id: 'h1', title: null, snippet: '这是片段摘要', heat: 0.9 },
          ],
          others: [],
        },
      }),
    );
    expect(out).toContain('- 这是片段摘要（id: h1）');
  });

  it('crystals.others 缺 title 时用 id 兜底', () => {
    const out = formatBriefContext(
      makeOutput({
        crystals: {
          highlighted: [],
          others: [
            { id: 'crys_abc', title: null },
          ],
        },
      }),
    );
    expect(out).toContain('- crys_abc（id: crys_abc）');
  });

  it('crystals 全空 → 不输出 "## 近期结晶" 段', () => {
    const out = formatBriefContext(
      makeOutput({
        crystals: { highlighted: [], others: [] },
      }),
    );
    expect(out).not.toContain('## 近期结晶');
  });

  it('recent 超过 3 → 截断到 3', () => {
    const out = formatBriefContext(
      makeOutput({
        recent: [
          { id: 'r1', title: 'R1', type: 'idea', timestamp: '2026-05-21' },
          { id: 'r2', title: 'R2', type: 'idea', timestamp: '2026-05-20' },
          { id: 'r3', title: 'R3', type: 'idea', timestamp: '2026-05-19' },
          { id: 'r4', title: 'R4', type: 'idea', timestamp: '2026-05-18' },
          { id: 'r5', title: 'R5', type: 'idea', timestamp: '2026-05-17' },
        ],
      }),
    );
    expect(out).toContain('R1');
    expect(out).toContain('R2');
    expect(out).toContain('R3');
    expect(out).not.toContain('R4');
    expect(out).not.toContain('R5');
  });

  it('recent 缺 title 时用 id 兜底', () => {
    const out = formatBriefContext(
      makeOutput({
        recent: [
          { id: 'rec_999', title: null, type: 'idea', timestamp: '2026-05-21' },
        ],
      }),
    );
    expect(out).toContain('- rec_999（id: rec_999）');
  });

  it('全字段都满载 → 段落顺序为 profile → keystones → crystals → recent', () => {
    const out = formatBriefContext(
      makeOutput({
        profile: { text: 'P', generated_at: '2026-05-21' },
        keystones: [{ id: 'k1', title: 'K', type: 'idea', link_count: 1 }],
        crystals: {
          highlighted: [{ id: 'h1', title: 'H', snippet: 's', heat: 1 }],
          others: [],
        },
        recent: [{ id: 'r1', title: 'R', type: 'idea', timestamp: '2026-05-21' }],
      }),
    );
    const profileIdx = out.indexOf('## 用户画像');
    const keystoneIdx = out.indexOf('## 关键枢纽');
    const crystalIdx = out.indexOf('## 近期结晶');
    const recentIdx = out.indexOf('## 最近活跃');

    expect(profileIdx).toBeGreaterThanOrEqual(0);
    expect(keystoneIdx).toBeGreaterThan(profileIdx);
    expect(crystalIdx).toBeGreaterThan(keystoneIdx);
    expect(recentIdx).toBeGreaterThan(crystalIdx);
  });

  it('段落之间用 \\n\\n 分隔', () => {
    const out = formatBriefContext(
      makeOutput({
        profile: { text: 'P', generated_at: '2026-05-21' },
        keystones: [{ id: 'k1', title: 'K', type: 'idea', link_count: 1 }],
      }),
    );
    // 至少包含两段且中间有空行
    expect(out).toMatch(/## 用户画像[\s\S]*\n\n## 关键枢纽/);
  });

  // 2026-05-21 修复:keystones/crystals/recent 的 title 兜底从 ?? 改为 ||,
  // 空字符串 title 不再原样输出空标题,而是 fallback 到 id (或 snippet)。
  // 旧测试用例锁的是有 bug 的行为,现在反过来验证修复后的正确行为。
  it('keystones 单个,title 空字符串 → fallback 到 id(?? → || 后的行为)', () => {
    const out = formatBriefContext(
      makeOutput({
        keystones: [{ id: 'k1', title: '', type: 'idea', link_count: 1 }],
      }),
    );
    // 修复后:title='' 走 || 兜底回 id → '- k1（id: k1）'
    expect(out).toContain('- k1（id: k1）');
    // 不应再渲染出形如 '- （id: k1）' 这种空标题
    expect(out).not.toMatch(/^- （id: k1）/m);
  });

  it('crystals.highlighted title 空字符串 → fallback 到 snippet(|| 兜底)', () => {
    const out = formatBriefContext(
      makeOutput({
        crystals: {
          highlighted: [{ id: 'h1', title: '', snippet: '片段摘要兜底', heat: 0.9 }],
          others: [],
        },
      }),
    );
    expect(out).toContain('- 片段摘要兜底（id: h1）');
  });

  it('crystals.others title 空字符串 → fallback 到 id(|| 兜底)', () => {
    const out = formatBriefContext(
      makeOutput({
        crystals: {
          highlighted: [],
          others: [{ id: 'crys_empty', title: '' }],
        },
      }),
    );
    expect(out).toContain('- crys_empty（id: crys_empty）');
  });

  it('recent title 空字符串 → fallback 到 id(|| 兜底)', () => {
    const out = formatBriefContext(
      makeOutput({
        recent: [{ id: 'rec_empty', title: '', type: 'idea', timestamp: '2026-05-21' }],
      }),
    );
    expect(out).toContain('- rec_empty（id: rec_empty）');
  });
});
