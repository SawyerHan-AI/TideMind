# Learning II 参数调优
## 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| interval_minutes | 10080 | 执行间隔（分钟） |
| gate_min_nodes | 500 | 激活所需最小节点数 |
| gate_min_recall_ops | 200 | 激活所需最小召回操作数 |
| min_feedback_samples | 20 | 触发调整所需最小反馈样本数 |
| cooldown_days | 14 | 同一策略两次调整的最小间隔天数 |
| monitoring_days | 7 | 调整后的监控窗口天数 |
| max_adjustment_pct | 0.10 | 单次调整最大幅度（10%） |
| trend_decline_threshold | -0.1 | 触发调整的趋势下降阈值 |
| max_tokens | 256 | 最大 token 数 |
| llm_tier | standard | 模型档位: light/standard/heavy |
| thinking | false | 是否开启扩展思考 |
| thinking_budget | 0 | 思考 token 预算 |
