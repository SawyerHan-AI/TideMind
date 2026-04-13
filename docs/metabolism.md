**English** | [中文](metabolism_CN.md)

# Metabolism

> The physics of the external brain -- how information flows, decays, consolidates, and evolves.

In the living graph architecture, **processing is not the job of a separate engine; it is woven into every graph interaction.** There are three metabolic modes, plus two levels of self-evolution.

---

## Three Metabolic Modes

### 1. Write-Link (Triggered on Digest)

When new information enters the system, it immediately begins finding its place in the graph.

**Step 1: Minimal processing.** The content is stored as a single atomic node with basic attributes -- type, content, source pointer. No LLM call is required on the critical path; the content is stored as-is.

**Step 2: Initial state assessment.** A heuristic quality check determines the initial heat value based on content characteristics (not source tool):

| Content Pattern | Initial Heat | Rationale |
|----------------|-------------|-----------|
| Pure URL or file path | 0.3 | Minimal standalone value |
| Very short content (<10 effective units) | 0.3 | Likely fragmentary |
| Short content (10-20 units) | 0.5 | Some value but limited |
| Substantive content (20+ units) | 1.0 | Full initial activity |

Why not differentiate by source: quality varies enormously within the same tool. A deep architectural discussion in Cursor deserves high initial values; a "write me a for loop" conversation does not. Content quality is the real signal; source is a crude proxy.

**Step 3: Positioning.** An embedding is computed and used to find nearest neighbors in the graph, determining where the new node "lands."

**Step 4: Landing connections.** Initial links are created based on neighbor search. The strategy is conservative: **only create a few high-confidence links (top-2, similarity > 0.8), marking "possibly related but uncertain" candidates as `pending` for idle deep processing.** This simulates the brain's two-phase processing -- quickly establishing a few certain associations while awake, slowly organizing potential connections during sleep.

**Step 5: Deduplication.** When nearest-neighbor similarity is very high (> 0.92), no new node is created. Instead, the existing node undergoes reconsolidation -- content is updated, context is supplemented, version increments. Tags from the source node are merged into the target.

**Step 6: Near-real-time annotation.** A background task (running on a short interval) picks up newly created nodes and annotates them with LLM-assessed dimensions (specificity, subjectivity, actuality), supplementary tags, and refined type classification. This keeps the digest path fast while ensuring rich metadata is eventually populated.

### 2. Read-Write (Triggered on Recall)

Every recall does not merely return results -- it simultaneously evolves the graph. But not every recall triggers full processing. Three levels are applied based on the situation, inspired by neuroscience reconsolidation research: memory only reopens for update when there is a "prediction error."

#### Silent Read (The Vast Majority of Cases)

Only updates hit nodes' heat. The heat bump is rank-weighted:

```
delta = max(0.01, 0.1 * (1 - rank / total_results))
```

Top-ranked results get a full +0.1 bump; lower-ranked results get progressively less. Cost is near zero.

#### Perceptual Read

**Trigger:** Recall returns 3+ results AND the link density among them is below 0.3 AND average search score passes a quality gate (>= 0.3).

**Action:** Creates `pending` links between result nodes that are semantically related but have no direct link. Up to 5 pending links per recall. These links are later evaluated by the idle deep processing pipeline.

**Link density calculation:**
```
density = existing_links_between_results / max_possible_links
```

Where `max_possible_links = n * (n-1) / 2` for `n` result nodes.

This does not block the recall response -- it runs synchronously but is lightweight (no LLM calls). Link relation types are inferred heuristically from content comparison.

#### Deep Read (Full Reconsolidation)

**Triggers:**
1. **Time condition:** `version == 1` AND more than 7 days since last reconsolidation (only first-version nodes; already-revised nodes skip time-driven deep reads).
2. **Prediction error:** Context provided by the caller conflicts with the node's content (detected by heuristic conflict signals).
3. **Inter-node contradiction:** Returned nodes may contradict each other.

**Action:** An LLM analyzes the node in the context of surrounding nodes and the caller's context. The LLM determines:
- Whether the content needs updating (`needs_update` + `updated_content`)
- Whether a conflict exists with a context node (`conflict_detected` + `conflict_with_index`)
- An updated independence score (`new_independence`)

If a conflict is detected, a `contradicts` pending link is created between the conflicting nodes. Refinement increases by +0.15, and the independence score is updated.

**Conflict detection is async and non-blocking.** Results are returned to the external AI immediately. Conflict detection runs in the background using a two-stage pipeline:

1. **Heuristic fast scan** (zero LLM cost): detects keyword contradictions, negation patterns, and context mismatches.
2. **LLM confirmation** (for medium-confidence signals): only called when heuristic confidence is between 0.3 and 0.7.

High-confidence signals (>= 0.7) trigger deep reconsolidation directly without LLM confirmation.

### 3. Idle Deep Processing (Triggered During Quiet Periods)

Idle processing handles operations that **require a global view** -- real-time metabolism is local (seeing only the new node and its neighbors) and cannot detect global patterns.

#### Daily Maintenance

**Synaptic Scaling (Global Cooldown)**

All nodes with `heat > 0.01` undergo decay. The decay formula:

```
decay_rate = 1 - base * (1 - damping * min(connectivity, 1))
```

Where `base = 0.05` and `damping = 0.8` (configurable via strategy parameters).

| Connectivity | Decay Rate | Daily Retention |
|-------------|------------|-----------------|
| 0.0 | 0.950 | 95.0% |
| 0.5 | 0.970 | 97.0% |
| 1.0 | 0.990 | 99.0% |

All nodes strictly decay (rate is always < 1.0). Highly connected nodes decay slower but never grow from decay alone -- this naturally implements keystone protection without special-case logic.

Processing is batched (100 nodes per transaction) to minimize write-lock contention.

**Link Decay (Hebbian Learning)**

Link strength decays based on the activity of both endpoints:

```
activity_factor = sqrt(heat_A * heat_B)
daily_retention = 1 - link_decay_base * (1 - activity_factor)
new_strength = strength * daily_retention
```

Where `link_decay_base = 0.03` by default. Links between active nodes (high heat on both ends) decay very slowly; links between dormant nodes decay quickly. Links whose strength drops below 0.05 are deleted entirely.

**Exception:** `tagged` links skip Hebbian decay. Tag membership is a structural classification relationship whose lifecycle follows the tag node's heat, not co-activation frequency.

**Pending Link Evaluation:** Candidate links accumulated during the day are evaluated by an LLM one by one -- confirmed or discarded.

#### Weekly Maintenance

**Divergent Scan (Structural Hole Detection)**

The core algorithm for producing "surprise" -- the emergent serendipity capability described in the [design philosophy](design-philosophy.md).

Algorithm:
1. Collect active nodes (`heat > 0.1`, up to 100 nodes).
2. Build an adjacency map (excluding `tagged` links -- structural holes should be detected based on semantic relationships only).
3. Find candidate pairs: nodes sharing >= 2 neighbors but with no direct link.
4. Sort by number of shared neighbors (descending).
5. For the top candidates (up to 10 pairs), use an LLM to generate a "bridge insight" -- evaluating whether there is an unexpected connection.
6. If the insight confidence >= 0.5, create a new crystal node containing the bridge insight, linked to both source nodes via `summarizes` relationships.

**Crystal Emergence**

Two paths for crystal generation:

| Path | Trigger | Input |
|------|---------|-------|
| **Path A: Hub crystallization** | A non-crystal node has >= 5 links, >= 3 relation type diversity, >= 3 in-degree, and sufficient independence/refinement | Hub node + its top-5 neighbors |
| **Path B: Cluster synthesis** | 3+ candidate hub nodes that did not qualify for Path A | Up to 10 pooled node contents |

Both paths use the same LLM crystal generation function. Path A marks the hub node in the input so the LLM knows which node is central. The generated crystal becomes a new node linked to its source nodes via `summarizes`.

Existing crystals are also checked: if >= 30% of supporting nodes have been modified since the crystal's last update, the crystal content is refreshed using the updated evidence.

**Keystone Identification**

Recalculates centrality metrics across the entire active graph. The top 5% of nodes by connectivity are marked as `is_keystone = 1`. Keystone nodes receive slower decay rates and are protected from automatic archival. Requires at least 20 active nodes to be meaningful.

---

## Self-Evolution

### Learning II: Strategy Parameter Tuning

*(Bateson's deutero-learning -- learning to learn)*

**Gate:** 500+ nodes AND 200+ recall operations.

**Mechanism:** Collect behavioral metrics -> analyze trends -> single-parameter adjustment -> monitor and rollback if needed.

**Signal collection:** Multiple feedback signals are collected continuously:
- Strategy feedback from each operation (recall hit rates, digest quality)
- Parameter-specific feedback (node awakening rates, correction frequency)
- Explicit user corrections as negative signals

**Trend analysis:** For each strategy parameter:
1. Collect 30 days of feedback data.
2. Split into early half (days 1-15) and late half (days 16-30).
3. Compute average signal for each half.
4. If the trend (late - early) is below a decline threshold (default: -0.1), intervention is warranted.

**Adjustment process:**
1. An LLM analyzes the trend data and decides direction (increase / decrease / hold).
2. The parameter is adjusted by at most 10% (multiplicative).
3. The adjustment enters a monitoring window (default: 7 days).
4. After the monitoring window:
   - If post-adjustment average < pre-adjustment average - 0.05: **rollback** to old value.
   - Otherwise: **confirm** the adjustment.

**Safeguards:**
- Cooldown period (default: 14 days) per strategy between adjustments.
- Evolution system's own parameters are blacklisted from self-modification.
- LLM-related parameters (model, max_tokens) are excluded.
- Minimum sample size (20) required before any adjustment.
- All adjustments are versioned and logged in `evolution-log.jsonl`.

### Learning III: Framework Reconstruction

*(Bateson's Learning III -- restructuring the cognitive framework itself)*

**Gate:** Learning II must have been running for 3+ months.

**Trigger:** Multiple signals must simultaneously reach critical levels (at least 2 of 4 signals above 0.5):

| Signal | What It Measures | High Value Means |
|--------|-----------------|------------------|
| **Diminishing returns** | Rejection rate of Learning II adjustments over 3 months | Strategy tuning is no longer effective |
| **Correction patterns** | Concentration of user corrections by node type | The classification framework itself may be wrong |
| **Recall-usage mismatch** | % of recalls not followed by any digest in the same session | Retrieved memories are not useful |
| **Graph accommodation** | Connectivity of recent nodes vs. historical nodes | New information cannot find its place in the existing structure |

**Action:** When triggered, Learning III generates a diagnostic report using a heavy LLM call. The report includes:
- Analysis of all four signals with evidence
- Diagnosis of the framework-level problem
- Recommendations classified as `low_risk` or `high_risk`, each specifying affected strategies

The report is saved as a JSON file for human review. Learning III does not automatically apply high-risk changes -- it produces diagnoses and recommendations, leaving the decision to the system operator or future automation.

---

## Cold-Start Gating Table

The system progressively activates features as data accumulates:

| Phase | Node Count | Features Active |
|-------|-----------|-----------------|
| **Seed** | 0 | Basic digest, stream logging |
| **Sprout** | 1-49 | + BM25 search |
| **Growth** | 50+ | + Vector search, hybrid retrieval |
| **Branching** | 100+ (with links) | + Graph expansion on recall |
| **Canopy** | 200+ | + Crystal generation, divergent scan |
| **Forest** | 500+ nodes, 200+ recalls | + Learning II (strategy self-tuning) |
| **Ecosystem** | Learning II running 3+ months | + Learning III (framework diagnosis) |

Each phase creates the conditions for the next, implementing Principle 16 (Cognitive Succession).

---

*See also: [Architecture](architecture.md) for the data model these processes operate on, and [API](api.md) for how external tools interact with the system.*
