# 检索策略
## 混合搜索权重

| 参数 | 值 | 说明 |
|------|-----|------|
| alpha | 0.3 | BM25 关键词匹配权重 |
| beta | 0.5 | 向量语义相似度权重 |
| gamma | 0.1 | 热度加成权重 |
| delta | 0.1 | 成熟度加成权重 |

## 返回模式参数

| 参数 | 值 | 说明 |
|------|-----|------|
| index_max_results | 30 | 索引模式最大返回条数 |
| index_snippet_length | 80 | 索引模式摘要截断字数 |
| detail_max_results | 8 | 详情模式最大返回条数 |
| detail_max_links_per_node | 5 | 详情模式每个节点最大关联链接数 |

## Intent 修饰规则

- **factual**（默认）：independence 权重翻倍——优先返回自包含的结论
- **exploratory**：connectivity 权重翻倍——优先返回枢纽节点
- **creative**：beta 提高到 0.6，alpha 降到 0.2——更依赖语义，更少依赖关键词

## 图扩展规则

- 搜索结果返回后，沿 strength > 0.5 的 confirmed 链接扩展一跳邻居
- 邻居的综合分乘以 0.7 衰减系数
- 最终合并排序，返回 top-K
