# 发散扫描策略
## 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| interval_minutes | 10080 | 执行间隔（分钟，10080=7d） |
| gate_min_nodes | 500 | 激活此策略需要的最小节点数 |
| min_shared_neighbors | 2 | 最少共享邻居数才成为候选对 |
| max_candidate_pairs | 10 | 每次最多评估多少对候选 |
| min_heat_threshold | 0.1 | 只在活跃节点（heat > 此值）中扫描 |
| max_active_nodes | 100 | 参与扫描的最大节点数 |
| min_confidence | 0.5 | 低于此置信度的发现不创建链接 |
| llm_tier | heavy | 模型档位: light/standard/heavy |
| thinking | true | 是否开启扩展思考 |
| thinking_budget | 4096 | 思考 token 预算 |

## 候选对筛选规则

1. 只看活跃（heat > 0.01）的非 meta 节点
2. 排除已有直接链接的节点对
3. 共享邻居数 ≥ min_shared_neighbors
4. 按共享邻居数降序排列，取 top-N
5. 优先包含不同类型的节点对（fact + idea 比 fact + fact 更可能产生惊喜）

设计理由（原则 3: 必须能产生惊喜）: 好的惊喜来自系统在自身积累基础上产生新联系，而非随机碰撞。结构洞——两个本应有联系但还没被连接的知识簇之间的空隙——就是创新的机会。
