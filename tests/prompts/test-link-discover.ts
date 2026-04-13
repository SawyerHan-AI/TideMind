/**
 * link-discover prompt 测试
 *
 * 测试链接发现的质量：有价值的连接能发现、无价值的不强行建立
 * 使用 scan-divergent 的 prompt（link-discover 复用它）
 */

import { initTestEnv, callWithStrategy, parseJSON, isValidRelation, printReport, type TestCase, type TestResult } from './helpers.js';

// ---- 类型 ----

interface DiscoverInput {
  contentA: string;
  contentB: string;
  sharedContext: string[];
}

interface DiscoverExpect {
  hasConnection: boolean;
  relation?: string;
  insightQuality?: 'specific' | 'generic' | 'any'; // insight 质量要求
}

interface DiscoverOutput {
  has_connection: boolean;
  insight?: string;
  confidence?: number;
  relation_type?: string;
}

// ---- 测试用例（30+ 组）----

const TEST_CASES: TestCase<DiscoverInput, DiscoverExpect>[] = [
  // === 应该发现的连接 ===
  {
    name: '发现-1: 跨项目相似模式',
    input: {
      contentA: 'PixelForge 的地牢生成采用三层架构：宏观（BSP 分割区域）、中观（WFC 填充房间）、微观（L-system 装饰细节）',
      contentB: 'MusicBox 的音乐生成也用了三层结构：宏观（曲式结构）、中观（和弦进行）、微观（旋律装饰音）',
      sharedContext: ['两者都是程序化内容生成的多层级架构'],
    },
    expected: { hasConnection: true, relation: 'analogous', insightQuality: 'specific' },
  },
  {
    name: '发现-2: 不同时期的技术偏好关联',
    input: {
      contentA: '2022年在明途教育选择 Godot 而非 Unity，因为开源、轻量、无授权费用',
      contentB: '2024年 PixelForge 核心用 Rust 而非 C++，同样是开源优先、社区活跃、工具链现代',
      sharedContext: ['技术选型偏好', '开源工具链策略'],
    },
    expected: { hasConnection: true, insightQuality: 'specific' },
  },
  {
    name: '发现-3: 因果关联',
    input: {
      contentA: '在星云互娱做商业手游时，发现纯数据驱动的关卡设计让游戏缺乏灵魂，玩家留存靠心理操控',
      contentB: 'PixelForge 的设计哲学强调"玩家体验优先"，用程序化生成保证内容多样性但不牺牲手感',
      sharedContext: ['游戏设计理念'],
    },
    expected: { hasConnection: true, insightQuality: 'specific' },
  },
  {
    name: '发现-4: 书籍笔记与实践关联',
    input: {
      contentA: '《游戏设计艺术》核心概念：好的游戏设计师用多个"镜头"审视设计，每个镜头揭示不同层面的问题',
      contentB: 'PixelForge 的地牢评估系统从三个维度打分：可玩性（路径通达）、美观性（视觉节奏）、挑战性（敌人分布）',
      sharedContext: ['多维度评估方法在游戏设计中的应用'],
    },
    expected: { hasConnection: true, relation: 'analogous', insightQuality: 'specific' },
  },
  {
    name: '发现-5: 围棋理论的跨域应用',
    input: {
      contentA: '围棋中"厚势"的概念：前期投入建立安全壁垒，中后期转化为全局优势',
      contentB: 'PixelForge 的 mod 系统设计：前期花大量时间做好插件 API 和文档，后期玩家社区自发产出内容',
      sharedContext: ['长期投资回报策略'],
    },
    expected: { hasConnection: true, relation: 'analogous', insightQuality: 'specific' },
  },

  // === 应该发现但关系微妙 ===
  {
    name: '微妙-1: 互补知识',
    input: {
      contentA: 'Godot 4 的 GDExtension 允许 Rust 编写的原生模块直接操作 SceneTree',
      contentB: 'PixelForge 的 Rust 核心模块通过 GDExtension 暴露生成 API，Godot 端只负责渲染和交互',
      sharedContext: ['Godot 与 Rust 的集成架构'],
    },
    expected: { hasConnection: true, relation: 'supports' },
  },
  {
    name: '微妙-2: 问题和解法的关联',
    input: {
      contentA: '程序化生成的地牢如果完全随机，很容易出现死胡同或不可达区域',
      contentB: 'PixelForge 用 WFC 的约束传播确保每个生成的地牢都满足连通性规则',
      sharedContext: ['程序化生成的质量控制'],
    },
    expected: { hasConnection: true, relation: 'caused_by' },
  },

  // === 不应该发现的连接 ===
  {
    name: '无关-1: 完全不同领域',
    input: {
      contentA: '柯洁在 2024 年围棋甲级联赛中保持不败',
      contentB: '今天用 V60 手冲了一杯耶加雪菲日晒豆，花香很明显',
      sharedContext: [],
    },
    expected: { hasConnection: false },
  },
  {
    name: '无关-2: 表面相似实则无关',
    input: {
      contentA: 'Rust 的所有权系统通过编译期检查防止内存泄漏',
      contentB: 'StarMap 是一个天文摄影管理工具，帮助用户管理拍摄的深空天体照片',
      sharedContext: ['都和 Rust 技术栈有关'],
    },
    expected: { hasConnection: false },
  },
  {
    name: '无关-3: 同领域但真的无关',
    input: {
      contentA: 'Godot 4.3 引入了 Typed Dictionaries',
      contentB: 'Blender 4.0 的 Geometry Nodes 支持模拟物理效果',
      sharedContext: ['游戏开发工具'],
    },
    expected: { hasConnection: false },
  },
  {
    name: '无关-4: 时间巧合',
    input: {
      contentA: '2025-06-15 重构了 PixelForge 的插件架构',
      contentB: '2025-06-15 拍了一张仙女座星系的照片',
      sharedContext: ['同一天的事件'],
    },
    expected: { hasConnection: false },
  },
  {
    name: '无关-5: 都是技术但无交叉',
    input: {
      contentA: 'SQLite 的 WAL 模式通过写前日志实现并发读写',
      contentB: 'CSS Grid 的 auto-fit 和 auto-fill 的区别在于空列的处理',
      sharedContext: [],
    },
    expected: { hasConnection: false },
  },

  // === 边界情况 ===
  {
    name: '边界-1: 弱关联',
    input: {
      contentA: '用 Rust 写后端代码比 Python 性能好',
      contentB: 'PixelForge 的核心算法是用 Rust 写的',
      sharedContext: ['Rust'],
    },
    expected: { hasConnection: false }, // 太弱了，不是"有价值的非显而易见的联系"
  },
  {
    name: '边界-2: 同项目不同方面',
    input: {
      contentA: 'PixelForge 的 UI 采用像素风 + 手绘混搭风格',
      contentB: 'PixelForge 的核心算法用 Rust 通过 GDExtension 接入 Godot',
      sharedContext: ['PixelForge'],
    },
    expected: { hasConnection: false }, // 同项目但无内在联系
  },

  // === 真实数据模拟 ===
  {
    name: '真实-1: 部署经验复用',
    input: {
      contentA: 'StarMap 后端部署到 Hetzner：Docker Compose 编排服务，Caddy 自动 HTTPS',
      contentB: 'BlogEngine 的部署配置：同样用 Docker + Caddy，加了 GitHub Actions 自动部署',
      sharedContext: ['Hetzner 服务器上的服务部署'],
    },
    expected: { hasConnection: true, insightQuality: 'specific' },
  },
  {
    name: '真实-2: 设计理念迁移',
    input: {
      contentA: '围棋中"先手"的价值：主动权决定了局势走向，被动应对永远落后一步',
      contentB: 'PixelForge 的 mod API 设计优先开放核心接口：让 modder 有创造的主动权，而非只能在预设框架内微调',
      sharedContext: ['主动权与系统设计'],
    },
    expected: { hasConnection: true, relation: 'analogous', insightQuality: 'specific' },
  },

  // === insight 质量测试 ===
  {
    name: 'insight-1: 不应该是泛泛的关联',
    input: {
      contentA: '用 AI 辅助分析了 15 个开源游戏引擎的架构，一天完成了原本一周的调研量',
      contentB: 'AI 让独立开发者能够独立完成以前需要团队的工作',
      sharedContext: ['AI 对独立开发者效率的影响'],
    },
    expected: { hasConnection: true, relation: 'supports', insightQuality: 'specific' },
  },

  // === 脏数据 ===
  {
    name: '脏-1: 空内容',
    input: { contentA: '', contentB: '正常记忆内容', sharedContext: [] },
    expected: { hasConnection: false },
    dirty: true,
  },
  {
    name: '脏-2: 乱码',
    input: { contentA: 'asdf1234!@#$', contentB: 'qwerty7890%^&*', sharedContext: ['乱码'] },
    expected: { hasConnection: false },
    dirty: true,
  },
  {
    name: '脏-3: 极短',
    input: { contentA: 'ok', contentB: 'yes', sharedContext: [] },
    expected: { hasConnection: false },
    dirty: true,
  },

  // === 更多真实场景 ===
  {
    name: '场景-1: 跨项目相同问题',
    input: {
      contentA: 'PixelForge 的 WFC 生成器在大地图（200x200）时性能骤降——约束传播的递归深度太大导致栈溢出',
      contentB: 'StarMap 的图像叠加在处理大量帧（500+）时内存溢出——一次性加载所有 FITS 文件到内存',
      sharedContext: ['大数据量场景下的性能问题'],
    },
    expected: { hasConnection: true, relation: 'analogous', insightQuality: 'specific' },
  },
  {
    name: '场景-2: 创作方法的迁移',
    input: {
      contentA: '写技术博客的方法：先列大纲定结构，再填充细节，最后润色文字',
      contentB: 'PixelForge 地牢生成的流程也是：先 BSP 划分大结构，再 WFC 填充细节，最后 L-system 添加装饰',
      sharedContext: ['从宏观到微观的创作方法'],
    },
    expected: { hasConnection: true, relation: 'analogous', insightQuality: 'specific' },
  },
  {
    name: '场景-3: 抽象原则在多处体现',
    input: {
      contentA: 'PixelForge 的设计原则："宁可生成简单但合理的地牢，也不要生成华丽但不可玩的地牢"——可玩性优先',
      contentB: 'BlogEngine 的排版原则："宁可排版简洁但易读，也不要花哨但难以阅读"——同样的实用优先',
      sharedContext: ['产品设计中的实用主义原则'],
    },
    expected: { hasConnection: true, insightQuality: 'specific' },
  },
  {
    name: '场景-4: 自然界知识迁移',
    input: {
      contentA: '天文摄影中的长曝光叠加：单张噪点很多，但叠加几十张后信噪比大幅提升',
      contentB: 'PixelForge 的地牢评估：单个评估维度可能有偏差，但综合可玩性、美观性、挑战性三个维度后判断更准确',
      sharedContext: ['多次采样/多维度综合提升质量'],
    },
    expected: { hasConnection: true, insightQuality: 'specific' },
  },
  {
    name: '场景-5: 矛盾发现',
    input: {
      contentA: '去年决定优先使用成熟稳定的技术（Godot 3, stable Rust），不追求最新版',
      contentB: '最近开始大量使用实验性技术：Godot 4 beta、nightly Rust 特性、Vulkan 渲染后端',
      sharedContext: ['技术选型策略'],
    },
    expected: { hasConnection: true, relation: 'contradicts' },
  },
];

// ---- 运行测试 ----

function buildPrompt(tc: TestCase<DiscoverInput, DiscoverExpect>): string {
  const shared = tc.input.sharedContext.length > 0
    ? tc.input.sharedContext.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
    : '  (无共同关联)';

  return `记忆 A: ${tc.input.contentA}\n\n记忆 B: ${tc.input.contentB}\n\n它们的共同关联:\n${shared}\n\n它们之间有什么意外的、有价值的联系？`;
}

function evaluate(
  tc: TestCase<DiscoverInput, DiscoverExpect>,
  result: DiscoverOutput | null,
): { passed: boolean; score: number; issues: string[] } {
  const issues: string[] = [];
  let score = 0;

  if (!result) {
    issues.push('LLM 返回解析失败');
    return { passed: false, score: 0, issues };
  }

  // 1. has_connection 判断（50%）
  if (result.has_connection !== tc.expected.hasConnection) {
    issues.push(`has_connection 判断错误: 期望 ${tc.expected.hasConnection}, 得到 ${result.has_connection}`);
  } else {
    score += 0.5;
  }

  // 2. relation_type（20%，仅 has_connection=true）
  if (tc.expected.hasConnection && result.has_connection) {
    if (result.relation_type && !isValidRelation(result.relation_type)) {
      issues.push(`无效关系类型: ${result.relation_type}`);
    } else if (tc.expected.relation && result.relation_type !== tc.expected.relation) {
      issues.push(`关系类型不匹配: 期望 ${tc.expected.relation}, 得到 ${result.relation_type}`);
      score += 0.1;
    } else {
      score += 0.2;
    }

    // 3. insight 质量（30%）
    if (result.insight) {
      if (tc.expected.insightQuality === 'specific') {
        // insight 不应该是泛泛的
        const genericPhrases = ['都跟技术有关', '都属于', '都是关于', '都涉及', '有一定关联'];
        const isGeneric = genericPhrases.some(p => result.insight!.includes(p));
        if (isGeneric) {
          issues.push(`insight 过于笼统: "${result.insight!.slice(0, 50)}..."`);
          score += 0.1;
        } else if (result.insight.length < 10) {
          issues.push(`insight 太短: "${result.insight}"`);
          score += 0.1;
        } else {
          score += 0.3;
        }
      } else {
        score += 0.2;
      }
    }
  } else if (!tc.expected.hasConnection && !result.has_connection) {
    score += 0.5; // 正确判断无关联
  }

  // 脏数据
  if (tc.dirty && result.has_connection) {
    issues.push('脏数据不应建立连接');
    score = Math.max(0, score - 0.3);
  }

  const passed = issues.length === 0;
  return { passed, score: Math.min(1, Math.max(0, score)), issues };
}

async function run(): Promise<void> {
  await initTestEnv();

  console.log(`🔍 link-discover 测试: ${TEST_CASES.length} 组用例\n`);

  const results: TestResult<DiscoverInput, DiscoverExpect, DiscoverOutput>[] = [];

  // 每个用例单独调用（发现任务是一对一的）
  for (const tc of TEST_CASES) {
    console.log(`  ${tc.name}`);
    const prompt = buildPrompt(tc);

    try {
      const { text, durationMs } = await callWithStrategy('scan-divergent', '', prompt, { model: 'heavy' });
      const output = parseJSON<DiscoverOutput>(text);
      const eval_ = evaluate(tc, output);

      results.push({
        name: tc.name,
        input: tc.input,
        expected: tc.expected,
        output,
        rawResponse: text,
        ...eval_,
        durationMs,
      });
    } catch (err) {
      results.push({
        name: tc.name,
        input: tc.input,
        expected: tc.expected,
        output: null,
        rawResponse: (err as Error).message,
        passed: false,
        score: 0,
        issues: [`LLM 调用失败: ${(err as Error).message}`],
        durationMs: 0,
      });
    }
  }

  printReport('link-discover', results);
}

run().catch(console.error);
