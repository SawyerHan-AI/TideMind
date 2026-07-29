import { parseClaudeResult } from '../../../src/llm/cli/parser-claude.js';

describe('Claude CLI parser', () => {
  it('parses successful text and usage', () => {
    const result = parseClaudeResult(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'answer',
      model: 'claude-fable-5',
      usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 4 },
    }), 'fable');
    expect(result).toMatchObject({
      text: 'answer',
      selectedModelAlias: 'fable',
      actualModel: 'claude-fable-5',
      inputTokens: 10,
      cachedInputTokens: 3,
      outputTokens: 4,
    });
  });

  it.each([
    '',
    '{}',
    '{"type":"result","subtype":"success","result":""}',
    '{"type":"result","subtype":"error","result":"partial"}',
  ])('fails closed for invalid output %#', (fixture) => {
    expect(() => parseClaudeResult(fixture, 'default')).toThrow();
  });

  it('classifies quota without exposing stderr', () => {
    expect(() => parseClaudeResult('', 'default', 1, 'usage limit exceeded for account')).toThrowError(
      expect.objectContaining({ kind: 'quota', message: 'Claude CLI failed with exit code 1' }),
    );
  });
});
