/**
 * annotate prompt 测试
 *
 * 测试三维度评分准确性 + 标签一致性 + 项目识别
 */

import { initTestEnv, callWithStrategy, parseJSON, isInRange, printReport, type TestCase, type TestResult } from './helpers.js';

// ---- 类型 ----

interface AnnotateInput {
  content: string;
  existingTags?: string[];
  neighborContents?: string[];
}

interface AnnotateExpect {
  specificityRange: [number, number];
  subjectivityRange: [number, number];
  actualityRange: [number, number];
  expectTags?: string[];       // 期望包含的标签
  rejectTags?: string[];       // 不应出现的标签
  expectProject?: string | null;
}

interface AnnotateOutput {
  index: number;
  specificity: number;
  subjectivity: number;
  actuality: number;
  tags: string[];
  project: string | null;
}

// ---- 已有词汇表（模拟真实环境） ----

const EXISTING_TAGS = [
  'PixelForge', 'StarMap', 'architecture', 'bug-fix', 'deployment',
  'procedural-generation', 'game-design', 'Godot', 'Rust', 'Blender',
  'optimization', 'UI', 'thinking-model', 'plugin', 'modding',
  'astrophotography', 'coffee', 'Go-game', '设计决策', '初始化流程',
];

const EXISTING_PROJECTS = [
  'PixelForge', 'StarMap', 'BlogEngine', 'MusicBox',
  'PersonalSite', 'DevToolkit', 'StardustChronicle',
];

// ---- 当前 prompt ----

// 测试用 system prompt 留空，让 callWithStrategy 直接使用策略文件中的最新版本
const SYSTEM_PROMPT = '';

// ---- 测试用例（30+ 组）----

const TEST_CASES: TestCase<AnnotateInput, AnnotateExpect>[] = [
  // === 高 specificity（绑定具体情景） ===
  {
    name: '具体-1: 含时间地点的事件',
    input: { content: '2025-09-15 在本地开发机上修复了 PixelForge 中 WFC 约束传播时边界 tile 越界的 BUG' },
    expected: { specificityRange: [0.7, 1.0], subjectivityRange: [0.0, 0.3], actualityRange: [0.8, 1.0] },
  },
  {
    name: '具体-2: 部署操作记录',
    input: { content: '用 Docker Compose 把 StarMap 后端部署到 Hetzner 服务器（Helsinki 节点），通过 Caddy 配置自动 HTTPS' },
    expected: { specificityRange: [0.8, 1.0], subjectivityRange: [0.0, 0.2], actualityRange: [0.8, 1.0], expectProject: 'StarMap', expectTags: ['deployment'] },
  },
  {
    name: '具体-3: 具体决策',
    input: { content: '决定用 Rust 而不是 C++ 编写 PixelForge 核心算法，因为内存安全和 Godot 4 GDExtension 支持' },
    expected: { specificityRange: [0.6, 0.9], subjectivityRange: [0.2, 0.5], actualityRange: [0.8, 1.0], expectProject: 'PixelForge', expectTags: ['Rust'] },
  },

  // === 低 specificity（通用知识） ===
  {
    name: '通用-1: 一般规律',
    input: { content: 'Wave Function Collapse 算法的核心是约束传播：每次坍缩一个单元格后，相邻单元格的可选项自动缩小' },
    expected: { specificityRange: [0.1, 0.4], subjectivityRange: [0.0, 0.3], actualityRange: [0.6, 1.0], expectTags: ['procedural-generation'] },
  },
  {
    name: '通用-2: 知识性事实',
    input: { content: 'Godot 4 的 GDExtension 接口允许用 C/C++/Rust 编写原生插件，无需重新编译引擎' },
    expected: { specificityRange: [0.0, 0.3], subjectivityRange: [0.0, 0.2], actualityRange: [0.9, 1.0], expectTags: ['Godot'] },
  },

  // === 高 subjectivity（主观偏好） ===
  {
    name: '主观-1: 明确偏好',
    input: { content: '我喜欢像素风 + 手绘混搭的美术风格，有复古感但不显廉价' },
    expected: { specificityRange: [0.2, 0.5], subjectivityRange: [0.7, 1.0], actualityRange: [0.7, 1.0], expectTags: ['UI'] },
  },
  {
    name: '主观-2: 价值判断',
    input: { content: '我觉得游戏设计最重要的不是玩法多，而是核心循环的手感足够好' },
    expected: { specificityRange: [0.0, 0.3], subjectivityRange: [0.7, 1.0], actualityRange: [0.6, 1.0] },
  },
  {
    name: '主观-3: 审美倾向',
    input: { content: '不喜欢 Unity 那种臃肿的编辑器，更偏向 Godot 轻量灵活的开发体验' },
    expected: { specificityRange: [0.3, 0.6], subjectivityRange: [0.7, 1.0], actualityRange: [0.7, 1.0] },
  },

  // === 低 actuality（猜测/计划） ===
  {
    name: '猜测-1: 未验证的想法',
    input: { content: '也许应该把地牢生成的约束规则做成数据驱动的，玩家可以通过 JSON 配置文件自定义' },
    expected: { specificityRange: [0.3, 0.7], subjectivityRange: [0.3, 0.6], actualityRange: [0.0, 0.4] },
  },
  {
    name: '猜测-2: 计划未执行',
    input: { content: '打算下周开始做个人主页项目，用 Astro + Three.js 做一个带 3D 星空背景的作品集' },
    expected: { specificityRange: [0.5, 0.8], subjectivityRange: [0.3, 0.6], actualityRange: [0.1, 0.4], expectProject: 'PersonalSite' },
  },
  {
    name: '猜测-3: 假设性推理',
    input: { content: '如果 PixelForge 的 L-system 用 GPU 并行计算会不会更快？可能在小规模场景下反而更慢' },
    expected: { specificityRange: [0.4, 0.7], subjectivityRange: [0.3, 0.8], actualityRange: [0.0, 0.4] },
  },

  // === 高 actuality（已确认事实） ===
  {
    name: '事实-1: 已完成的工作',
    input: { content: 'PixelForge 全部 5 个核心模块完成：M1 WFC 生成器、M2 BSP 分割器、M3 L-system 植被、M4 光照烘焙、M5 导出管线' },
    expected: { specificityRange: [0.7, 1.0], subjectivityRange: [0.0, 0.2], actualityRange: [0.9, 1.0], expectProject: 'PixelForge' },
  },
  {
    name: '事实-2: 确定的技术事实',
    input: { content: 'Hetzner CPX31 云服务器的价格是 €15.90/月，4 vCPU + 8GB RAM' },
    expected: { specificityRange: [0.5, 1.0], subjectivityRange: [0.0, 0.2], actualityRange: [0.9, 1.0], expectTags: ['deployment'] },
  },

  // === 标签一致性测试 ===
  {
    name: '标签-1: 应复用已有标签',
    input: { content: '优化了 PixelForge 的 Rust 核心模块，WFC 生成速度提升 3 倍', existingTags: ['PixelForge', 'Rust'] },
    expected: { specificityRange: [0.6, 0.9], subjectivityRange: [0.0, 0.3], actualityRange: [0.8, 1.0], expectTags: ['PixelForge', 'Rust'], rejectTags: ['pixelforge', 'pixel-forge', 'rust'] },
  },
  {
    name: '标签-2: 不创建过于宽泛的标签',
    input: { content: 'StarMap 的 FITS 文件解析出了 BUG，HDU 扩展头没有正确处理' },
    expected: { specificityRange: [0.7, 1.0], subjectivityRange: [0.0, 0.2], actualityRange: [0.9, 1.0], expectTags: ['StarMap', 'bug-fix'], rejectTags: ['技术', '开发', '编程'] },
  },
  {
    name: '标签-3: 新领域应创建新标签',
    input: { content: '柯洁在 2024 年围棋甲级联赛中表现出色，连续 12 场不败' },
    expected: { specificityRange: [0.7, 1.0], subjectivityRange: [0.0, 0.3], actualityRange: [0.9, 1.0], expectTags: ['Go-game'] },
  },

  // === 项目识别 ===
  {
    name: '项目-1: 明确提到项目名',
    input: { content: 'MusicBox V2 的核心改动是引入马尔可夫链做旋律生成' },
    expected: { specificityRange: [0.5, 0.8], subjectivityRange: [0.1, 0.4], actualityRange: [0.8, 1.0], expectProject: 'MusicBox' },
  },
  {
    name: '项目-2: 没有项目',
    input: { content: '学习了程序化内容生成的基本原理：噪声函数、约束传播、语法规则' },
    expected: { specificityRange: [0.1, 0.4], subjectivityRange: [0.1, 0.4], actualityRange: [0.6, 1.0], expectProject: null },
  },
  {
    name: '项目-3: 多项目交叉',
    input: { content: '把 StarMap 和 BlogEngine 的部署脚本统一了，都用 Docker Compose + Caddy' },
    expected: { specificityRange: [0.7, 1.0], subjectivityRange: [0.0, 0.3], actualityRange: [0.8, 1.0] },
    // 两个项目都合理，不强制判断
  },

  // === 混合维度 ===
  {
    name: '混合-1: 主观决策（半主观半客观）',
    input: { content: '选择 Godot 4 而非 Unity 做游戏引擎，因为开源自由度高，虽然 Unity 生态更成熟' },
    expected: { specificityRange: [0.4, 0.8], subjectivityRange: [0.3, 0.7], actualityRange: [0.7, 1.0], expectTags: ['Godot'] },
  },
  {
    name: '混合-2: 带猜测的事实',
    input: { content: '256 个测试全部通过，但我怀疑 WFC 在大尺寸地图上可能有性能问题，某些极端情况没有被测到' },
    expected: { specificityRange: [0.5, 0.8], subjectivityRange: [0.3, 0.7], actualityRange: [0.4, 0.9] },
  },

  // === 内容类型覆盖 ===
  {
    name: '类型-1: 日记风格（碎片化）',
    input: { content: '今天试了 KataGo 分析自己的棋局，发现中盘判断力还是太弱。下午调了 WFC 的参数。晚上想到可以把围棋的"势"用到地牢生成的区域规划上。' },
    expected: { specificityRange: [0.6, 0.9], subjectivityRange: [0.4, 0.8], actualityRange: [0.5, 0.9] },
  },
  {
    name: '类型-2: 书籍笔记',
    input: { content: '《游戏设计艺术》核心概念：镜头（lens）是分析游戏的不同视角，好的游戏设计师能同时通过多个镜头审视同一个设计。游戏的本质是体验，不是机制。' },
    expected: { specificityRange: [0.1, 0.4], subjectivityRange: [0.0, 0.3], actualityRange: [0.7, 1.0] },
  },
  {
    name: '类型-3: 长篇技术分析',
    input: { content: 'Godot 4 的渲染架构采用 Vulkan 后端，场景树通过 RenderingServer 提交渲染命令。关键设计是 MultiMesh：一次 draw call 渲染数千个相同网格体的实例，非常适合程序化生成的场景——地牢中大量重复的砖块和装饰物可以用 MultiMesh 一次性渲染。' },
    expected: { specificityRange: [0.4, 0.8], subjectivityRange: [0.1, 0.4], actualityRange: [0.8, 1.0] },
  },

  // === 脏数据 ===
  {
    name: '脏-1: 极短内容',
    input: { content: 'ok' },
    expected: { specificityRange: [0.0, 0.5], subjectivityRange: [0.0, 0.5], actualityRange: [0.0, 0.5] },
    dirty: true,
  },
  {
    name: '脏-2: 纯数字',
    input: { content: '12345678901234567890' },
    expected: { specificityRange: [0.0, 1.0], subjectivityRange: [0.0, 0.5], actualityRange: [0.0, 1.0] },
    dirty: true,
  },
  {
    name: '脏-3: 特殊字符',
    input: { content: '!@#$%^&*()_+-=[]{}|;:,.<>?' },
    expected: { specificityRange: [0.0, 1.0], subjectivityRange: [0.0, 1.0], actualityRange: [0.0, 1.0] },
    dirty: true,
  },
  {
    name: '脏-4: 重复文本',
    input: { content: '测试测试测试测试测试测试测试测试测试测试测试测试测试测试测试测试测试测试' },
    expected: { specificityRange: [0.0, 1.0], subjectivityRange: [0.0, 1.0], actualityRange: [0.0, 1.0] },
    dirty: true,
  },

  // === 边界 ===
  {
    name: '边界-1: 英文内容',
    input: { content: 'Godot 4.3 introduces typed dictionaries and improved GDExtension API, enabling better Rust integration for native plugins.' },
    expected: { specificityRange: [0.2, 0.6], subjectivityRange: [0.0, 0.2], actualityRange: [0.8, 1.0] },
  },
  {
    name: '边界-2: 中英混合',
    input: { content: '用 cargo test 跑了一下 PixelForge 的 Rust 模块，256 passed，0 failed。coverage 还没看' },
    expected: { specificityRange: [0.7, 1.0], subjectivityRange: [0.0, 0.3], actualityRange: [0.8, 1.0], expectProject: 'PixelForge' },
  },
];

// ---- 运行测试 ----

function buildPrompt(cases: TestCase<AnnotateInput, AnnotateExpect>[]): string {
  const header = `已有标签（优先复用）: ${EXISTING_TAGS.join(', ')}\n已有项目: ${EXISTING_PROJECTS.join(', ')}\n\n`;
  const parts: string[] = [header];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    parts.push(`记忆 ${i + 1}: ${c.input.content}`);
    if (c.input.existingTags && c.input.existingTags.length > 0) {
      parts.push(`  来源标签: [${c.input.existingTags.join(', ')}]`);
    }
    if (c.input.neighborContents && c.input.neighborContents.length > 0) {
      parts.push(`  相关记忆: ${c.input.neighborContents.map(n => `"${n.slice(0, 100)}"`).join(', ')}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

function evaluate(
  tc: TestCase<AnnotateInput, AnnotateExpect>,
  result: AnnotateOutput | null,
): { passed: boolean; score: number; issues: string[] } {
  const issues: string[] = [];
  let score = 0;

  if (!result) {
    issues.push('LLM 返回解析失败');
    return { passed: false, score: 0, issues };
  }

  const e = tc.expected;

  // 维度评分（各占 15%）
  if (isInRange(result.specificity, e.specificityRange[0], e.specificityRange[1])) {
    score += 0.15;
  } else {
    issues.push(`specificity ${result.specificity.toFixed(2)} 不在期望范围 [${e.specificityRange}]`);
  }

  if (isInRange(result.subjectivity, e.subjectivityRange[0], e.subjectivityRange[1])) {
    score += 0.15;
  } else {
    issues.push(`subjectivity ${result.subjectivity.toFixed(2)} 不在期望范围 [${e.subjectivityRange}]`);
  }

  if (isInRange(result.actuality, e.actualityRange[0], e.actualityRange[1])) {
    score += 0.15;
  } else {
    issues.push(`actuality ${result.actuality.toFixed(2)} 不在期望范围 [${e.actualityRange}]`);
  }

  // 标签（占 30%）
  if (e.expectTags) {
    const found = e.expectTags.filter(t => result.tags.some(rt => rt.toLowerCase() === t.toLowerCase()));
    if (found.length === e.expectTags.length) {
      score += 0.3;
    } else {
      const missing = e.expectTags.filter(t => !result.tags.some(rt => rt.toLowerCase() === t.toLowerCase()));
      issues.push(`缺少期望标签: ${missing.join(', ')} (得到: ${result.tags.join(', ')})`);
      score += 0.3 * (found.length / e.expectTags.length);
    }
  } else {
    // 没有指定期望标签，只要有标签就给分
    score += result.tags.length > 0 ? 0.3 : 0;
  }

  if (e.rejectTags) {
    const rejected = e.rejectTags.filter(t => result.tags.some(rt => rt.toLowerCase() === t.toLowerCase()));
    if (rejected.length > 0) {
      issues.push(`不应出现的标签变体: ${rejected.join(', ')}`);
      score -= 0.15;
    }
  }

  // 项目（占 25%）
  if (e.expectProject !== undefined) {
    if (e.expectProject === null && result.project === null) {
      score += 0.25;
    } else if (e.expectProject && result.project?.toLowerCase() === e.expectProject.toLowerCase()) {
      score += 0.25;
    } else if (e.expectProject) {
      issues.push(`项目不匹配: 期望 ${e.expectProject}, 得到 ${result.project}`);
    } else {
      issues.push(`不应有项目，但得到 ${result.project}`);
    }
  } else {
    score += 0.15; // 没有指定预期，给部分分
  }

  score = Math.min(1, Math.max(0, score));
  const passed = issues.length === 0;
  return { passed, score, issues };
}

async function run(): Promise<void> {
  await initTestEnv();

  console.log(`📝 annotate 测试: ${TEST_CASES.length} 组用例\n`);

  const BATCH_SIZE = 10;
  const results: TestResult<AnnotateInput, AnnotateExpect, AnnotateOutput>[] = [];

  for (let batchStart = 0; batchStart < TEST_CASES.length; batchStart += BATCH_SIZE) {
    const batch = TEST_CASES.slice(batchStart, batchStart + BATCH_SIZE);
    console.log(`  批次 ${Math.floor(batchStart / BATCH_SIZE) + 1}: ${batch.map(c => c.name).join(', ')}`);

    const prompt = buildPrompt(batch);
    const { text, durationMs } = await callWithStrategy('annotate', SYSTEM_PROMPT, prompt, { model: 'light', maxTokens: 4096 });
    const parsed = parseJSON<AnnotateOutput[]>(text);

    if (!parsed) {
      console.log(`\n  [DEBUG] 批次 ${Math.floor(batchStart / BATCH_SIZE) + 1} 解析失败，原始响应 (前 300 字):\n  ${text.slice(0, 300)}\n`);
    }

    for (let i = 0; i < batch.length; i++) {
      const tc = batch[i];
      const output = parsed ? parsed.find(r => r.index === i + 1) ?? null : null;
      const eval_ = evaluate(tc, output);

      results.push({
        name: tc.name,
        input: tc.input,
        expected: tc.expected,
        output,
        rawResponse: i === 0 ? text : '',
        ...eval_,
        durationMs: Math.round(durationMs / batch.length),
      });
    }
  }

  printReport('annotate', results);
}

run().catch(console.error);
