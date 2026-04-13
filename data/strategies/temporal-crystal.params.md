# 时间结晶策略
## 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| interval_minutes | 10080 | 执行间隔（分钟，10080=7天） |
| gate_min_nodes | 200 | 门控：最少节点数 |
| max_topics | 3 | 同主题演变：最大分析主题数 |
| min_nodes_per_topic | 5 | 同主题演变：每个主题最少节点数 |
| max_resonance_weeks | 3 | 跨主题共振：最大分析周数 |
| llm_tier | heavy | 模型档位: light/standard/heavy |
| thinking | true | 是否开启扩展思考 |
| thinking_budget | 4096 | 思考 token 预算 |
