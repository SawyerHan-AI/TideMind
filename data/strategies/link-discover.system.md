# 链接发现策略
纯启发式候选筛选，不调 LLM。创建 pending 链接交给 link-evaluate 判断。

## 参数

| 参数 | 值 | 说明 |
|------|-----|------|
| interval_minutes | 60 | 执行间隔（分钟） |
| vector_similarity_threshold | 0.55 | 向量邻居发现的相似度阈值 |
| vector_max_checks | 5 | 每节点最大向量检查数 |
| max_active_nodes | 50 | 参与向量扫描的最大节点数 |
| min_shared_neighbors | 2 | 共同邻居发现的最少共同邻居数 |
| max_shared_candidates | 20 | 共同邻居候选上限 |