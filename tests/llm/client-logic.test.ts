import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LLMServiceError,
  TIMEOUT_MS_BY_TIER,
  isRetryable,
  isServiceError,
  normalizeBaseUrl,
  fingerprintCreds,
  manualThinkingUnsupported,
} from '../../src/llm/client.js';
import { processThinkTags } from '../../src/llm/thinking.js';

// LLM 客户端纯逻辑测试。
//
// 历史:本文件曾经 inline 复刻 isRetryable / isServiceError / extractThinking /
// normalizeBaseUrl 等函数。复刻随源码演进出现严重漂移(参见 docs/design/
// test-coverage-plan-2026-05-20.md §1.1 #1)。改为 import 真源后,几个原本通过
// 的 case 暴露出真源行为已变(下面用 NEW 标记的 case):
//   - isServiceError 不再用 `/\b(401|403|429|5\d{2})\b/` 正则,改为结构化
//     statusCode 判断 → "HTTP 429: error" 字符串本身不再是 service error
//   - processThinkTags 已从 `^` 锚点改为全局匹配,且新增孤立 <think> 处理

// ── LLMServiceError ──────────────────────────────────────────

describe('LLMServiceError', () => {
  it('has name "LLMServiceError"', () => {
    const err = new LLMServiceError('test');
    expect(err.name).toBe('LLMServiceError');
  });

  it('stores statusCode', () => {
    const err = new LLMServiceError('rate limited', 429);
    expect(err.statusCode).toBe(429);
  });

  it('statusCode is undefined when not provided', () => {
    const err = new LLMServiceError('unknown error');
    expect(err.statusCode).toBeUndefined();
  });

  it('stores the message correctly', () => {
    const err = new LLMServiceError('something went wrong');
    expect(err.message).toBe('something went wrong');
  });

  it('is instanceof Error', () => {
    const err = new LLMServiceError('test');
    expect(err).toBeInstanceOf(Error);
  });
});

// ── TIMEOUT_MS_BY_TIER ───────────────────────────────────────

describe('TIMEOUT_MS_BY_TIER', () => {
  // 2026-05-21:60/180/300 → 360/600/1200。外脑所有 LLM 调用都是后台异步,
  // 对延迟不敏感;原 light 60s 在慢 provider 下容易撞,放宽余量更稳。
  // 详见 src/llm/client.ts::TIMEOUT_MS_BY_TIER 注释。
  it('light = 360_000ms', () => {
    expect(TIMEOUT_MS_BY_TIER.light).toBe(360_000);
  });

  it('standard = 600_000ms', () => {
    expect(TIMEOUT_MS_BY_TIER.standard).toBe(600_000);
  });

  it('heavy = 1200_000ms', () => {
    expect(TIMEOUT_MS_BY_TIER.heavy).toBe(1200_000);
  });

  it('light < standard < heavy', () => {
    expect(TIMEOUT_MS_BY_TIER.light).toBeLessThan(TIMEOUT_MS_BY_TIER.standard);
    expect(TIMEOUT_MS_BY_TIER.standard).toBeLessThan(TIMEOUT_MS_BY_TIER.heavy);
  });
});

// ── isRetryable ──────────────────────────────────────────────

describe('isRetryable', () => {
  describe('LLMServiceError status codes', () => {
    it('429 (rate limit) → true', () => {
      expect(isRetryable(new LLMServiceError('rate limited', 429))).toBe(true);
    });

    it('500 (internal server error) → true', () => {
      expect(isRetryable(new LLMServiceError('server error', 500))).toBe(true);
    });

    it('502 (bad gateway) → true', () => {
      expect(isRetryable(new LLMServiceError('bad gateway', 502))).toBe(true);
    });

    it('503 (service unavailable) → true', () => {
      expect(isRetryable(new LLMServiceError('unavailable', 503))).toBe(true);
    });

    it('400 (bad request) → false', () => {
      expect(isRetryable(new LLMServiceError('bad request', 400))).toBe(false);
    });

    it('401 (unauthorized) → false', () => {
      expect(isRetryable(new LLMServiceError('unauthorized', 401))).toBe(false);
    });

    it('403 (forbidden) → false', () => {
      expect(isRetryable(new LLMServiceError('forbidden', 403))).toBe(false);
    });

    it('no statusCode → false', () => {
      expect(isRetryable(new LLMServiceError('unknown'))).toBe(false);
    });
  });

  describe('generic Error with network messages', () => {
    it('ECONNREFUSED → true', () => {
      expect(isRetryable(new Error('connect ECONNREFUSED 127.0.0.1:8080'))).toBe(true);
    });

    it('ETIMEDOUT → true', () => {
      expect(isRetryable(new Error('connect ETIMEDOUT 10.0.0.1:443'))).toBe(true);
    });

    it('fetch failed → true', () => {
      expect(isRetryable(new Error('fetch failed'))).toBe(true);
    });

    it('parse error → false', () => {
      expect(isRetryable(new Error('parse error'))).toBe(false);
    });
  });

  // NEW: 源码已加 AbortSignal.timeout 触发的超时识别
  describe('timeout/abort error shapes (NEW: present in source, missing from old inline)', () => {
    it('TimeoutError name → true', () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      expect(isRetryable(err)).toBe(true);
    });

    it('AbortError name → true', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      expect(isRetryable(err)).toBe(true);
    });

    it('"aborted due to timeout" in message → true', () => {
      expect(isRetryable(new Error('The operation was aborted due to timeout'))).toBe(true);
    });

    it('APIUserAbortError (Claude 路径 tier 超时经 SDK 抛出) → true', () => {
      // SDK 在 signal aborted 时丢弃 reason 抛 APIUserAbortError:extends APIError、
      // status=undefined、name 不是 'AbortError'——必须在 APIError 分支之前分流,
      // 否则 tier 超时被误判不可重试(与 Gemini/OpenAI 路径的 TimeoutError 行为不一致)
      const err = new Anthropic.APIUserAbortError();
      expect(err instanceof Anthropic.APIError).toBe(true); // 前提确认:确实会命中 APIError 分支
      expect(isRetryable(err)).toBe(true);
    });
  });

  describe('non-error values', () => {
    it('non-error object → false', () => {
      expect(isRetryable({ message: 'ECONNREFUSED' })).toBe(false);
    });

    it('null → false', () => {
      expect(isRetryable(null)).toBe(false);
    });

    it('undefined → false', () => {
      expect(isRetryable(undefined)).toBe(false);
    });
  });
});

// ── isServiceError ───────────────────────────────────────────

describe('isServiceError', () => {
  describe('network errors → true', () => {
    it('ECONNREFUSED', () => {
      expect(isServiceError(new Error('connect ECONNREFUSED 127.0.0.1:8080'))).toBe(true);
    });

    it('ETIMEDOUT', () => {
      expect(isServiceError(new Error('connect ETIMEDOUT'))).toBe(true);
    });

    it('fetch failed', () => {
      expect(isServiceError(new Error('fetch failed'))).toBe(true);
    });
  });

  // NEW: 源码改为结构化判断。原 inline 测试 `HTTP ${code}: error` 字符串
  // 直接是 service error,新源码下应通过 LLMServiceError 才被认定。
  describe('LLMServiceError statusCode (replaces old string-regex tests)', () => {
    it.each([401, 403, 429, 500, 502, 503])('LLMServiceError statusCode=%d → true', (code) => {
      expect(isServiceError(new LLMServiceError(`API returned ${code}`, code))).toBe(true);
    });

    it('LLMServiceError statusCode=400 → false (context overflow etc., not service-level)', () => {
      expect(isServiceError(new LLMServiceError('bad request', 400))).toBe(false);
    });

    it('LLMServiceError without statusCode → true (provider wrapped error, conservative)', () => {
      expect(isServiceError(new LLMServiceError('Ollama returned not ok'))).toBe(true);
    });
  });

  describe('plain Error messages NO LONGER service errors (CRITICAL bug fix vs old inline test)', () => {
    // 旧 inline 版本:任何 message 含 `\b(401|403|429|500|502|503)\b` 都视为 service error,
    // 含 "API error"/"API key" 也是。新源码这些都不是 service error —— 必须走结构化路径。
    it('"HTTP 429: error" plain string → false (was true under old regex)', () => {
      expect(isServiceError(new Error('HTTP 429: error'))).toBe(false);
    });

    it('"API error: something" plain string → false', () => {
      expect(isServiceError(new Error('API error: something went wrong'))).toBe(false);
    });

    it('"Invalid API key" plain string → false', () => {
      expect(isServiceError(new Error('Invalid API key provided'))).toBe(false);
    });

    // 验证旧正则的"误伤"问题确实被新实现避免:Postgres 端口、行号等含数字字符串不再误判
    it(':5432 Postgres port in message → false (no longer false-positive)', () => {
      expect(isServiceError(new Error('connect to postgres at db:5432 failed'))).toBe(false);
    });

    it('"line 429" line number in message → false (no longer false-positive)', () => {
      expect(isServiceError(new Error('parse error at line 429'))).toBe(false);
    });
  });

  // NEW: 源码已加 Anthropic SDK 类型识别
  describe('Anthropic SDK errors (NEW)', () => {
    it('APIConnectionError → true', () => {
      const err = new Anthropic.APIConnectionError({ message: 'conn refused' });
      expect(isServiceError(err)).toBe(true);
    });

    it('APIConnectionTimeoutError → true', () => {
      const err = new Anthropic.APIConnectionTimeoutError({ message: 'timeout' });
      expect(isServiceError(err)).toBe(true);
    });
  });

  describe('non-service errors → false', () => {
    it('normal error message', () => {
      expect(isServiceError(new Error('something went wrong'))).toBe(false);
    });

    it('unrelated number in message', () => {
      expect(isServiceError(new Error('found 42 items'))).toBe(false);
    });

    it('non-error value', () => {
      expect(isServiceError('string error')).toBe(false);
    });

    it('null', () => {
      expect(isServiceError(null)).toBe(false);
    });
  });
});

// ── processThinkTags (from src/llm/thinking.ts) ──────────────
//
// 旧 inline 用 `extractThinking` 名字 + `/^<think>([\s\S]*?)<\/think>\s*/` 仅匹配开头。
// 真源 processThinkTags **全局**匹配 + **孤立 <think>** 兜底(S8 修复)。

describe('processThinkTags', () => {
  it('no think tags → text unchanged, 0 tokens', () => {
    const result = processThinkTags('Hello world');
    expect(result.text).toBe('Hello world');
    expect(result.thinkingTokens).toBe(0);
  });

  it('with think tags → thinking removed, tokens counted', () => {
    const thinking = 'Let me reason about this carefully step by step';
    const body = 'The answer is 42.';
    const raw = `<think>${thinking}</think>\n${body}`;
    const result = processThinkTags(raw);
    expect(result.text).toBe(body);
    expect(result.thinkingTokens).toBe(Math.ceil(thinking.length / 4));
  });

  it('empty think tags → empty thinking, 0 tokens', () => {
    const result = processThinkTags('<think></think>Some response');
    expect(result.text).toBe('Some response');
    expect(result.thinkingTokens).toBe(0);
  });

  it('think tags with content after → content preserved', () => {
    const result = processThinkTags('<think>reasoning</think>   Here is my answer.\nWith multiple lines.');
    expect(result.text).toBe('Here is my answer.\nWith multiple lines.');
    expect(result.thinkingTokens).toBeGreaterThan(0);
  });

  // NEW: 旧 inline 版本断言 "think tags not at start → not extracted",
  // 真源全局匹配后这是相反行为(CRITICAL difference)。
  // 注意:正则 `<\/think>\s*` 会吃掉紧跟在闭合标签后的空白(吞掉 " "),
  // 加上末尾的 trim,最终输出是 "prefix suffix"。
  it('think tags NOT at start → ALSO extracted (NEW global match)', () => {
    const raw = 'prefix <think>reasoning</think> suffix';
    const result = processThinkTags(raw);
    expect(result.text).toBe('prefix suffix');
    expect(result.thinkingTokens).toBe(Math.ceil('reasoning'.length / 4));
  });

  it('multiline thinking content', () => {
    const thinking = 'line 1\nline 2\nline 3';
    const raw = `<think>${thinking}</think>\nResult`;
    const result = processThinkTags(raw);
    expect(result.text).toBe('Result');
    expect(result.thinkingTokens).toBe(Math.ceil(thinking.length / 4));
  });

  // NEW: S8 孤立 <think> 兜底
  it('orphan <think> without closing tag → strips from orphan to end (S8 fix)', () => {
    const raw = 'final answer\n<think>incomplete reasoning truncated by max_tokens';
    const result = processThinkTags(raw);
    expect(result.text).toBe('final answer');
    expect(result.thinkingTokens).toBeGreaterThan(0);
  });
});

// ── normalizeBaseUrl ─────────────────────────────────────────

describe('normalizeBaseUrl', () => {
  it('URL without /v1 gets /v1 appended', () => {
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com/v1');
  });

  it('URL with /v1 stays unchanged', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
  });

  it('trailing slashes removed before /v1 check', () => {
    expect(normalizeBaseUrl('https://api.example.com///')).toBe('https://api.example.com/v1');
  });

  it('http://localhost:11434 → http://localhost:11434/v1', () => {
    expect(normalizeBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
  });

  it('https://api.openrouter.ai/api → https://api.openrouter.ai/api/v1', () => {
    expect(normalizeBaseUrl('https://api.openrouter.ai/api')).toBe('https://api.openrouter.ai/api/v1');
  });

  it('URL already ending with /v1/ → trailing slash removed, /v1 preserved', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
  });

  it('URL with /v1 in path but not at end gets /v1 appended', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/chat')).toBe('https://api.example.com/v1/chat/v1');
  });
});

// ── fingerprintCreds ─────────────────────────────────────────

describe('fingerprintCreds', () => {
  it('returns stable hash for same creds', () => {
    const fp1 = fingerprintCreds({ api_key: 'abc' });
    const fp2 = fingerprintCreds({ api_key: 'abc' });
    expect(fp1).toBe(fp2);
  });

  it('changes when creds change', () => {
    const fp1 = fingerprintCreds({ api_key: 'abc' });
    const fp2 = fingerprintCreds({ api_key: 'def' });
    expect(fp1).not.toBe(fp2);
  });

  it('changes when file mtime changes (Vertex cache invalidation)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-fp-'));
    const credPath = path.join(tmpDir, 'creds.json');
    try {
      fs.writeFileSync(credPath, '{"project_id":"x"}');
      const fpOld = fingerprintCreds({ project_id: 'x' }, credPath);

      // 重写文件:不同 mtime,且 size 也可能不同
      fs.writeFileSync(credPath, '{"project_id":"x","key":"k"}');
      // mtime 在某些 FS 上可能精度不够,显式 utimesSync 推后 1s
      const future = new Date(Date.now() + 2000);
      fs.utimesSync(credPath, future, future);

      const fpNew = fingerprintCreds({ project_id: 'x' }, credPath);
      expect(fpNew).not.toBe(fpOld);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('falls back gracefully when path missing', () => {
    const fp = fingerprintCreds({ project_id: 'x' }, '/nonexistent/path/that/does/not/exist.json');
    expect(typeof fp).toBe('string');
    expect(fp.length).toBe(12);
  });
});

// ── manualThinkingUnsupported ────────────────────────────────

describe('manualThinkingUnsupported', () => {
  // API 事实:Opus 4.7+ / Fable 系列移除 manual extended thinking,
  // 发送 thinking:{type:'enabled',budget_tokens} 直接 400。
  // Opus 4.6 / Sonnet 4.6 处于 deprecated 过渡期仍可用。

  it('claude-opus-4-7 (heavy 档默认) → true', () => {
    expect(manualThinkingUnsupported('claude-opus-4-7')).toBe(true);
  });

  it('claude-opus-4-8 → true', () => {
    expect(manualThinkingUnsupported('claude-opus-4-8')).toBe(true);
  });

  it('claude-fable-5 → true', () => {
    expect(manualThinkingUnsupported('claude-fable-5')).toBe(true);
  });

  it('claude-opus-5-0 (未来主版本) → true', () => {
    expect(manualThinkingUnsupported('claude-opus-5-0')).toBe(true);
  });

  it('claude-opus-4-6 (过渡期 budget_tokens 仍可用) → false', () => {
    expect(manualThinkingUnsupported('claude-opus-4-6')).toBe(false);
  });

  it('claude-sonnet-4-6 → false', () => {
    expect(manualThinkingUnsupported('claude-sonnet-4-6')).toBe(false);
  });

  it('claude-haiku-4-5 → false', () => {
    expect(manualThinkingUnsupported('claude-haiku-4-5')).toBe(false);
  });

  it('Vertex 风格带版本后缀的 ID 也能匹配', () => {
    expect(manualThinkingUnsupported('claude-opus-4-7@20260301')).toBe(true);
  });

  it('大写模型名也能匹配（toLowerCase）', () => {
    expect(manualThinkingUnsupported('Claude-Opus-4-7')).toBe(true);
  });

  it('非 Claude 模型 → false', () => {
    expect(manualThinkingUnsupported('gemini-2.5-pro')).toBe(false);
  });
});
