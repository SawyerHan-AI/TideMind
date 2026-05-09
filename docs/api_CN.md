[English](api.md) | **中文**

# API 参考

> TideMind 三个 MCP 工具的完整参数参考。

TideMind 通过 [Model Context Protocol](https://modelcontextprotocol.io/) 暴露三个工具。所有工具接受 JSON 参数并返回 JSON 响应。

---

## brain_prepare

**用途：** 在每次新对话开始时调用。返回认知包：用户画像、关键节点、标签索引、Crystal 摘要和近期活动。可以理解为在导航前加载记忆地形图。

**调用时机：** 每次对话开始时调用一次。返回结果提供索引，指导后续的 `brain_recall` 调用。

### 参数

| 参数 | 类型 | 必需 | 描述 |
|-----------|------|----------|-------------|
| `tool` | `string` | 是 | 调用工具的名称（如 `"claude-code"`、`"cursor"`） |
| `files` | `string[]` | 否 | 当前相关的文件或资源 |
| `hint` | `string` | 否 | 用户的第一句话或对话主题 |
| `detail_level` | `"brief" \| "standard" \| "deep"` | 否 | 控制返回的详细程度。默认：`"standard"` |

### 响应结构

```typescript
{
  profile: {
    text: string;              // 用户画像摘要（自然语言）
    structured?: object;       // 可选的结构化画像数据
    generated_at: string;      // 画像最后生成时间
  };
  keystones: Array<{
    id: string;                // 节点 ID（可用于 brain_recall）
    title: string | null;      // 显示标题
    type: string;              // 节点类型（fact、context、preference 等）
    link_count: number;        // 连接数量
  }>;
  tags: Array<{
    id: string;                // 标签节点 ID
    title: string;             // 标签名称
    link_count: number;        // 已标记的记忆数量
  }>;
  crystals: {
    highlighted: Array<{
      id: string;
      title: string | null;
      snippet: string;         // 内容前约 80 个字符
      heat: number;            // 当前活跃度
    }>;
    others: Array<{
      id: string;
      title: string | null;
    }>;
  };
  recent: Array<{
    id: string;
    title: string | null;
    type: string;
    timestamp: string;         // 最近活动时间
  }>;
  guidance?: string;           // AI 的动态行为指导
}
```

### 示例

```json
// 请求
{
  "tool": "claude-code",
  "hint": "Help me refactor the authentication module",
  "detail_level": "standard"
}

// 响应（简略版）
{
  "profile": {
    "text": "Full-stack developer focused on TypeScript/Node.js. Prefers functional patterns...",
    "generated_at": "2026-04-10T08:00:00Z"
  },
  "keystones": [
    { "id": "n_a1b2c3d4", "title": "Authentication architecture decisions", "type": "fact", "link_count": 12 }
  ],
  "tags": [
    { "id": "n_t001", "title": "authentication", "link_count": 8 },
    { "id": "n_t002", "title": "typescript", "link_count": 23 }
  ],
  "crystals": {
    "highlighted": [
      { "id": "n_c001", "title": "Prefers zero-ops solutions for personal tools", "snippet": "Prefers zero-ops solutions for personal tools. Consistently choo...", "heat": 0.85 }
    ],
    "others": []
  },
  "recent": [
    { "id": "n_r001", "title": "Switched auth from JWT to session cookies", "type": "fact", "timestamp": "2026-04-12T14:30:00Z" }
  ],
  "guidance": "Use brain_recall to retrieve details about specific keystones or tags. Provide context parameter when querying."
}
```

### 副作用

- 记录操作以供策略反馈。
- 触发搭便车维护（fire-and-forget）：如果到期，可能运行每日/每周代谢任务。

---

## brain_recall

**用途：** 按需从记忆图谱检索信息。支持多种查询模式：语义搜索、直接 ID 查找、图谱遍历、来源文件查找和浏览。

**调用时机：** 在对话过程中需要历史上下文时调用。

### 参数

| 参数 | 类型 | 必需 | 描述 |
|-----------|------|----------|-------------|
| `query` | `string` | 否 | 搜索关键词或语义查询 |
| `node_id` | `string` | 否 | 按 ID 检索特定节点 |
| `index_ref` | `string` | 否 | 按 prepare 索引引用检索（如 `"tag:typescript"`） |
| `source_file` | `string` | 否 | 查找源自特定文件的记忆 |
| `from_node` | `string` | 否 | 从此节点开始图谱遍历 |
| `context` | `string` | 否 | **为什么**要搜索——显著提升检索质量 |
| `intent` | `"factual" \| "exploratory" \| "creative"` | 否 | 影响排序策略（见下文） |
| `relation` | `string` | 否 | 使用 `from_node` 时按关系类型筛选 |
| `depth` | `number` | 否 | 图谱遍历深度（默认：1） |
| `scope` | `string` | 否 | 筛选范围，如 `"tag:project-name"` |
| `type` | `string` | 否 | 按节点类型筛选（如 `"fact"`、`"idea"`、`"meta"`） |
| `created_after` | `string` | 否 | 仅返回此 ISO 日期之后创建的记忆 |
| `created_before` | `string` | 否 | 仅返回此 ISO 日期之前创建的记忆 |
| `include_surprise` | `boolean` | 否 | 包含来自图谱邻居的意外连接 |
| `limit` | `number` | 否 | 最大结果数。默认：8（detail）或 30（index） |
| `mode` | `"index" \| "detail"` | 否 | 响应详细程度。默认：`"detail"` |

**应至少提供 `query`、`node_id`、`index_ref`、`source_file` 或 `from_node` 之一。** 如果都未提供，系统返回最活跃的节点（浏览模式）。

### Intent 行为

`intent` 参数改变结果排序方式：

| Intent | 排序优先级 | 使用场景 |
|--------|-----------------|----------|
| `factual`（默认） | 独立性加权：偏好自包含、可直接使用的结论 | "我们关于 X 做了什么决定？" |
| `exploratory` | 连接度加权：偏好能引出更多联想的枢纽节点 | "我在这个领域知道些什么？" |
| `creative` | 优先图像性（类比）链接，降低强度阈值 | "有什么意想不到的联系吗？" |

### Mode 行为

**`mode: "index"`** -- 返回轻量级条目供快速浏览：

```typescript
Array<{
  id: string;
  type: string;
  title: string | null;
  snippet: string;       // 前约 80 个字符
  tags: string[];
  heat: number;
  created: string;
}>
```

**`mode: "detail"`**（默认）-- 返回完整内容和链接：

```typescript
Array<{
  id: string;
  type: string;
  title: string | null;
  content: string;       // 完整记忆内容
  maturity: {
    heat: number;
    refinement: number;
    connectivity: number;
    independence: number;
  };
  links: Array<{
    to_id: string;
    to_title: string | null;
    to_type: string;
    relation: Array<{ type: string; confidence: number }>;
    strength: number;
    note?: string;
  }>;
  source_ref?: string;   // Stream 日志引用
  tags?: string[];
  freshness?: string;    // 人类可读的过时警告（如适用）
}>
```

**推荐工作流：** 先使用 `mode: "index"` 扫描可用记忆，然后使用 `node_id` 配合 `mode: "detail"` 深入特定节点。

### 响应结构

```typescript
{
  nodes: RecallNode[] | RecallIndexItem[];  // 取决于 mode
  mode: "index" | "detail";
  summary?: string;         // 模板生成的结果摘要
  surprises?: Array<{       // 仅在 include_surprise 为 true 时出现
    insight: string;
    node_a_id: string;
    node_b_id: string;
    confidence: number;
  }>;
}
```

### 查询模式示例

```json
// 语义搜索（最常见）
{ "query": "database selection criteria" }

// 带上下文的语义搜索（更精确）
{ "query": "SQLite", "context": "Evaluating whether to migrate to DuckDB" }

// 直接 ID 查找
{ "node_id": "n_a1b2c3d4" }

// 来自 prepare 的索引引用
{ "index_ref": "tag:authentication" }

// 来源文件查找
{ "source_file": "src/server.ts" }

// 图谱遍历
{ "from_node": "n_a1b2c3d4", "relation": "caused_by", "depth": 2 }

// 带意外发现的创意搜索
{ "query": "architecture design", "intent": "creative", "include_surprise": true }

// 带筛选的搜索
{ "query": "state management", "scope": "tag:frontend", "type": "idea", "created_after": "2026-01-01" }

// 浏览模式（无查询）
{ "limit": 10 }
```

### 副作用

- **热度增幅：** 所有返回的节点获得热度增加（按排名加权，排名第一的结果获得 +0.1，后续逐渐递减）。
- **再巩固：** 根据条件触发感知性读取（创建待定链接）或深度读取（内容重新评估）。参见 [Metabolism](metabolism.md#2-read-write-triggered-on-recall)。
- **链接再验证：** 异步检查结果节点之间的链接是否仍然有效。

---

## brain_digest

**用途：** 将信息存入记忆图谱。处理新记忆、现有记忆的修正、链接移除和归档。

**调用时机：** 在每次实质性交互之后。也用于修正错误或归档过时信息。

### 参数

| 参数 | 类型 | 必需 | 描述 |
|-----------|------|----------|-------------|
| `content` | `string` | 是 | 要存储的信息。每次调用聚焦一个主题。 |
| `title` | `string` | 否 | 可选的记忆标题 |
| `source` | `object` | 否 | 信息来源（见下文） |
| `context` | `string` | 否 | 为什么值得记住；未来什么场景可能用到 |
| `tags` | `string[]` | 否 | 内容标签 |
| `target_node` | `string` | 否 | 要修正或归档的节点 ID（配合 `intent: "correction"` 或 `"archive"` 使用） |
| `target_link` | `{ from: string, to: string }` | 否 | 要移除的链接（配合 `intent: "correction"` 使用） |
| `intent` | `"new" \| "correction" \| "archive"` | 否 | 操作类型。默认：`"new"` |
| `async` | `boolean` | 否 | 是否异步处理。默认：`true` |

**Source 对象：**

```typescript
{
  tool: string;          // 必需。工具名称（如 "claude-code"）
  session?: string;      // 可选。会话标识
  files?: string[];      // 可选。相关文件
}
```

### Intent 行为

**`intent: "new"`**（默认）-- 存储新信息：

1. 通过启发式方法评估内容质量（最少 5 个字符，纯 URL 内容获得较低初始热度）。
2. 将原始内容写入 Stream 日志（不可变事实锚点）。
3. 创建新节点，带有启发式维度评分。
4. 如果向量搜索已激活，计算 embedding 并创建着陆连接到附近节点。
5. 如果已存在非常相似的节点（相似度 > 0.92），则对已有节点进行再巩固而非创建重复节点。

**`intent: "correction"`** -- 修正已有信息：

- 配合 `target_node`：更新节点内容。创建 `meta` 节点记录修改前后的变化。保留完整的修正历史。
- 配合 `target_link`：移除两个节点之间的指定链接。

**`intent: "archive"`** -- 归档过时信息：

- 配合 `target_node`：将节点标记为已归档。已归档节点从搜索结果中排除但不删除。

### 质量门控

以下情况内容被拒绝（status: `"rejected"`）：
- 长度少于 5 个字符（且未提供标题）

初始质量较低的内容获得降低的热度（0.3-0.5 而非 1.0），导致其在搜索中排名较低且衰减更快。如果该内容后来通过 recall 被访问，其热度自然恢复——一种自修正机制。

### 异步 vs 同步行为

| `async` 值 | 行为 | 响应 |
|---------------|----------|----------|
| `true`（默认） | Stream 日志立即写入。节点创建、embedding 和链接生成在后台进行。 | `{ status: "accepted", trace_id: "..." }` |
| `false` | 完整处理完成后才返回。 | `{ status: "processed", trace_id: "...", created_nodes: [...], created_links: [...] }` |

正常使用推荐异步模式——它保持 AI 对话的响应性。同步模式适用于测试或需要立即确认创建内容的场景。

如果异步处理失败，digest 会被排入队列自动重试（最多 3 次）。失败的 digest 会在下一次 `brain_prepare` 调用中报告。

### 响应结构

```typescript
{
  status: "accepted" | "processed" | "rejected";
  trace_id?: string;           // 此操作的唯一追踪 ID
  reject_reason?: string;      // 内容被拒绝的原因（status 为 "rejected" 时）
  created_nodes?: Array<{      // 创建的节点（仅同步模式）
    id: string;
    content: string;
    type: string;
  }>;
  updated_nodes?: Array<{      // 更新的节点（仅修正操作）
    id: string;
    content: string;
    version: number;
  }>;
  created_links?: Array<{      // 创建的链接（仅同步模式）
    from_id: string;
    to_id: string;
    relation: string;
  }>;
  archived_nodes?: string[];   // 已归档的节点 ID（仅归档操作）
}
```

### 示例

```json
// 存储新记忆
{
  "content": "Decided to use SQLite with sqlite-vec for vector search instead of a separate vector database. Key reasons: single-file deployment, no infrastructure, good enough performance for personal use.",
  "source": { "tool": "claude-code" },
  "context": "Database architecture decision for the TideMind project",
  "tags": ["architecture", "database"]
}

// 修正已有记忆
{
  "content": "Actually migrated from JWT to session cookies for auth, not the other way around.",
  "target_node": "n_a1b2c3d4",
  "intent": "correction",
  "context": "The original memory had the migration direction reversed"
}

// 移除错误链接
{
  "target_link": { "from": "n_a1b2c3d4", "to": "n_e5f6g7h8" },
  "intent": "correction",
  "content": "These two nodes are not actually related"
}

// 归档过时信息
{
  "target_node": "n_old_node",
  "intent": "archive",
  "content": "This project was completed and is no longer active"
}
```

---

## 常见模式

### 对话开始

```
1. 调用 brain_prepare({ tool: "your-tool-name", hint: "user's first message" })
2. 使用返回的关键节点、标签和 Crystal 理解用户上下文
3. 保存 guidance 用于行为调整
```

### 对话过程中

```
1. 需要历史上下文时：
   brain_recall({ query: "relevant topic", context: "why you need this" })
2. 广泛浏览：
   brain_recall({ query: "topic", mode: "index" })
3. 获取具体细节：
   brain_recall({ node_id: "n_xxx" })
```

### 对话结束

```
1. 识别对话中的实质性决策、洞察或事实
2. 为每个独立主题调用 brain_digest
3. 包含 context 解释为什么值得记住
```

### 错误修正工作流

```
1. brain_recall 查找错误的记忆
2. brain_digest 配合 intent: "correction" 和 target_node 进行修正
3. 或 brain_digest 配合 intent: "correction" 和 target_link 移除错误连接
```

---

*另见：[Architecture](architecture.md) 了解这些工具背后的数据模型，以及 [Metabolism](metabolism.md) 了解每个操作触发的后台处理。*
