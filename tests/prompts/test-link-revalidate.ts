/**
 * link-revalidate prompt 测试
 *
 * 测试 recall 触发的链接重新验证：鲁棒性（不因无关上下文否定有效链接）+ 敏感性（真正过时的能识别）
 */

import { initTestEnv, callWithStrategy, parseJSON, isValidRelation, printReport, type TestCase, type TestResult } from './helpers.js';

interface RevalInput {
  query: string;
  recentInteractions?: string[];
  nodeA: string;
  nodeB: string;
  currentRelation: string;
  currentStrength: number;
}

interface RevalExpect {
  stillValid: boolean;
  newRelation?: string;
}

interface RevalOutput {
  still_valid: boolean;
  relation?: string;
  confidence?: number;
  reason?: string;
}

const TEST_CASES: TestCase<RevalInput, RevalExpect>[] = [
  // === 应该保持有效 ===
  { name: '保持-1: 上下文相关且链接正确', input: { query: 'PixelForge 架构设计', nodeA: '决定用 Rust 编写核心算法', nodeB: 'PixelForge 采用开源优先的技术选型策略', currentRelation: 'supports', currentStrength: 0.7 }, expected: { stillValid: true } },
  { name: '保持-2: 上下文无关不应影响判断', input: { query: '今天天气怎么样', nodeA: 'StarMap 后端部署到 Hetzner 服务器', nodeB: 'Docker Compose 编排多个服务容器', currentRelation: 'continues', currentStrength: 0.8 }, expected: { stillValid: true } },
  { name: '保持-3: 弱链接但仍有效', input: { query: '部署策略', nodeA: 'PixelForge 使用 Godot 4 游戏引擎', nodeB: 'Godot 4.3 引入 Typed Dictionaries', currentRelation: 'tagged', currentStrength: 0.4 }, expected: { stillValid: true } },
  { name: '保持-4: 因果链仍然成立', input: { query: '回顾 BUG 修复历史', nodeA: '修复了 WFC 边界 tile 越界 BUG', nodeB: '大尺寸地图生成时偶尔崩溃', currentRelation: 'caused_by', currentStrength: 0.8 }, expected: { stillValid: true } },
  { name: '保持-5: 长期有效的知识关联', input: { query: '程序化生成理论', nodeA: '《游戏设计艺术》的镜头方法：多维度审视同一设计', nodeB: 'PixelForge 从可玩性、美观性、挑战性三维度评估地牢', currentRelation: 'analogous', currentStrength: 0.7 }, expected: { stillValid: true } },
  { name: '保持-6: 完全无关查询不应干扰', input: { query: '明天有什么计划', nodeA: '柯洁 2024 围棋甲级联赛连续不败', nodeB: 'KataGo 是最强开源围棋 AI', currentRelation: 'tagged', currentStrength: 0.6 }, expected: { stillValid: true } },
  { name: '保持-7: 矛盾链接在新上下文中依然矛盾', input: { query: '技术选型偏好', nodeA: '后端首选 Python', nodeB: '所有项目统一用 Rust', currentRelation: 'contradicts', currentStrength: 0.7 }, expected: { stillValid: true } },
  { name: '保持-8: 概括关系不受时间影响', input: { query: '设计原则', nodeA: '技术选型遵循开源优先原则', nodeB: '选择 Godot 而非 Unity', currentRelation: 'summarizes', currentStrength: 0.8 }, expected: { stillValid: true } },

  // === 应该失效 ===
  { name: '失效-1: 新信息直接否定', input: { query: '我们最终放弃了 Godot，改用 Bevy 引擎', recentInteractions: ['digest: 项目迁移到 Bevy 引擎'], nodeA: 'PixelForge 采用 Godot 4 作为游戏引擎', nodeB: 'Godot 4 的 GDExtension 适合 Rust 原生插件开发', currentRelation: 'supports', currentStrength: 0.7 }, expected: { stillValid: false } },
  { name: '失效-2: 方案已被替代', input: { query: '当前的生成管线设计', recentInteractions: ['digest: 生成管线从三层简化为两层，去掉了 L-system'], nodeA: 'L-system 负责微观装饰：植被、裂缝、苔藓等', nodeB: 'L-system 模块的参数配置文件格式', currentRelation: 'continues', currentStrength: 0.6 }, expected: { stillValid: false } },
  { name: '失效-3: 关系类型需要调整', input: { query: 'StarMap 的架构演进', recentInteractions: ['recall: StarMap v2 完全用 Rust 重写了后端'], nodeA: 'StarMap v2 用 Actix-web 替代 Flask', nodeB: 'StarMap 初始用 Python + Flask', currentRelation: 'continues', currentStrength: 0.6 }, expected: { stillValid: true, newRelation: 'updates' } },

  // === 边界 ===
  { name: '边界-1: 模糊语境', input: { query: '之前讨论过什么', nodeA: '用 Docker Compose 编排服务', nodeB: '用 Caddy 做反向代理', currentRelation: 'tagged', currentStrength: 0.5 }, expected: { stillValid: true } },
  { name: '边界-2: 部分过时', input: { query: '编辑器改造', recentInteractions: ['digest: 编辑器从参数面板改为可视化节点图'], nodeA: '编辑器由参数调节面板和实时预览组成', nodeB: '编辑器像调参工具而非设计工具', currentRelation: 'supports', currentStrength: 0.6 }, expected: { stillValid: true } },

  // === 脏数据 ===
  { name: '脏-1: 空查询', input: { query: '', nodeA: '正常记忆', nodeB: '正常记忆', currentRelation: 'supports', currentStrength: 0.7 }, expected: { stillValid: true }, dirty: true },
  { name: '脏-2: 极短节点', input: { query: '测试', nodeA: 'ok', nodeB: 'yes', currentRelation: 'tagged', currentStrength: 0.3 }, expected: { stillValid: false }, dirty: true },

  // === 更多保持场景（确保不过度失效） ===
  { name: '保持-9: 跨项目类比不受项目变化影响', input: { query: 'PixelForge 最新进展', nodeA: 'MusicBox 音乐生成：曲式→和弦→旋律', nodeB: 'PixelForge 地牢生成：区域→房间→装饰', currentRelation: 'analogous', currentStrength: 0.6 }, expected: { stillValid: true } },
  { name: '保持-10: 技术事实不会因时间失效', input: { query: '数据库选型', nodeA: 'SQLite WAL 模式支持并发读', nodeB: 'better-sqlite3 是同步 API', currentRelation: 'supports', currentStrength: 0.5 }, expected: { stillValid: true } },
  { name: '保持-11: 偏好类链接除非明确否定否则不失效', input: { query: '设计偏好', nodeA: '喜欢像素风美术风格', nodeB: '游戏采用像素风 + 手绘混搭', currentRelation: 'supports', currentStrength: 0.7 }, expected: { stillValid: true } },

  // === 更多失效场景 ===
  { name: '失效-4: 过时的计划', input: { query: '项目状态', recentInteractions: ['digest: 个人主页项目暂时搁置，优先做 PixelForge'], nodeA: '打算下周开始做个人主页', nodeB: '个人主页技术栈：Astro + Three.js', currentRelation: 'continues', currentStrength: 0.6 }, expected: { stillValid: true } },

  // === 不应该因查询改变关系 ===
  { name: '不变-1: 查询暗示不同关系但原关系正确', input: { query: '什么导致了 BUG', nodeA: '256 个测试全部通过', nodeB: 'Rust 编译通过', currentRelation: 'tagged', currentStrength: 0.5 }, expected: { stillValid: true } },
];

function buildPrompt(tc: TestCase<RevalInput, RevalExpect>): string {
  const parts = [
    `当前 recall 查询: ${tc.input.query}`,
    tc.input.recentInteractions ? `最近交互:\n${tc.input.recentInteractions.map(i => `  - ${i}`).join('\n')}` : '',
    '',
    `正在评估的链接:`,
    `A: ${tc.input.nodeA}`,
    `B: ${tc.input.nodeB}`,
    `当前关系: ${tc.input.currentRelation} (strength: ${tc.input.currentStrength.toFixed(2)})`,
    '',
    `在当前语境下，这条链接还成立吗？关系类型是否需要调整？`,
  ].filter(Boolean);
  return parts.join('\n');
}

function evaluate(tc: TestCase<RevalInput, RevalExpect>, result: RevalOutput | null): { passed: boolean; score: number; issues: string[] } {
  const issues: string[] = [];
  let score = 0;

  if (!result) { issues.push('解析失败'); return { passed: false, score: 0, issues }; }

  if (result.still_valid !== tc.expected.stillValid) {
    issues.push(`still_valid 错误: 期望 ${tc.expected.stillValid}, 得到 ${result.still_valid}`);
  } else {
    score += 0.6;
  }

  if (tc.expected.newRelation && result.relation) {
    if (result.relation !== tc.expected.newRelation) {
      issues.push(`新关系不匹配: 期望 ${tc.expected.newRelation}, 得到 ${result.relation}`);
    } else {
      score += 0.3;
    }
  } else {
    score += 0.2;
  }

  if (result.reason && result.reason.length > 5) score += 0.1;

  return { passed: issues.length === 0, score: Math.min(1, score), issues };
}

async function run(): Promise<void> {
  await initTestEnv();
  console.log(`🔄 link-revalidate 测试: ${TEST_CASES.length} 组用例\n`);

  const results: TestResult<RevalInput, RevalExpect, RevalOutput>[] = [];

  for (const tc of TEST_CASES) {
    console.log(`  ${tc.name}`);
    try {
      const prompt = buildPrompt(tc);
      const { text, durationMs } = await callWithStrategy('link-revalidate', '', prompt, { model: 'standard' });
      const output = parseJSON<RevalOutput>(text);
      const eval_ = evaluate(tc, output);
      results.push({ name: tc.name, input: tc.input, expected: tc.expected, output, rawResponse: text, ...eval_, durationMs });
    } catch (err) {
      results.push({ name: tc.name, input: tc.input, expected: tc.expected, output: null, rawResponse: (err as Error).message, passed: false, score: 0, issues: [`调用失败: ${(err as Error).message}`], durationMs: 0 });
    }
  }

  printReport('link-revalidate', results);
}

run().catch(console.error);
