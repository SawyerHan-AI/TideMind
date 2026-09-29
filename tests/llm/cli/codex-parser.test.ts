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

describe('Codex startup notices caused by Tide Mind isolation (real 0.156.1 smoke)', () => {
  const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');
  const notice = (message: string) => ({ type: 'item.completed', item: { id: 'item_0', type: 'error', message } });
  const codeMode = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
  const deprecated = '`[features].web_search_cached` is deprecated because web search is enabled by default.';
  const completedTurn = [
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } },
  ];

  it('ignores reviewed notices that arrive before turn.started', () => {
    const result = parseCodexJsonLines(lines(
      { type: 'thread.started', thread_id: 't' },
      notice(codeMode),
      notice(deprecated),
      ...completedTurn,
    ), 'default');
    expect(result.text).toBe('OK');
  });

  it('still fails on the same notice after the turn started', () => {
    expect(() => parseCodexJsonLines(lines(
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.started' },
      notice(codeMode),
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'OK' } },
      { type: 'turn.completed', usage: {} },
    ), 'default')).toThrow();
  });

  it('still fails on an unreviewed pre-turn error item', () => {
    expect(() => parseCodexJsonLines(lines(
      { type: 'thread.started', thread_id: 't' },
      notice('Sandbox is unavailable; running without sandbox'),
      ...completedTurn,
    ), 'default')).toThrow();
  });
});
