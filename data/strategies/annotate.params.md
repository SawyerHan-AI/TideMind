# 节点标注策略
## 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| batch_size | 30 | 候选节点上限（实际数量由 token 预算动态决定） |
| interval_minutes | 3 | 检查间隔（分钟） |
| neighbor_count | 3 | 每个节点取多少向量邻居 |
| frequent_tags_limit | 30 | 已有标签体系展示数量 |
| content_budget | 8000 | 每批 prompt 中节点内容的总字符预算 |
| max_content_per_node | 1500 | 单个节点内容截断上限 |
| neighbor_preview_length | 300 | 邻居内容预览字符数 |
| llm_tier | light | 模型档位: light/standard/heavy |
| thinking | false | 是否开启扩展思考 |
| thinking_budget | 0 | 思考 token 预算 |

## 动态分批规则

按 token 预算（8000 字符）动态分批，短记忆多塞、长记忆少塞：
- 单个节点内容截断上限: 1500 字符
- 邻居内容预览: 300 字符
- 每批 prompt 总节点内容不超过 8000 字符
- 使用 index 字段匹配 LLM 返回结果，避免位置偏移导致标注错误
