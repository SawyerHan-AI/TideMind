# 链接评估策略
## 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| interval_minutes | 60 | 执行间隔（分钟） |
| lookback_hours | 48 | 回溯时间窗口 |
| max_links_per_run | 50 | 每次最大评估链接数 |
| pending_expire_days | 7 | pending 链接过期天数 |
| llm_tier | standard | 模型档位: light/standard/heavy |
| thinking | false | 是否开启扩展思考 |
| thinking_budget | 0 | 思考 token 预算 |
