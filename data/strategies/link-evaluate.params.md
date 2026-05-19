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
| gc_interval_minutes | 1440 | pending-link-gc 任务执行间隔（分钟，默认 24h） |
| gc_max_per_run | 2000 | 单次 GC 删除上限（兜底防失控） |
| gc_health_window_ratio | 0.5 | GC 健康度窗口：last_llm_success_at 距今 < pending_expire_days × 此值 才允许 GC |
