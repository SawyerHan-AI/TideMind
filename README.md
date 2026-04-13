# TideMind

A living second brain that connects everything you think with — your AI agents, your notes, and whatever comes next.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-purple.svg)](https://modelcontextprotocol.io/)

[English](README.md) | [中文](README_CN.md)

---

```mermaid
graph LR
    subgraph Input["🔌 Connect"]
        A1["🤖 AI Agents"]
        A2["📝 Notes"]
        A3["··· More"]
    end

    subgraph Core["🧠 Active Graph"]
        B1[Nodes & Links]
        B2[4D Maturity]
        B3[Metabolism]
        B1 --- B2
        B2 --- B3
    end

    subgraph Value["✨ Emerge"]
        C1[Shared Memory]
        C2[Pattern Discovery]
        C3[Crystallization]
    end

    A1 -->|MCP| Core
    A2 -->|File Sync| Core
    A3 -.->|Open Protocol| Core
    Core --> C1
    Core --> C2
    Core --> C3

    style Input fill:#1a1a2e,stroke:#7c3aed,color:#e0e0e0
    style Core fill:#1a1a2e,stroke:#3b82f6,color:#e0e0e0
    style Value fill:#1a1a2e,stroke:#10b981,color:#e0e0e0
```

---

## Why TideMind

**Your memory is scattered across a dozen tools, and none of them talk to each other.**

Claude remembers you like concise code, but Cursor has no idea. You spent a week organizing design thinking in Logseq, but the next time you discuss it with an AI, it knows nothing. The rapport you built with one agent vanishes the moment you switch to another. Every tool quietly accumulates its own understanding of you, yet nothing connects them.

The deeper problem: even AIs that have built-in memory are just storing flat facts. They won't link a decision you made three months ago to the problem you're facing today. They won't let go of details that no longer matter. They won't discover patterns across your ideas that you haven't noticed yourself.

TideMind is a memory layer that spans all your tools — a living knowledge graph that connects your AI, your notes, and your thinking.

## What is TideMind

**All your AI tools share one persistent memory.** Connect through the MCP protocol — no tool switching, no habit changes. Install and go.

**A living knowledge graph, not a database.** Information automatically forms connections. Important memories stay; unimportant ones naturally decay. The system discovers links between ideas you never realized were related — like a thinking partner that occasionally says, "Have you noticed that the decision you made in that project three months ago and the problem you're facing now are the same pattern?"

**Your notes join the graph.** Logseq, Obsidian, and Apple Notes content enters the same graph alongside your AI conversations — connecting and cross-pollinating. A thought you jotted down in your notebook might be automatically recalled during your next AI conversation, becoming the clue that solves the problem at hand.

**All data stays on your machine.** Stored in a single SQLite file. Export to Markdown anytime. No cloud, no lock-in. You choose the LLM and embedding models — go fully local with Ollama for privacy, use cloud models like Claude or GPT for quality, or mix both (e.g., local embeddings, cloud extraction). It's your call.

## Quick Start

### Prerequisites

- Node.js >= 18

That's the only hard requirement. TideMind runs out of the box with text search (BM25) and basic storage.

**Optional, for the full experience:**

- **An LLM provider** (Anthropic API Key, Google Vertex AI, or Gemini) — enables automatic information extraction, memory reconsolidation, divergent scanning, and crystal emergence. Without it, these features are simply skipped.
- **An embedding provider** (Ollama, Vertex AI, or Gemini) — enables semantic vector search alongside BM25. Without it, search falls back to keyword matching.
- You can mix and match: e.g., Ollama locally for embeddings + Anthropic for LLM, or go fully local, or fully cloud. See the [Integration Guide](docs/integrations.md) for details.

### Install

```bash
git clone https://github.com/SawyerHan-AI/tidemind.git
cd tidemind
npm install
npm run build
```

### Launch and Connect

```bash
npm start
```

Open the desktop client, then head to **Settings** to connect your AI tools and note systems with one click — no manual config file editing required.

> Also supports manual MCP configuration — see the [Integration Guide](docs/integrations.md).

That's it. Next time you open a conversation, your AI will remember you.

## Core Concepts

### Active Graph

All information — AI conversations, note content, your preferences and decisions — lives as nodes and links in a single graph. Nodes aren't static index cards; they carry four maturity dimensions (activity, refinement, connectivity, independence) that together determine a memory's fate: reinforced, connected, crystallized, or forgotten.

[Learn more about the Active Graph model](docs/architecture.md)

### Three Cognitive Tools

TideMind exposes three tools via the MCP protocol, corresponding to three cognitive operations:

| Tool | What it does | When to use |
|------|-------------|-------------|
| `brain_prepare` | Load memory context | Start of every conversation |
| `brain_recall` | Retrieve relevant memories | When you need historical context |
| `brain_digest` | Store new information | When something worth remembering emerges |

This isn't CRUD. Prepare is like opening a memory map. Recall is like remembering — and each recall strengthens the memory. Digest is like absorption — incoming information is decomposed, connected, and woven into the existing knowledge network.

[Learn more about the three tools](docs/api.md)

### Metabolism

TideMind continuously maintains the graph in the background, much like the brain organizes memories during sleep:

- **Daily**: Inactive memories gradually decay (but highly connected hub nodes are protected); candidate links are confirmed or pruned
- **Weekly**: Divergent scanning — discovering node pairs that share neighbors but lack direct links, evaluating whether hidden connections exist; highly connected information crystallizes into Crystals — distilled representations of your thinking patterns, behavioral preferences, and core decisions

Information isn't just stored. It's digested, organized, connected, and sometimes forgotten. That's what "living" means.

[Learn more about the metabolism system](docs/metabolism.md)

## Supported Integrations

### AI Tools

| Tool | Status | Notes |
|------|--------|-------|
| Claude Code | Supported | Native MCP support |
| Cursor | Supported | MCP configuration |
| Windsurf | Supported | MCP configuration |
| Codex | Supported | MCP configuration |
| Any MCP-compatible tool | Supported | Standard protocol, plug and play |

### Note Systems

| Source | Status | Notes |
|--------|--------|-------|
| Logseq | Supported | File watching, incremental sync, properties promoted to tags |
| Obsidian | Supported | Vault import, Canvas support, wikilink resolution |
| Apple Notes | Supported | Read-only sync, attachment text extraction |
| *More coming soon...* | | |

## Desktop Client

<!-- Screenshot placeholder -->

TideMind ships with a desktop client for browsing your knowledge graph, monitoring system metabolism, and tuning parameters. It's an inspection tool — for observing what your external brain is thinking, discovering, and forgetting.

The main interface of TideMind isn't this app. It's whatever AI tool you're already using.

## Documentation

| Document | Description |
|----------|-------------|
| [Design Philosophy](docs/design-philosophy.md) | From Bush (1945) to Clark & Chalmers (1998) — the cognitive science behind TideMind |
| [Architecture](docs/architecture.md) | Active Graph model, four maturity dimensions, link type system |
| [Metabolism & Self-Evolution](docs/metabolism.md) | Decay mechanics, divergent scanning, crystal emergence, three-tier learning |
| [Integration Guide](docs/integrations.md) | Detailed setup for each AI tool and note system |
| [API Reference](docs/api.md) | Full parameter documentation for prepare / recall / digest |

## Contributing

Contributions of all kinds are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

[MIT](LICENSE)

---

*Inspired by 80 years of cognitive science — from Bush's Memex to modern memory reconsolidation research.*
