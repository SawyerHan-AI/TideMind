import { callLLM, LLMServiceError } from './client.js';
import { parseLLMJson } from './json-parse.js';
import {
  CRYSTAL_SYSTEM, crystalPrompt,
  KEYSTONE_ENRICH_SYSTEM,
} from './prompts.js';
import { getPrompt, getLLMOptions, renderUserPrompt } from '../strategy/loader.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('extract');

/**
 * 从相关记忆中生成 crystal 节点
 */
export async function generateCrystal(
  nodeContents: string[],
  existingCrystals?: string[],
): Promise<{
  title?: string;
  content: string;
  tags: string[];
  confidence: number;
} | null> {
  try {
    const response = await callLLM({
      system: getPrompt('crystal-emerge', CRYSTAL_SYSTEM),
      prompt: renderUserPrompt('crystal-emerge', {
        existing_crystals: existingCrystals?.map(c => `- ${c}`).join('\n') ?? '',
        node_count: String(nodeContents.length),
        node_list: nodeContents.map((c, i) => `${i + 1}. ${c}`).join('\n'),
      }, crystalPrompt(nodeContents, existingCrystals)),
      ...getLLMOptions('crystal-emerge'),
      operationName: 'crystal',
    });

    return parseLLMJson(response);
  } catch (err) {
    // 只吞 LLM 服务级错误和 JSON 解析相关的 SyntaxError;其它(TypeError 等
    // programmer error)让它们冒泡 —— scheduler 的 circuit breaker 需要分辨
    // "模型调不动" vs "我们代码有 bug"。前者累计失败,后者应该直接炸。
    if (err instanceof LLMServiceError || err instanceof SyntaxError) {
      log.warn(`generateCrystal 失败: ${(err as Error).message}`);
      return null;
    }
    log.error(`generateCrystal 非服务错误,上抛: ${(err as Error)?.message ?? err}`);
    throw err;
  }
}

/**
 * 为提升为 crystal 的枢纽节点生成综合注释
 * 保留原始内容，追加综合分析
 */
export async function enrichCrystalContent(
  originalContent: string,
  neighborContents: string[],
): Promise<string | null> {
  try {
    const neighbors = neighborContents.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const fallbackPrompt = `枢纽节点内容: ${originalContent}\n\n它连接的邻居记忆:\n${neighbors}\n\n用 1-2 句话总结这个枢纽的核心价值。`;
    const response = await callLLM({
      system: getPrompt('keystone-enrich', KEYSTONE_ENRICH_SYSTEM),
      prompt: renderUserPrompt('keystone-enrich', {
        original_content: originalContent,
        neighbors,
      }, fallbackPrompt),
      ...getLLMOptions('keystone-enrich'),
      maxTokens: 200,
      operationName: 'keystone',
    });
    if (response.trim()) {
      return `${originalContent}\n\n---\n综合: ${response.trim()}`;
    }
    return null;
  } catch (err) {
    if (err instanceof LLMServiceError || err instanceof SyntaxError) {
      log.warn(`enrichCrystalContent 失败: ${(err as Error).message}`);
      return null;
    }
    log.error(`enrichCrystalContent 非服务错误,上抛: ${(err as Error)?.message ?? err}`);
    throw err;
  }
}

/**
 * 发散扫描：从看似无关的节点对中生成桥接洞察
 *
 * 输出一个新的知识节点内容（而非链接判断），
 * 用于在两个不同领域之间建立跨域桥梁。
 */
export async function generateBridgeInsight(
  contentA: string,
  contentB: string,
  sharedContext: string[],
): Promise<{
  has_insight: boolean;
  title?: string;
  content?: string;
  tags?: string[];
  confidence?: number;
} | null> {
  const BRIDGE_SYSTEM_FALLBACK = `你是一个跨领域洞察发现器。两条记忆彼此没有直接链接，但它们共享了多个共同关联的记忆。

你的任务是：判断它们之间是否存在有价值的跨领域联系。如果有，生成一条简洁的桥接洞察——用一两句话阐明这个联系为什么有价值。

判断标准:
- 有价值: 这个联系如果被发现，会改变用户对其中一条（或两条）记忆的理解
- 不显而易见: 不是简单的"都关于同一个项目"或"都提到了同一个词"
- 可迁移: 这个洞察脱离原始记忆也能被理解和使用

不要强行建立联系。如果没有真正有价值的关联，直接返回 has_insight: false。

输出 JSON:
有洞察: { "has_insight": true, "title": "一句话标题", "content": "桥接洞察内容", "tags": ["标签"], "confidence": 0.0-1.0 }
无洞察: { "has_insight": false }

只输出 JSON，不要其他内容。`;

  try {
    const shared = sharedContext.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
    const fallbackPrompt = `记忆 A: ${contentA}\n\n记忆 B: ${contentB}\n\n它们的共同关联:\n${shared}\n\n它们之间有什么意外的、有价值的联系？如果有，生成一条桥接洞察。`;

    const response = await callLLM({
      system: getPrompt('scan-divergent', BRIDGE_SYSTEM_FALLBACK),
      prompt: renderUserPrompt('scan-divergent', {
        content_a: contentA,
        content_b: contentB,
        shared_context: shared,
      }, fallbackPrompt),
      ...getLLMOptions('scan-divergent'),
      operationName: 'divergent',
    });

    return parseLLMJson(response);
  } catch (err) {
    if (err instanceof LLMServiceError || err instanceof SyntaxError) {
      log.warn(`generateBridgeInsight 失败: ${(err as Error).message}`);
      return null;
    }
    log.error(`generateBridgeInsight 非服务错误,上抛: ${(err as Error)?.message ?? err}`);
    throw err;
  }
}

