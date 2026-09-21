import { OPENCODE_V2_INSTRUCTION_PREPARE_PROBE } from '@server/agent-integration-recognition.js'
import { sha256Bytes } from '../fingerprint'

export const PORTABLE_TIDEMIND_SKILL = `---
name: tidemind
description: Tide Mind 外部记忆系统。用于在对话开始时准备用户上下文、按需检索历史记忆，并沉淀有长期价值的信息。
---

# Tide Mind

- 新会话开始时，优先调用 \`brain_prepare\` 获取用户画像、记忆索引和行为指导。
- 回答依赖历史背景、既往决策或用户偏好时，调用 \`brain_recall\`，并提供清晰的查询背景。
- 对话产生重要决策、事实、偏好、纠正或后续行动时，调用 \`brain_digest\` 保存；不要存储无实质价值的寒暄。
- 如果记忆工具当前不可用，请明确说明，不能假装已经查询或保存。

## OpenCode V2 接入确认

仅当当前宿主是 OpenCode V2 时：首次读取本说明后，在当前会话调用 \`brain_prepare\`，并将 \`integration_probe\` 精确设为 \`${OPENCODE_V2_INSTRUCTION_PREPARE_PROBE}\`。这个值只用于确认当前 OpenCode V2 会话已加载这份 Tide Mind 使用说明，不要把它写入 \`hint\` 或其他用户上下文字段。
`

/** Exact bytes written by every managed-text Skill adapter. */
export const NORMALIZED_PORTABLE_TIDEMIND_SKILL = `${PORTABLE_TIDEMIND_SKILL.replace(/\s+$/u, '')}\n`
export const PORTABLE_TIDEMIND_SKILL_SHA256 = sha256Bytes(NORMALIZED_PORTABLE_TIDEMIND_SKILL)
