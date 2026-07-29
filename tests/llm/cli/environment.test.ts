import { assertNoForbiddenEnvironment, sanitizeCliEnvironment } from '../../../src/llm/cli/environment.js';

describe('CLI environment sanitizer', () => {
  it('keeps only runtime identity/locale and controlled PATH', () => {
    const env = sanitizeCliEnvironment({
      HOME: '/Users/test',
      USER: 'test',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      OPENAI_API_KEY: 'secret',
      ANTHROPIC_API_KEY: 'secret',
      OPENAI_BASE_URL: 'https://evil.invalid',
      NODE_OPTIONS: '--require evil',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      SSH_AUTH_SOCK: '/tmp/agent',
      HTTPS_PROXY: 'https://proxy.invalid',
      BUSINESS_TOKEN: 'secret',
    }, '/safe/bin/codex', '/safe/bin:/usr/bin:/bin');

    expect(env).toEqual({
      HOME: '/Users/test',
      USER: 'test',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      PATH: '/safe/bin:/usr/bin:/bin',
    });
    expect(() => assertNoForbiddenEnvironment(env)).not.toThrow();
  });

  it('detects accidental forbidden keys', () => {
    expect(() => assertNoForbiddenEnvironment({ OPENAI_API_KEY: 'x' })).toThrow(
      /unsafe CLI environment/,
    );
  });
});
