# 代谢参数
## 突触衰减（每日）

| 参数 | 值 | 说明 |
|------|-----|------|
| decay_base | 0.05 | 基础每日衰减率（connectivity=0 时衰减 5%） |
| decay_damping | 0.8 | 连通度对衰减的阻尼系数（0-1，越大保护越强） |

衰减公式: `decay_rate = 1 - base × (1 - damping × min(connectivity, 1))`

效果:
- connectivity=0 → ×0.950（每日衰减 5%，半衰期 ~14 天）
- connectivity=0.5 → ×0.970（每日衰减 3%，半衰期 ~23 天）
- connectivity=1.0 → ×0.990（每日衰减 1%，半衰期 ~69 天）

所有节点严格衰减（decay_rate 恒 < 1.0），连通度高的节点衰减更慢但不会增长。
keystone 节点通过 heat 自然衰减到极低值后仍可被强匹配召回。

## 链接衰减（赫布学习）

| 参数 | 值 | 说明 |
|------|-----|------|
| link_decay_base | 0.03 | 基础每日链接衰减率 |
| link_delete_threshold | 0.05 | strength 低于此值时删除链接 |

衰减公式: `daily_retention = 1 - link_decay_base × (1 - sqrt(heat_a × heat_b))`

- 两端都活跃 → 几乎不衰减
- 一端冷一端热 → 缓慢衰减
- 两端都冷 → 快速衰减，最终自动删除

设计理由（赫布学习）: 一起激活的神经元连接在一起；不一起激活的连接逐渐减弱。

> **注意**：已移除二元归档（archived）机制，改为 heat 自然衰减到极低值。heat ≤ 0.01 的节点在查询中自动过滤，但如果 embedding 匹配极强仍可被召回。

## 着陆连接

| 参数 | 值 | 说明 |
|------|-----|------|
| dedup_threshold | 0.92 | 向量相似度 > 此值视为重复，触发再巩固而非创建新节点 |
| landing_link_threshold | 0.80 | 向量相似度 > 此值创建 confirmed 链接 |
| pending_link_threshold | 0.60 | 向量相似度 > 此值创建 pending 链接 |
| landing_link_top_k | 2 | 每个新节点最多创建几条 confirmed 着陆连接 |
| pending_expire_days | 7 | 待确认链接过期天数 |
| pending_llm_batch_size | 5 | 每次 LLM 判断的 pending 链接数上限 |

设计理由（两阶段处理模拟）: 保守的着陆策略模拟大脑的两阶段处理——醒着时快速建立少量确定的关联，睡眠时（空闲深加工）慢慢整理潜在连接。

## 标签涌现

| 参数 | 值 | 说明 |
|------|-----|------|
| tag_promote_threshold | 25 | 标签被 N 个以上节点引用时提升为 tag 节点 |
| tag_link_min_strength | 0.3 | tagged 链接最低强度，低于此值不创建 |

## 再巩固

| 参数 | 值 | 说明 |
|------|-----|------|
| reconsolidate_min_nodes | 3 | 触发感知读的最小节点数 |
| perceptual_read_link_strength | 0.5 | 感知读链接初始强度 |
| reconsolidate_days_threshold | 7 | 触发深度读的天数阈值 |
| deep_reconsolidate_max_per_recall | 3 | 每次 recall 最多触发的深度再巩固数 |
| max_conflict_checks_per_recall | 2 | 每次 recall 最多触发的冲突检测 LLM 调用数 |
| conflict_min_overlap | 0.15 | 上下文冲突检测的最小关键词重叠度 |
| conflict_cross_min_overlap | 0.25 | 跨节点冲突检测的最小关键词重叠度 |
| conflict_high_confidence | 0.85 | 冲突置信度上限 |

## 结晶涌现

| 参数 | 值 | 说明 |
|------|-----|------|
| hub_min_links | 5 | 枢纽节点最少 confirmed 链接数 |
| hub_min_diversity | 3 | 枢纽节点最少不同关系类型数 |
| hub_min_indegree | 3 | 枢纽节点最少入度（被其他节点链接数） |

## 调度

| 参数 | 值 | 说明 |
|------|-----|------|
| decay_interval_minutes | 1440 | 突触衰减执行间隔（分钟，1440=24h） |
| tag_promote_interval_minutes | 1440 | 标签涌现执行间隔（分钟） |

### 已废弃（向后兼容保留）

| 参数 | 值 | 说明 |
|------|-----|------|
| daily_check_hours | 24 | [已废弃] 改用各任务的 interval_minutes |
| weekly_check_days | 7 | [已废弃] 改用各任务的 interval_minutes |
