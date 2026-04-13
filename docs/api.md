**English** | [中文](api_CN.md)

# API Reference

> Complete parameter reference for TideMind's three MCP tools.

TideMind exposes three tools via the [Model Context Protocol](https://modelcontextprotocol.io/). All tools accept JSON parameters and return JSON responses.

---

## brain_prepare

**Purpose:** Called at the start of every new conversation. Returns a cognitive package: user profile, keystone nodes, tag index, crystal summaries, and recent activity. Think of it as loading a map of the memory landscape before navigating.

**When to call:** Once, at the beginning of each conversation. The result provides an index that guides subsequent `brain_recall` calls.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tool` | `string` | Yes | Name of the calling tool (e.g., `"claude-code"`, `"cursor"`) |
| `hint_topic` | `string` | No | Current topic name |
| `files` | `string[]` | No | Currently relevant files or resources |
| `hint` | `string` | No | User's first message or conversation topic |
| `detail_level` | `"brief" \| "standard" \| "deep"` | No | Controls how much detail is returned. Default: `"standard"` |

### Response Structure

```typescript
{
  profile: {
    text: string;              // User profile summary (natural language)
    structured?: object;       // Optional structured profile data
    generated_at: string;      // When the profile was last generated
  };
  keystones: Array<{
    id: string;                // Node ID (use with brain_recall)
    title: string | null;      // Display title
    type: string;              // Node type (fact, context, preference, etc.)
    link_count: number;        // Number of connections
  }>;
  tags: Array<{
    id: string;                // Tag node ID
    title: string;             // Tag name
    link_count: number;        // Number of tagged memories
  }>;
  crystals: {
    highlighted: Array<{
      id: string;
      title: string | null;
      snippet: string;         // First ~80 chars of content
      heat: number;            // Current activity level
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
    timestamp: string;         // Most recent activity time
  }>;
  guidance?: string;           // Dynamic behavioral guidance for the AI
}
```

### Example

```json
// Request
{
  "tool": "claude-code",
  "hint": "Help me refactor the authentication module",
  "detail_level": "standard"
}

// Response (abbreviated)
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

### Side Effects

- Logs the operation for strategy feedback.
- Triggers piggyback maintenance (fire-and-forget): daily/weekly metabolism tasks may run if due.

---

## brain_recall

**Purpose:** Retrieve information from the memory graph on demand. Supports multiple query modes: semantic search, direct ID lookup, graph traversal, source file lookup, and browsing.

**When to call:** Whenever historical context is needed during a conversation.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | No | Search keywords or semantic query |
| `node_id` | `string` | No | Retrieve a specific node by ID |
| `index_ref` | `string` | No | Retrieve by prepare index reference (e.g., `"tag:typescript"`) |
| `source_file` | `string` | No | Find memories originating from a specific file |
| `from_node` | `string` | No | Start graph traversal from this node |
| `context` | `string` | No | **Why** you are searching -- significantly improves retrieval quality |
| `intent` | `"factual" \| "exploratory" \| "creative"` | No | Influences ranking strategy (see below) |
| `relation` | `string` | No | Filter by relation type when using `from_node` |
| `depth` | `number` | No | Graph traversal depth (default: 1) |
| `scope` | `string` | No | Filter scope, e.g., `"tag:project-name"` |
| `type` | `string` | No | Filter by node type (e.g., `"fact"`, `"idea"`, `"meta"`) |
| `created_after` | `string` | No | Only return memories created after this ISO date |
| `created_before` | `string` | No | Only return memories created before this ISO date |
| `include_surprise` | `boolean` | No | Include serendipitous connections from graph neighbors |
| `limit` | `number` | No | Maximum results. Default: 8 (detail) or 30 (index) |
| `mode` | `"index" \| "detail"` | No | Response verbosity. Default: `"detail"` |

**At least one of `query`, `node_id`, `index_ref`, `source_file`, or `from_node` should be provided.** If none is given, the system returns the most active nodes (browse mode).

### Intent Behavior

The `intent` parameter changes how results are ranked:

| Intent | Ranking Priority | Use Case |
|--------|-----------------|----------|
| `factual` (default) | Independence-weighted: prefers self-contained, directly usable conclusions | "What did we decide about X?" |
| `exploratory` | Connectivity-weighted: prefers hub nodes that lead to more associations | "What do I know about this area?" |
| `creative` | Iconic (analogous) links prioritized, lower strength threshold | "Any unexpected connections?" |

### Mode Behavior

**`mode: "index"`** -- Returns lightweight entries for scanning:

```typescript
Array<{
  id: string;
  type: string;
  title: string | null;
  snippet: string;       // First ~80 chars
  tags: string[];
  heat: number;
  created: string;
}>
```

**`mode: "detail"`** (default) -- Returns full content with links:

```typescript
Array<{
  id: string;
  type: string;
  title: string | null;
  content: string;       // Full memory content
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
  source_ref?: string;   // Stream log reference
  tags?: string[];
  freshness?: string;    // Human-readable staleness warning (if applicable)
}>
```

**Recommended workflow:** Use `mode: "index"` first to scan available memories, then use `node_id` with `mode: "detail"` to dive into specific nodes.

### Response Structure

```typescript
{
  nodes: RecallNode[] | RecallIndexItem[];  // Depends on mode
  mode: "index" | "detail";
  summary?: string;         // Template-generated summary of results
  surprises?: Array<{       // Only present if include_surprise was true
    insight: string;
    node_a_id: string;
    node_b_id: string;
    confidence: number;
  }>;
}
```

### Query Mode Examples

```json
// Semantic search (most common)
{ "query": "database selection criteria" }

// Semantic search with context (more precise)
{ "query": "SQLite", "context": "Evaluating whether to migrate to DuckDB" }

// Direct ID lookup
{ "node_id": "n_a1b2c3d4" }

// Index reference from prepare
{ "index_ref": "tag:authentication" }

// Source file lookup
{ "source_file": "src/server.ts" }

// Graph traversal
{ "from_node": "n_a1b2c3d4", "relation": "caused_by", "depth": 2 }

// Creative search with surprises
{ "query": "architecture design", "intent": "creative", "include_surprise": true }

// Filtered search
{ "query": "state management", "scope": "tag:frontend", "type": "idea", "created_after": "2026-01-01" }

// Browse mode (no query)
{ "limit": 10 }
```

### Side Effects

- **Heat bump:** All returned nodes get a heat increase (rank-weighted, top result gets +0.1, decreasing for lower ranks).
- **Reconsolidation:** Triggers perceptual read (pending link creation) or deep read (content re-evaluation) based on conditions. See [Metabolism](metabolism.md#2-read-write-triggered-on-recall).
- **Link revalidation:** Asynchronously checks whether links among result nodes are still valid.

---

## brain_digest

**Purpose:** Store information into the memory graph. Handles new memories, corrections to existing memories, link removal, and archival.

**When to call:** After each substantive interaction. Also used to correct errors or archive outdated information.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | `string` | Yes | The information to store. Focus on one topic per call. |
| `title` | `string` | No | Optional title for the memory |
| `source` | `object` | No | Information source (see below) |
| `context` | `string` | No | Why this is worth remembering; what future scenario it might be useful in |
| `tags` | `string[]` | No | Content tags |
| `target_node` | `string` | No | Node ID to correct or archive (used with `intent: "correction"` or `"archive"`) |
| `target_link` | `{ from: string, to: string }` | No | Link to remove (used with `intent: "correction"`) |
| `intent` | `"new" \| "correction" \| "archive"` | No | Operation type. Default: `"new"` |
| `async` | `boolean` | No | Whether to process asynchronously. Default: `true` |

**Source object:**

```typescript
{
  tool: string;          // Required. Tool name (e.g., "claude-code")
  session?: string;      // Optional. Session identifier
  files?: string[];      // Optional. Related files
}
```

### Intent Behavior

**`intent: "new"`** (default) -- Store new information:

1. Content quality is assessed heuristically (minimum 5 characters, URL-only content gets lower initial heat).
2. The raw content is written to the stream log (immutable truth anchor).
3. A new node is created with heuristic dimension scores.
4. If vector search is active, an embedding is computed, and landing connections are created to nearby nodes.
5. If a very similar node already exists (similarity > 0.92), the existing node is reconsolidated instead of creating a duplicate.

**`intent: "correction"`** -- Correct existing information:

- With `target_node`: Updates the node's content. Creates a `meta` node recording the before/after change. Preserves the full correction history.
- With `target_link`: Removes the specified link between two nodes.

**`intent: "archive"`** -- Archive outdated information:

- With `target_node`: Marks the node as archived. Archived nodes are excluded from search results but not deleted.

### Quality Gate

Content is rejected (status: `"rejected"`) if:
- Length is less than 5 characters (and no title is provided)

Content with low initial quality gets reduced heat (0.3-0.5 instead of 1.0), causing it to rank lower in search and decay faster. If the content is later accessed via recall, its heat naturally recovers -- a self-correcting mechanism.

### Async vs Sync Behavior

| `async` value | Behavior | Response |
|---------------|----------|----------|
| `true` (default) | Stream log is written immediately. Node creation, embedding, and link generation happen in the background. | `{ status: "accepted", trace_id: "..." }` |
| `false` | Full processing completes before returning. | `{ status: "processed", trace_id: "...", created_nodes: [...], created_links: [...] }` |

Async mode is recommended for normal use -- it keeps the AI conversation responsive. Sync mode is useful for testing or when you need immediate confirmation of what was created.

If async processing fails, the digest is enqueued for automatic retry (up to 3 attempts). Failed digests are reported in the next `brain_prepare` call.

### Response Structure

```typescript
{
  status: "accepted" | "processed" | "rejected";
  trace_id?: string;           // Unique trace ID for this operation
  reject_reason?: string;      // Why content was rejected (if status is "rejected")
  created_nodes?: Array<{      // Nodes created (sync mode only)
    id: string;
    content: string;
    type: string;
  }>;
  updated_nodes?: Array<{      // Nodes updated (correction only)
    id: string;
    content: string;
    version: number;
  }>;
  created_links?: Array<{      // Links created (sync mode only)
    from_id: string;
    to_id: string;
    relation: string;
  }>;
  archived_nodes?: string[];   // Node IDs archived (archive only)
}
```

### Examples

```json
// Store a new memory
{
  "content": "Decided to use SQLite with sqlite-vec for vector search instead of a separate vector database. Key reasons: single-file deployment, no infrastructure, good enough performance for personal use.",
  "source": { "tool": "claude-code" },
  "context": "Database architecture decision for the TideMind project",
  "tags": ["architecture", "database"]
}

// Correct an existing memory
{
  "content": "Actually migrated from JWT to session cookies for auth, not the other way around.",
  "target_node": "n_a1b2c3d4",
  "intent": "correction",
  "context": "The original memory had the migration direction reversed"
}

// Remove an incorrect link
{
  "target_link": { "from": "n_a1b2c3d4", "to": "n_e5f6g7h8" },
  "intent": "correction",
  "content": "These two nodes are not actually related"
}

// Archive outdated information
{
  "target_node": "n_old_node",
  "intent": "archive",
  "content": "This project was completed and is no longer active"
}
```

---

## Common Patterns

### Start of Conversation

```
1. Call brain_prepare({ tool: "your-tool-name", hint: "user's first message" })
2. Use the returned keystones, tags, and crystals to understand the user's context
3. Store the guidance for behavioral adjustment
```

### During Conversation

```
1. When historical context is needed:
   brain_recall({ query: "relevant topic", context: "why you need this" })
2. For broad scanning:
   brain_recall({ query: "topic", mode: "index" })
3. For specific details:
   brain_recall({ node_id: "n_xxx" })
```

### End of Conversation

```
1. Identify substantive decisions, insights, or facts from the conversation
2. Call brain_digest for each distinct topic
3. Include context explaining why it is worth remembering
```

### Error Correction Workflow

```
1. brain_recall to find the incorrect memory
2. brain_digest with intent: "correction" and target_node to fix it
3. Or brain_digest with intent: "correction" and target_link to remove a bad connection
```

---

*See also: [Architecture](architecture.md) for the data model behind these tools, and [Metabolism](metabolism.md) for the background processing triggered by each operation.*
