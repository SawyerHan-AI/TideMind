# 再巩固策略
## 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| max_context_nodes | 5 | 传入上下文的最大节点数 |
| refinement_boost | 0.15 | 再巩固后精炼度提升量(老名 `independence_boost` 为历史遗留,v0.2.23 已更名;代码按新名读,老名通过 strategy-loader 回退兼容) |
| llm_tier | standard | 模型档位: light/standard/heavy |
| thinking | true | 是否开启扩展思考 |
| thinking_budget | 1024 | 思考 token 预算 |

## 保守原则

再巩固的目标是"保鲜"而非"改写"。具体来说:
- 不改变记忆的核心判断或结论
- 只补充缺失的上下文使记忆更自包含
- 只在事实确实过时时更新事实部分
- updated_content 应尽量保留原始表述风格
