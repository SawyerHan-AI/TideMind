import { parseCodexJsonLines } from '../../../src/llm/cli/parser-codex.js';

const line = (value: unknown) => JSON.stringify(value);

describe('Codex CLI JSONL parser', () => {
  it('aggregates messages and usage', () => {
    const result = parseCodexJsonLines([
      line({ type: 'thread.started', model: 'gpt-5.6-sol' }),
      line({ type: 'turn.started' }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'one' } }),
      line({ type: 'item.completed', item: { type: 'reasoning', text: 'hidden' } }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'two' } }),
      line({
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_tokens: 3 },
      }),
    ].join('\n'), 'default');
    expect(result).toMatchObject({
      text: 'onetwo',
      actualModel: 'gpt-5.6-sol',
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      reasoningTokens: 3,
    });
  });

  it.each(['command_execution', 'mcp_tool_call', 'web_search', 'file_change'])(
    'fails closed on %s item',
    (type) => {
      expect(() => parseCodexJsonLines([
        line({ type: 'thread.started' }),
        line({ type: 'item.completed', item: { type } }),
        line({ type: 'turn.completed' }),
      ].join('\n'), 'default')).toThrowError(
        expect.objectContaining({ kind: 'permission_policy' }),
      );
    },
  );

  it('classifies passive error items as a failed turn instead of a tool event', () => {
    expect(() => parseCodexJsonLines([
      line({ type: 'thread.started' }),
      line({
        type: 'item.completed',
        item: { type: 'error', message: 'You have insufficient quota' },
      }),
    ].join('\n'), 'default')).toThrowError(
      expect.objectContaining({ kind: 'quota' }),
    );
  });

  it('fails closed on unknown active event and truncated JSONL', () => {
    expect(() => parseCodexJsonLines(line({ type: 'approval.requested' }), 'default')).toThrowError(
      expect.objectContaining({ kind: 'permission_policy' }),
    );
    expect(() => parseCodexJsonLines('{"type":', 'default')).toThrowError(
      expect.objectContaining({ kind: 'protocol' }),
    );
  });
});
