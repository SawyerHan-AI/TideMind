/**
 * tests/llm/extract.test.ts
 *
 * 覆盖 src/llm/extract.ts:
 *  - generateCrystal:从节点内容生成 crystal 节点
 *  - enrichCrystalContent:为枢纽节点生成综合注释
 *  - generateBridgeInsight:从看似无关的节点对中生成桥接洞察
 *
 * 关键错误处理规约(extract.ts:38-46 注释):
 *  - 只吞 LLMServiceError 和 SyntaxError(返回 null + warn)
 *  - 其它 (TypeError 等 programmer error) 必须冒泡 — scheduler 的 circuit
 *    breaker 需要分辨"模型调不动"vs"我们代码有 bug",前者累计,后者直接炸
 *
 * 风险点:
 *  - 一旦 catch 块漏掉 instanceof 守护,programmer error 会被静默吞掉,
 *    scheduler 永远 circuit-break 不出问题
 *  - parseLLMJson 返回的 shape 直接被透传给调用方,如果 callLLM mock 输出
 *    格式漂移会让测试假绿
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock 三个外部依赖,extract.ts 的纯逻辑可以独立验证
const callLLMMock = vi.fn();
const parseLLMJsonMock = vi.fn();

vi.mock('@server/llm/client.js', async () => {
  // 引入真实 LLMServiceError 类用作 instanceof 检查
  const actual = (await vi.importActual('@server/llm/client.js')) as Record<
    string,
    unknown
  >;
  return {
    ...actual,
    callLLM: callLLMMock,
    LLMServiceError: actual.LLMServiceError,
  };
});

vi.mock('@server/llm/json-parse.js', () => ({
  parseLLMJson: parseLLMJsonMock,
}));

vi.mock('@server/strategy/loader.js', () => ({
  getPrompt: (_strategyId: string, fallback: string) => fallback,
  getLLMOptions: (_strategyId: string) => ({ tier: 'standard' as const }),
  renderUserPrompt: (_strategyId: string, _vars: object, fallback: string) =>
    fallback,
}));

const { generateCrystal, enrichCrystalContent, generateBridgeInsight } =
  await import('@server/llm/extract.js');
const { LLMServiceError } = await import('@server/llm/client.js');

beforeEach(() => {
  callLLMMock.mockReset();
  parseLLMJsonMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extract — generateCrystal', () => {
  it('LLM 返回有效 JSON 时透传 parseLLMJson 结果', async () => {
    callLLMMock.mockResolvedValueOnce('{"content":"crystal","tags":["t"],"confidence":0.8}');
    parseLLMJsonMock.mockReturnValueOnce({
      content: 'crystal',
      tags: ['t'],
      confidence: 0.8,
    });

    const result = await generateCrystal(['n1', 'n2']);
    expect(result).toEqual({
      content: 'crystal',
      tags: ['t'],
      confidence: 0.8,
    });
    expect(callLLMMock).toHaveBeenCalledTimes(1);
    expect(parseLLMJsonMock).toHaveBeenCalledTimes(1);
  });

  it('调用 callLLM 时 operationName=crystal', async () => {
    callLLMMock.mockResolvedValueOnce('{}');
    parseLLMJsonMock.mockReturnValueOnce({});
    await generateCrystal(['x']);
    const callArgs = callLLMMock.mock.calls[0][0];
    expect(callArgs.operationName).toBe('crystal');
  });

  it('existingCrystals 参与 prompt 渲染', async () => {
    callLLMMock.mockResolvedValueOnce('{}');
    parseLLMJsonMock.mockReturnValueOnce({});
    await generateCrystal(['n1'], ['existing-c1', 'existing-c2']);
    // renderUserPrompt mock 透传 fallback,所以 prompt 是 crystalPrompt(nodes, existingCrystals)
    // 不直接断言内部 prompt 文本——但应该至少传入 callLLM
    expect(callLLMMock).toHaveBeenCalledTimes(1);
  });

  it('callLLM 抛 LLMServiceError 时返回 null', async () => {
    callLLMMock.mockRejectedValueOnce(
      new LLMServiceError('rate limited', 'rate_limit', 429),
    );
    const result = await generateCrystal(['n']);
    expect(result).toBeNull();
  });

  it('parseLLMJson 抛 SyntaxError 时返回 null', async () => {
    callLLMMock.mockResolvedValueOnce('not json');
    parseLLMJsonMock.mockImplementationOnce(() => {
      throw new SyntaxError('Unexpected token');
    });
    const result = await generateCrystal(['n']);
    expect(result).toBeNull();
  });

  it('callLLM 抛 TypeError(programmer error) 时**冒泡**不吞', async () => {
    callLLMMock.mockRejectedValueOnce(new TypeError("Cannot read 'foo' of undefined"));
    await expect(generateCrystal(['n'])).rejects.toThrow(TypeError);
  });

  it('parseLLMJson 抛非 SyntaxError 的普通 Error 时**冒泡**不吞', async () => {
    callLLMMock.mockResolvedValueOnce('x');
    parseLLMJsonMock.mockImplementationOnce(() => {
      throw new Error('parser internal bug');
    });
    await expect(generateCrystal(['n'])).rejects.toThrow('parser internal bug');
  });

  it('callLLM 抛 RangeError(programmer error) 时也冒泡', async () => {
    callLLMMock.mockRejectedValueOnce(new RangeError('stack overflow'));
    await expect(generateCrystal(['n'])).rejects.toThrow(RangeError);
  });
});

describe('extract — enrichCrystalContent', () => {
  it('LLM 返回非空文本时拼接综合内容', async () => {
    callLLMMock.mockResolvedValueOnce('这是核心价值的综合分析');
    const result = await enrichCrystalContent('原始内容', ['邻居1', '邻居2']);
    expect(result).toBe('原始内容\n\n---\n综合: 这是核心价值的综合分析');
  });

  it('LLM 返回空字符串时返回 null(不拼接 separator)', async () => {
    callLLMMock.mockResolvedValueOnce('');
    const result = await enrichCrystalContent('原始', ['邻居']);
    expect(result).toBeNull();
  });

  it('LLM 返回纯空白时返回 null', async () => {
    callLLMMock.mockResolvedValueOnce('   \n\t  ');
    const result = await enrichCrystalContent('原始', ['邻居']);
    expect(result).toBeNull();
  });

  it('LLM 返回含两端空白的文本时 trim 后拼接', async () => {
    callLLMMock.mockResolvedValueOnce('  综合分析  ');
    const result = await enrichCrystalContent('原始', ['邻居']);
    expect(result).toBe('原始\n\n---\n综合: 综合分析');
  });

  it('maxTokens 被设为 200', async () => {
    callLLMMock.mockResolvedValueOnce('x');
    await enrichCrystalContent('原始', ['邻居']);
    const callArgs = callLLMMock.mock.calls[0][0];
    expect(callArgs.maxTokens).toBe(200);
  });

  it('operationName=keystone', async () => {
    callLLMMock.mockResolvedValueOnce('x');
    await enrichCrystalContent('原始', ['邻居']);
    const callArgs = callLLMMock.mock.calls[0][0];
    expect(callArgs.operationName).toBe('keystone');
  });

  it('LLMServiceError 时返回 null', async () => {
    callLLMMock.mockRejectedValueOnce(
      new LLMServiceError('timeout', 'timeout', 504),
    );
    const result = await enrichCrystalContent('原始', ['邻居']);
    expect(result).toBeNull();
  });

  it('TypeError 时冒泡', async () => {
    callLLMMock.mockRejectedValueOnce(new TypeError('bad'));
    await expect(enrichCrystalContent('原始', ['邻居'])).rejects.toThrow(TypeError);
  });

  it('空 neighbors 数组也能工作(neighbors string 为空)', async () => {
    callLLMMock.mockResolvedValueOnce('something');
    const result = await enrichCrystalContent('原始', []);
    expect(result).toBe('原始\n\n---\n综合: something');
  });
});

describe('extract — generateBridgeInsight', () => {
  it('has_insight=true 时透传 parseLLMJson 结果', async () => {
    callLLMMock.mockResolvedValueOnce('{"has_insight":true,"content":"bridge","confidence":0.7}');
    parseLLMJsonMock.mockReturnValueOnce({
      has_insight: true,
      content: 'bridge',
      confidence: 0.7,
    });
    const result = await generateBridgeInsight('A', 'B', ['shared1']);
    expect(result).toEqual({
      has_insight: true,
      content: 'bridge',
      confidence: 0.7,
    });
  });

  it('has_insight=false 时也透传(调用方判断)', async () => {
    callLLMMock.mockResolvedValueOnce('{"has_insight":false}');
    parseLLMJsonMock.mockReturnValueOnce({ has_insight: false });
    const result = await generateBridgeInsight('A', 'B', []);
    expect(result).toEqual({ has_insight: false });
  });

  it('operationName=divergent', async () => {
    callLLMMock.mockResolvedValueOnce('{}');
    parseLLMJsonMock.mockReturnValueOnce({});
    await generateBridgeInsight('A', 'B', ['s']);
    const callArgs = callLLMMock.mock.calls[0][0];
    expect(callArgs.operationName).toBe('divergent');
  });

  it('LLMServiceError 时返回 null', async () => {
    callLLMMock.mockRejectedValueOnce(
      new LLMServiceError('upstream', 'unknown', 500),
    );
    const result = await generateBridgeInsight('A', 'B', []);
    expect(result).toBeNull();
  });

  it('SyntaxError 时返回 null', async () => {
    callLLMMock.mockResolvedValueOnce('garbage');
    parseLLMJsonMock.mockImplementationOnce(() => {
      throw new SyntaxError('parse fail');
    });
    const result = await generateBridgeInsight('A', 'B', []);
    expect(result).toBeNull();
  });

  it('TypeError 时冒泡', async () => {
    callLLMMock.mockRejectedValueOnce(new TypeError('bad'));
    await expect(generateBridgeInsight('A', 'B', [])).rejects.toThrow(TypeError);
  });

  it('sharedContext 多条参与 prompt(被 numbered list 渲染)', async () => {
    callLLMMock.mockResolvedValueOnce('{}');
    parseLLMJsonMock.mockReturnValueOnce({});
    await generateBridgeInsight('A', 'B', ['s1', 's2', 's3']);
    expect(callLLMMock).toHaveBeenCalledTimes(1);
    const args = callLLMMock.mock.calls[0][0];
    // prompt fallback 包含 "1. s1"
    expect(args.prompt).toContain('1. s1');
    expect(args.prompt).toContain('2. s2');
    expect(args.prompt).toContain('3. s3');
  });

  it('空 sharedContext 不抛错', async () => {
    callLLMMock.mockResolvedValueOnce('{}');
    parseLLMJsonMock.mockReturnValueOnce({ has_insight: false });
    await expect(generateBridgeInsight('A', 'B', [])).resolves.toEqual({
      has_insight: false,
    });
  });
});

describe('extract — circuit breaker discipline (cross-function)', () => {
  it('三个函数都不能吞 programmer error(回归保护:防止 catch 块漏 instanceof 守护)', async () => {
    // 任何一个函数如果 catch (err) {} 没有 instanceof 守护,会把 TypeError 吞了
    // 这是关键回归保护,Round 3 audit 找过类似 bug。
    callLLMMock.mockRejectedValue(new TypeError('regression'));

    await expect(generateCrystal(['n'])).rejects.toThrow(TypeError);
    await expect(enrichCrystalContent('a', ['b'])).rejects.toThrow(TypeError);
    await expect(generateBridgeInsight('A', 'B', [])).rejects.toThrow(TypeError);
  });
});
