<p align="center">
  <img src="docs/assets/banner.png" alt="TideMind" width="100%" />
</p>

<p align="center">A living second brain that connects everything you think with — your AI agents, your notes, and whatever comes next.</p>

<p align="center">

[![Website](https://img.shields.io/badge/Website-tidemind.ai-6C5CE7?style=for-the-badge&logo=safari&logoColor=white)](https://tidemind.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-6C5CE7?style=for-the-badge&logoColor=white)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-4B3F8F?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-8B7FD4?style=for-the-badge&logoColor=white)](https://modelcontextprotocol.io/)
[![Docs](https://img.shields.io/badge/Docs-Read%20the%20Docs-5B4FCF?style=for-the-badge&logo=readthedocs&logoColor=white)](docs/)
[![GitHub Discussions](https://img.shields.io/badge/Community-Discussions-7C6DD8?style=for-the-badge&logo=github&logoColor=white)](https://github.com/SawyerHan-AI/TideMind/discussions)

</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README_CN.md">中文</a>
</p>

## Why TideMind

**Your memory is scattered across a dozen tools, and none of them talk to each other.**

Claude remembers you like concise code, but Cursor has no idea. You spent a week organizing design thinking in your notes, but the next time you discuss it with an AI, it knows nothing. Every tool quietly accumulates its own understanding of you, yet nothing connects them.

The deeper problem: existing AI memory is just listing and storing facts. It won't link memories together, won't discover commonalities across your ideas that you haven't noticed yourself, and certainly won't build a complete profile of who you are. And as memories pile up, the data grows increasingly redundant and harder to retrieve.

TideMind is a memory layer that spans all your tools — a living knowledge graph that connects your AI, your notes, and your thinking.

## What is TideMind

![TideMind Concept](docs/assets/concept-banner.png)

**All your memory, in one place.** TideMind connects your AI tools, your notes, and whatever comes next into a single knowledge graph. Conversations across different AIs, notes across different apps — no longer scattered in silos, but woven together, cross-pollinating.

**Every AI knows you completely.** At the start of each conversation, TideMind provides your AI with a profile and key memories distilled from all past interactions — who you are, how you think, what you care about.

**More precise, more complete recall.** When your AI needs more context, it doesn't just rely on keyword/vector search — it can follow links between memories, navigating from one decision to the discussion behind it, then to later changes it triggered. No need to load everything; no risk of missing what matters. It starts with a few highly relevant nodes and explores along links when more context is needed — on-demand exploration.

**More than a database — a living system.** Memories form connections automatically. Unimportant details naturally fade; important ones are reinforced and updated. TideMind actively discovers commonalities you haven't noticed — linking a decision from three months ago to the problem you're facing today. Information doesn't end at storage. It's digested, connected, distilled, and sometimes forgotten. That's what "living" means.

**Simple to start.** Connect your AI tools through the MCP protocol — one config, no habit changes. Import and sync notes with a single click.

**Your memory belongs to you.** All data lives in a single SQLite file on your machine, exportable to Markdown anytime. No cloud, no vendor lock-in. Go fully local with Ollama for privacy, use cloud models for quality, or mix both.

## How it's different

|  | Typical AI Memory | TideMind |
|---|---|---|
| **Profile** | No profile, or siloed within a single AI | Complete profile built from all your data, delivered to AI at the start of every conversation |
| **Storage** | Flat list of facts | Knowledge graph where memories dynamically evolve across multiple dimensions over time and use |
| **Recall** | Keyword / vector top-K | Starts from the most relevant memories, follows links to explore, expands on demand |
| **Emerge** | Stored memories stay frozen | A living system that surfaces new cognition |
| **Data** | Cloud / vendor-locked | Local SQLite file, export to Markdown anytime |

## Quick Start

### Option 1: Download the Desktop App

The easiest way to get started. Download, install, and you're ready to go.

**[Download for macOS (Apple Silicon) — Beta](https://github.com/SawyerHan-AI/TideMind/releases/tag/v0.1.0)**

Open the app, then head to **Settings** to connect your AI tools and note systems with one click.

### Option 2: From Source

For developers who prefer building from source.

#### Prerequisites

- Node.js >= 18

That's the only hard requirement. TideMind runs out of the box with text search (BM25) and basic storage.

**Optional, for the full experience:**

- **An LLM provider** (Anthropic API Key, Google Vertex AI, or Gemini) — enables automatic information extraction, memory reconsolidation, divergent scanning, and crystal emergence. Without it, these features are simply skipped.
- **An embedding provider** (Ollama, Vertex AI, or Gemini) — enables semantic vector search alongside BM25. Without it, search falls back to keyword matching.
- You can mix and match: e.g., Ollama locally for embeddings + Anthropic for LLM, or go fully local, or fully cloud. See the [Integration Guide](docs/integrations.md) for details.

#### Install

```bash
git clone https://github.com/SawyerHan-AI/tidemind.git
cd tidemind
npm install
npm run build
```

#### Launch and Connect

```bash
npm start
```

Open the desktop client, then head to **Settings** to connect your AI tools and note systems with one click — no manual config file editing required.

> Also supports manual MCP configuration — see the [Integration Guide](docs/integrations.md).

That's it. Next time you open a conversation, your AI will remember you.

## How it works

### Active Graph

All information — AI conversations, note content, your preferences and decisions — lives as nodes and links in a single graph. Nodes aren't static index cards; they carry four maturity dimensions (activity, refinement, connectivity, independence) that together determine a memory's fate: reinforced, connected, crystallized, or forgotten.

[Learn more about the Active Graph model](docs/architecture.md)

### Three Cognitive Tools

TideMind exposes three tools via the MCP protocol, corresponding to three cognitive operations:

| Tool | What it does | When to use |
|------|-------------|-------------|
| `brain_prepare` | Load memory context | Start of every conversation |
| `brain_recall` | Navigate and retrieve memories | When you need historical context |
| `brain_digest` | Store new information | When something worth remembering emerges |

This isn't CRUD. Prepare is like opening a memory map. Recall is like remembering — and each recall strengthens the memory. Digest is like absorption — incoming information is decomposed, connected, and woven into the existing knowledge network.

`brain_recall` goes beyond search. AI can follow links between memories — starting from an architecture decision, jumping to the discussion behind it, then to later changes it triggered. Like walking through a knowledge network, not guessing keywords in a search box. It returns a small set of highly relevant nodes first, then expands along links when more context is needed — exploring on demand, never loading everything upfront.

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

TideMind ships with a desktop client for browsing your knowledge graph, monitoring system metabolism, and tuning parameters. It's an inspection tool — for observing what your external brain is thinking, discovering, and forgetting.

The main interface of TideMind isn't this app. It's whatever AI tool you're already using.

<p align="center">
  <img src="docs/assets/screenshot-dashboard.jpg" alt="Dashboard — metrics, activity feed, crystal discoveries, and tag overview" width="100%" />
</p>
<p align="center"><em>Dashboard — real-time pulse of your second brain</em></p>

<p align="center">
  <img src="docs/assets/screenshot-graph.jpg" alt="Brain Explorer — interactive knowledge graph with cross-domain connections" width="100%" />
</p>
<p align="center"><em>Brain Explorer — visualize how your memories connect across domains</em></p>

<p align="center">
  <img src="docs/assets/screenshot-list.jpg" alt="Memory detail — maturity radar, evidence chains, and linked nodes" width="100%" />
</p>
<p align="center"><em>Memory detail — four-dimensional maturity model and evidence chains</em></p>

## Documentation

| Document | Description |
|----------|-------------|
| [Design Philosophy](docs/design-philosophy.md) | From Bush (1945) to Clark & Chalmers (1998) — the cognitive science behind TideMind |
| [Architecture](docs/architecture.md) | Active Graph model, four maturity dimensions, link type system |
| [Metabolism & Self-Evolution](docs/metabolism.md) | Decay mechanics, divergent scanning, crystal emergence, three-tier learning |
| [Integration Guide](docs/integrations.md) | Detailed setup for each AI tool and note system |
| [API Reference](docs/api.md) | Full parameter documentation for prepare / recall / digest |

## FAQ

**Q: How is TideMind different from Obsidian / Notion / Mem?**

TideMind is not a note-taking app — it's a memory layer that sits *between* your tools. Obsidian and Notion are where you write; TideMind is where all your thinking connects. It ingests notes from Obsidian, Logseq, Apple Notes, and conversations from your AI tools, then weaves them into a single living knowledge graph. You keep using whatever tools you prefer — TideMind connects them behind the scenes.

**Q: I already have a note system. Why do I need TideMind?**

Your notes are one slice of your thinking. The other slices — AI conversations, decisions made in passing, preferences expressed across tools — are scattered and siloed. TideMind captures all of them and builds connections you wouldn't make manually. It also delivers this context to your AI automatically, so every conversation starts with full awareness of who you are, not a blank slate.

**Q: Where is my data stored? Is it secure?**

Everything lives in a single SQLite file on your machine. No cloud, no third-party servers, no accounts. You can export all your data to Markdown at any time. If you want full privacy, run TideMind entirely offline with local models via Ollama — no API calls leave your machine.

**Q: Do I need an API key? Which models are supported?**

TideMind works out of the box with zero API keys — basic text search (BM25) and storage are fully functional. For advanced features (automatic extraction, memory reconsolidation, divergent scanning, crystal emergence), you'll need an LLM provider: Anthropic, Google Vertex AI, or Gemini. For semantic search, you can use Ollama (local, free), Vertex AI, or Gemini for embeddings. Mix and match freely — e.g., Ollama locally for embeddings + Anthropic for LLM.

**Q: What AI tools and note systems does TideMind support?**

Any tool that supports the [MCP protocol](https://modelcontextprotocol.io/) works with TideMind — including Claude Code, Cursor, Windsurf, and Codex. For notes, TideMind currently supports Logseq, Obsidian, and Apple Notes, with more coming. See the full [Integration Guide](docs/integrations.md).

**Q: How do I install it? Do I need a technical background?**

Two options: **Desktop App** (download, install, done — no terminal needed) or **From Source** (for developers: `git clone` → `npm install` → `npm start`). The desktop app handles all configuration through a visual settings panel.

**Q: "Memories naturally fade" — does that mean my data gets deleted?**

No. The raw data is always preserved. What changes is *relevance*: memories you haven't revisited gradually lose prominence in retrieval, just like in a real brain. Important, highly-connected memories are protected from decay. And any faded memory is instantly reinforced the moment you or your AI recall it. Think of it as prioritization, not deletion.

**Q: What's the difference between TideMind (open source) and TideMind Cloud?**

The open-source version is fully functional for local use — all core features, no limitations. TideMind Cloud (coming soon) adds cross-device sync, mobile access, and a managed account system for users who prefer not to self-host. Some features requiring cloud infrastructure (such as browser extension integration) may only be available in the Cloud version. The core engine is identical.

## Contributing

Contributions of all kinds are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

[MIT](LICENSE)

---

*Inspired by 80 years of cognitive science — from Bush's Memex to modern memory reconsolidation research.*
