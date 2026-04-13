# 排序策略
## 混合搜索综合评分公式

```
score = α × bm25 + β × vector + γ × heat_bonus + δ × maturity_bonus
```

其中:
- bm25: FTS5 BM25 评分（归一化到 0-1）
- vector: embedding 余弦相似度（0-1）
- heat_bonus: min(heat / 2, 1)（对数缩放避免极热节点完全主导）
- maturity_bonus: maturity_score（四维加权汇总）

## 基础权重

| 参数 | 值 | 说明 |
|------|-----|------|
| alpha | 0.3 | BM25 关键词匹配 |
| beta | 0.5 | 向量语义相似度 |
| gamma | 0.1 | 热度（近期活跃度）加成 |
| delta | 0.1 | 成熟度（长期质量）加成 |

## 成熟度汇总分权重

| 参数 | 值 | 说明 |
|------|-----|------|
| heat_weight | 0.2 | 热度在汇总分中的权重 |
| refinement_weight | 0.3 | 精炼度权重 |
| connectivity_weight | 0.3 | 连通度权重 |
| independence_weight | 0.2 | 独立度权重 |

## Intent 修饰规则

### factual（默认）
目标: 返回最直接可用的结论
- independence_weight × 2（优先返回自包含的、可脱离上下文使用的记忆）
- meta 类型节点排除

### exploratory
目标: 返回能引出更多关联的枢纽节点
- connectivity_weight × 2（优先返回连接丰富的节点——拉出一个能带出一串）
- 链接遍历深度 +1

### creative
目标: 发现意外关联
- beta = 0.6, alpha = 0.2（更依赖语义理解，少依赖精确关键词）
- strength 过滤阈值降低到 0.3（允许更弱的关联浮现）
- analogous 类型链接优先

## 节点类型加权（原则 11: 下行因果）

| 节点类型 | maturity_bonus 加成 | 说明 |
|---------|-------------------|------|
| crystal | +0.15 | 涌现的高层洞察应优先呈现 |
| keystone | +0.05 | 图的结构枢纽，连接不同知识域 |

设计理由: crystal 和 keystone 节点代表系统从具体记忆中涌现出的高层理解，在搜索中应获得额外提升，让用户首先看到抽象模式而非零散细节。

## 图扩展规则

| 参数 | 值 | 说明 |
|------|-----|------|
| expansion_min_strength | 0.5 | 只沿 strength > 此值的 confirmed 链接扩展 |
| expansion_decay | 0.7 | 邻居节点的 score 乘以此衰减系数 |
| expansion_max_nodes | 5 | 最多扩展几个邻居节点 |
