[English](integrations.md) | **中文**

# 集成指南

> 将 TideMind 连接到你的 AI 工具和知识系统。

TideMind 通过 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 通信，与任何支持 MCP 服务器的 AI 工具兼容。它还能集成笔记系统作为知识来源。

---

## 快速开始：桌面客户端（推荐）

TideMind 桌面客户端（Electron 应用）提供一键配置所有集成。安装并启动客户端后：

1. **AI 工具连接**在 **设置 > 插件** 中配置。选择你的 AI 工具（Claude Code、Cursor、Windsurf、Codex 等），客户端会自动生成必要的配置文件。

2. **笔记系统连接**在 **设置 > 笔记来源** 中配置。将 TideMind 指向你的 Logseq 图谱文件夹、Obsidian 库或 Apple Notes 数据库，即可开始同步。

3. **LLM 提供商**在 **设置 > 连接** 中配置。可选云端提供商（Anthropic、Google Vertex AI、Google Gemini）或本地模型（Ollama）。

本文其余部分涵盖手动配置方式，适用于偏好自行设置或使用尚未被一键配置支持的工具的用户。

---

## 连接 AI 工具

TideMind 作为 MCP 服务器运行，暴露三个工具：`brain_prepare`、`brain_recall` 和 `brain_digest`。任何兼容 MCP 的 AI 工具都可以连接。

### 支持的 AI 工具

| 工具 | 连接方式 | 自动配置 |
|------|------------------|------------|
| Claude Code | 插件（`.mcp.json` + Skill + Hook） | 支持（通过桌面客户端） |
| Claude Desktop (Cowork) | Desktop MCP 配置 + Skill 文件 | 支持 |
| Cursor | MCP 配置 | 支持 |
| Windsurf | MCP 配置 | 支持 |
| Codex | MCP 配置 + Hook | 支持 |
| 任何兼容 MCP 的工具 | 手动 MCP 配置 | 手动 |

### 手动 MCP 配置

如果你偏好手动配置或使用不支持的工具，在你工具的配置中将 TideMind 添加为 MCP 服务器。

**Claude Code**（项目根目录的 `.mcp.json` 或全局的 `~/.claude/.mcp.json`）：

```json
{
  "mcpServers": {
    "tidemind": {
      "command": "node",
      "args": ["/path/to/tidemind/dist/index.js"],
      "env": {
        "EB_AGENT_ID": "claude-code-main"
      }
    }
  }
}
```

**Claude Desktop**（macOS 上为 `~/Library/Application Support/Claude/claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "tidemind": {
      "command": "node",
      "args": ["/path/to/tidemind/dist/index.js"],
      "env": {
        "EB_AGENT_ID": "claude-desktop-main"
      }
    }
  }
}
```

**Cursor**（设置 > MCP Servers，或 `.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "tidemind": {
      "command": "node",
      "args": ["/path/to/tidemind/dist/index.js"],
      "env": {
        "EB_AGENT_ID": "cursor-main"
      }
    }
  }
}
```

**重要说明：**
- `EB_AGENT_ID` 环境变量标识连接的 AI 工具实例。每个唯一的 agent ID 拥有独立的活动追踪。
- 使用桌面客户端的自动配置时，`command` 字段使用 shim 脚本（`~/.tidemind/bin/tm-node`）而非直接使用 `node`。shim 确保无论 shell 环境如何都能找到正确的 Node.js 运行时（当外部 agent 通过 `/bin/sh` 启动进程时至关重要，因为 Homebrew/nvm 路径可能不可用）。
- 从源码构建后（`npm run build`），MCP 服务器入口是 `dist/index.js`。

### 多实例支持

你可以连接同一工具的多个实例（如独立的 Cursor 工作区）。每个实例应有唯一的 `EB_AGENT_ID`：

```json
{
  "env": {
    "EB_AGENT_ID": "cursor-project-alpha"
  }
}
```

所有实例共享同一记忆图谱。Agent ID 追踪哪个工具贡献或检索了每条信息。

---

## 连接笔记系统

TideMind 可以从三个知识系统导入并持续同步笔记。笔记被分段为原子记忆并注入活图谱，支持完整的版本追踪和增量同步。

### Logseq

**同步内容：** Logseq 图谱 `pages/` 和 `journals/` 目录中的 Markdown 文件。每个 block（列表项）被视为一个潜在的记忆单元。属性（标签、链接）被保留并提升为图谱标签。

**桌面客户端配置：** 设置 > 笔记来源 > 添加 Logseq Graph > 选择图谱目录。

**手动配置**（`~/.tidemind/config.toml`）：

```toml
[sources.logseq]
path = "/path/to/logseq-graph"
watch = true
poll_interval = 60
```

**选项：**
- `watch`：启用文件系统监控实现实时同步（默认：true）
- `poll_interval`：回退轮询间隔，单位秒（默认：60）
- `import_concurrency`：并行导入工作线程（默认：自动）
- `import_batch_size`：初始导入时每批节点数（默认：自动）
- `excluded_dirs`：要跳过的目录（如 `["assets", ".recycle"]`）

**多实例：** 可以连接多个 Logseq 图谱。每个图谱有独立的 source ID 和同步状态。

### Obsidian

**同步内容：** Obsidian 库中的 Markdown 文件。遵循 `.obsidian` 配置中的排除文件夹设置。Canvas 文件（`.canvas`）会解析其文本内容。YAML frontmatter 属性被提取并提升为图谱标签。

**桌面客户端配置：** 设置 > 笔记来源 > 添加 Obsidian Vault > 选择库目录。

**手动配置**（`~/.tidemind/config.toml`）：

```toml
[sources.obsidian]
path = "/path/to/obsidian-vault"
watch = true
```

**选项：**
- `watch`：启用文件系统监控（默认：true）
- `import_concurrency`：并行导入工作线程
- `import_batch_size`：初始导入时每批节点数

Obsidian 库配置（排除的文件夹、附件路径）自动从 `.obsidian/app.json` 读取。

### Apple Notes

**同步内容：** Apple Notes 应用中的笔记，直接从 NoteStore SQLite 数据库读取。支持通过账户 ID 进行基于文件夹的筛选。笔记内容从 protobuf 格式解码并分段为记忆单元。包含文本内容的附件（PDF 等）也会被包含。

**桌面客户端配置：** 设置 > 笔记来源 > 添加 Apple Notes > 授予数据库访问权限。

**配置详情：**
- 路径格式：`/path/to/NoteStore.sqlite?accounts=1,3`（账户 ID 筛选要同步的账户）
- 同步使用轮询（非文件系统监控），因为数据源是数据库
- 默认轮询间隔：300 秒

**多实例：** 每个 Apple 账户或筛选后的账户集可以作为独立的来源。

### 同步行为（所有来源通用）

- **初始导入：** 首次连接时，所有现有笔记被导入。进度通过桌面客户端 UI 显示。
- **增量同步：** 初始导入后，仅处理变更的文件/笔记。同步状态追踪文件哈希（Logseq/Obsidian）或修改时间戳（Apple Notes）。
- **删除处理：** 检测到已删除的文件/笔记，对应节点可被标记为过时。
- **版本追踪：** 笔记被修改时，对应节点更新并保留版本历史。
- **回滚：** 回滚机制允许在导入遇到错误时恢复同步状态。

---

## 配置参考

TideMind 的配置存储在 `~/.tidemind/config.toml` 中。桌面客户端提供 GUI 编辑这些设置；你也可以直接编辑文件。

### 通用设置

```toml
[general]
data_dir = "~/.tidemind"     # 所有数据存储位置
user_name = "Your Name"      # 用于用户画像生成
```

### LLM 提供商

TideMind 在三个层级使用 LLM 处理不同操作：

| 层级 | 用途 | 默认 |
|------|----------|---------|
| `light` | 快速标注、启发式检查 | 快速、低成本模型 |
| `standard` | 再巩固、链接评估 | 均衡模型 |
| `heavy` | Crystal 生成、Learning III 诊断 | 最强模型 |

```toml
[llm]
provider = "anthropic"              # 所有层级的默认提供商
light_provider = "gemini"           # light 层级覆盖
standard_provider = "anthropic"     # standard 层级覆盖
heavy_provider = "anthropic"        # heavy 层级覆盖
light_model = "gemini-2.0-flash"
standard_model = "claude-sonnet-4-6"
heavy_model = "claude-opus-4-7"
```

**提供商选项：**
- `anthropic`：需要 `anthropic.api_key`
- `vertex`：需要 `vertex.project_id` 和 `vertex.region`
- `gemini`：需要 `gemini.api_key`

### Embedding

```toml
[embedding]
provider = "gemini"                # "vertex"、"gemini" 或 "ollama"
model = "text-embedding-004"
dimensions = 768
```

如需完全本地运行，使用 Ollama：

```toml
[embedding]
provider = "ollama"
model = "nomic-embed-text"
dimensions = 768

[ollama]
url = "http://localhost:11434"
```

### 搜索权重

```toml
[search]
alpha = 0.3    # BM25（词汇匹配）权重
beta = 0.4     # 向量（语义匹配）权重
gamma = 0.15   # 热度（时效性）权重
delta = 0.15   # 成熟度评分权重
```

### 门控阈值

```toml
[gates]
vector_search = 50
graph_expansion = 100
graph_expansion_links = 50
crystal_generation = 200
divergent_scan = 200
learning_2_min_nodes = 500
learning_2_min_recall_ops = 200
```

### 代谢时序

```toml
[metabolism]
annotate_interval_minutes = 5   # 后台标注运行频率
daily_check_hours = 24          # 每日维护间隔
weekly_check_days = 7           # 每周维护间隔
```

---

## 使用 Ollama 的纯本地运行

TideMind 可以使用 [Ollama](https://ollama.ai/) 完全在本地运行，无需任何云端 API 调用，同时用于 LLM 推理和 embedding：

```toml
[ollama]
url = "http://localhost:11434"

[llm]
provider = "ollama"
light_model = "llama3.2"
standard_model = "llama3.2"
heavy_model = "llama3.2"

[embedding]
provider = "ollama"
model = "nomic-embed-text"
dimensions = 768
```

注意，本地模型在 Crystal 生成、再巩固和发散扫描方面的结果质量会低于云端模型。系统会优雅降级——如果 LLM 调用失败，它会回退到纯启发式处理（例如，再巩固时仅增加精炼度而不做内容分析）。

---

## 数据目录结构

所有 TideMind 数据默认存储在 `~/.tidemind/` 下：

```
~/.tidemind/
  config.toml              # 主配置文件
  brain.db                 # SQLite 数据库（节点、链接、向量）
  stream/                  # 原始 Stream 日志（不可变事实锚点）
  strategies/              # 可进化的策略文件（prompt、参数）
  crystal/                 # Crystal 节点的 Markdown 镜像
  plugins/                 # 生成的插件配置
  bin/                     # 运行时 shim（tm-node）
  mcp-descriptions.json    # 可自定义的 MCP 工具描述
```

---

*另见：[API](api.md) 了解完整的工具参数参考，以及 [Architecture](architecture.md) 了解底层数据模型。*
