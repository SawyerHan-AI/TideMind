/**
 * reconsolidate prompt 测试 — 保守更新验证
 */

import { initTestEnv, callWithStrategy, parseJSON, printReport, type TestCase, type TestResult } from './helpers.js';

interface ReconInput { nodeContent: string; contextNodes: string[]; }
interface ReconExpect { needsUpdate: boolean; }
interface ReconOutput { needs_update: boolean; updated_content?: string; conflict_detected?: boolean; conflict_with_index?: number; new_independence?: number; reason?: string; }

const TEST_CASES: TestCase<ReconInput, ReconExpect>[] = [
  { name: '不更新-1: 无关上下文', input: { nodeContent: '决定用 Rust 编写核心算法', contextNodes: ['今天天气不错', '下午开了个会'] }, expected: { needsUpdate: false } },
  { name: '不更新-2: 互补信息', input: { nodeContent: 'PixelForge 用 Godot 4 做游戏引擎', contextNodes: ['Godot 4 支持 Vulkan 渲染后端', 'GDExtension 允许原生 Rust 插件'] }, expected: { needsUpdate: false } },
  { name: '不更新-3: 模糊措辞但不过时', input: { nodeContent: '项目进展顺利，预计下周完成', contextNodes: ['项目已有 120 个 tile 模板', '256 个测试全部通过'] }, expected: { needsUpdate: false } },
  { name: '不更新-4: 旧但仍正确', input: { nodeContent: '2024 年开始用 Rust 做个人项目', contextNodes: ['2025 年仍然在用 Rust', 'Rust 的 cargo 工具链很稳定'] }, expected: { needsUpdate: false } },
  { name: '不更新-5: 主观偏好无需更新', input: { nodeContent: '我喜欢像素风美术风格', contextNodes: ['最近在做像素风 + 手绘混搭的视觉设计', '用了 Aseprite 做动画'] }, expected: { needsUpdate: false } },
  { name: '不更新-6: 技术事实不变', input: { nodeContent: 'WFC 算法基于约束传播实现', contextNodes: ['WFC 用于 PixelForge 的房间填充模块', '约束传播确保生成结果满足连通性'] }, expected: { needsUpdate: false } },

  { name: '更新-1: 明确矛盾', input: { nodeContent: 'PixelForge 使用两种生成算法：WFC 和 BSP', contextNodes: ['生成管线升级为三种算法组合：WFC + BSP + L-system'] }, expected: { needsUpdate: true } },
  { name: '更新-2: 事实已改变', input: { nodeContent: '部署方式是手动 scp 到服务器', contextNodes: ['部署架构升级为 Docker Compose + Caddy + GitHub Actions 自动化'] }, expected: { needsUpdate: true } },
  { name: '更新-3: 数据过时', input: { nodeContent: '当前有 50 个 tile 模板', contextNodes: ['tile 模板库已扩充到 120 个', '256 个测试全部通过'] }, expected: { needsUpdate: true } },

  { name: '脏-1: 极短记忆', input: { nodeContent: 'ok', contextNodes: ['测试'] }, expected: { needsUpdate: false }, dirty: true },
  { name: '脏-2: 无上下文', input: { nodeContent: '正常的技术记录', contextNodes: [] }, expected: { needsUpdate: false }, dirty: true },
];

function buildPrompt(tc: TestCase<ReconInput, ReconExpect>): string {
  const ctx = tc.input.contextNodes.length > 0
    ? tc.input.contextNodes.map((c, i) => `上下文记忆 ${i + 1}: ${c}`).join('\n')
    : '(无上下文)';
  return `当前记忆: ${tc.input.nodeContent}\n\n${ctx}\n\n这条记忆是否需要更新？`;
}

function evaluate(tc: TestCase<ReconInput, ReconExpect>, result: ReconOutput | null): { passed: boolean; score: number; issues: string[] } {
  const issues: string[] = [];
  let score = 0;
  if (!result) { issues.push('解析失败'); return { passed: false, score: 0, issues }; }
  if (result.needs_update !== tc.expected.needsUpdate) {
    issues.push(`needs_update 错误: 期望 ${tc.expected.needsUpdate}, 得到 ${result.needs_update}`);
  } else {
    score += 0.6;
  }
  if (result.needs_update && result.updated_content && result.updated_content.length > 10) score += 0.2;
  else if (!result.needs_update) score += 0.2;
  if (result.reason && result.reason.length > 5) score += 0.2;
  return { passed: issues.length === 0, score: Math.min(1, score), issues };
}

async function run(): Promise<void> {
  await initTestEnv();
  console.log(`🔄 reconsolidate 测试: ${TEST_CASES.length} 组\n`);
  const results: TestResult<ReconInput, ReconExpect, ReconOutput>[] = [];
  for (const tc of TEST_CASES) {
    console.log(`  ${tc.name}`);
    try {
      const { text, durationMs } = await callWithStrategy('reconsolidate', '', buildPrompt(tc), { model: 'standard' });
      const output = parseJSON<ReconOutput>(text);
      const eval_ = evaluate(tc, output);
      results.push({ name: tc.name, input: tc.input, expected: tc.expected, output, rawResponse: text, ...eval_, durationMs });
    } catch (err) {
      results.push({ name: tc.name, input: tc.input, expected: tc.expected, output: null, rawResponse: '', passed: false, score: 0, issues: ['调用失败'], durationMs: 0 });
    }
  }
  printReport('reconsolidate', results);
}
run().catch(console.error);
