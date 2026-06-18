import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { expandTilde } from '../../src/utils/path.js';

describe('expandTilde', () => {
  const home = os.homedir();

  it('单独的 ~ 展开为 home', () => {
    expect(expandTilde('~')).toBe(home);
  });

  it('~/ 前缀展开为 home 拼接', () => {
    expect(expandTilde('~/notes')).toBe(path.join(home, 'notes'));
    expect(expandTilde('~/a/b/c')).toBe(path.join(home, 'a/b/c'));
  });

  it('绝对路径原样返回', () => {
    expect(expandTilde('/Users/x/notes')).toBe('/Users/x/notes');
  });

  // 回归：路径中间含 ~ 不应被破坏（旧 replace('~', home) 的 bug）
  it('路径中间或结尾的 ~ 不被展开', () => {
    expect(expandTilde('/Users/x/notes~archive')).toBe('/Users/x/notes~archive');
    expect(expandTilde('/Users/x/my~vault/notes')).toBe('/Users/x/my~vault/notes');
    expect(expandTilde('/data/backup~')).toBe('/data/backup~');
  });

  // ~user 形式不展开（无法可靠解析他人 home），原样返回
  it('~user 形式原样返回', () => {
    expect(expandTilde('~bob/notes')).toBe('~bob/notes');
    expect(expandTilde('~bob')).toBe('~bob');
  });

  it('相对路径原样返回', () => {
    expect(expandTilde('notes/foo.md')).toBe('notes/foo.md');
    expect(expandTilde('./rel')).toBe('./rel');
  });
});
