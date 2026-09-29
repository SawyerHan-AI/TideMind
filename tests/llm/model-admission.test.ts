import { describe, expect, it } from 'vitest';
import {
  evaluateModelAdmission,
  type AdmissionInput,
} from '../../src/llm/model-admission.js';
import type { ModelObservation, ObservationOutcome } from '../../src/db/model-discovery.js';
import { pinnedModelMatches, selectionModeFor } from '../../src/llm/cli/catalogs.js';

const NOW = Date.parse('2026-09-25T08:00:00.000Z');

function observation(
  outcome: ObservationOutcome,
  extra: Partial<ModelObservation> = {},
): ModelObservation {
  return {
    connectionId: 'mc_fixture',
    scopeKey: 'codex-cli:xinghai',
    authEpoch: 3,
    modelId: 'gpt-5.3-codex',
    selectionMode: 'pinned_id',
    lastOutcome: outcome,
    errorKind: null,
    errorMessage: null,
    actualModel: null,
    lastSource: 'business',
    lastSuccessAt: outcome === 'success' ? '2026-09-20T00:00:00.000Z' : null,
    lastFailureAt: outcome === 'success' ? null : '2026-09-25T07:59:00.000Z',
    backoffUntil: null,
    updatedAt: '2026-09-25T07:59:00.000Z',
    ...extra,
  };
}

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    purpose: 'background',
    providerType: 'codex-cli',
    connectionStatus: 'online',
    scopeState: 'known',
    modelId: 'gpt-5.3-codex',
    observation: null,
    now: NOW,
    ...overrides,
  };
}

const both = ['background', 'connection_test'] as const;

describe('evaluateModelAdmission — design §5.4 matrix', () => {
  it('新发现/手动 ID、已选入路由、环境与认证有效：允许首次调用，firstCall=true', () => {
    for (const purpose of both) {
      expect(evaluateModelAdmission(input({ purpose }))).toEqual({
        allowed: true,
        selectionMode: 'pinned_id',
        firstCall: true,
      });
    }
    // Manual id with unusual but valid characters.
    expect(evaluateModelAdmission(input({ modelId: 'datapilot/fine-tune:v2@2026' })))
      .toMatchObject({ allowed: true, firstCall: true });
  });

  it('同一认证范围的历史成功：允许且 firstCall=false；TTL/目录缺席不影响', () => {
    const decision = evaluateModelAdmission(input({
      observation: observation('success', { lastSuccessAt: '2025-01-01T00:00:00.000Z' }),
    }));
    expect(decision).toEqual({ allowed: true, selectionMode: 'pinned_id', firstCall: false });
  });

  it('历史成功后的临时失败（无 backoff）仍允许，firstCall 仍为 false', () => {
    expect(evaluateModelAdmission(input({
      observation: observation('temporary_failure', { lastSuccessAt: '2026-09-01T00:00:00.000Z' }),
    }))).toEqual({ allowed: true, selectionMode: 'pinned_id', firstCall: false });
  });

  it.each(['model_rejected', 'mismatch'] as const)(
    '%s 阻断后台，但显式 connection_test 允许重测',
    (outcome) => {
      const obs = observation(outcome);
      expect(evaluateModelAdmission(input({ observation: obs }))).toMatchObject({
        allowed: false,
        reason: outcome === 'mismatch' ? 'model_mismatch' : 'model_rejected',
      });
      expect(evaluateModelAdmission(input({ purpose: 'connection_test', observation: obs })))
        .toMatchObject({ allowed: true });
    },
  );

  it('backoff 未到期阻断后台（带 retryAt），到期后允许；测试不受 backoff 限制', () => {
    const future = new Date(NOW + 60_000).toISOString();
    const past = new Date(NOW - 1).toISOString();
    expect(evaluateModelAdmission(input({
      observation: observation('temporary_failure', { backoffUntil: future }),
    }))).toEqual({ allowed: false, selectionMode: 'pinned_id', reason: 'backoff', retryAt: future });
    expect(evaluateModelAdmission(input({
      observation: observation('temporary_failure', { backoffUntil: new Date(NOW).toISOString() }),
    }))).toMatchObject({ allowed: true });
    expect(evaluateModelAdmission(input({
      observation: observation('unclassified_failure', { backoffUntil: past }),
    }))).toMatchObject({ allowed: true, firstCall: true });
    expect(evaluateModelAdmission(input({
      purpose: 'connection_test',
      observation: observation('temporary_failure', { backoffUntil: future }),
    }))).toMatchObject({ allowed: true });
    // An unparseable backoff timestamp is not treated as an active cooldown.
    expect(evaluateModelAdmission(input({
      observation: observation('temporary_failure', { backoffUntil: 'not-a-date' }),
    }))).toMatchObject({ allowed: true });
  });

  it('scope unknown 阻断后台；测试允许', () => {
    expect(evaluateModelAdmission(input({ scopeState: 'unknown' }))).toMatchObject({
      allowed: false,
      reason: 'scope_unknown',
    });
    expect(evaluateModelAdmission(input({ scopeState: 'unknown', purpose: 'connection_test' })))
      .toMatchObject({ allowed: true, firstCall: true });
  });

  it('尚无 binding（null）不在 route 预判：由 service 绑定后在租约内再准入', () => {
    expect(evaluateModelAdmission(input({ scopeState: null }))).toMatchObject({ allowed: true });
  });

  it('ambiguous / 环境失败 / busy 阻断后台；测试作为恢复路径允许', () => {
    const cases: Array<[string, string]> = [
      ['ambiguous', 'ambiguous_outcome'],
      ['checking', 'connection_busy'],
      ['testing', 'connection_busy'],
      ['not_installed', 'connection_unavailable'],
      ['not_authenticated', 'connection_unavailable'],
      ['wrong_auth_method', 'connection_unavailable'],
      ['unsupported_version', 'connection_unavailable'],
      ['offline', 'connection_unavailable'],
      ['unconfigured', 'connection_unavailable'],
    ];
    for (const [connectionStatus, reason] of cases) {
      expect(evaluateModelAdmission(input({ connectionStatus })), connectionStatus)
        .toMatchObject({ allowed: false, reason });
      expect(evaluateModelAdmission(input({ connectionStatus, purpose: 'connection_test' })), connectionStatus)
        .toMatchObject({ allowed: true });
    }
    // Environment is checked before scope: a busy unknown-scope connection reports busy.
    expect(evaluateModelAdmission(input({ connectionStatus: 'testing', scopeState: 'unknown' })))
      .toMatchObject({ reason: 'connection_busy' });
    for (const connectionStatus of ['online', 'untested', 'degraded']) {
      expect(evaluateModelAdmission(input({ connectionStatus })), connectionStatus)
        .toMatchObject({ allowed: true });
    }
  });

  it('ambiguous 观察本身不阻断（连接级 ambiguous 状态才阻断）', () => {
    expect(evaluateModelAdmission(input({ observation: observation('ambiguous') })))
      .toMatchObject({ allowed: true });
  });

  it('API 连接只挡 offline；不看 scope / 观察 / 模型 ID 形状', () => {
    for (const providerType of ['anthropic', 'openai-compatible', 'gemini', 'ollama']) {
      expect(evaluateModelAdmission(input({
        providerType,
        connectionStatus: 'offline',
      }))).toMatchObject({ allowed: false, reason: 'connection_unavailable' });
      expect(evaluateModelAdmission(input({
        providerType,
        connectionStatus: 'untested',
        scopeState: null,
        modelId: 'models/gemini 2.5 pro',
        observation: observation('model_rejected'),
      }))).toMatchObject({ allowed: true, firstCall: false });
    }
  });

  it('legacy 路由直接放行', () => {
    expect(evaluateModelAdmission(input({ connectionStatus: 'legacy', scopeState: null })))
      .toMatchObject({ allowed: true, firstCall: false });
  });

  it('非法模型 ID 对后台和测试都阻断', () => {
    for (const modelId of ['', ' gpt-5', '-m', '--model=x', 'gpt 5', 'a;rm -rf /', 'x'.repeat(129), 'ç-model', 'gpt-5\n']) {
      for (const purpose of both) {
        expect(evaluateModelAdmission(input({ purpose, modelId })), `${purpose}:${JSON.stringify(modelId)}`)
          .toMatchObject({ allowed: false, reason: 'invalid_model_id' });
      }
    }
    expect(evaluateModelAdmission(input({ modelId: 'x'.repeat(128) }))).toMatchObject({ allowed: true });
  });

  it('选择模式：default → follow_default，Claude 家族 alias → alias，其余 → pinned_id', () => {
    expect(evaluateModelAdmission(input({ modelId: 'default' })).selectionMode).toBe('follow_default');
    expect(evaluateModelAdmission(input({ providerType: 'claude-cli', modelId: 'sonnet' })).selectionMode)
      .toBe('alias');
    expect(selectionModeFor('claude-cli', 'opus[1m]')).toBe('alias');
    expect(selectionModeFor('claude-cli', 'claude-sonnet-4-6')).toBe('pinned_id');
    // Codex has no family aliases: a bare word is a pinned id.
    expect(selectionModeFor('codex-cli', 'sonnet')).toBe('pinned_id');
  });
});

describe('pinnedModelMatches', () => {
  it('only identity or a dated snapshot suffix of the same id is equivalent', () => {
    expect(pinnedModelMatches('claude-sonnet-4-6', 'claude-sonnet-4-6')).toBe(true);
    expect(pinnedModelMatches('claude-sonnet-4-6', 'claude-sonnet-4-6-20260101')).toBe(true);
    expect(pinnedModelMatches('claude-sonnet-4-6', 'claude-sonnet-4-6-2026')).toBe(false);
    expect(pinnedModelMatches('claude-sonnet-4-6', 'claude-sonnet-4-6-20260101-extra')).toBe(false);
    expect(pinnedModelMatches('claude-sonnet-4-6', 'claude-opus-4-1')).toBe(false);
    expect(pinnedModelMatches('gpt-5', 'gpt-5.3-codex')).toBe(false);
    expect(pinnedModelMatches('gpt-5', 'gpt-5-mini')).toBe(false);
  });
});
