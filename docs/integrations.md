**English** | [中文](integrations_CN.md)

# Integrations

> Connecting TideMind to your AI tools and knowledge systems.

TideMind communicates via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), making it compatible with any AI tool that supports MCP servers. It also integrates with note-taking systems as knowledge sources.

---

## Quick Start: Desktop Client (Recommended)

The TideMind desktop client (Electron app) provides one-click setup for all integrations. After installing and launching the client:

1. **AI tool connections** are configured from **Settings > Plugins**. Select your AI tool (Claude Code, Cursor, Windsurf, Codex, etc.), and the client generates the necessary configuration files automatically.

2. **Note system connections** are configured from **Settings > Note Sources**. Point TideMind at your Logseq graph folder, Obsidian vault, or Apple Notes database, and it begins syncing.

3. **LLM provider** is configured from **Settings > Connections**. Choose between cloud providers (Anthropic, Google Vertex AI, Google Gemini) or local models (Ollama).

The remainder of this document covers manual configuration for users who prefer to set things up themselves or who use tools not yet supported by the one-click setup.

---

## Connecting AI Tools

TideMind runs as an MCP server, exposing three tools: `brain_prepare`, `brain_recall`, and `brain_digest`. Any MCP-compatible AI tool can connect to it.

### Supported AI Tools

| Tool | Connection Method | Auto-Setup |
|------|------------------|------------|
| Claude Code | Plugin (`.mcp.json` + Skill + Hook) | Yes (via desktop client) |
| Claude Desktop (Cowork) | Desktop MCP config + Skill file | Yes |
| Cursor | MCP config | Yes |
| Windsurf | MCP config | Yes |
| Codex | MCP config + Hook | Yes |
| Any MCP-compatible tool | Manual MCP config | Manual |

### Manual MCP Configuration

If you prefer manual setup or use an unsupported tool, add TideMind as an MCP server in your tool's configuration.

**Claude Code** (`.mcp.json` in project root or `~/.claude/.mcp.json` globally):

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

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

**Cursor** (Settings > MCP Servers, or `.cursor/mcp.json`):

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

**Important notes:**
- The `EB_AGENT_ID` environment variable identifies which AI tool instance is connecting. Each unique agent ID gets its own activity tracking.
- When using the desktop client's auto-setup, the `command` field uses a shim script (`~/.tidemind/bin/tm-node`) instead of `node` directly. The shim ensures the correct Node.js runtime is found regardless of the shell environment (critical when external agents spawn processes via `/bin/sh` where Homebrew/nvm paths may not be available).
- After building from source (`npm run build`), the MCP server entry point is `dist/index.js`.

### Multi-Instance Support

You can connect multiple instances of the same tool (e.g., separate Cursor workspaces). Each instance should have a unique `EB_AGENT_ID`:

```json
{
  "env": {
    "EB_AGENT_ID": "cursor-project-alpha"
  }
}
```

All instances share the same memory graph. The agent ID tracks which tool contributed or retrieved each piece of information.

---

## Connecting Note Systems

TideMind can import and continuously sync notes from three knowledge systems. Notes are segmented into atomic memories and ingested into the living graph, with full version tracking and incremental sync.

### Logseq

**What syncs:** Markdown files in your Logseq graph's `pages/` and `journals/` directories. Each block (bullet point) is treated as a potential memory unit. Properties (tags, links) are preserved and promoted to graph tags.

**Desktop client setup:** Settings > Note Sources > Add Logseq Graph > Select the graph directory.

**Manual configuration** (`~/.tidemind/config.toml`):

```toml
[sources.logseq]
path = "/path/to/logseq-graph"
watch = true
poll_interval = 60
```

**Options:**
- `watch`: Enable filesystem watching for real-time sync (default: true)
- `poll_interval`: Fallback polling interval in seconds (default: 60)
- `import_concurrency`: Parallel import workers (default: auto)
- `import_batch_size`: Nodes per batch during initial import (default: auto)
- `excluded_dirs`: Directories to skip (e.g., `["assets", ".recycle"]`)

**Multi-instance:** You can connect multiple Logseq graphs. Each gets its own source ID and sync state.

### Obsidian

**What syncs:** Markdown files in your Obsidian vault. Respects `.obsidian` configuration for excluded folders. Canvas files (`.canvas`) are parsed for their text content. YAML frontmatter properties are extracted and promoted to graph tags.

**Desktop client setup:** Settings > Note Sources > Add Obsidian Vault > Select the vault directory.

**Manual configuration** (`~/.tidemind/config.toml`):

```toml
[sources.obsidian]
path = "/path/to/obsidian-vault"
watch = true
```

**Options:**
- `watch`: Enable filesystem watching (default: true)
- `import_concurrency`: Parallel import workers
- `import_batch_size`: Nodes per batch during initial import

Obsidian vault configuration (excluded folders, attachment paths) is automatically read from `.obsidian/app.json`.

### Apple Notes

**What syncs:** Notes from Apple's Notes app, read directly from the NoteStore SQLite database. Supports folder-based filtering via account IDs. Note content is decoded from protobuf format and segmented into memory units. Attachments with text content (PDFs, etc.) are included.

**Desktop client setup:** Settings > Note Sources > Add Apple Notes > Grant database access.

**Configuration details:**
- Path format: `/path/to/NoteStore.sqlite?accounts=1,3` (account IDs filter which accounts to sync)
- Sync uses polling (not filesystem watching) since the data source is a database
- Default poll interval: 300 seconds

**Multi-instance:** Each Apple account or filtered account set can be a separate source.

### Sync Behavior (All Sources)

- **Initial import:** On first connection, all existing notes are imported. Progress is reported via the desktop client UI.
- **Incremental sync:** After initial import, only changed files/notes are processed. Sync state tracks file hashes (Logseq/Obsidian) or modification timestamps (Apple Notes).
- **Deletion handling:** Deleted files/notes are detected and corresponding nodes can be marked stale.
- **Version tracking:** When a note is modified, the corresponding node is updated with version history preserved.
- **Rollback:** A rollback mechanism allows reverting sync state if import encounters errors.

---

## Configuration Reference

TideMind stores its configuration in `~/.tidemind/config.toml`. The desktop client provides a GUI for editing these settings; you can also edit the file directly.

### General

```toml
[general]
data_dir = "~/.tidemind"     # Where all data is stored
user_name = "Your Name"      # Used in user profile generation
```

### LLM Providers

TideMind uses LLMs at three tiers for different operations:

| Tier | Used For | Default |
|------|----------|---------|
| `light` | Quick annotations, heuristic checks | Fast, cheap model |
| `standard` | Reconsolidation, link evaluation | Balanced model |
| `heavy` | Crystal generation, Learning III diagnosis | Most capable model |

```toml
[llm]
provider = "anthropic"              # Default provider for all tiers
light_provider = "gemini"           # Override for light tier
standard_provider = "anthropic"     # Override for standard tier
heavy_provider = "anthropic"        # Override for heavy tier
light_model = "gemini-2.0-flash"
standard_model = "claude-sonnet-4-20250514"
heavy_model = "claude-sonnet-4-20250514"
```

**Provider options:**
- `anthropic`: Requires `anthropic.api_key`
- `vertex`: Requires `vertex.project_id` and `vertex.region`
- `gemini`: Requires `gemini.api_key`

### Embedding

```toml
[embedding]
provider = "gemini"                # "vertex", "gemini", or "ollama"
model = "text-embedding-004"
dimensions = 768
```

For fully local operation, use Ollama:

```toml
[embedding]
provider = "ollama"
model = "nomic-embed-text"
dimensions = 768

[ollama]
url = "http://localhost:11434"
```

### Search Weights

```toml
[search]
alpha = 0.3    # BM25 (lexical) weight
beta = 0.4     # Vector (semantic) weight
gamma = 0.15   # Heat (recency) weight
delta = 0.15   # Maturity score weight
```

### Gate Thresholds

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

### Metabolism Timing

```toml
[metabolism]
annotate_interval_minutes = 5   # How often to run background annotation
daily_check_hours = 24          # Interval for daily maintenance
weekly_check_days = 7           # Interval for weekly maintenance
```

---

## Local-Only Operation with Ollama

TideMind can run entirely locally with no cloud API calls by using [Ollama](https://ollama.ai/) for both LLM inference and embeddings:

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

Note that local models will produce lower-quality results for crystal generation, reconsolidation, and divergent scan compared to cloud models. The system degrades gracefully -- if LLM calls fail, it falls back to heuristic-only processing (e.g., reconsolidation increments refinement without content analysis).

---

## Data Directory Structure

All TideMind data lives under `~/.tidemind/` by default:

```
~/.tidemind/
  config.toml              # Main configuration
  brain.db                 # SQLite database (nodes, links, vectors)
  stream/                  # Raw stream logs (immutable truth anchor)
  strategies/              # Evolvable strategy files (prompts, parameters)
  crystal/                 # Crystal node markdown mirrors
  plugins/                 # Generated plugin configurations
  bin/                     # Runtime shims (tm-node)
  mcp-descriptions.json    # Customizable MCP tool descriptions
```

---

*See also: [API](api.md) for the complete tool parameter reference, and [Architecture](architecture.md) for the underlying data model.*
