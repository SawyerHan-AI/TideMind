/**
 * temporal-crystal prompt 测试
 *
 * 测试时间维度分析的质量：能否发现演变趋势、跨域共振、周期性模式
 */

import { initTestEnv, callWithStrategy, parseJSON, printReport, type TestCase, type TestResult } from './helpers.js';

interface TemporalInput { nodes: Array<{ date: string; content: string }>; mode: string; }
interface TemporalExpect {
  patternType: string;
  minInsightLength: number;
  shouldIdentifyTurningPoints?: boolean;
  insightKeywords?: string[];  // 期望 insight 中包含的关键词
}
interface TemporalOutput { pattern_type?: string; title?: string; insight: string; key_node_ids?: string[]; confidence: number; }

const TEST_CASES: TestCase<TemporalInput, TemporalExpect>[] = [
  // === 演变模式 ===
  {
    name: '演变-1: 游戏设计理念的职业演进',
    input: { mode: 'evolution', nodes: [
      { date: '2020-06', content: '星云互娱阶段：做商业手游关卡设计，关注付费转化率和留存数据' },
      { date: '2021-01', content: '开始反思纯数据驱动设计的局限，意识到玩家情感体验才是核心' },
      { date: '2022-03', content: '明途教育阶段：做教育游戏化产品，发现叙事驱动比奖励机制更能维持长期动力' },
      { date: '2023-06', content: '离职前的思考：商业游戏过度依赖心理操控，想做尊重玩家的游戏' },
      { date: '2024-03', content: '独立开发阶段：确立"玩家体验优先"原则，用程序化生成替代重复手工内容' },
    ]},
    expected: { patternType: 'evolution', minInsightLength: 80, shouldIdentifyTurningPoints: true, insightKeywords: ['游戏', '玩家'] },
  },
  {
    name: '演变-2: 程序化生成技术的迭代',
    input: { mode: 'evolution', nodes: [
      { date: '2022-02', content: '学习 Perlin Noise 生成地形，用 Unity 做了第一个 demo' },
      { date: '2022-05', content: '转向 Wave Function Collapse 算法，生成更有结构的地牢' },
      { date: '2022-09', content: '用 Godot 重写 WFC 实现，发现 GDScript 性能不够' },
      { date: '2024-01', content: '用 Rust 重写核心算法作为 Godot 插件，性能提升 20 倍' },
      { date: '2025-06', content: 'PixelForge 工具集成熟：WFC + BSP + L-system 组合，支持多层级生成' },
    ]},
    expected: { patternType: 'evolution', minInsightLength: 80, shouldIdentifyTurningPoints: true, insightKeywords: ['程序化', '生成', '性能'] },
  },
  {
    name: '演变-3: 工作经历变迁',
    input: { mode: 'evolution', nodes: [
      { date: '2020-07', content: '加入星云互娱做商业手游，负责关卡系统和数值策划' },
      { date: '2021-06', content: '项目组被优化，公司方向转向短视频互动游戏' },
      { date: '2022-04', content: '跳槽到明途教育，做教育游戏化产品，用 Godot 做交互式课件' },
      { date: '2023-03', content: '明途教育融资失败开始裁员，团队从20人缩到5人' },
      { date: '2023-09', content: '离开明途，决定全职独立开发，注册"像素熔炉"工作室' },
      { date: '2024-06', content: '第一款独立游戏《星尘编年史》开始开发，叙事驱动 roguelike' },
      { date: '2025-12', content: '并行维护多个项目：PixelForge 引擎工具、StarMap 天文摄影、BlogEngine 博客系统' },
    ]},
    expected: { patternType: 'evolution', minInsightLength: 80, shouldIdentifyTurningPoints: true },
  },
  {
    name: '演变-4: 部署策略从本地到云端',
    input: { mode: 'evolution', nodes: [
      { date: '2024-01', content: '项目直接在本地开发机上运行和测试' },
      { date: '2024-04', content: '租了 Hetzner 云服务器，开始把服务迁移上去' },
      { date: '2024-06', content: 'BlogEngine 部署到 Hetzner：Docker Compose + Caddy 反向代理' },
      { date: '2024-09', content: '多个服务统一部署流程：Docker + Caddy + GitHub Actions 自动部署' },
      { date: '2025-03', content: 'StarMap 后端 API 上线，加了 Caddy 自动 HTTPS 和访问限制' },
    ]},
    expected: { patternType: 'evolution', minInsightLength: 50 },
  },
  {
    name: '演变-5: PixelForge 工具链快速演进',
    input: { mode: 'evolution', nodes: [
      { date: '2024-01', content: '开始 PixelForge 项目，用 GDScript 写了第一批地牢生成脚本' },
      { date: '2024-03', content: '引入 Rust 编写核心算法，通过 GDExtension 接入 Godot 4' },
      { date: '2024-06', content: 'Blender 插件开发：自动生成低多边形资源，导出到 Godot' },
      { date: '2024-09', content: '地牢生成器支持三种算法组合：WFC + BSP + L-system' },
      { date: '2025-01', content: '加入 mod 支持系统，玩家可以用 Lua 脚本自定义生成规则' },
      { date: '2025-06', content: '性能优化：多线程生成 + 流式加载，大地图不再卡顿' },
      { date: '2025-12', content: '编辑器模式完善：可视化调参、实时预览、一键导出' },
    ]},
    expected: { patternType: 'evolution', minInsightLength: 80, insightKeywords: ['工具', '迭代'] },
  },

  // === 共振模式 ===
  {
    name: '共振-1: 多项目同时处理模块化设计',
    input: { mode: 'resonance', nodes: [
      { date: '2025-06-15', content: '[PixelForge] 重构为插件架构：每个生成算法是独立模块' },
      { date: '2025-06-15', content: '[MusicBox] 核心改动：每个音乐模式是独立的生成器模块' },
      { date: '2025-06-15', content: '[BlogEngine] 模板系统重写：每个主题是独立插件' },
    ]},
    expected: { patternType: 'resonance', minInsightLength: 50, insightKeywords: ['模块'] },
  },
  {
    name: '共振-2: 程序化生成理念在多处体现',
    input: { mode: 'resonance', nodes: [
      { date: '2025-09-01', content: '[PixelForge] 地牢布局：WFC 算法基于约束传播，自动满足设计规则' },
      { date: '2025-09-01', content: '[MusicBox] 旋律生成：马尔可夫链基于转移概率，自动满足和声规则' },
      { date: '2025-09-02', content: '[StarMap] 星图标注：基于天体亮度自动生成拍摄计划' },
      { date: '2025-09-02', content: '[BlogEngine] 目录和标签：基于文章内容自动生成分类' },
    ]},
    expected: { patternType: 'resonance', minInsightLength: 50, insightKeywords: ['自动', '生成'] },
  },
  {
    name: '共振-3: 跨时期的工具链偏好',
    input: { mode: 'resonance', nodes: [
      { date: '2022-04', content: '明途教育：选择 Godot 而非 Unity，因为开源、轻量、自由度高' },
      { date: '2023-06', content: '个人博客技术选型：选 Hugo 而非 WordPress，因为开源、快、无数据库' },
      { date: '2024-01', content: 'PixelForge 核心算法用 Rust：开源生态好、性能强、内存安全' },
      { date: '2025-03', content: 'StarMap 后端选 Rust + Actix：同样的开源偏好，一致的技术栈' },
    ]},
    expected: { patternType: 'resonance', minInsightLength: 50 },
  },
  {
    name: '共振-4: 不同领域的迭代思维',
    input: { mode: 'resonance', nodes: [
      { date: '2024-06', content: '《游戏设计艺术》读书笔记：好的游戏设计是不断原型→测试→迭代的循环' },
      { date: '2024-09', content: '围棋 AI 的启示：AlphaGo 通过自我对弈不断迭代策略' },
      { date: '2025-01', content: '程序化生成的核心：生成→评估→调整参数→重新生成的循环' },
      { date: '2025-06', content: '天文摄影：拍摄→叠加→处理→调整参数→重新拍摄的循环' },
    ]},
    expected: { patternType: 'resonance', minInsightLength: 50, insightKeywords: ['迭代'] },
  },

  // === 更多真实场景 ===
  {
    name: '演变-6: 围棋理解的深入',
    input: { mode: 'evolution', nodes: [
      { date: '2022-06', content: '开始学围棋，在弈城上打到业余3段' },
      { date: '2022-10', content: '研究 AI 围棋：AlphaGo 的蒙特卡罗树搜索 + 深度学习' },
      { date: '2023-03', content: '关注 KataGo 开源项目，尝试用它分析自己的棋局' },
      { date: '2024-06', content: '将围棋的"厚势"概念应用到游戏设计：前期投资换后期优势' },
    ]},
    expected: { patternType: 'evolution', minInsightLength: 50 },
  },
  {
    name: '演变-7: 天文摄影装备演进',
    input: { mode: 'evolution', nodes: [
      { date: '2023-03', content: '入门阶段：用手机拍月亮，买了第一台小型赤道仪' },
      { date: '2023-09', content: '升级到 80mm APO 折射望远镜 + 冷冻 CMOS 相机' },
      { date: '2024-03', content: '开始挑战深空天体：猎户座大星云、仙女座星系' },
      { date: '2025-01', content: '自制了简易的自动导星系统，用树莓派控制赤道仪' },
    ]},
    expected: { patternType: 'evolution', minInsightLength: 40 },
  },

  // === 脏数据 ===
  {
    name: '脏-1: 无关碎片',
    input: { mode: 'evolution', nodes: [
      { date: '2026-01-01', content: 'ok' },
      { date: '2026-06-01', content: 'test' },
      { date: '2026-12-01', content: '123' },
    ]},
    expected: { patternType: 'evolution', minInsightLength: 0 },
    dirty: true,
  },
  {
    name: '脏-2: 时间跨度极短无变化',
    input: { mode: 'evolution', nodes: [
      { date: '2025-09-01', content: '今天写了代码' },
      { date: '2025-09-01', content: '晚上喝了手冲咖啡' },
    ]},
    expected: { patternType: 'evolution', minInsightLength: 0 },
    dirty: true,
  },
];

function buildPrompt(tc: TestCase<TemporalInput, TemporalExpect>): string {
  const modeLabel = tc.input.mode === 'evolution' ? '项目时间线' : '同期不同项目';
  const timeline = tc.input.nodes.map((n, i) => `[${i + 1}] ${n.date} | ${n.content}`).join('\n');
  return `分析模式: ${modeLabel}\n\n按时间排列的记忆:\n${timeline}\n\n发现跨时间的模式和演变。`;
}

function evaluate(tc: TestCase<TemporalInput, TemporalExpect>, result: TemporalOutput | null): { passed: boolean; score: number; issues: string[] } {
  const issues: string[] = [];
  let score = 0;

  if (!result) { issues.push('解析失败'); return { passed: false, score: 0, issues }; }

  // insight 长度和质量（40%）
  if (result.insight && result.insight.length >= tc.expected.minInsightLength) {
    score += 0.3;
    // 检查是否只是按时间复述（不应该是）— 允许少量时间引用，只在明显过多时扣分
    const timeMarkers = (result.insight.match(/\d{4}/g) || []).length;
    const isOverlyChronological = timeMarkers > tc.input.nodes.length;
    if (isOverlyChronological && result.insight.length < 150) {
      issues.push('insight 过多引用具体时间，可能只是复述而非分析');
      score -= 0.1;
    } else {
      score += 0.1;
    }
  } else if (result.insight) {
    issues.push(`insight 太短: ${result.insight.length} < ${tc.expected.minInsightLength}`);
    score += 0.1;
  } else {
    issues.push('无 insight');
  }

  // pattern_type（15%）
  if (result.pattern_type) score += 0.15;

  // title（15%）
  if (result.title && result.title.length > 5) score += 0.15;
  else if (result.title) score += 0.05;

  // confidence 合理性（10%）
  if (result.confidence > 0 && result.confidence <= 1) score += 0.1;

  // 关键词命中（20%）
  if (tc.expected.insightKeywords && tc.expected.insightKeywords.length > 0 && result.insight) {
    const hits = tc.expected.insightKeywords.filter(k => result.insight.includes(k));
    if (hits.length > 0) score += 0.2;
    else issues.push(`insight 未包含期望关键词: ${tc.expected.insightKeywords.join(', ')}`);
  } else {
    score += 0.1;
  }

  // 脏数据处理
  if (tc.dirty && result.confidence > 0.7) {
    issues.push('脏数据不应有高 confidence');
  }

  return { passed: issues.length === 0, score: Math.min(1, Math.max(0, score)), issues };
}

async function run(): Promise<void> {
  await initTestEnv();
  console.log(`⏳ temporal-crystal 测试: ${TEST_CASES.length} 组\n`);
  const results: TestResult<TemporalInput, TemporalExpect, TemporalOutput>[] = [];
  for (const tc of TEST_CASES) {
    console.log(`  ${tc.name}`);
    try {
      const { text, durationMs } = await callWithStrategy('temporal-crystal', '', buildPrompt(tc), { model: 'heavy' });
      const output = parseJSON<TemporalOutput>(text);
      const eval_ = evaluate(tc, output);
      results.push({ name: tc.name, input: tc.input, expected: tc.expected, output, rawResponse: text, ...eval_, durationMs });
    } catch (err) {
      results.push({ name: tc.name, input: tc.input, expected: tc.expected, output: null, rawResponse: '', passed: false, score: 0, issues: ['调用失败'], durationMs: 0 });
    }
  }
  printReport('temporal-crystal', results);
}
run().catch(console.error);
