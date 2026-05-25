# 排序策略 (v0.2.77+)

> v0.2.77 重设计：加 recency 维度、砍 intent 修饰规则、统一加权约束 α+β+γ+δ=1.0。
> 设计 doc: docs/design/brain-recall-redesign-2026-05.md §7.1 / §8.6

## 混合搜索综合评分公式

```
final = α × keyword + β × semantic + γ × heat + δ × recency
```

其中:
- `keyword`: BM25 (local) / ts_rank (cloud)，归一化到 [0,1]
- `semantic`: 向量余弦相似度 [0,1]（归一化向量）
- `heat`: nodes.heat 字段 [0,1]（历史累计被引用频次，含衰减）
- `recency`: `exp(-age_days / τ)`，τ=30（创建时间衰减因子）

## 基础权重（v0.2.77 调整）

| 参数 | 值 | 说明 |
|------|-----|------|
| alpha | 0.40 | BM25 / ts_rank 关键词匹配 |
| beta | 0.45 | 向量语义相似度 |
| gamma | 0.10 | heat（历史累计被引用频次） |
| delta | 0.05 | recency（创建时间衰减） |

**强约束**：`|α + β + γ + δ - 1.0| < 0.01`，保证 final ∈ [0,1]。

**约束执行机制**：strategy 加载时若总和不归一化 → reject 加载（fallback 到 hardcoded defaults 并 log error）。不做自动归一化，避免用户配置看似生效实际被改。

## heat 与 recency 不重复加权

| 维度 | 语义 | 计算 |
|---|---|---|
| `heat` | **历史累计被引用频次（含衰减）** | nodes.heat 字段，受 bumpHeat 累计 + 自然衰减 |
| `recency` | **创建时间到现在的衰减** | `exp(-age_days / τ)`，τ=30（30 天前权重 ≈ 1/e） |

新建记忆：heat=1（出生）+ recency=1，γ+δ=0.15 总加成。
老记忆但常被 recall 时 heat 仍高、recency 低——两者**独立来源**，不重复。

## Recency time constant

| 参数 | 值 | 说明 |
|---|---|---|
| `tau` | 30 | recency 时间衰减常数（天）。30 天前的记忆 recency 降到 1/e ≈ 0.37 |

τ 后续可基于真实查询日志（operation_log）回测调整，看用户实际"recall 最近"类 query 的 age 分布。

## 成熟度汇总分权重（用于二级排序，不进 final）

| 参数 | 值 | 说明 |
|------|-----|------|
| heat_weight | 0.2 | 热度在汇总分中的权重 |
| refinement_weight | 0.3 | 精炼度权重 |
| connectivity_weight | 0.3 | 连通度权重 |
| independence_weight | 0.2 | 独立度权重 |

## 节点类型加权（原则 11: 下行因果）

| 节点类型 | maturity_bonus 加成 | 说明 |
|---------|-------------------|------|
| crystal | +0.15 | 涌现的高层洞察应优先呈现 |
| keystone | +0.05 | 图的结构枢纽，连接不同知识域 |

## sort 模式

| sort 值 | 公式 |
|---|---|
| `relevance`（有 query 默认） | 按 final 降序 |
| `recent`（无 query 默认） | 按 created 降序 |

handler 内部按上下文给默认：有 query → relevance；无 query → recent。

## Fallback chain（设计 doc §6）

只在搜索维度路径触发：

```
TRIGGER_THRESHOLD = min(5, limit)    # exact 少于这个触发 fallback
STOP_THRESHOLD    = min(10, limit)   # total 达到这个停止退化
MAX_TIME_EXPAND   = 2                # Step 3 最多扩档数
STEP1_RELATIVE    = 0.7              # Step 1 阈值放宽系数
STEP1_MIN_CANDIDATES = 5             # Step 1 触发的最少向量候选数
EMBEDDING_TIMEOUT_MS = 3000          # recall 路径 embedding 硬上限
```

每步独立判断是否执行（设计 doc §6.6 表）。每步命中进 related_matches。

### fallback step 编码（用于 operation_log）

| reason 文案 | step code |
|---|---|
| 语义相似（放宽阈值后命中） | `semantic_relax` |
| 关键词部分命中 | `match_or` |
| 时间窗扩大后命中 | `time_expand` |
| 标签部分重合 | `tags_or` |
| 时间窗内高活跃度记忆（兜底） | `heat_fallback` |

## 图扩展规则

| 参数 | 值 | 说明 |
|------|-----|------|
| expansion_min_strength | 0.5 | 只沿 strength > 此值的 confirmed 链接扩展 |
| expansion_decay | 0.7 | 邻居节点的 score 乘以此衰减系数 |
| expansion_max_nodes | 5 | 最多扩展几个邻居节点 |

## 已删除的 Intent 修饰规则（v0.2.77 砍）

旧版 intent 字段 (factual / exploratory / creative) 已废弃，新版按 sort 字段控制排序，
不再依赖 intent 的 connectivity/independence 修饰。

handler 检测到 intent 参数 → 返回结构化升级 hint（设计 doc §8.5）。
