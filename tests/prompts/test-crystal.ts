/**
 * crystal-emerge (拓扑结晶) prompt 测试
 *
 * 测试从节点群中提炼高层洞察的质量
 */

import { initTestEnv, callWithStrategy, parseJSON, printReport, type TestCase, type TestResult } from './helpers.js';

interface CrystalInput {
  nodeContents: string[];
}

interface CrystalExpect {
  minLength: number;        // 内容最小字数
  shouldBeAbstract: boolean; // 应比源节点更抽象
  shouldHaveTags: boolean;
}

interface CrystalOutput {
  content: string;
  tags?: string[];
  confidence?: number;
}

const TEST_CASES: TestCase<CrystalInput, CrystalExpect>[] = [
  {
    name: '结晶-1: 技术选型决策群',
    input: { nodeContents: [
      '选择 Godot 4 作为游戏引擎，因为开源、轻量、无授权费',
      'PixelForge 核心算法用 Rust 编写，通过 GDExtension 接入 Godot',
      '部署统一使用 Docker + Caddy，所有服务走相同的运维流程',
      'StarMap 后端选择 Actix-web 框架，与 PixelForge 共享 Rust 工具链',
      'BlogEngine 用 Hugo 作为静态生成器，追求构建速度和零依赖',
    ]},
    expected: { minLength: 50, shouldBeAbstract: true, shouldHaveTags: true },
  },
  {
    name: '结晶-2: 部署运维群',
    input: { nodeContents: [
      'StarMap 后端部署到 Hetzner：Docker Compose + Caddy 反向代理',
      'BlogEngine 通过 GitHub Actions 自动构建，推送到 Hetzner 服务器',
      'PixelForge 本地开发为主，CI 只跑测试不部署',
      '所有项目统一用 Hetzner 云服务器，月费可控',
    ]},
    expected: { minLength: 30, shouldBeAbstract: true, shouldHaveTags: true },
  },
  {
    name: '结晶-3: 游戏设计理念群',
    input: { nodeContents: [
      '玩家体验优先——宁可减少内容量也不降低单个内容的质量',
      '程序化生成不是随机，而是用算法编码设计意图',
      '模块化架构方便 mod 支持——让玩家社区参与内容创作',
      '难度曲线应该匹配玩家的技能成长——"心流"设计',
      '叙事驱动的 roguelike：每次运行都是一个新故事，而非纯数值堆叠',
    ]},
    expected: { minLength: 80, shouldBeAbstract: true, shouldHaveTags: true },
  },
  {
    name: '结晶-4: 跨项目程序化生成模式',
    input: { nodeContents: [
      'PixelForge 地牢生成：宏观分割→中观填充→微观装饰',
      'MusicBox 音乐生成：曲式结构→和弦进行→旋律细节',
      'BlogEngine 文章推荐：分类聚合→相似度排序→个性化调整',
    ]},
    expected: { minLength: 30, shouldBeAbstract: true, shouldHaveTags: true },
  },
  // 脏数据
  {
    name: '脏-1: 无关节点',
    input: { nodeContents: ['ok', 'yes', 'test', '123'] },
    expected: { minLength: 0, shouldBeAbstract: false, shouldHaveTags: false },
    dirty: true,
  },
];

function buildPrompt(tc: TestCase<CrystalInput, CrystalExpect>): string {
  return tc.input.nodeContents.map((c, i) => `记忆 ${i + 1}: ${c}`).join('\n\n');
}

function evaluate(tc: TestCase<CrystalInput, CrystalExpect>, result: CrystalOutput | null): { passed: boolean; score: number; issues: string[] } {
  const issues: string[] = [];
  let score = 0;

  if (!result) { issues.push('解析失败'); return { passed: false, score: 0, issues }; }

  if (result.content.length >= tc.expected.minLength) score += 0.4;
  else issues.push(`内容太短: ${result.content.length} < ${tc.expected.minLength}`);

  if (tc.expected.shouldBeAbstract) {
    const isJustListing = result.content.includes('1.') && result.content.includes('2.') && result.content.includes('3.');
    if (isJustListing) { issues.push('内容是简单罗列而非抽象归纳'); score += 0.1; }
    else score += 0.3;
  } else score += 0.2;

  if (tc.expected.shouldHaveTags && result.tags && result.tags.length > 0) score += 0.2;
  else if (!tc.expected.shouldHaveTags) score += 0.1;

  if (result.confidence && result.confidence > 0 && result.confidence <= 1) score += 0.1;

  return { passed: issues.length === 0, score: Math.min(1, score), issues };
}

async function run(): Promise<void> {
  await initTestEnv();
  console.log(`💎 crystal-emerge 测试: ${TEST_CASES.length} 组用例\n`);

  const results: TestResult<CrystalInput, CrystalExpect, CrystalOutput>[] = [];

  for (const tc of TEST_CASES) {
    console.log(`  ${tc.name}`);
    try {
      const prompt = buildPrompt(tc);
      const { text, durationMs } = await callWithStrategy('crystal-emerge', '', prompt, { model: 'heavy' });
      const output = parseJSON<CrystalOutput>(text);
      const eval_ = evaluate(tc, output);
      results.push({ name: tc.name, input: tc.input, expected: tc.expected, output, rawResponse: text, ...eval_, durationMs });
    } catch (err) {
      results.push({ name: tc.name, input: tc.input, expected: tc.expected, output: null, rawResponse: (err as Error).message, passed: false, score: 0, issues: [`调用失败`], durationMs: 0 });
    }
  }

  printReport('crystal-emerge', results);
}

run().catch(console.error);
