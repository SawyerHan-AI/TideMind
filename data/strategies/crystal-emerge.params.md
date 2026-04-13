# 知识结晶策略
## 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| interval_minutes | 10080 | 执行间隔（分钟，10080=7d） |
| gate_min_nodes | 200 | 激活此策略需要的最小节点数 |
| min_source_nodes | 3 | Path B 聚类合成最少需要的源节点数 |
| min_confidence | 0.4 | 低于此置信度不创建结晶节点 |
| hub_min_links | 5 | Path A 枢纽提升所需最少链接数 |
| hub_min_diversity | 3 | Path A 枢纽提升所需最少关系类型数 |
| llm_tier | heavy | 模型档位: light/standard/heavy |
| thinking | true | 是否开启扩展思考 |
| thinking_budget | 4096 | 思考 token 预算 |

## 质量标准

好的结晶例子:
- "在技术选型中，倾向选择约束更强的方案来减少后续决策负担"（从多次选型记忆中归纳）
- "面对复杂问题时，习惯先拆解为独立子问题再逐个攻破"（从多次问题解决记忆中归纳）

差的结晶例子:
- "用户使用了 React 和 SQLite"（只是事实罗列，不是抽象归纳）
- "用户关注效率"（太笼统，缺乏具体模式）
