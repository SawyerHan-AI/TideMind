import { describe, expect, it } from 'vitest';
import { callLLM, shutdownLLMClient } from '../../src/llm/client.js';

describe('LLM runtime shutdown admission', () => {
  it('shutdown latch 建立后拒绝任何新的 provider 调用', async () => {
    await shutdownLLMClient();
    await expect(callLLM({ prompt: 'must not be admitted' }))
      .rejects.toThrow('LLM runtime is shutting down');
  });
});
