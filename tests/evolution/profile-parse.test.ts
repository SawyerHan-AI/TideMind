/**
 * 画像解析与净化测试（src/evolution/profile-parse.ts）
 *
 * 核心回归:2026-06 事故——parseLLMJson 的宽容子串提取把画像 JSON 内部的数组误当
 * 顶层返回,旧 fast path 只判 truthy 就采信,导致原始 fenced JSON 全文被当画像存库。
 * 见 docs/design/hook-injection-overflow-fix-2026-06-11.md。
 *
 * 全部用虚构数据(星海科技 / DataPilot),禁止真实画像内容(PII)。
 */
import { describe, it, expect } from 'vitest';
import { parseLLMJson } from '../../src/llm/json-parse.js';
import { parseProfileResponse, sanitizeProfileContent } from '../../src/evolution/profile-parse.js';

// 复刻事故触发条件:fenced JSON + profile_text 含未转义引号(破坏顶层解析)
//                  + structured 内含一个合法 JSON 数组(被 step4 误当顶层抓出)
const POISON_FIXTURE = `\`\`\`json
{
  "profile_text": "用户是星海科技的产品负责人，期望 AI 给出"允许 X / 禁止 Y"式的精确边界定义，主导过 DataPilot 数据分析系统。",
  "structured": {
    "role": "产品负责人",
    "expertise": ["数据分析系统设计", "AI Agent 落地", "产品边界定义"]
  }
}
\`\`\``;

describe('parseProfileResponse — 事故复刻与 F1 修复', () => {
  it('fixture 确实复刻 step4 误判:parseLLMJson 对该响应返回数组而非对象', () => {
    // 这是整条 bug 的前提。若哪天 parseLLMJson 行为变了导致这里不再是数组,
    // 本套件的"回归"意义就失效了,故显式守护。
    const raw = parseLLMJson(POISON_FIXTURE);
    expect(Array.isArray(raw)).toBe(true);
  });

  it('fast path 拒收数组,落慢路径提取出干净 profile_text(不是原文全文)', () => {
    const parsed = parseProfileResponse(POISON_FIXTURE);
    expect(parsed).not.toBeNull();
    const text = parsed!.profileText;
    // 关键断言:画像文本不再是 raw JSON blob
    expect(text.trimStart().startsWith('```')).toBe(false);
    expect(text.trimStart().startsWith('{')).toBe(false);
    expect(text).toContain('星海科技');
    expect(text).toContain('允许 X / 禁止 Y'); // 未转义引号内的内容被正确还原
  });

  it('慢路径同时救回 structured', () => {
    const parsed = parseProfileResponse(POISON_FIXTURE);
    expect(parsed!.structured).toMatchObject({ role: '产品负责人' });
    expect(parsed!.structured.expertise).toBeInstanceOf(Array);
  });

  it('健康 fenced JSON(无未转义引号)走 fast path 正常返回', () => {
    const clean = `\`\`\`json
{
  "profile_text": "用户来自星海科技，主导 DataPilot 项目。",
  "structured": {"role": "PM"}
}
\`\`\``;
    const parsed = parseProfileResponse(clean);
    expect(parsed!.profileText).toBe('用户来自星海科技，主导 DataPilot 项目。');
    expect(parsed!.structured).toEqual({ role: 'PM' });
  });
});

describe('parseProfileResponse — F2 彻底失败返回 null', () => {
  it('JSON 结构但无法提取 profile_text(畸形对象)→ null,不存原文', () => {
    const unsalvageable = `\`\`\`json
{
  "wrong_key": "缺 profile_text 且这里有未转义引号 " 破坏顶层",
  "list": ["x", "y"]
}
\`\`\``;
    expect(parseProfileResponse(unsalvageable)).toBeNull();
  });

  it('纯散文(无任何 JSON 结构)→ 合理降级为纯文本画像,非 null', () => {
    const prose = '用户是一位注重边界定义的产品负责人，偏好精确表述。';
    const parsed = parseProfileResponse(prose);
    expect(parsed).not.toBeNull();
    expect(parsed!.profileText).toBe(prose);
    expect(parsed!.structured).toEqual({});
  });

  // M1(审计 A）：structured 键物理位置在 profile_text 之前 + 未转义引号,
  // 慢路径会把 profile_text 整段切掉 → profileText 为空 → 必须判 null,
  // 否则空画像会 supersede 健康旧画像。
  it('structured 在 profile_text 之前且含未转义引号 → 切出空文本 → null', () => {
    const structFirst = `\`\`\`json
{ "structured": {"role":"PM"}, "profile_text": "期望"精确"的边界定义" }
\`\`\``;
    expect(parseProfileResponse(structFirst)).toBeNull();
  });

  it('纯空白响应 → null,不创建空画像', () => {
    expect(parseProfileResponse('   \n  ')).toBeNull();
  });
});

describe('sanitizeProfileContent — F3 读取侧自愈三态', () => {
  it('污染(raw JSON blob)→ 重新提取出干净文本', () => {
    const s = sanitizeProfileContent(POISON_FIXTURE);
    expect(s).not.toBeNull();
    expect(s!.profileText.trimStart().startsWith('```')).toBe(false);
    expect(s!.profileText).toContain('星海科技');
  });

  it('健康(纯文本)→ 原样返回', () => {
    const healthy = '用户是星海科技的产品负责人，关注数据分析产品。';
    const s = sanitizeProfileContent(healthy);
    expect(s!.profileText).toBe(healthy);
    expect(s!.structured).toEqual({});
  });

  it('健康(标准 text + structured 格式)→ 切出 text 与 structured', () => {
    const standard = '用户来自星海科技。\n\n---\n\n```json\n{"role":"PM"}\n```';
    const s = sanitizeProfileContent(standard);
    expect(s!.profileText).toBe('用户来自星海科技。');
    expect(s!.structured).toEqual({ role: 'PM' });
  });

  it('不可救污染 → null,交由调用方降级', () => {
    const unsalvageable = `\`\`\`json
{ "wrong_key": "无 profile_text 未转义 " 破坏", "list": ["x"] }
\`\`\``;
    expect(sanitizeProfileContent(unsalvageable)).toBeNull();
  });
});
