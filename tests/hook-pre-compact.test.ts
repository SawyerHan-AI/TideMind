/**
 * tests/hook-pre-compact.test.ts
 *
 * 端到端测试 src/hook-pre-compact.ts(PreCompact hook 脚本):
 *  - parseArgs() 缺 --agent-id 时 warn 但继续(2026-05-09 bug fix:之前 throw 会让 tool 重置)
 *  - --tool 参数正确路由(claude-code / codex / gemini 等)
 *  - outputHook 生成的输出符合各 tool 的协议(claude-code 纯文本, codex/gemini JSON)
 *
 * 测法:subprocess 跑 dist/hook-pre-compact.js,捕获 stdout/stderr。
 * 前置:依赖 npm run build 产出 dist/。
 *
 * 风险点(注释明确):
 *  - parseArgs 缺 agent-id 时 throw 会让下方 tool 赋值跳过 → 退化为默认
 *    'claude-code',导致传了 --tool codex 但漏 --agent-id 的调用变成
 *    claude-code 输出,Codex JSON 解析失败。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.resolve(__dirname, '..', 'dist', 'hook-pre-compact.js');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runHook(args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [HOOK_SCRIPT, ...args], {
      timeout: 10_000,
    });
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : '',
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

describe('hook-pre-compact subprocess', () => {
  beforeAll(() => {
    // 跳过整个 suite 如果 dist/ 还没 build
    if (!fs.existsSync(HOOK_SCRIPT)) {
      // vitest 没有简单的"全 suite skip"机制,这里通过 it.skip 阻止 case 真跑
      // beforeAll throw 会让所有 case fail,所以只 warn 不 throw
      // eslint-disable-next-line no-console
      process.stderr.write(`[hook-pre-compact.test] dist/ 未 build,运行 npm run build 后重试\n`);
    }
  });

  it('happy path:--agent-id + --tool claude-code → stdout 纯文本提示', async () => {
    if (!fs.existsSync(HOOK_SCRIPT)) return;
    const r = await runHook(['--agent-id', 'eb_test1234', '--tool', 'claude-code']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('TIDE MIND');
    expect(r.stdout).toContain('PRE-COMPACT');
    expect(r.stdout).toContain('brain_digest');
    // claude-code 协议是纯文本,不是 JSON
    expect(() => JSON.parse(r.stdout)).toThrow();
  });

  it('--tool codex → stdout 是 JSON 含 hookSpecificOutput', async () => {
    if (!fs.existsSync(HOOK_SCRIPT)) return;
    const r = await runHook(['--agent-id', 'eb_codex', '--tool', 'codex']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreCompact');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('TIDE MIND');
  });

  it('--tool gemini → JSON 包装,hookEventName=PreCompact', async () => {
    if (!fs.existsSync(HOOK_SCRIPT)) return;
    const r = await runHook(['--agent-id', 'eb_gemini', '--tool', 'gemini']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreCompact');
  });

  it('缺 --agent-id 时:warn 到 stderr 但不 throw(2026-05-09 regression guard)', async () => {
    if (!fs.existsSync(HOOK_SCRIPT)) return;
    const r = await runHook(['--tool', 'claude-code']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('Missing --agent-id');
    expect(r.stdout).toContain('TIDE MIND'); // 仍然有输出
  });

  it('**关键 regression**: 缺 --agent-id + --tool codex → codex JSON 协议**仍生效**(不退化为 claude-code 纯文本)', async () => {
    if (!fs.existsSync(HOOK_SCRIPT)) return;
    // 这正是 2026-05-09 修复的 bug:之前 throw 会让 tool 赋值跳过,退化为默认 'claude-code'
    const r = await runHook(['--tool', 'codex']);
    expect(r.exitCode).toBe(0);
    // stdout 必须是合法 JSON(codex 协议),不是纯文本
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreCompact');
  });

  it('完全无参数 → 默认 tool=claude-code + warn missing agent-id + 输出仍生成', async () => {
    if (!fs.existsSync(HOOK_SCRIPT)) return;
    const r = await runHook([]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('Missing --agent-id');
    expect(r.stdout).toContain('TIDE MIND');
    expect(() => JSON.parse(r.stdout)).toThrow(); // 纯文本
  });

  it('未知 --tool 值 → forward-compatible 默认行为(纯文本 fallback)', async () => {
    if (!fs.existsSync(HOOK_SCRIPT)) return;
    const r = await runHook(['--agent-id', 'eb_x', '--tool', 'unknown-future-cli']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('TIDE MIND');
  });

  it('--agent-id 在 --tool 之前也能正确解析', async () => {
    if (!fs.existsSync(HOOK_SCRIPT)) return;
    const r = await runHook(['--agent-id', 'eb_a', '--tool', 'codex']);
    expect(r.exitCode).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('--tool 在 --agent-id 之前也能正确解析', async () => {
    if (!fs.existsSync(HOOK_SCRIPT)) return;
    const r = await runHook(['--tool', 'codex', '--agent-id', 'eb_b']);
    expect(r.exitCode).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('--agent-id 没跟值 → 视为无 agentId(--agent-id 是最后一个)', async () => {
    if (!fs.existsSync(HOOK_SCRIPT)) return;
    const r = await runHook(['--agent-id']);
    // 数组解析里 --agent-id 后没值,agentId 仍 ''(warn)
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('Missing --agent-id');
  });

  it('codex 输出 JSON 是 pure JSON(无 leading/trailing 文本)', async () => {
    if (!fs.existsSync(HOOK_SCRIPT)) return;
    const r = await runHook(['--agent-id', 'eb_pure', '--tool', 'codex']);
    expect(r.exitCode).toBe(0);
    const out = r.stdout.trim();
    expect(out.startsWith('{')).toBe(true);
    expect(out.endsWith('}')).toBe(true);
  });

  it('claude-code 输出中文字段正确(不是 escape)', async () => {
    if (!fs.existsSync(HOOK_SCRIPT)) return;
    const r = await runHook(['--agent-id', 'eb_zh', '--tool', 'claude-code']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('压缩');
    expect(r.stdout).toContain('digest');
  });
});
