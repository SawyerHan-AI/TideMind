**English** | [中文](architecture_CN.md)

# System Architecture

> Based on the [18 design principles](design-philosophy.md) -- a living graph, not a static database.

## Core Abstraction: The Living Graph

### Why Not Layered Containers

An earlier design split the system into three storage layers: Stream (information flow) -> Atoms (atomic memories) -> Crystal (crystallized insights). Information flowed one-way between containers, processed by an independent reflection engine.

This design had fundamental problems:

1. **Information flow is not linear.** A highly refined insight written in Logseq is already Crystal-level content -- it does not need the Stream -> Atom -> Crystal pipeline. Conversely, a crystal ("I tend to make quick decisions") can trigger a new atomic memory ("Made another quick decision today"). The layers interpenetrate; they are not a one-way pipe.

2. **A separate reflection engine means the system's "aliveness" depends on whether the engine is running.** When the engine is idle, the system is a dead database. Per Principle 8 (memory evolves through use), evolution should happen at the moment of retrieval, not at the next engine scheduling cycle.

3. **The brain has no "short-term memory box" and "long-term memory box."** It has a continuous neural network with different plasticity characteristics across regions. Memory "layers" are a continuous spectrum of consolidation, not physically separated containers.

### How the Living Graph Works

The system's core is **a single graph** where every node has its own "maturity." What we call "layers" are not preset structures -- they are phenomena emerging from the maturity spectrum.

A freshly ingested information fragment from a Cursor conversation enters as a small node at the graph's periphery: few connections, low maturity. As it gets used, processed, and linked, it naturally "sinks" toward the dense core. Highly connected hub nodes are what we call "crystals" -- but they were not "moved" to another container; they grew into that form in place.

### Stream Log: The Graph's External Truth Anchor

The stream log exists **outside the graph**, serving as its foundation.

Why: every node in the living graph has undergone at least one processing step (split by an LLM, assigned a type, had an embedding computed). The stream is the unprocessed raw flow -- original conversations with thousands of words, interleaved code, trial-and-error, and chatter. Inserting all of this verbatim into the graph would severely pollute signal-to-noise ratio (violating Principle 9: dissipative structures need signal-to-noise control).

But the stream is not an irrelevant audit log. It serves critical roles:

- **Immutable truth anchor.** Nodes may look very different after multiple reconsolidations, but you can always go back to the stream to see what originally happened.
- **AI-accessible raw context.** When AI needs more detail ("What was the full context of that discussion?"), it follows the node's `source` pointer to read the stream -- analogous to the hippocampus being reactivated during reconsolidation.
- **Relationship:** Every node has a pointer back to its original stream fragment. Stream and graph are not two independent systems but the same thing at different granularity -- stream is the lossless continuous signal; graph is the lossy structured distillation.

---

## Node Model

### Four-Dimensional Maturity

A node's state is described by four independent but interacting dimensions. This design is inspired by the distinct dimensions involved in memory consolidation in neuroscience.

| Dimension | Description | Dynamics | Neural Analogy |
|-----------|-------------|----------|----------------|
| **Heat** | Short-term activity indicator. Recently created, retrieved, or used nodes are hot. | Fast decay (daily, but decay rate is influenced by other dimensions) | Recent neuronal firing frequency |
| **Refinement** | How many times the content has been processed. Raw stream fragments have low refinement; after LLM distillation, medium; after multiple reconsolidations, high. | Slow growth, increases only during reconsolidation | Memory shifting from fuzzy to clear to abstract |
| **Connectivity** | How many effective links to other nodes exist in the graph. Not just quantity -- diversity matters. All `tagged` links is less valuable than a mix of `caused_by`, `analogous`, `contradicts`. | Changes with link creation/deletion | Richly connected hippocampal memories are easier to recall |
| **Independence** | How well the content can be understood and used outside its original context. "Decided to use SQLite on 2026-03-20 in Cursor" has low independence. "Prefer zero-ops solutions for personal tools" has high independence -- self-contained, transferable. | Gradually increases through reconsolidation (specific -> abstract) | Migration from hippocampus-dependent to cortex-independent |

**Heat vs. Maturity:** Heat is short-term; the other three are long-term. They are independent but interact: hot nodes are more likely to be selected for reconsolidation (evolving through use), and reconsolidation increases maturity. High-maturity nodes are not easily archived even when cold (keystone protection), while low-maturity cold nodes are most likely to be forgotten.

**Maturity Score:** The four dimensions are stored individually (different operations need different dimensions -- `prepare` prioritizes independence, `explore` prioritizes connectivity). For external ranking, a weighted composite score is used, with weights stored in the evolvable strategy library.

### Node Types

Each node has a `type` attribute that influences its behavior in the graph:

| Type | Description | Structure Level |
|------|-------------|-----------------|
| `fact` | Decisions, conclusions, established facts | High |
| `context` | Project information, relationships, current state | High |
| `preference` | Coding style, communication preferences, tool configurations | Medium |
| `idea` | Inspirations, hypotheses, unvalidated thoughts | Low (links are freer) |
| `crystal` | High-dimensional cognitive products emerging from many nodes -- user profiles, behavioral patterns, decision principles. Not a separate container; hub nodes in the graph. | Highest |
| `meta` | System operation records -- MCP call logs, strategy changes, internal operations. Hidden from external queries by default; used for internal reflection. Very low weight. | Internal |

**Rigidity difference between `fact` and `idea`** (echoing Principle 10, edge of chaos): `fact`-type link creation requires higher confidence thresholds; `idea`-type links can be more liberal (lower `strength` thresholds). This ensures the factual network's reliability and the ideational network's flexibility coexist.

### Derived Category (Computed, Not Stored)

From the three content-nature dimensions (`specificity`, `subjectivity`, `actuality`), a derived category is computed at read time:

| Derived Category | Meaning |
|-----------------|---------|
| `record` | Specific, objective, time-bound |
| `knowledge` | General, objective, enduring |
| `belief` | General, subjective, enduring |
| `hypothesis` | General, subjective, time-bound |
| `intention` | Specific, subjective, future-oriented |

### Link Model

Links connect nodes with rich metadata:

| Field | Type | Description |
|-------|------|-------------|
| `relation` | `LinkRelation[]` | Array of `{type, confidence}` pairs. A single link can carry multiple relation types. |
| `strength` | `number` (0--1) | How strong the connection is. Decays over time via Hebbian learning. |
| `note` | `string?` | Optional explanation of why this link exists. |
| `auto` | `boolean` | Whether the link was automatically generated (vs. human-confirmed). |
| `status` | `'confirmed' \| 'pending'` | Pending links await evaluation before being promoted or discarded. |

**Relation types** (current implementation):

| Relation | Semiotic Class | Description |
|----------|---------------|-------------|
| `caused_by` | Indexical | Causal relationship |
| `continues` | Indexical | Temporal continuation |
| `updates` | Indexical | Newer version of the same information |
| `supports` | Iconic | Evidence or supporting argument |
| `contradicts` | Iconic | Conflicting information |
| `summarizes` | Symbolic | Higher-level summary of source nodes |
| `part_of` | Symbolic | Component of a larger concept |
| `analogous` | Iconic | Structural similarity |
| `tagged` | Symbolic | Categorization by tag |

### Crystal Nodes and Dynamic Granularity

Crystal nodes are not fixed-size. Like how "dog," "golden retriever," and "my dog Buddy" are all concepts at different granularity levels, crystal granularity is driven by content pressure:

**Splitting:** When content exceeds a threshold (e.g., 500 words) and contains distinct sub-topics, the crystal splits into more focused child nodes linked by `summarizes` relationships.

**Merging:** When several small nodes are always retrieved together, always co-linked to other nodes, and have very high mutual `strength`, a new parent node is generated to synthesize them (via `summarizes` links; original nodes are not deleted).

**No nesting structures.** Nesting complicates graph operations. Expressing hierarchy through link relationships (`summarizes`, `part_of`) is more flexible -- a child node can belong to multiple parent summaries simultaneously. This is closer to Luhmann's Zettelkasten approach: using numbering and references to express hierarchy while keeping each card atomic.

---

## Storage Architecture

### SQLite + FTS5 + sqlite-vec

All data lives in a single SQLite database file. This eliminates deployment complexity and ensures zero-ops for personal use.

| Table | Purpose |
|-------|---------|
| `nodes` | All memory nodes with maturity dimensions, structural role flags, and lifecycle metadata |
| `links` | Semantic connections between nodes (relation stored as JSON array) |
| `node_versions` | Version history for reconsolidated nodes |
| `operation_log` | MCP call records (prepare/recall/digest) |
| `strategy_feedback` | Strategy evaluation data for Learning II |
| `strategy_versions` | Strategy file version history |
| `metadata` | System metadata (maintenance timestamps, schema version) |
| `agents` | Agent identity table (multi-agent support) |
| `note_sources` | Note integration instances (Logseq, Obsidian, Apple Notes) |
| `llm_usage_log` | LLM API usage tracking |
| `sync_hashes` | Source-to-runtime sync tracking |

**Full-text search:** SQLite FTS5 provides BM25 text search with no external dependencies.

**Vector search:** The `sqlite-vec` extension stores embeddings and performs approximate nearest-neighbor search directly in SQLite. The graph node's embedding is stored separately and linked by node ID.

**Hybrid search:** Retrieval combines BM25 (lexical), vector similarity (semantic), heat (recency), and maturity score. Weights are configurable and evolvable:

```
final_score = alpha * bm25 + beta * vector + gamma * heat + delta * maturity
```

### Cold-Start Gating

Features activate progressively as data accumulates. The gate system checks node and link counts to avoid running advanced features on insufficient data:

| Feature | Activation Condition |
|---------|---------------------|
| Basic digest | Always active |
| BM25 search | Always active |
| Vector search | Nodes >= `vector_search` gate (default: 50) |
| Graph expansion | Links >= `graph_expansion_links` gate |
| Crystal generation | Nodes >= `crystal_generation` gate |
| Divergent scan | Nodes >= `divergent_scan` gate |
| Learning II | Nodes >= 500 AND recall operations >= 200 |
| Learning III | Learning II running for 3+ months |

---

## Cognitive Interface

The system exposes three MCP tools, mapped to real cognitive operations rather than database CRUD:

| Tool | Cognitive Metaphor | When |
|------|-------------------|------|
| `brain_prepare` | "Give me the map" | Every new conversation |
| `brain_recall` | "Retrieve on demand" | When historical context is needed |
| `brain_digest` | "Digest this information" | After producing valuable content |

Six cognitive operations (digest, recall, prepare, explore, diverge, correct) were refined down to three:

- **explore** (graph traversal) and **diverge** (divergent search) are retrieval strategies within `recall`, not separate interfaces. The external AI does not need to know whether it is doing vector search or graph traversal -- it just needs relevant information.
- **correct** is a special form of `digest` -- "this was wrong" is itself new information that should be fully digested (with audit trail and correction history), not a simple data modification.

All interfaces support a **context parameter** -- explaining "why" you are performing this operation. Context not only improves the current operation's precision; it is itself valuable data for understanding user cognitive patterns, feeding into Learning II.

For complete API reference, see [API Documentation](api.md).

---

*See also: [Metabolism](metabolism.md) for how information flows and evolves within the graph, and [Integrations](integrations.md) for connecting external tools.*
