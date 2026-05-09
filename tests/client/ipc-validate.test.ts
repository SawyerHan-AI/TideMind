import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {
  validateConnectionId,
  validateProviderType,
  validateAgentId,
  validatePluginName,
  validateCli,
  assertPathWithinRoot,
  ALLOWED_PROVIDER_TYPES,
  ALLOWED_CLIS,
} from '../../client/electron/ipc/_validate.js';

// 这些 validator 是 IPC 入口的安全边界。S11 加入正则白名单 + assertPathWithinRoot
// 保护了 Vertex SA 私钥写入路径不被路径穿越覆盖到任意位置。
// 测试目的:正则一旦被无意改宽,CI 立即报。

describe('validateConnectionId', () => {
  it('accepts well-formed mc_xxxxxxxx', () => {
    expect(validateConnectionId('mc_abcdef01')).toBe('mc_abcdef01');
  });

  it('rejects missing prefix', () => {
    expect(() => validateConnectionId('abcdef01')).toThrow(/Invalid connectionId/);
  });

  it('rejects wrong prefix', () => {
    expect(() => validateConnectionId('eb_abcdef01')).toThrow();
  });

  it('rejects uppercase hex', () => {
    expect(() => validateConnectionId('mc_ABCDEF01')).toThrow();
  });

  it('rejects too short', () => {
    expect(() => validateConnectionId('mc_abc')).toThrow();
  });

  it('rejects too long', () => {
    expect(() => validateConnectionId('mc_abcdef0123')).toThrow();
  });

  it('rejects path traversal attempt', () => {
    expect(() => validateConnectionId('mc_abc/../etc')).toThrow();
    expect(() => validateConnectionId('../../etc/passwd')).toThrow();
  });

  it('rejects null / number / object', () => {
    expect(() => validateConnectionId(null)).toThrow();
    expect(() => validateConnectionId(42 as unknown)).toThrow();
    expect(() => validateConnectionId({ id: 'mc_abcdef01' } as unknown)).toThrow();
  });
});

describe('validateProviderType', () => {
  it('accepts every allowed provider', () => {
    for (const p of ALLOWED_PROVIDER_TYPES) {
      expect(validateProviderType(p)).toBe(p);
    }
  });

  it('rejects unknown provider', () => {
    expect(() => validateProviderType('cohere')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateProviderType('')).toThrow();
  });

  it('is case-sensitive', () => {
    expect(() => validateProviderType('Anthropic')).toThrow();
    expect(() => validateProviderType('VERTEX')).toThrow();
  });
});

describe('validateAgentId', () => {
  it('accepts eb_ prefix + 8 hex', () => {
    expect(validateAgentId('eb_12345678')).toBe('eb_12345678');
  });

  it('accepts up to 32 chars after prefix', () => {
    expect(validateAgentId('eb_' + 'a'.repeat(32))).toBeTruthy();
  });

  it('rejects > 32 chars after prefix', () => {
    expect(() => validateAgentId('eb_' + 'a'.repeat(33))).toThrow();
  });

  it('rejects path traversal', () => {
    expect(() => validateAgentId('../etc')).toThrow();
    expect(() => validateAgentId('eb_../bad')).toThrow();
  });
});

describe('validatePluginName', () => {
  it('accepts tidemind-eb_xxxxxxxx', () => {
    expect(validatePluginName('tidemind-eb_abcdef01')).toBe('tidemind-eb_abcdef01');
  });

  it('rejects bare agentId', () => {
    expect(() => validatePluginName('eb_abcdef01')).toThrow();
  });

  it('rejects path traversal', () => {
    expect(() => validatePluginName('tidemind-eb_../bad')).toThrow();
  });
});

describe('validateCli', () => {
  it('accepts every allowed cli', () => {
    for (const c of ALLOWED_CLIS) {
      expect(validateCli(c)).toBe(c);
    }
  });

  it('rejects shell-injection-shaped input', () => {
    expect(() => validateCli('claude; rm -rf /')).toThrow();
    expect(() => validateCli('claude && evil')).toThrow();
    expect(() => validateCli('$(echo evil)')).toThrow();
  });
});

describe('assertPathWithinRoot', () => {
  const root = path.join(os.tmpdir(), 'tidemind-test-root');

  it('passes for path strictly under root', () => {
    expect(() => assertPathWithinRoot(path.join(root, 'foo.txt'), root)).not.toThrow();
    expect(() => assertPathWithinRoot(path.join(root, 'sub', 'bar.txt'), root)).not.toThrow();
  });

  it('passes for the root itself', () => {
    expect(() => assertPathWithinRoot(root, root)).not.toThrow();
  });

  it('rejects parent escape via ..', () => {
    expect(() => assertPathWithinRoot(path.join(root, '..', 'etc', 'passwd'), root)).toThrow(/Path escape/);
  });

  it('rejects sibling-with-prefix attack', () => {
    // /tmp/tidemind-test-root2 不能被允许 (prefix 共享前缀但不在 root 下)
    expect(() => assertPathWithinRoot(root + '2', root)).toThrow(/Path escape/);
  });

  it('rejects absolute path outside root', () => {
    expect(() => assertPathWithinRoot('/etc/passwd', root)).toThrow();
  });
});
