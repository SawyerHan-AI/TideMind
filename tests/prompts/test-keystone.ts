/**
 * keystone-enrich prompt 测试
 *
 * 测试枢纽节点分析的质量：是否能具体说明连接了哪些不同领域
 */

import { initTestEnv, callWithStrategy, printReport, type TestCase, type TestResult } from './helpers.js';

interface KeystoneInput { nodeContent: string; neighborContents: string[]; }
interface KeystoneExpect {
  minLength: number;
  shouldMentionDomains: boolean;
  domainKeywords?: string[];  // 期望提及的领域关键词（至少命中一个）
}

const TEST_CASES: TestCase<KeystoneInput, KeystoneExpect>[] = [
  // === 技术架构枢纽 ===
  {
    name: '枢纽-1: PixelForge 技术栈核心',
    input: {
      nodeContent: 'PixelForge 采用 Godot 4 + Rust + Blender 的开源工具链架构',
      neighborContents: [
        'Rust 核心算法通过 GDExtension 接入 Godot，性能提升 20 倍',
        '像素风 + 手绘混搭的美术风格设计',
        '三种程序化生成算法组合：WFC + BSP + L-system',
        'mod 支持系统允许玩家用 Lua 脚本自定义生成规则',
        '地牢评估从可玩性、美观性、挑战性三个维度打分',
        'Blender 插件自动生成低多边形资源导出到 Godot',
      ],
    },
    expected: { minLength: 30, shouldMentionDomains: true, domainKeywords: ['算法', '美术', '生成', 'mod', '评估', '工具'] },
  },
  {
    name: '枢纽-2: 开源优先技术选型策略',
    input: {
      nodeContent: '所有项目优先选择开源工具链',
      neighborContents: [
        '选 Godot 而非 Unity，因为开源、轻量、无授权费',
        '核心算法用 Rust：开源生态好、性能强、内存安全',
        'Hugo 作为博客生成器：开源、快速、零依赖',
        '部署用 Docker + Caddy：都是开源项目，社区活跃',
        'PixelForge 本身也计划开源核心生成器模块',
        'StarMap 的后端框架 Actix-web 也是开源项目',
      ],
    },
    expected: { minLength: 30, shouldMentionDomains: true, domainKeywords: ['引擎', '部署', '项目', '工具'] },
  },

  // === 跨项目枢纽 ===
  {
    name: '枢纽-3: Hetzner 云服务器',
    input: {
      nodeContent: 'Hetzner 云服务器作为统一的项目托管平台',
      neighborContents: [
        'StarMap 后端部署到 Hetzner Helsinki 节点：Docker Compose + Caddy',
        'BlogEngine 通过 GitHub Actions 自动部署到 Hetzner',
        'PixelForge 的 CI 测试也在 Hetzner 上跑',
        'MusicBox 的 Web Demo 托管在同一台 Hetzner 服务器',
        '统一用 Docker + Caddy 的部署模式',
      ],
    },
    expected: { minLength: 30, shouldMentionDomains: true, domainKeywords: ['StarMap', 'BlogEngine', '部署', '服务'] },
  },

  // === 知识方法论枢纽 ===
  {
    name: '枢纽-4: 程序化内容生成作为核心方法论',
    input: {
      nodeContent: '程序化生成不是随机，而是用算法编码设计意图',
      neighborContents: [
        'WFC 算法基于约束传播，确保生成结果满足预设规则',
        'BSP 树分割用于宏观区域划分，保证空间结构合理',
        'L-system 模拟植物生长，为场景添加自然装饰',
        '马尔可夫链用于 MusicBox 的旋律生成',
        'StarMap 的自动拍摄计划也是一种程序化调度',
        'PixelForge 的 mod 系统让玩家也能参与程序化规则的定义',
      ],
    },
    expected: { minLength: 30, shouldMentionDomains: true, domainKeywords: ['算法', '生成', '游戏', '音乐'] },
  },

  // === 游戏设计枢纽 ===
  {
    name: '枢纽-5: 玩家体验优先原则',
    input: {
      nodeContent: '游戏设计的核心：玩家体验优先，宁可减少内容量也不降低质量',
      neighborContents: [
        '心流设计：难度曲线匹配玩家技能成长',
        'roguelike 的每次运行都是新故事，保持新鲜感',
        'mod 支持让玩家参与创作，延长游戏寿命',
        '叙事驱动而非数值堆叠，尊重玩家智商',
        '程序化生成减少手工内容但保证质量下限',
      ],
    },
    expected: { minLength: 30, shouldMentionDomains: true, domainKeywords: ['玩家', '设计', '内容', '体验'] },
  },

  // === 兴趣爱好枢纽 ===
  {
    name: '枢纽-6: 围棋与 AI',
    input: {
      nodeContent: '围棋是策略博弈的极致形式，AI 围棋是人工智能的重要里程碑',
      neighborContents: [
        'AlphaGo 的蒙特卡罗树搜索 + 深度学习彻底改变了围棋',
        'KataGo 开源项目让普通棋手也能用 AI 分析棋局',
        '围棋中"厚势"的概念可以类比到游戏设计中的前期投资',
        '"先手"的价值可以映射到 mod API 设计的主动权',
        '业余3段水平，在弈城上下棋',
        'AI 围棋让人重新思考"创造力"的本质',
      ],
    },
    expected: { minLength: 30, shouldMentionDomains: true, domainKeywords: ['围棋', 'AI', '策略', '游戏'] },
  },

  // === 天文摄影枢纽 ===
  {
    name: '枢纽-7: 深空天文摄影',
    input: {
      nodeContent: '天文摄影是技术与艺术的结合，深空天体需要长时间曝光和精确追踪',
      neighborContents: [
        '80mm APO 折射望远镜 + 冷冻 CMOS 相机的装备组合',
        '猎户座大星云、仙女座星系是入门级深空目标',
        '自制树莓派自动导星系统控制赤道仪',
        'StarMap 工具管理拍摄计划和图像处理流程',
        '图像叠加技术提升信噪比：单张噪点多，叠加几十张后细节浮现',
        'FITS 文件格式是天文摄影的标准数据格式',
      ],
    },
    expected: { minLength: 30, shouldMentionDomains: true, domainKeywords: ['天文', '摄影', '设备', '图像'] },
  },

  // === 科幻文学枢纽 ===
  {
    name: '枢纽-8: 科幻小说与游戏叙事',
    input: {
      nodeContent: '科幻小说是游戏叙事的重要灵感来源，尤其是硬科幻中的世界观构建',
      neighborContents: [
        '阿西莫夫的《基地》系列：宏大的历史叙事和文明兴衰',
        '刘慈欣的《三体》：硬科幻中的物理学想象力',
        '《星尘编年史》的叙事借鉴了阿西莫夫的多线叙事结构',
        'roguelike 的随机叙事和科幻小说的世界观设定有天然契合',
        '科幻中的"费米悖论"可以作为游戏世界观的设定基础',
        '硬科幻要求科学合理性，游戏设计也需要内在逻辑一致性',
      ],
    },
    expected: { minLength: 30, shouldMentionDomains: true, domainKeywords: ['科幻', '叙事', '游戏', '世界观'] },
  },

  // === 咖啡与感官枢纽 ===
  {
    name: '枢纽-9: 手冲咖啡与体验设计',
    input: {
      nodeContent: '手冲咖啡的核心是控制变量来呈现豆子的最佳风味',
      neighborContents: [
        '不同产区的风味特点：埃塞俄比亚（花香果酸）、哥伦比亚（坚果巧克力）、肯尼亚（明亮莓果）',
        '水温、研磨度、注水方式都会影响萃取结果',
        '咖啡品鉴的层次感和游戏设计的体验层次有相似之处',
        '日晒 vs 水洗处理法的风味差异：日晒更浓郁，水洗更干净',
      ],
    },
    expected: { minLength: 30, shouldMentionDomains: true, domainKeywords: ['咖啡', '风味', '体验', '变量'] },
  },

  // === 方法论枢纽 ===
  {
    name: '枢纽-10: 模块化设计哲学',
    input: {
      nodeContent: '模块化架构是所有项目的共同设计原则：独立组件 + 注册表 + 配置驱动',
      neighborContents: [
        'PixelForge 的生成算法是独立插件，通过注册表加载',
        'MusicBox 的音乐模式是独立生成器模块',
        'BlogEngine 的主题是独立插件，支持热切换',
        'Godot 本身的节点系统就是模块化的典范',
        'mod 系统让玩家也能编写独立模块扩展游戏',
      ],
    },
    expected: { minLength: 30, shouldMentionDomains: true, domainKeywords: ['模块', '插件', '项目', '架构'] },
  },

  // === 独立开发者身份枢纽 ===
  {
    name: '枢纽-11: 独立开发者的多面身份',
    input: {
      nodeContent: '独立游戏开发者需要同时扮演程序员、设计师、美术、运营、客服多个角色',
      neighborContents: [
        '程序化生成是独立开发者的"人力倍增器"——用算法替代手工内容',
        '技术博客是建立个人品牌和获取反馈的重要渠道',
        'Steam Wishlists 是衡量游戏市场期待度的关键指标',
        'mod 支持让玩家社区替代部分内容生产的角色',
        '开源工具链降低了独立开发的成本门槛',
      ],
    },
    expected: { minLength: 30, shouldMentionDomains: true, domainKeywords: ['开发', '设计', '运营', '社区'] },
  },

  // === 脏数据 ===
  {
    name: '脏-1: 无邻居',
    input: { nodeContent: 'ok', neighborContents: [] },
    expected: { minLength: 5, shouldMentionDomains: false },
    dirty: true,
  },
  {
    name: '脏-2: 极短邻居',
    input: { nodeContent: 'test', neighborContents: ['a', 'b', 'c'] },
    expected: { minLength: 5, shouldMentionDomains: false },
    dirty: true,
  },
];

function buildPrompt(tc: TestCase<KeystoneInput, KeystoneExpect>): string {
  const neighbors = tc.input.neighborContents.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
  return `枢纽节点: ${tc.input.nodeContent}\n\n链接到的记忆:\n${neighbors}\n\n为什么这个节点是知识枢纽？它连接了哪些不同的主题？`;
}

function evaluate(tc: TestCase<KeystoneInput, KeystoneExpect>, text: string): { passed: boolean; score: number; issues: string[] } {
  const issues: string[] = [];
  let score = 0;

  // 长度（20%）
  if (text.length >= tc.expected.minLength) score += 0.2;
  else issues.push(`输出太短: ${text.length} < ${tc.expected.minLength}`);

  // 不应是泛泛的"重要"（20%）
  const vague = ['很重要', '非常关键', '至关重要'];
  const isJustVague = vague.some(v => text.includes(v)) && text.length < 50;
  if (isJustVague) issues.push('过于笼统，缺乏具体说明');
  else score += 0.2;

  // 应该是纯文本不是 JSON（10%）
  if (!text.includes('{') && !text.includes('[')) score += 0.1;
  else issues.push('输出包含 JSON 格式');

  // 领域覆盖度（30%）— 是否提及了不同的主题领域
  if (tc.expected.domainKeywords && tc.expected.domainKeywords.length > 0) {
    const hits = tc.expected.domainKeywords.filter(k => text.includes(k));
    const coverage = hits.length / tc.expected.domainKeywords.length;
    if (coverage >= 0.3) score += 0.3 * Math.min(1, coverage / 0.5);
    else issues.push(`领域覆盖不足: 仅命中 ${hits.join(', ')} (期望至少包含部分: ${tc.expected.domainKeywords.join(', ')})`);
  } else {
    score += 0.15;
  }

  // 具体性（20%）— 应提到具体的邻居内容或概念（脏数据豁免）
  if (!tc.dirty) {
    const neighborKeywords = tc.input.neighborContents
      .flatMap(n => n.match(/[\u4e00-\u9fff]{2,}|[A-Z][a-z]+[A-Za-z]*/g) || [])
      .filter(w => w.length >= 2);
    const mentionedCount = new Set(neighborKeywords.filter(k => text.includes(k))).size;
    if (mentionedCount >= 2) score += 0.2;
    else if (mentionedCount >= 1) score += 0.15;
    else { score += 0.05; issues.push('没有提及任何邻居的具体内容'); }
  } else {
    score += 0.1;
  }

  return { passed: issues.length === 0, score: Math.min(1, Math.max(0, score)), issues };
}

async function run(): Promise<void> {
  await initTestEnv();
  console.log(`🔑 keystone-enrich 测试: ${TEST_CASES.length} 组\n`);
  const results: TestResult<KeystoneInput, KeystoneExpect, string>[] = [];
  for (const tc of TEST_CASES) {
    console.log(`  ${tc.name}`);
    try {
      const { text, durationMs } = await callWithStrategy('keystone-enrich', '', buildPrompt(tc), { model: 'standard' });
      const eval_ = evaluate(tc, text);
      results.push({ name: tc.name, input: tc.input, expected: tc.expected, output: text, rawResponse: text, ...eval_, durationMs });
    } catch (err) {
      results.push({ name: tc.name, input: tc.input, expected: tc.expected, output: null, rawResponse: '', passed: false, score: 0, issues: ['调用失败'], durationMs: 0 });
    }
  }
  printReport('keystone-enrich', results);
}
run().catch(console.error);
