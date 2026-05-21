/**
 * tests/scripts/check-version-sync.test.ts
 *
 * 2026-05-21 audit F11:check-version-sync.mjs 的 AboutSection.tsx 正则
 * 原本 `currentVersion[\s\S]*?useState\(['"]([\d.]+)['"]\)` 用了 .* 跨行,
 * 可以匹配到组件里**任何**后面的 useState('X.Y.Z'),容易把别的字符串
 * 字面量误当成版本号(比如某 status 默认值)。改紧后必须是
 * `const [currentVersion, ...] = useState('X.Y.Z')` 这一行结构。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error mjs without declaration
import * as mod from '../../scripts/check-version-sync.mjs';

interface Check {
  file: string;
  extract: (content: string) => string | undefined;
}

const checks = mod.checks as Check[];
const aboutCheck = checks.find(c => c.file.includes('AboutSection'))!;

describe('check-version-sync: AboutSection extract regex (audit-5 F11)', () => {
  it('正确从 useState 解构行抽到版本号', () => {
    const src = `
      import { useState } from 'react';
      export function AboutSection() {
        const [currentVersion, setCurrentVersion] = useState('0.2.72');
        return <div>{currentVersion}</div>;
      }
    `;
    expect(aboutCheck.extract(src)).toBe('0.2.72');
  });

  it('忽略其他 useState 字面量(防劫持回归)', () => {
    // 老正则 `currentVersion[\s\S]*?useState\(['"]([\d.]+)['"]\)` 是非贪婪,
    // 在"currentVersion 标识符出现之后的第一个 useState('X.X.X')"上命中。
    // 若 currentVersion 那行没字面量、下一行 useState 字面量是别的版本号,
    // 老正则会把别的版本号当成 currentVersion 的值。新正则要求字面量直接
    // 跟在 `const [currentVersion,...] = ` 后,本场景下应返 undefined。
    const src = `
      const [currentVersion, setCurrentVersion] = useState(initialVersion);
      const [statusLabel, setStatusLabel] = useState('1.2.3');
    `;
    expect(aboutCheck.extract(src)).toBeUndefined();
  });

  it('双引号也能匹配', () => {
    const src = `const [currentVersion, setCurrentVersion] = useState("0.3.0");`;
    expect(aboutCheck.extract(src)).toBe('0.3.0');
  });

  it('泛型 useState<string>(...) 当前不匹配(已知 limitation)', () => {
    // AboutSection 实际写法是 useState('0.2.72') 不带泛型,故不实现。
    const src = `const [currentVersion, setCurrentVersion] = useState<string>('0.2.72');`;
    expect(aboutCheck.extract(src)).toBeUndefined();
  });

  it('实际 AboutSection.tsx 仍能抽出正确版本号(smoke)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const realPath = path.resolve(here, '../../client/src/components/settings/AboutSection.tsx');
    if (!fs.existsSync(realPath)) return;
    const content = fs.readFileSync(realPath, 'utf8');
    const v = aboutCheck.extract(content);
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
