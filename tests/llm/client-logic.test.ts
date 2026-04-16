import { describe, it, expect } from 'vitest';

// ── Inlined from src/llm/client.ts (pure logic, no SDK dependency) ──

class LLMServiceError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'LLMServiceError';
  }
}

const TIMEOUT_MS_BY_TIER: Record<'light' | 'standard' | 'heavy', number> = {
  light: 60_000,
  standard: 180_000,
  heavy: 300_000,
};

function isRetryable(err: unknown): boolean {
  if (err instanceof LLMServiceError) {
    return err.statusCode === 429 || (err.statusCode != null && err.statusCode >= 500);
  }
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) return true;
  }
  return false;
}

function isServiceError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) return true;
    if (msg.includes('API error') || msg.includes('API key')) return true;
    if (/\b(401|403|429|500|502|503)\b/.test(msg)) return true;
  }
  return false;
}

function extractThinking(rawText: string): { text: string; thinkingTokens: number } {
  let text = rawText;
  let thinkingTokens = 0;
  const thinkMatch = rawText.match(/^<think>([\s\S]*?)<\/think>\s*/);
  if (thinkMatch) {
    text = rawText.slice(thinkMatch[0].length);
    thinkingTokens = Math.ceil(thinkMatch[1].length / 4);
  }
  return { text, thinkingTokens };
}

function normalizeBaseUrl(rawUrl: string): string {
  const cleaned = rawUrl.replace(/\/+$/, '');
  return cleaned.endsWith('/v1') ? cleaned : cleaned + '/v1';
}

// ── Tests ──

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

describe('TIMEOUT_MS_BY_TIER', () => {
  it('light = 60_000ms', () => {
    expect(TIMEOUT_MS_BY_TIER.light).toBe(60_000);
  });

  it('standard = 180_000ms', () => {
    expect(TIMEOUT_MS_BY_TIER.standard).toBe(180_000);
  });

  it('heavy = 300_000ms', () => {
    expect(TIMEOUT_MS_BY_TIER.heavy).toBe(300_000);
  });

  it('light < standard < heavy', () => {
    expect(TIMEOUT_MS_BY_TIER.light).toBeLessThan(TIMEOUT_MS_BY_TIER.standard);
    expect(TIMEOUT_MS_BY_TIER.standard).toBeLessThan(TIMEOUT_MS_BY_TIER.heavy);
  });
});

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

  describe('API errors → true', () => {
    it('API error in message', () => {
      expect(isServiceError(new Error('API error: something went wrong'))).toBe(true);
    });

    it('API key in message', () => {
      expect(isServiceError(new Error('Invalid API key provided'))).toBe(true);
    });
  });

  describe('HTTP status codes in message → true', () => {
    it.each([401, 403, 429, 500, 502, 503])('status %d', (code) => {
      expect(isServiceError(new Error(`HTTP ${code}: error`))).toBe(true);
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

describe('extractThinking', () => {
  it('no think tags → text unchanged, 0 tokens', () => {
    const result = extractThinking('Hello world');
    expect(result.text).toBe('Hello world');
    expect(result.thinkingTokens).toBe(0);
  });

  it('with think tags → thinking removed, tokens counted', () => {
    const thinking = 'Let me reason about this carefully step by step';
    const body = 'The answer is 42.';
    const raw = `<think>${thinking}</think>\n${body}`;
    const result = extractThinking(raw);
    expect(result.text).toBe(body);
    expect(result.thinkingTokens).toBe(Math.ceil(thinking.length / 4));
  });

  it('empty think tags → empty thinking, 0 tokens', () => {
    const result = extractThinking('<think></think>Some response');
    expect(result.text).toBe('Some response');
    expect(result.thinkingTokens).toBe(0);
  });

  it('think tags with content after → content preserved', () => {
    const result = extractThinking('<think>reasoning</think>   Here is my answer.\nWith multiple lines.');
    expect(result.text).toBe('Here is my answer.\nWith multiple lines.');
    expect(result.thinkingTokens).toBeGreaterThan(0);
  });

  it('think tags not at start → not extracted (regex anchored to ^)', () => {
    const raw = 'prefix <think>reasoning</think> suffix';
    const result = extractThinking(raw);
    expect(result.text).toBe(raw);
    expect(result.thinkingTokens).toBe(0);
  });

  it('nested think tags → only outer matched (lazy quantifier)', () => {
    const raw = '<think>outer <think>inner</think> rest</think> final answer';
    const result = extractThinking(raw);
    // The lazy [\s\S]*? matches up to the first </think>
    // So it captures "outer <think>inner" and the remaining " rest</think> final answer" is the text
    expect(result.text).toBe('rest</think> final answer');
    expect(result.thinkingTokens).toBe(Math.ceil('outer <think>inner'.length / 4));
  });

  it('multiline thinking content', () => {
    const thinking = 'line 1\nline 2\nline 3';
    const raw = `<think>${thinking}</think>\nResult`;
    const result = extractThinking(raw);
    expect(result.text).toBe('Result');
    expect(result.thinkingTokens).toBe(Math.ceil(thinking.length / 4));
  });
});

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
