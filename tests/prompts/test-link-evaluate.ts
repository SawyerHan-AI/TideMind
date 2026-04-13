/**
 * link-evaluate prompt 测试
 *
 * 测试链接评估的准确性：valid 判断 + 关系类型 + confidence 校准
 */

import { initTestEnv, callWithStrategy, parseJSON, isValidRelation, isInRange, printReport, type TestCase, type TestResult } from './helpers.js';

// ---- 类型 ----

interface LinkEvalInput {
  nodeA: { content: string; type?: string; project?: string; created?: string };
  nodeB: { content: string; type?: string; project?: string; created?: string };
}

interface LinkEvalExpect {
  valid: boolean;
  relation?: string;       // 期望的关系类型（如果 valid=true）
  confidenceMin?: number;  // 期望的最低 confidence
  confidenceMax?: number;  // 期望的最高 confidence
}

interface LinkEvalOutput {
  index: number;
  valid: boolean;
  relation?: string;
  confidence?: number;
}

// ---- 当前 prompt ----

const SYSTEM_PROMPT = `你是关系评估器。判断多对记忆之间的关系是否成立，以及具体的关系类型。

关系类型:
- caused_by: A 是 B 的结果/后果
- continues: A 是 B 的延续/后续
- updates: A 是 B 的更新版本（新信息替代旧信息）
- supports: A 支持/佐证 B
- contradicts: A 和 B 矛盾
- summarizes: A 是 B 的总结/抽象
- part_of: A 是 B 的一部分
- analogous: A 和 B 有类比关系（不同领域的相似结构）
- tagged: A 和 B 共享相同标签/分类

对每一对，判断：
1. 这两条记忆之间是否存在有意义的关联？（valid: true/false）
2. 如果有，最准确的关系类型是什么？

输出 JSON 数组:
[{ "index": 1, "valid": true, "relation": "...", "confidence": 0.0-1.0 }]

如果关联不成立:
[{ "index": 1, "valid": false }]

只输出 JSON 数组。`;

// ---- 测试用例（30+ 组）----

const TEST_CASES: TestCase<LinkEvalInput, LinkEvalExpect>[] = [
  // === 因果关系 ===
  {
    name: '因果-1: 方案失败导致更换',
    input: {
      nodeA: { content: '决定放弃 C++ 方案，改用 Rust 编写 PixelForge 核心算法', type: 'fact', project: 'PixelForge' },
      nodeB: { content: 'C++ 方案手动内存管理频繁出错，GDExtension 绑定代码冗长，开发效率低', type: 'fact', project: 'PixelForge' },
    },
    expected: { valid: true, relation: 'caused_by', confidenceMin: 0.7 },
  },
  {
    name: '因果-2: BUG 导致修复',
    input: {
      nodeA: { content: '修复了 WFC 生成器中边界 tile 约束传播时数组越界的 BUG，添加了边界检查', type: 'fact', project: 'PixelForge' },
      nodeB: { content: '大尺寸地图（200x200）生成时偶尔崩溃，定位到 WFC 约束传播递归中未检查边界条件', type: 'fact', project: 'PixelForge' },
    },
    expected: { valid: true, relation: 'caused_by', confidenceMin: 0.7 },
  },
  {
    name: '因果-3: 需求驱动设计',
    input: {
      nodeA: { content: '设计了三层生成管线（宏观 BSP → 中观 WFC → 微观 L-system），每层独立配置参数', type: 'fact', project: 'PixelForge' },
      nodeB: { content: '单一 WFC 生成器无法同时满足大结构合理性和细节丰富度，需要分层处理不同尺度', type: 'fact', project: 'PixelForge' },
    },
    expected: { valid: true, relation: 'caused_by', confidenceMin: 0.6 },
  },

  // === 延续关系 ===
  {
    name: '延续-1: 项目版本迭代',
    input: {
      nodeA: { content: 'StarMap v2 重写：改用 Rust + Actix 架构，支持自动拍摄计划生成和多目标调度', type: 'fact', project: 'StarMap' },
      nodeB: { content: 'StarMap 初始版本：Python + Flask，支持基础的 FITS 文件查看和手动记录拍摄参数', type: 'fact', project: 'StarMap' },
    },
    expected: { valid: true, relation: 'updates', confidenceMin: 0.6 },
  },
  {
    name: '延续-2: 讨论的后续',
    input: {
      nodeA: { content: '确定了 mod 系统的具体方案：Lua 脚本 + 沙箱环境 + 注册表 API', type: 'fact', project: 'PixelForge' },
      nodeB: { content: '完整梳理了 mod 支持的所有需求：自定义生成规则、自定义 tile 集、自定义评估维度', type: 'fact', project: 'PixelForge' },
    },
    expected: { valid: true, relation: 'continues', confidenceMin: 0.5 },
  },

  // === 更新关系 ===
  {
    name: '更新-1: 新信息替代旧信息',
    input: {
      nodeA: { content: 'PixelForge 生成算法从 2 种扩展为 3 种组合：WFC + BSP + L-system，每种算法独立配置', type: 'fact', project: 'PixelForge', created: '2025-06-01' },
      nodeB: { content: 'PixelForge 使用 WFC 和 BSP 两种生成算法，WFC 负责房间填充，BSP 负责区域分割', type: 'fact', project: 'PixelForge', created: '2025-03-01' },
    },
    expected: { valid: true, relation: 'updates', confidenceMin: 0.7 },
  },
  {
    name: '更新-2: 方案迭代',
    input: {
      nodeA: { content: '部署架构从手动 scp 升级为 Docker Compose + Caddy + GitHub Actions 自动化流水线', type: 'fact', project: 'StarMap' },
      nodeB: { content: '部署方式是手动 scp 代码到 Hetzner 服务器，重启 systemd 服务', type: 'fact', project: 'StarMap' },
    },
    expected: { valid: true, relation: 'updates', confidenceMin: 0.7 },
  },

  // === 支持关系 ===
  {
    name: '支持-1: 案例佐证论点',
    input: {
      nodeA: { content: 'AlphaGo 通过蒙特卡罗树搜索 + 深度学习实现了超人类围棋水平，自我对弈不断迭代策略', type: 'fact' },
      nodeB: { content: '程序化内容生成的核心是用算法编码设计意图，通过迭代优化逼近设计目标', type: 'fact' },
    },
    expected: { valid: true, relation: 'supports', confidenceMin: 0.5 },
  },
  {
    name: '支持-2: 数据支撑结论',
    input: {
      nodeA: { content: 'Rust 重写后 WFC 生成性能测试：100x100 地图从 12 秒降到 0.6 秒，提升 20 倍', type: 'fact', project: 'PixelForge' },
      nodeB: { content: '用 Rust 重写核心算法的决策是正确的，性能提升显著', type: 'fact', project: 'PixelForge' },
    },
    expected: { valid: true, relation: 'supports', confidenceMin: 0.5 },
  },

  // === 矛盾关系 ===
  {
    name: '矛盾-1: 直接对立',
    input: {
      nodeA: { content: '商业手游应该优先关注付费转化和数值平衡，这是生存的基础', type: 'preference' },
      nodeB: { content: '游戏设计应该把玩家体验放在第一位，付费机制不应该破坏核心体验', type: 'preference' },
    },
    expected: { valid: true, relation: 'contradicts', confidenceMin: 0.6 },
  },
  {
    name: '矛盾-2: 偏好变化',
    input: {
      nodeA: { content: '决定所有项目统一使用 Rust 作为后端语言，因为性能和类型安全', type: 'preference', created: '2025-06-01' },
      nodeB: { content: '后端首选 Python，因为 AI/ML 生态和快速原型能力', type: 'preference', created: '2024-06-01' },
    },
    expected: { valid: true, relation: 'updates', confidenceMin: 0.5 },
  },

  // === 类比关系 ===
  {
    name: '类比-1: 跨领域结构相似',
    input: {
      nodeA: { content: 'PixelForge 地牢生成管线：宏观分割（BSP）→ 中观填充（WFC）→ 微观装饰（L-system）', type: 'fact', project: 'PixelForge' },
      nodeB: { content: 'MusicBox 音乐生成管线：曲式结构 → 和弦进行 → 旋律装饰音', type: 'fact', project: 'MusicBox' },
    },
    expected: { valid: true, relation: 'analogous', confidenceMin: 0.4 },
  },
  {
    name: '类比-2: 不同项目的相似架构',
    input: {
      nodeA: { content: 'PixelForge 采用 Godot 4 + Rust GDExtension 的游戏工具架构', type: 'fact', project: 'PixelForge' },
      nodeB: { content: 'Bevy 也是 Rust 编写的游戏引擎，用 ECS 架构', type: 'fact' },
    },
    expected: { valid: true, relation: 'analogous', confidenceMin: 0.4 },
  },

  // === 概括关系 ===
  {
    name: '概括-1: 抽象总结',
    input: {
      nodeA: { content: '技术选型遵循"开源优先"原则：Godot 而非 Unity、Rust 而非 C++、Hugo 而非 WordPress', type: 'fact' },
      nodeB: { content: '选择 Godot 4 作为游戏引擎，因为开源、轻量、无授权费', type: 'fact', project: 'PixelForge' },
    },
    expected: { valid: true, relation: 'summarizes', confidenceMin: 0.5 },
  },

  // === 部分关系 ===
  {
    name: '部分-1: 章节与整体',
    input: {
      nodeA: { content: 'WFC 约束传播模块：在坍缩一个单元格后，递归检查相邻格子的可选 tile 集合', type: 'fact', project: 'PixelForge' },
      nodeB: { content: '设计了三层生成管线（BSP + WFC + L-system），覆盖从区域分割到细节装饰的完整流程', type: 'fact', project: 'PixelForge' },
    },
    expected: { valid: true, relation: 'part_of', confidenceMin: 0.6 },
  },

  // === 标签关系 ===
  {
    name: '标签-1: 同分类',
    input: {
      nodeA: { content: '围棋甲级联赛 2024 赛季赛程：3月预选赛、5月常规赛、9月季后赛', type: 'fact' },
      nodeB: { content: 'KataGo 是目前最强的开源围棋 AI，可以用来分析棋局', type: 'fact' },
    },
    expected: { valid: true, relation: 'tagged', confidenceMin: 0.4 },
  },

  // === 无关系 ===
  {
    name: '无关-1: 完全不相关',
    input: {
      nodeA: { content: '今天天气很好，适合户外跑步', type: 'fact' },
      nodeB: { content: 'SQLite 的 WAL 模式通过写前日志实现并发读写', type: 'fact' },
    },
    expected: { valid: false },
  },
  {
    name: '无关-2: 同领域但无关联',
    input: {
      nodeA: { content: 'Godot 的 GDScript 是一种类 Python 的脚本语言', type: 'fact' },
      nodeB: { content: 'Blender 的 Geometry Nodes 支持程序化建模', type: 'fact' },
    },
    expected: { valid: false },
  },
  {
    name: '无关-3: 不同用户场景',
    input: {
      nodeA: { content: '下周三下午去天文台参加深空摄影分享会', type: 'fact' },
      nodeB: { content: '最近在看的书：《游戏设计艺术》，关于多镜头分析方法', type: 'fact' },
    },
    expected: { valid: false },
  },

  // === 边界情况 ===
  {
    name: '边界-1: 弱关联但不够有意义',
    input: {
      nodeA: { content: '用 cargo build 编译 PixelForge 的 Rust 模块', type: 'fact', project: 'PixelForge' },
      nodeB: { content: 'PixelForge 使用 Rust 编写核心算法', type: 'fact', project: 'PixelForge' },
    },
    expected: { valid: true, relation: 'tagged', confidenceMin: 0.3 },
  },
  {
    name: '边界-2: 时间相近但内容无关',
    input: {
      nodeA: { content: '修复了 StarMap 的 FITS 文件头解析错误，HDU 扩展没有正确处理', type: 'fact', project: 'StarMap', created: '2025-09-03' },
      nodeB: { content: '晚上用 V60 冲了一杯肯尼亚 AA，莓果酸很亮', type: 'fact', created: '2025-09-03' },
    },
    expected: { valid: false },
  },

  // === 脏数据 ===
  {
    name: '脏数据-1: 空内容',
    input: {
      nodeA: { content: '', type: 'fact' },
      nodeB: { content: '这是一条正常的记忆', type: 'fact' },
    },
    expected: { valid: false },
    dirty: true,
  },
  {
    name: '脏数据-2: 极短无意义',
    input: {
      nodeA: { content: 'ok', type: 'fact' },
      nodeB: { content: 'yes', type: 'fact' },
    },
    expected: { valid: false },
    dirty: true,
  },
  {
    name: '脏数据-3: 乱码',
    input: {
      nodeA: { content: 'asdfghjkl qwerty 12345 !@#$%', type: 'fact' },
      nodeB: { content: '正常的技术决策记录', type: 'fact' },
    },
    expected: { valid: false },
    dirty: true,
  },
  {
    name: '脏数据-4: 超长重复',
    input: {
      nodeA: { content: '测试 '.repeat(500), type: 'fact' },
      nodeB: { content: '正常的项目记录', type: 'fact' },
    },
    expected: { valid: false },
    dirty: true,
  },

  // === 复杂场景 ===
  {
    name: '复杂-1: 多重关系但应选最主要的',
    input: {
      nodeA: { content: 'PixelForge 编辑器 UI 全面重做：从命令行工具升级为可视化编辑器，支持实时预览和参数调节', type: 'fact', project: 'PixelForge', created: '2025-12-01' },
      nodeB: { content: 'PixelForge 初始版本是纯命令行工具，通过 JSON 配置文件驱动生成', type: 'fact', project: 'PixelForge', created: '2025-01-01' },
    },
    expected: { valid: true, relation: 'updates', confidenceMin: 0.6 },
  },
  {
    name: '复杂-2: 跨项目的深层关联',
    input: {
      nodeA: { content: 'MusicBox V2 的核心改动是把节拍和节奏作为一等公民，不再是旋律的附属', type: 'fact', project: 'MusicBox' },
      nodeB: { content: 'PixelForge 的设计原则：地形结构是一等公民，装饰是结构的附属而非独立层', type: 'fact', project: 'PixelForge' },
    },
    expected: { valid: true, relation: 'analogous', confidenceMin: 0.5 },
  },
  {
    name: '复杂-3: 隐含的因果',
    input: {
      nodeA: { content: '将 Blender 导出插件的多边形上限从 500 提高到 2000，因为低多边形模型在 Godot 中显得太粗糙', type: 'fact', project: 'PixelForge' },
      nodeB: { content: '玩家反馈游戏中的物体模型太简陋，影响沉浸感', type: 'preference', project: 'PixelForge' },
    },
    expected: { valid: true, relation: 'caused_by', confidenceMin: 0.5 },
  },
  {
    name: '复杂-4: 支持还是部分？',
    input: {
      nodeA: { content: 'WFC 约束规则格式：每个 tile 的四边标记兼容性列表，用 JSON 文件定义', type: 'fact', project: 'PixelForge' },
      nodeB: { content: 'mod 系统设计文档第三章：自定义 tile 集规范，包含约束规则格式、预览图生成、验证工具', type: 'fact', project: 'PixelForge' },
    },
    expected: { valid: true, relation: 'part_of', confidenceMin: 0.5 },
  },
];

// ---- 运行测试 ----

function buildPrompt(cases: TestCase<LinkEvalInput, LinkEvalExpect>[]): string {
  const parts: string[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    parts.push(`--- 对 ${i + 1} ---`);
    parts.push(`A [${c.input.nodeA.type ?? 'fact'}${c.input.nodeA.project ? ` | ${c.input.nodeA.project}` : ''}${c.input.nodeA.created ? ` | ${c.input.nodeA.created}` : ''}]: ${c.input.nodeA.content.slice(0, 500)}`);
    parts.push(`B [${c.input.nodeB.type ?? 'fact'}${c.input.nodeB.project ? ` | ${c.input.nodeB.project}` : ''}${c.input.nodeB.created ? ` | ${c.input.nodeB.created}` : ''}]: ${c.input.nodeB.content.slice(0, 500)}`);
    parts.push('');
  }
  return parts.join('\n');
}

function evaluate(
  tc: TestCase<LinkEvalInput, LinkEvalExpect>,
  result: LinkEvalOutput | null,
): { passed: boolean; score: number; issues: string[] } {
  const issues: string[] = [];
  let score = 0;

  if (!result) {
    issues.push('LLM 返回结果解析失败');
    return { passed: false, score: 0, issues };
  }

  // 1. valid 判断
  if (result.valid !== tc.expected.valid) {
    issues.push(`valid 判断错误: 期望 ${tc.expected.valid}, 得到 ${result.valid}`);
  } else {
    score += 0.4; // valid 占 40%
  }

  // 2. relation 类型（仅 valid=true 时检查）
  if (tc.expected.valid && result.valid) {
    if (result.relation && !isValidRelation(result.relation)) {
      issues.push(`无效的关系类型: ${result.relation}`);
    } else if (tc.expected.relation && result.relation !== tc.expected.relation) {
      issues.push(`关系类型不匹配: 期望 ${tc.expected.relation}, 得到 ${result.relation}`);
      score += 0.1; // 类型不对但 valid 对了，给点分
    } else {
      score += 0.3; // relation 占 30%
    }

    // 3. confidence 校准
    if (result.confidence !== undefined) {
      if (tc.expected.confidenceMin && result.confidence < tc.expected.confidenceMin) {
        issues.push(`confidence 过低: ${result.confidence} < 期望最低 ${tc.expected.confidenceMin}`);
      } else if (tc.expected.confidenceMax && result.confidence > tc.expected.confidenceMax) {
        issues.push(`confidence 过高: ${result.confidence} > 期望最高 ${tc.expected.confidenceMax}`);
      } else {
        score += 0.2; // confidence 占 20%
      }

      // confidence 不能全是 0.7
      if (result.confidence === 0.7) {
        issues.push('confidence 可能是默认值 0.7，缺乏区分度');
      }
    }
  } else if (!tc.expected.valid && !result.valid) {
    score += 0.5; // valid=false 判断正确给更多分
  }

  // 4. 脏数据鲁棒性
  if (tc.dirty && result.valid) {
    issues.push('脏数据应被判为 valid=false');
    score = Math.max(0, score - 0.3);
  }

  const passed = issues.length === 0;
  score = Math.min(1, Math.max(0, score + (passed ? 0.1 : 0)));
  return { passed, score, issues };
}

async function run(): Promise<void> {
  await initTestEnv();

  console.log(`🔗 link-evaluate 测试: ${TEST_CASES.length} 组用例\n`);

  // 分批调用（每批 10 对，避免单次 prompt 过长）
  const BATCH_SIZE = 10;
  const results: TestResult<LinkEvalInput, LinkEvalExpect, LinkEvalOutput>[] = [];

  for (let batchStart = 0; batchStart < TEST_CASES.length; batchStart += BATCH_SIZE) {
    const batch = TEST_CASES.slice(batchStart, batchStart + BATCH_SIZE);
    console.log(`  批次 ${Math.floor(batchStart / BATCH_SIZE) + 1}: ${batch.map(c => c.name).join(', ')}`);

    const prompt = buildPrompt(batch);
    const { text, durationMs } = await callWithStrategy('link-evaluate', SYSTEM_PROMPT, prompt, { model: 'standard' });
    const parsed = parseJSON<LinkEvalOutput[]>(text);

    for (let i = 0; i < batch.length; i++) {
      const tc = batch[i];
      const output = parsed ? parsed.find(r => r.index === i + 1) ?? null : null;
      const eval_ = evaluate(tc, output);

      results.push({
        name: tc.name,
        input: tc.input,
        expected: tc.expected,
        output,
        rawResponse: i === 0 ? text : '', // 只保留第一条的原始响应
        ...eval_,
        durationMs: Math.round(durationMs / batch.length), // 平均分配
      });
    }
  }

  printReport('link-evaluate', results);
}

run().catch(console.error);
