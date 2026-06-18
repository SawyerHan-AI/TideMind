/**
 * Skill 使用指南体积守门测试（S1 瘦身的回弹防护）。
 *
 * SessionStart hook 注入正文 = 使用指南 + prepare 结果,受 Claude Code 10,000 字符
 * 硬上限约束(见 docs/design/hook-injection-overflow-fix-2026-06-11.md)。使用指南
 * 是其中的固定成本,必须保持精简——参数 reference 已由 MCP zod schema 覆盖,指南只留
 * 行为原则。这里设阈值防止未来文案无意中回弹到旧的 ~2700 字符。
 *
 * 阈值留了余量(hook 变体 ≤2000、其余 ≤2500),避免误伤正常微调;实际应在 ~1100 以内。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SKILL_DIR = path.join(__dirname, '..', 'data', 'skill');

// hook 注入变体(SessionStart/Bootstrap 自动加载,无 brain_prepare 调用段)
const HOOK_VARIANTS = ['claude-code', 'codex', 'gemini', 'openclaw'];
// prepare 调用变体(含 brain_prepare 说明段,体积略大)
const PREPARE_VARIANTS = ['base', 'cowork', 'cursor', 'windsurf'];

const HOOK_MAX = 2000;
const PREPARE_MAX = 2500;

describe('skill 使用指南体积守门', () => {
  for (const name of HOOK_VARIANTS) {
    it(`${name}-skill.md ≤ ${HOOK_MAX} 字符`, () => {
      const content = readFileSync(path.join(SKILL_DIR, `${name}-skill.md`), 'utf-8');
      expect(content.length).toBeLessThanOrEqual(HOOK_MAX);
    });
  }

  for (const name of PREPARE_VARIANTS) {
    it(`${name}-skill.md ≤ ${PREPARE_MAX} 字符`, () => {
      const content = readFileSync(path.join(SKILL_DIR, `${name}-skill.md`), 'utf-8');
      expect(content.length).toBeLessThanOrEqual(PREPARE_MAX);
    });
  }

  it('每个变体都保留核心行为原则(不被瘦身砍穿)', () => {
    for (const name of [...HOOK_VARIANTS, ...PREPARE_VARIANTS]) {
      const content = readFileSync(path.join(SKILL_DIR, `${name}-skill.md`), 'utf-8');
      expect(content).toContain('brain_digest');
      expect(content).toContain('brain_recall');
      expect(content).toContain('context'); // recall 的 context 质量原则
    }
  });
});
