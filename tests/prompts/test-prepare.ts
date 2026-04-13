/**
 * prepare-assemble prompt 测试
 *
 * 测试认知包组装的质量：生成的行为指导是否具体、可执行、基于事实
 */

import { initTestEnv, callWithStrategy, printReport, type TestCase, type TestResult } from './helpers.js';

interface PrepareInput {
  profile: string;
  project?: string;
  recentTopics?: string[];
  crystals?: string[];
}
interface PrepareExpect {
  minLines: number;
  maxLines: number;
  shouldBeActionable: boolean;
  shouldReflectProfile?: boolean;  // 指导应反映用户画像中的特征
  profileKeywords?: string[];       // 指导中应包含的画像关键词
}

const TEST_CASES: TestCase<PrepareInput, PrepareExpect>[] = [
  // === 技术项目上下文 ===
  {
    name: '指导-1: PixelForge 游戏引擎工具开发上下文',
    input: {
      profile: '独立游戏开发者，偏好开源工具链，使用 Godot 4 + Rust + Blender。沟通风格直接高效，重视第一性原理思考。正在开发程序化地牢生成工具集。',
      project: 'PixelForge',
      recentTopics: ['WFC 算法优化', 'Rust GDExtension 接口', 'mod 支持系统'],
    },
    expected: { minLines: 3, maxLines: 7, shouldBeActionable: true, shouldReflectProfile: true, profileKeywords: ['开源', '直接', 'Godot'] },
  },
  {
    name: '指导-2: StarMap 天文摄影管理上下文',
    input: {
      profile: '独立开发者兼天文摄影爱好者，正在维护一个深空天体拍摄管理工具，使用 Rust + Actix + SQLite。关注自动化拍摄计划和图像叠加流程。',
      project: 'StarMap',
      recentTopics: ['自动导星算法', '图像叠加优化', 'FITS 文件解析'],
    },
    expected: { minLines: 3, maxLines: 7, shouldBeActionable: true },
  },

  // === 无特定项目 ===
  {
    name: '指导-3: 多项目并行无焦点',
    input: {
      profile: '关注游戏设计理论、程序化生成、开源工具链。有多个进行中的项目：PixelForge、StarMap、BlogEngine。偏好深度讨论而非表面建议。',
      recentTopics: ['PixelForge 插件架构重构', 'BlogEngine 主题系统', 'MusicBox 原型'],
    },
    expected: { minLines: 3, maxLines: 7, shouldBeActionable: true },
  },

  // === 业务/商业上下文 ===
  {
    name: '指导-4: 独立游戏商业化探索',
    input: {
      profile: '独立游戏开发者，分析了 Steam 上 42 款同类 roguelike 游戏的商业表现。关注差异化定位和社区运营。对"换皮游戏"持批评态度。',
      project: 'StardustChronicle',
    },
    expected: { minLines: 3, maxLines: 7, shouldBeActionable: true, profileKeywords: ['差异化', 'roguelike'] },
  },
  {
    name: '指导-5: 技术博客运营',
    input: {
      profile: '技术博主，运营 "Code & Pixels" 博客，写游戏开发和程序化生成技术文章。关注内容质量和 SEO，使用自研静态博客系统。',
      project: 'BlogEngine',
      recentTopics: ['文章推荐算法', 'Markdown 渲染优化', 'RSS 订阅功能'],
    },
    expected: { minLines: 3, maxLines: 7, shouldBeActionable: true },
  },

  // === 学习研究上下文 ===
  {
    name: '指导-6: 游戏设计理论研究',
    input: {
      profile: '最近在研究游戏设计理论（《游戏设计艺术》《Rules of Play》）和程序化内容生成（PCG），并将理论应用到 PixelForge 的设计中。偏好从第一性原理思考问题。',
      crystals: [
        '技术选型遵循开源优先原则',
        '设计中倾向玩家体验优先：宁可减少内容量也不降低单个内容的质量',
      ],
    },
    expected: { minLines: 3, maxLines: 7, shouldBeActionable: true },
  },
  {
    name: '指导-7: 程序化生成方法论研究',
    input: {
      profile: '游戏开发者，持续研究 PCG 方法论。关注 WFC、BSP、L-system 等算法的应用场景。信奉"程序化生成不是随机，而是用算法编码设计意图"。',
      recentTopics: ['WFC 约束传播优化', '多层级生成管线', '玩家反馈驱动的参数调整'],
    },
    expected: { minLines: 3, maxLines: 7, shouldBeActionable: true, profileKeywords: ['程序化', '生成'] },
  },

  // === 兴趣爱好上下文 ===
  {
    name: '指导-8: 休闲讨论',
    input: {
      profile: '兴趣广泛：天文摄影（偏好深空天体）、围棋（关注 AI 围棋发展）、科幻小说（阿西莫夫和刘慈欣的忠实读者）、手冲咖啡（研究不同产区风味特点）。',
    },
    expected: { minLines: 3, maxLines: 7, shouldBeActionable: true },
  },

  // === 特殊画像 ===
  {
    name: '指导-9: 强调沟通风格',
    input: {
      profile: '沟通要求：直接说结论不绕弯子，有不同意见直接指出，不要敷衍式同意。代码风格偏好简洁、不过度抽象。中文沟通为主。',
      project: 'PixelForge',
    },
    expected: { minLines: 3, maxLines: 7, shouldBeActionable: true, profileKeywords: ['直接', '简洁'] },
  },
  {
    name: '指导-10: 含结晶洞察的上下文',
    input: {
      profile: '独立游戏开发者，多个个人项目并行。重视项目间的技术复用和模式迁移。',
      crystals: [
        '多个项目中反复出现相同的模块化架构：插件 + 注册表 + 配置文件',
        '部署策略统一为 Docker + Caddy，所有服务走相同的运维流程',
        '设计中倾向选择约束更强的方案来减少后续决策负担',
      ],
      recentTopics: ['PixelForge mod 系统', 'Hetzner 服务器部署'],
    },
    expected: { minLines: 3, maxLines: 7, shouldBeActionable: true },
  },

  // === 其他场景 ===
  {
    name: '指导-11: 科幻阅读与创作',
    input: {
      profile: '科幻小说爱好者，阅读了大量阿西莫夫和刘慈欣的作品。正在将科幻元素融入游戏叙事设计。关注硬科幻中的科学合理性。',
    },
    expected: { minLines: 3, maxLines: 7, shouldBeActionable: true },
  },
  {
    name: '指导-12: 咖啡与感官训练',
    input: {
      profile: '手冲咖啡爱好者，系统性地研究不同产区的风味特点。认为咖啡品鉴和游戏设计的共同点在于"体验的层次感"。重视感官训练的方法论。',
      recentTopics: ['埃塞俄比亚日晒 vs 水洗风味差异', '游戏中的感官反馈设计'],
    },
    expected: { minLines: 3, maxLines: 7, shouldBeActionable: true },
  },

  // === 脏数据 ===
  {
    name: '脏-1: 空画像',
    input: { profile: '' },
    expected: { minLines: 1, maxLines: 7, shouldBeActionable: false },
    dirty: true,
  },
  {
    name: '脏-2: 极短画像',
    input: { profile: '一个人' },
    expected: { minLines: 1, maxLines: 7, shouldBeActionable: false },
    dirty: true,
  },
];

function buildPrompt(tc: TestCase<PrepareInput, PrepareExpect>): string {
  const parts = [`用户画像: ${tc.input.profile}`];
  if (tc.input.project) parts.push(`当前项目: ${tc.input.project}`);
  if (tc.input.recentTopics && tc.input.recentTopics.length > 0) {
    parts.push(`最近活跃话题: ${tc.input.recentTopics.join(', ')}`);
  }
  if (tc.input.crystals && tc.input.crystals.length > 0) {
    parts.push(`已有高层洞察:\n${tc.input.crystals.map(c => `- ${c}`).join('\n')}`);
  }
  parts.push('\n生成个性化的行为指导。');
  return parts.join('\n');
}

function evaluate(tc: TestCase<PrepareInput, PrepareExpect>, text: string): { passed: boolean; score: number; issues: string[] } {
  const issues: string[] = [];
  let score = 0;
  const lines = text.trim().split('\n').filter(l => l.trim().length > 0);

  // 行数范围（25%）
  if (lines.length >= tc.expected.minLines && lines.length <= tc.expected.maxLines) score += 0.25;
  else {
    issues.push(`行数 ${lines.length} 不在 [${tc.expected.minLines}, ${tc.expected.maxLines}] 范围`);
    if (lines.length > 0) score += 0.1;
  }

  // 可执行性（25%）
  if (tc.expected.shouldBeActionable) {
    const vague = ['保持', '注意', '继续努力', '加油', '记得', '不要忘记'];
    const vagueCount = lines.filter(l => vague.some(v => l.includes(v)) && l.length < 20).length;
    if (vagueCount > lines.length / 2) {
      issues.push('超过半数指导过于笼统空洞');
    } else {
      score += 0.25;
    }
  } else {
    score += 0.15;
  }

  // 画像反映度（25%）
  if (tc.expected.profileKeywords && tc.expected.profileKeywords.length > 0) {
    const hits = tc.expected.profileKeywords.filter(k => text.includes(k));
    if (hits.length > 0) {
      score += 0.25;
    } else {
      // 也接受语义上相关但措辞不同的情况，给部分分
      score += 0.1;
      issues.push(`指导未反映画像关键特征: ${tc.expected.profileKeywords.join(', ')}`);
    }
  } else if (tc.expected.shouldReflectProfile) {
    // 检查是否提到了画像中的具体内容
    const profileWords = tc.input.profile.match(/[\u4e00-\u9fff]{2,}|[A-Z][a-z]+[A-Za-z]*/g) || [];
    const mentioned = profileWords.filter(w => text.includes(w));
    if (mentioned.length >= 2) score += 0.25;
    else { score += 0.1; issues.push('指导与用户画像关联度不足'); }
  } else {
    score += 0.15;
  }

  // 不应包含 JSON（10%）
  if (!text.includes('{')) score += 0.1;
  else issues.push('输出包含 JSON');

  // 内容质量（15%）— 每条指导应有实质内容
  const substantiveLines = lines.filter(l => l.trim().length > 15);
  if (substantiveLines.length >= Math.min(3, lines.length)) score += 0.15;
  else { score += 0.05; issues.push('部分指导内容过短'); }

  return { passed: issues.length === 0, score: Math.min(1, Math.max(0, score)), issues };
}

async function run(): Promise<void> {
  await initTestEnv();
  console.log(`📋 prepare-assemble 测试: ${TEST_CASES.length} 组\n`);
  const results: TestResult<PrepareInput, PrepareExpect, string>[] = [];
  for (const tc of TEST_CASES) {
    console.log(`  ${tc.name}`);
    try {
      const { text, durationMs } = await callWithStrategy('prepare-assemble', '', buildPrompt(tc), { model: 'standard' });
      const eval_ = evaluate(tc, text);
      results.push({ name: tc.name, input: tc.input, expected: tc.expected, output: text, rawResponse: text, ...eval_, durationMs });
    } catch (err) {
      results.push({ name: tc.name, input: tc.input, expected: tc.expected, output: null, rawResponse: '', passed: false, score: 0, issues: ['调用失败'], durationMs: 0 });
    }
  }
  printReport('prepare-assemble', results);
}
run().catch(console.error);
