/**
 * 复现 2026-05-21 问题 A 根因诊断的脚本。
 *
 * 真因: Node 22+ 内置 fetch 默认 `headersTimeout = 60_000` 写死,Vertex AI
 * `rawPredict` 是非流式 API——客户端必须等服务端把所有 max_tokens 生成完才
 * 返回 HTTP response headers。Sonnet-4-6 生成速度约 40 tokens/秒,所以
 * max_tokens >= ~2500 几乎必然超 60 秒触发 undici abort,SDK 包装成
 * `Connection error.` 没有 HTTP 状态码。
 *
 * 运行: node tests/manual/maxtokens-timeout.mjs
 * 前置: VERTEX_CRED env 指定 (~/.tidemind/vertex-credentials-*.json) 存在
 * 期望输出 (修复前):
 *   max_tokens=50  ✅ ~4s
 *   max_tokens=1000 ✅ ~24s
 *   max_tokens=4000 ❌ ~60.5s Connection error
 *   max_tokens=10000 ❌ ~60.9s Connection error
 * 修复后 (走 npm undici + 自定义 dispatcher):
 *   全部应该成功,大 max_tokens 耗时 2-5 分钟。
 */
import AnthropicVertex from '@anthropic-ai/vertex-sdk';
import { GoogleAuth } from 'google-auth-library';

// 必须显式传入,不硬编码任何项目 ID / SA 路径 (避免开源同步泄漏 PII)
const CRED = process.env.VERTEX_CRED;
const PROJECT = process.env.VERTEX_PROJECT;
const REGION = process.env.VERTEX_REGION || 'us-east5';

if (!CRED || !PROJECT) {
  console.error('Usage: VERTEX_CRED=/path/to/sa.json VERTEX_PROJECT=your-project node tests/manual/maxtokens-timeout.mjs');
  process.exit(1);
}

const client = new AnthropicVertex({
  projectId: PROJECT, region: REGION, maxRetries: 0,
  googleAuth: new GoogleAuth({ keyFile: CRED, scopes: 'https://www.googleapis.com/auth/cloud-platform' }),
});

// 模拟 profile-synthesize 真实 prompt 规模 (~30KB UTF-8 中文)
const bigPrompt = (() => {
  const crystals = Array.from({ length: 198 }, (_, i) =>
    `${i + 1}. **结晶 ${i + 1}**\n用户的核心洞察,涉及思考方法、决策风格、领域专长等综合判断。${i % 3 === 0 ? '强调批判性思维与第一性原理的结合。' : i % 3 === 1 ? '注重系统思考和反馈机制。' : '价值观倾向长期主义,做对的事不迎合。'}`
  ).join('\n\n');
  return `${crystals}\n\n请基于以上 198 条结晶,凝练一份完整深度的用户画像。`;
})();

console.log(`prompt size: ${Buffer.byteLength(bigPrompt, 'utf8')} bytes`);

const sys = `你是用户画像分析助手,基于材料凝练详尽的用户画像。要求每个维度展开充分论述,不要简略。`;

for (const maxTokens of [50, 1000, 4000, 10000]) {
  console.log(`\n--- max_tokens=${maxTokens} ---`);
  const t0 = Date.now();
  try {
    const r = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: maxTokens, system: sys,
      messages: [{ role: 'user', content: bigPrompt }],
    });
    console.log(`✅ ${Date.now() - t0}ms output=${r.usage?.output_tokens} stop=${r.stop_reason}`);
  } catch (e) {
    console.log(`❌ (${Date.now() - t0}ms) ${e?.name}: ${e?.message?.slice(0, 200)}`);
    if (e?.cause) console.log(`   cause: ${e.cause?.name}: ${e.cause?.message?.slice(0, 200)} code=${e.cause?.code}`);
  }
}
