import type { ReactNode } from 'react'
import { Clock, Zap } from 'lucide-react'
import type { GroupTab, ProcessingNode } from './types'

export const TRIGGER_PARAM_KEYS = new Set([
  'interval_minutes', 'lookback_hours', 'pending_expire_days',
  'min_link_age_hours', 'decay_interval_minutes', 'tag_promote_interval_minutes',
  'contradiction_lookback_hours',
])

export const LLM_PARAM_KEYS = new Set([
  'llm_tier', 'thinking', 'thinking_budget',
  'max_tokens', 'content_budget', 'max_content_per_node',
  'neighbor_preview_length',
  'max_content_length',
])

export function classifyParam(key: string): 'trigger' | 'llm' | 'param' {
  if (TRIGGER_PARAM_KEYS.has(key)) return 'trigger'
  if (LLM_PARAM_KEYS.has(key)) return 'llm'
  return 'param'
}

// ============================================================
// 分组配置
// ============================================================

export const GROUP_DESC_KEYS: Record<GroupTab, string> = {
  memory: 'strategy.groupDesc.memory',
  'think-associate': 'strategy.groupDesc.thinkAssociate',
  'think-emerge': 'strategy.groupDesc.thinkEmerge',
  output: 'strategy.groupDesc.output',
  evolution: 'strategy.groupDesc.evolution',
}

// ============================================================
// 节点定义 — 按认知功能分组
// ============================================================

export const MEMORY_NODES: ProcessingNode[] = [
  {
    id: 'landing',
    name: 'strategy.nodes.landing.name',
    description: 'strategy.nodes.landing.description',
    configParams: [
      { key: 'landing_threshold', label: 'strategy.nodes.landing.confirmedThreshold', tip: 'strategy.nodes.landing.confirmedThresholdTip', default: 0.80, step: 0.01, section: 'metabolism' },
      { key: 'pending_threshold', label: 'strategy.nodes.landing.pendingThreshold', tip: 'strategy.nodes.landing.pendingThresholdTip', default: 0.60, step: 0.01, section: 'metabolism' },
      { key: 'landing_top_k', label: 'strategy.nodes.landing.topK', tip: 'strategy.nodes.landing.topKTip', default: 2, step: 1, section: 'metabolism' },
    ],
    trigger: { type: 'realtime', label: 'strategy.nodes.landing.trigger' },
  },
  {
    id: 'dedup',
    name: 'strategy.nodes.dedup.name',
    description: 'strategy.nodes.dedup.description',
    configParams: [
      { key: 'dedup_threshold', label: 'strategy.nodes.dedup.threshold', tip: 'strategy.nodes.dedup.thresholdTip', default: 0.92, step: 0.01, section: 'metabolism' },
    ],
    trigger: { type: 'realtime', label: 'strategy.nodes.dedup.trigger' },
  },
  {
    id: 'dedup-merge',
    name: 'strategy.nodes.dedupMerge.name',
    description: 'strategy.nodes.dedupMerge.description',
    llmStrategy: 'dedup-merge',
    strategy: 'dedup-merge',
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.dedupMerge.trigger',
      intervalParam: { key: 'interval_minutes', label: 'strategy.nodes.dedupMerge.interval', tip: 'strategy.nodes.dedupMerge.intervalTip', strategyName: 'dedup-merge', step: 60 },
    },
  },
  {
    id: 'annotate',
    name: 'strategy.nodes.annotate.name',
    description: 'strategy.nodes.annotate.description',
    llmStrategy: 'annotate',
    strategyParams: [
      { key: 'batch_size', label: 'strategy.nodes.annotate.batchSize', tip: 'strategy.nodes.annotate.batchSizeTip', strategyName: 'annotate', step: 1 },
      { key: 'neighbor_count', label: 'strategy.nodes.annotate.neighborCount', tip: 'strategy.nodes.annotate.neighborCountTip', strategyName: 'annotate', step: 1 },
      { key: 'frequent_tags_limit', label: 'strategy.nodes.annotate.frequentTagsLimit', tip: 'strategy.nodes.annotate.frequentTagsLimitTip', strategyName: 'annotate', step: 5 },
      { key: 'content_budget', label: 'strategy.nodes.annotate.contentBudget', tip: 'strategy.nodes.annotate.contentBudgetTip', strategyName: 'annotate', step: 500 },
      { key: 'max_content_per_node', label: 'strategy.nodes.annotate.maxContentPerNode', tip: 'strategy.nodes.annotate.maxContentPerNodeTip', strategyName: 'annotate', step: 100 },
      { key: 'neighbor_preview_length', label: 'strategy.nodes.annotate.neighborPreviewLength', tip: 'strategy.nodes.annotate.neighborPreviewLengthTip', strategyName: 'annotate', step: 50 },
    ],
    strategy: 'annotate',
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.annotate.trigger',
      intervalParam: { key: 'interval_minutes', label: 'strategy.nodes.annotate.interval', tip: 'strategy.nodes.annotate.intervalTip', strategyName: 'annotate', step: 1 },
    },
  },
  {
    id: 'synaptic-consolidate',
    name: 'strategy.nodes.synapticConsolidate.name',
    description: 'strategy.nodes.synapticConsolidate.description',
    llmStrategy: 'reconsolidate',
    strategyParams: [
      { key: 'max_context_nodes', label: 'strategy.nodes.synapticConsolidate.maxContextNodes', tip: 'strategy.nodes.synapticConsolidate.maxContextNodesTip', strategyName: 'reconsolidate', step: 1 },
      { key: 'independence_boost', label: 'strategy.nodes.synapticConsolidate.independenceBoost', tip: 'strategy.nodes.synapticConsolidate.independenceBoostTip', strategyName: 'reconsolidate', step: 0.05 },
      { key: 'conflict_min_overlap', label: 'strategy.nodes.synapticConsolidate.conflictMinOverlap', tip: 'strategy.nodes.synapticConsolidate.conflictMinOverlapTip', strategyName: 'metabolism-params', step: 0.05 },
      { key: 'conflict_cross_min_overlap', label: 'strategy.nodes.synapticConsolidate.conflictCrossMinOverlap', tip: 'strategy.nodes.synapticConsolidate.conflictCrossMinOverlapTip', strategyName: 'metabolism-params', step: 0.05 },
      { key: 'conflict_high_confidence', label: 'strategy.nodes.synapticConsolidate.conflictHighConfidence', tip: 'strategy.nodes.synapticConsolidate.conflictHighConfidenceTip', strategyName: 'metabolism-params', step: 0.05 },
    ],
    strategy: 'reconsolidate',
    trigger: { type: 'query', label: 'strategy.nodes.synapticConsolidate.trigger' },
  },
  {
    id: 'synaptic',
    name: 'strategy.nodes.synapticDecay.name',
    description: 'strategy.nodes.synapticDecay.description',
    configParams: [
      { key: 'decay_base', label: 'strategy.nodes.synapticDecay.decayBase', tip: 'strategy.nodes.synapticDecay.decayBaseTip', default: 0.05, step: 0.01, section: 'metabolism' },
      { key: 'link_decay_base', label: 'strategy.nodes.synapticDecay.linkDecayBase', tip: 'strategy.nodes.synapticDecay.linkDecayBaseTip', default: 0.03, step: 0.01, section: 'metabolism' },
      { key: 'link_delete_threshold', label: 'strategy.nodes.synapticDecay.linkDeleteThreshold', tip: 'strategy.nodes.synapticDecay.linkDeleteThresholdTip', default: 0.05, step: 0.01, section: 'metabolism' },
      { key: 'decay_damping', label: 'strategy.nodes.synapticDecay.decayDamping', tip: 'strategy.nodes.synapticDecay.decayDampingTip', default: 0.8, step: 0.05, section: 'metabolism' },
    ],
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.synapticDecay.trigger',
      intervalParam: { key: 'decay_interval_minutes', label: 'strategy.nodes.synapticDecay.interval', tip: 'strategy.nodes.synapticDecay.intervalTip', strategyName: 'metabolism-params', step: 60 },
    },
  },
]

export const THINK_ASSOCIATE_NODES: ProcessingNode[] = [
  {
    id: 'link-discover',
    name: 'strategy.nodes.linkDiscover.name',
    description: 'strategy.nodes.linkDiscover.description',
    strategyParams: [
      { key: 'vector_similarity_threshold', label: 'strategy.nodes.linkDiscover.vectorThreshold', tip: 'strategy.nodes.linkDiscover.vectorThresholdTip', strategyName: 'link-discover', step: 0.01 },
      { key: 'vector_max_checks', label: 'strategy.nodes.linkDiscover.vectorMaxChecks', tip: 'strategy.nodes.linkDiscover.vectorMaxChecksTip', strategyName: 'link-discover', step: 1 },
      { key: 'max_active_nodes', label: 'strategy.nodes.linkDiscover.maxActiveNodes', tip: 'strategy.nodes.linkDiscover.maxActiveNodesTip', strategyName: 'link-discover', step: 10 },
      { key: 'min_shared_neighbors', label: 'strategy.nodes.linkDiscover.minSharedNeighbors', tip: 'strategy.nodes.linkDiscover.minSharedNeighborsTip', strategyName: 'link-discover', step: 1 },
      { key: 'max_shared_candidates', label: 'strategy.nodes.linkDiscover.maxSharedCandidates', tip: 'strategy.nodes.linkDiscover.maxSharedCandidatesTip', strategyName: 'link-discover', step: 5 },
    ],
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.linkDiscover.trigger',
      intervalParam: { key: 'interval_minutes', label: 'strategy.nodes.linkDiscover.interval', tip: 'strategy.nodes.linkDiscover.intervalTip', strategyName: 'link-discover', step: 1440 },
    },
  },
  {
    id: 'link-evaluate',
    name: 'strategy.nodes.linkEvaluate.name',
    description: 'strategy.nodes.linkEvaluate.description',
    llmStrategy: 'link-evaluate',
    strategyParams: [
      { key: 'lookback_hours', label: 'strategy.nodes.linkEvaluate.lookbackHours', tip: 'strategy.nodes.linkEvaluate.lookbackHoursTip', strategyName: 'link-evaluate', step: 1 },
      { key: 'max_links_per_run', label: 'strategy.nodes.linkEvaluate.maxLinksPerRun', tip: 'strategy.nodes.linkEvaluate.maxLinksPerRunTip', strategyName: 'link-evaluate', step: 5 },
      { key: 'pending_expire_days', label: 'strategy.nodes.linkEvaluate.pendingExpireDays', tip: 'strategy.nodes.linkEvaluate.pendingExpireDaysTip', strategyName: 'link-evaluate', step: 1 },
    ],
    strategy: 'link-evaluate',
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.linkEvaluate.trigger',
      intervalParam: { key: 'interval_minutes', label: 'strategy.nodes.linkEvaluate.interval', tip: 'strategy.nodes.linkEvaluate.intervalTip', strategyName: 'link-evaluate', step: 60 },
    },
  },
  {
    id: 'link-revalidate',
    name: 'strategy.nodes.linkRevalidate.name',
    description: 'strategy.nodes.linkRevalidate.description',
    llmStrategy: 'link-revalidate',
    strategyParams: [
      { key: 'max_links_per_run', label: 'strategy.nodes.linkRevalidate.maxLinksPerRun', tip: 'strategy.nodes.linkRevalidate.maxLinksPerRunTip', strategyName: 'link-revalidate', step: 1 },
      { key: 'min_link_age_hours', label: 'strategy.nodes.linkRevalidate.minLinkAgeHours', tip: 'strategy.nodes.linkRevalidate.minLinkAgeHoursTip', strategyName: 'link-revalidate', step: 1 },
    ],
    strategy: 'link-revalidate',
    trigger: { type: 'event', label: 'strategy.nodes.linkRevalidate.trigger' },
  },
]

export const THINK_EMERGE_NODES: ProcessingNode[] = [
  {
    id: 'keystone',
    name: 'strategy.nodes.keystone.name',
    description: 'strategy.nodes.keystone.description',
    strategy: 'keystone-enrich',
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.keystone.trigger',
      intervalParam: { key: 'interval_minutes', label: 'strategy.nodes.keystone.interval', tip: 'strategy.nodes.keystone.intervalTip', strategyName: 'keystone-enrich', step: 60 },
    },
  },
  {
    id: 'tag-promote',
    name: 'strategy.nodes.tagPromote.name',
    description: 'strategy.nodes.tagPromote.description',
    llmStrategy: 'tag-define',
    strategy: 'tag-define',
    strategyParams: [
      { key: 'tag_promote_threshold', label: 'strategy.nodes.tagPromote.threshold', tip: 'strategy.nodes.tagPromote.thresholdTip', strategyName: 'metabolism-params', step: 1 },
      { key: 'tag_link_min_strength', label: 'strategy.nodes.tagPromote.minStrength', tip: 'strategy.nodes.tagPromote.minStrengthTip', strategyName: 'metabolism-params', step: 0.05 },
    ],
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.tagPromote.trigger',
      intervalParam: { key: 'tag_promote_interval_minutes', label: 'strategy.nodes.tagPromote.interval', tip: 'strategy.nodes.tagPromote.intervalTip', strategyName: 'metabolism-params', step: 60 },
    },
  },
  {
    id: 'divergent',
    name: 'strategy.nodes.divergent.name',
    description: 'strategy.nodes.divergent.description',
    llmStrategy: 'scan-divergent',
    strategyParams: [
      { key: 'max_candidate_pairs', label: 'strategy.nodes.divergent.maxCandidatePairs', tip: 'strategy.nodes.divergent.maxCandidatePairsTip', strategyName: 'scan-divergent', step: 1 },
      { key: 'min_heat_threshold', label: 'strategy.nodes.divergent.minHeatThreshold', tip: 'strategy.nodes.divergent.minHeatThresholdTip', strategyName: 'scan-divergent', step: 0.01 },
      { key: 'max_active_nodes', label: 'strategy.nodes.divergent.maxActiveNodes', tip: 'strategy.nodes.divergent.maxActiveNodesTip', strategyName: 'scan-divergent', step: 10 },
      { key: 'min_shared_neighbors', label: 'strategy.nodes.divergent.minSharedNeighbors', tip: 'strategy.nodes.divergent.minSharedNeighborsTip', strategyName: 'scan-divergent', step: 1 },
      { key: 'min_confidence', label: 'strategy.nodes.divergent.minConfidence', tip: 'strategy.nodes.divergent.minConfidenceTip', strategyName: 'scan-divergent', step: 0.05 },
    ],
    strategy: 'scan-divergent',
    gates: [{ key: 'divergent_scan', label: 'strategy.nodes.divergent.gateLabel', tip: 'strategy.nodes.divergent.gateTip', default: 500, unit: 'strategy.nodes.divergent.gateUnit' }],
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.divergent.trigger',
      intervalParam: { key: 'interval_minutes', label: 'strategy.nodes.divergent.interval', tip: 'strategy.nodes.divergent.intervalTip', strategyName: 'scan-divergent', step: 1440 },
    },
  },
  {
    id: 'crystal',
    name: 'strategy.nodes.crystal.name',
    description: 'strategy.nodes.crystal.description',
    llmStrategy: 'crystal-emerge',
    strategyParams: [
      { key: 'min_source_nodes', label: 'strategy.nodes.crystal.minSourceNodes', tip: 'strategy.nodes.crystal.minSourceNodesTip', strategyName: 'crystal-emerge', step: 1 },
      { key: 'min_confidence', label: 'strategy.nodes.crystal.minConfidence', tip: 'strategy.nodes.crystal.minConfidenceTip', strategyName: 'crystal-emerge', step: 0.05 },
    ],
    strategy: 'crystal-emerge',
    gates: [{ key: 'crystal_generation', label: 'strategy.nodes.crystal.gateLabel', tip: 'strategy.nodes.crystal.gateTip', default: 200, unit: 'strategy.nodes.crystal.gateUnit' }],
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.crystal.trigger',
      intervalParam: { key: 'interval_minutes', label: 'strategy.nodes.crystal.interval', tip: 'strategy.nodes.crystal.intervalTip', strategyName: 'crystal-emerge', step: 1440 },
    },
  },
  {
    id: 'temporal-crystal',
    name: 'strategy.nodes.temporalCrystal.name',
    description: 'strategy.nodes.temporalCrystal.description',
    llmStrategy: 'temporal-crystal',
    strategyParams: [
      { key: 'max_topics', label: 'strategy.nodes.temporalCrystal.maxTopics', tip: 'strategy.nodes.temporalCrystal.maxTopicsTip', strategyName: 'temporal-crystal', step: 1 },
      { key: 'min_nodes_per_topic', label: 'strategy.nodes.temporalCrystal.minNodesPerTopic', tip: 'strategy.nodes.temporalCrystal.minNodesPerTopicTip', strategyName: 'temporal-crystal', step: 1 },
      { key: 'max_resonance_weeks', label: 'strategy.nodes.temporalCrystal.maxResonanceWeeks', tip: 'strategy.nodes.temporalCrystal.maxResonanceWeeksTip', strategyName: 'temporal-crystal', step: 1 },
    ],
    strategy: 'temporal-crystal',
    gates: [{ key: 'crystal_generation', label: 'strategy.nodes.temporalCrystal.gateLabel', tip: 'strategy.nodes.temporalCrystal.gateTip', default: 200, unit: 'strategy.nodes.temporalCrystal.gateUnit' }],
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.temporalCrystal.trigger',
      intervalParam: { key: 'interval_minutes', label: 'strategy.nodes.temporalCrystal.interval', tip: 'strategy.nodes.temporalCrystal.intervalTip', strategyName: 'temporal-crystal', step: 1440 },
    },
  },
  {
    id: 'profile-synthesize',
    name: 'strategy.nodes.profileSynthesize.name',
    description: 'strategy.nodes.profileSynthesize.description',
    llmStrategy: 'profile-synthesize',
    strategyParams: [
      { key: 'trigger_min_new_crystals', label: 'strategy.nodes.profileSynthesize.triggerCrystals', tip: 'strategy.nodes.profileSynthesize.triggerCrystalsTip', strategyName: 'profile-synthesize', step: 1 },
      { key: 'trigger_min_new_preferences', label: 'strategy.nodes.profileSynthesize.triggerPreferences', tip: 'strategy.nodes.profileSynthesize.triggerPreferencesTip', strategyName: 'profile-synthesize', step: 1 },
      { key: 'trigger_max_days', label: 'strategy.nodes.profileSynthesize.triggerMaxDays', tip: 'strategy.nodes.profileSynthesize.triggerMaxDaysTip', strategyName: 'profile-synthesize', step: 1 },
      { key: 'input_max_tokens', label: 'strategy.nodes.profileSynthesize.inputMaxTokens', tip: 'strategy.nodes.profileSynthesize.inputMaxTokensTip', strategyName: 'profile-synthesize', step: 1000 },
    ],
    special: 'profile-fields',
    strategy: 'profile-synthesize',
    gates: [{ key: 'crystal_generation', label: 'strategy.nodes.profileSynthesize.gateLabel', tip: 'strategy.nodes.profileSynthesize.gateTip', default: 50, unit: 'strategy.nodes.profileSynthesize.gateUnit' }],
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.profileSynthesize.trigger',
      intervalParam: { key: 'interval_minutes', label: 'strategy.nodes.profileSynthesize.interval', tip: 'strategy.nodes.profileSynthesize.intervalTip', strategyName: 'profile-synthesize', step: 60 },
    },
  },
]

export const OUTPUT_NODES: ProcessingNode[] = [
  {
    id: 'prepare',
    name: 'strategy.nodes.prepare.name',
    description: 'strategy.nodes.prepare.description',
    strategyParams: [
      { key: 'max_keystones', label: 'strategy.nodes.prepare.maxKeystones', tip: 'strategy.nodes.prepare.maxKeystonesTip', strategyName: 'prepare-assemble', step: 1 },
      { key: 'max_tags', label: 'strategy.nodes.prepare.maxTags', tip: 'strategy.nodes.prepare.maxTagsTip', strategyName: 'prepare-assemble', step: 5 },
      { key: 'max_crystals_highlighted', label: 'strategy.nodes.prepare.maxCrystalsHighlighted', tip: 'strategy.nodes.prepare.maxCrystalsHighlightedTip', strategyName: 'prepare-assemble', step: 1 },
      { key: 'max_crystals_total', label: 'strategy.nodes.prepare.maxCrystalsTotal', tip: 'strategy.nodes.prepare.maxCrystalsTotalTip', strategyName: 'prepare-assemble', step: 5 },
      { key: 'crystal_snippet_length', label: 'strategy.nodes.prepare.crystalSnippetLength', tip: 'strategy.nodes.prepare.crystalSnippetLengthTip', strategyName: 'prepare-assemble', step: 10 },
      { key: 'max_recent', label: 'strategy.nodes.prepare.maxRecent', tip: 'strategy.nodes.prepare.maxRecentTip', strategyName: 'prepare-assemble', step: 1 },
      { key: 'recent_window_hours', label: 'strategy.nodes.prepare.recentWindowHours', tip: 'strategy.nodes.prepare.recentWindowHoursTip', strategyName: 'prepare-assemble', step: 6 },
    ],
    trigger: { type: 'query', label: 'strategy.nodes.prepare.trigger' },
  },
  {
    id: 'search-weights',
    name: 'strategy.nodes.searchWeights.name',
    description: 'strategy.nodes.searchWeights.description',
    configParams: [
      { key: 'alpha', label: 'strategy.nodes.searchWeights.alpha', tip: 'strategy.nodes.searchWeights.alphaTip', default: 0.3, step: 0.05, section: 'search' },
      { key: 'beta', label: 'strategy.nodes.searchWeights.beta', tip: 'strategy.nodes.searchWeights.betaTip', default: 0.5, step: 0.05, section: 'search' },
      { key: 'gamma', label: 'strategy.nodes.searchWeights.gamma', tip: 'strategy.nodes.searchWeights.gammaTip', default: 0.1, step: 0.05, section: 'search' },
      { key: 'delta', label: 'strategy.nodes.searchWeights.delta', tip: 'strategy.nodes.searchWeights.deltaTip', default: 0.1, step: 0.05, section: 'search' },
    ],
    strategyParams: [
      { key: 'index_max_results', label: 'strategy.nodes.searchWeights.indexMaxResults', tip: 'strategy.nodes.searchWeights.indexMaxResultsTip', strategyName: 'recall-search', step: 5 },
      { key: 'index_snippet_length', label: 'strategy.nodes.searchWeights.indexSnippetLength', tip: 'strategy.nodes.searchWeights.indexSnippetLengthTip', strategyName: 'recall-search', step: 10 },
      { key: 'detail_max_results', label: 'strategy.nodes.searchWeights.detailMaxResults', tip: 'strategy.nodes.searchWeights.detailMaxResultsTip', strategyName: 'recall-search', step: 1 },
      { key: 'detail_max_links_per_node', label: 'strategy.nodes.searchWeights.detailMaxLinks', tip: 'strategy.nodes.searchWeights.detailMaxLinksTip', strategyName: 'recall-search', step: 1 },
    ],
    strategy: 'recall-search',
    special: 'weights',
    gates: [{ key: 'vector_search', label: 'strategy.nodes.searchWeights.vectorGateLabel', tip: 'strategy.nodes.searchWeights.vectorGateTip', default: 50, unit: 'strategy.nodes.searchWeights.vectorGateUnit' }],
    trigger: { type: 'query', label: 'strategy.nodes.searchWeights.trigger' },
  },
  {
    id: 'maturity',
    name: 'strategy.nodes.maturity.name',
    description: 'strategy.nodes.maturity.description',
    strategyParams: [
      { key: 'heat_weight', label: 'strategy.nodes.maturity.heatWeight', tip: 'strategy.nodes.maturity.heatWeightTip', strategyName: 'recall-rank', step: 0.05 },
      { key: 'refinement_weight', label: 'strategy.nodes.maturity.refinementWeight', tip: 'strategy.nodes.maturity.refinementWeightTip', strategyName: 'recall-rank', step: 0.05 },
      { key: 'connectivity_weight', label: 'strategy.nodes.maturity.connectivityWeight', tip: 'strategy.nodes.maturity.connectivityWeightTip', strategyName: 'recall-rank', step: 0.05 },
      { key: 'independence_weight', label: 'strategy.nodes.maturity.independenceWeight', tip: 'strategy.nodes.maturity.independenceWeightTip', strategyName: 'recall-rank', step: 0.05 },
    ],
    trigger: { type: 'query', label: 'strategy.nodes.maturity.trigger' },
  },
  {
    id: 'graph-expansion',
    name: 'strategy.nodes.graphExpansion.name',
    description: 'strategy.nodes.graphExpansion.description',
    strategyParams: [
      { key: 'expansion_decay', label: 'strategy.nodes.graphExpansion.expansionDecay', tip: 'strategy.nodes.graphExpansion.expansionDecayTip', strategyName: 'recall-rank', step: 0.05 },
      { key: 'expansion_max_nodes', label: 'strategy.nodes.graphExpansion.expansionMaxNodes', tip: 'strategy.nodes.graphExpansion.expansionMaxNodesTip', strategyName: 'recall-rank', step: 1 },
      { key: 'expansion_min_strength', label: 'strategy.nodes.graphExpansion.expansionMinStrength', tip: 'strategy.nodes.graphExpansion.expansionMinStrengthTip', strategyName: 'recall-rank', step: 0.05 },
    ],
    gates: [
      { key: 'graph_expansion_nodes', label: 'strategy.nodes.graphExpansion.nodeGateLabel', tip: 'strategy.nodes.graphExpansion.nodeGateTip', default: 100, unit: 'strategy.nodes.graphExpansion.nodeGateUnit', metric: 'node_count' },
      { key: 'graph_expansion_links', label: 'strategy.nodes.graphExpansion.linkGateLabel', tip: 'strategy.nodes.graphExpansion.linkGateTip', default: 50, unit: 'strategy.nodes.graphExpansion.linkGateUnit', metric: 'link_count' },
    ],
    trigger: { type: 'query', label: 'strategy.nodes.graphExpansion.trigger' },
  },
  {
    id: 'rerank',
    name: 'strategy.nodes.rerank.name',
    description: 'strategy.nodes.rerank.description',
    strategy: 'recall-rank',
    trigger: { type: 'query', label: 'strategy.nodes.rerank.trigger' },
  },
]

export const EVOLUTION_NODES: ProcessingNode[] = [
  {
    id: 'learning2',
    name: 'strategy.nodes.learning2.name',
    description: 'strategy.nodes.learning2.description',
    llmStrategy: 'evolution-learning2',
    strategy: 'evolution-learning2',
    locked: true,
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.learning2.trigger',
      intervalParam: { key: 'interval_minutes', label: 'strategy.nodes.learning2.interval', tip: 'strategy.nodes.learning2.intervalTip', strategyName: 'evolution-learning2', step: 1440 },
    },
  },
  {
    id: 'learning3',
    name: 'strategy.nodes.learning3.name',
    description: 'strategy.nodes.learning3.description',
    llmStrategy: 'evolution-learning3',
    strategy: 'evolution-learning3',
    locked: true,
    trigger: {
      type: 'interval',
      label: 'strategy.nodes.learning3.trigger',
      intervalParam: { key: 'interval_minutes', label: 'strategy.nodes.learning3.interval', tip: 'strategy.nodes.learning3.intervalTip', strategyName: 'evolution-learning3', step: 1440 },
    },
  },
]

export const NODES_BY_GROUP: Record<GroupTab, ProcessingNode[]> = {
  memory: MEMORY_NODES,
  'think-associate': THINK_ASSOCIATE_NODES,
  'think-emerge': THINK_EMERGE_NODES,
  output: OUTPUT_NODES,
  evolution: EVOLUTION_NODES,
}

// ============================================================
// 触发类型样式
// ============================================================

export const TRIGGER_STYLES: Record<string, string> = {
  realtime: 'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
  interval: 'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
  query: 'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
  event: 'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
}

export const TRIGGER_ICONS: Record<string, ReactNode> = {
  realtime: <Zap size={9} />,
  interval: <Clock size={9} />,
  query: <Zap size={9} />,
  event: <Zap size={9} />,
}

export const TRIGGER_LABEL_KEYS: Record<string, string> = {
  realtime: 'strategy.triggerType.realtime',
  interval: 'strategy.triggerType.interval',
  query: 'strategy.triggerType.query',
  event: 'strategy.triggerType.event',
}

// ============================================================
