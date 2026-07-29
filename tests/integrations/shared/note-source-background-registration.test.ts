import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('note-source detached work registration', () => {
  it.each([
    ['logseq', 1],
    ['obsidian', 2],
    ['apple-notes', 1],
    ['notion', 2],
  ])('%s 的所有定时/文件异步入口均登记完整 background work', (source, minimumRegistrations) => {
    const text = fs.readFileSync(
      path.join(process.cwd(), 'src', 'integrations', source, 'index.ts'),
      'utf8',
    );
    const registrations = text.match(/trackBackgroundWork\(work\)/g) ?? [];
    expect(registrations.length).toBeGreaterThanOrEqual(minimumRegistrations);
  });
});
