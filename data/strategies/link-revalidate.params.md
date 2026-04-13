# 链接重新验证策略
## 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| max_links_per_run | 10 | 每次 recall 最大重新验证链接数 |
| min_link_age_hours | 24 | 只验证存在超过此时间的链接 |
| llm_tier | standard | 模型档位: light/standard/heavy |
| thinking | true | 是否开启扩展思考 |
| thinking_budget | 1024 | 思考 token 预算 |
