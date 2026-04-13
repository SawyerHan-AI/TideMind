# 画像凝练策略
## 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| interval_minutes | 1440 | 检查间隔（分钟，1440=1天） |
| trigger_min_new_crystals | 3 | 触发所需最少新增结晶数 |
| trigger_min_new_preferences | 4 | 触发所需最少新增意愿数 |
| trigger_max_days | 7 | 最长不更新天数（兜底） |
| input_max_tokens | 15000 | LLM 输入 token 上限 |
| llm_tier | standard | 模型档位: light/standard/heavy |
| thinking | false | 是否开启扩展思考 |
| gate_min_nodes | 50 | 激活此策略需要的最小节点数 |
| profile_fields | [{"name":"role","description":"职业角色与身份"},{"name":"expertise","description":"擅长的技术或领域（数组）"},{"name":"thinking_style","description":"思考和决策风格"},{"name":"communication","description":"沟通偏好"},{"name":"interests","description":"当前核心关注领域（数组）"},{"name":"values","description":"做事的核心原则"}] | 结构化字段配置（JSON） |
