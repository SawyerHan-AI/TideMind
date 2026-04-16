import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useFormatters } from '../../hooks/useFormatters'
import { motion } from 'framer-motion'
import { Check, Clock, Loader2, Save, CheckCircle, RotateCcw, Lock, ChevronDown, ChevronRight, History, Database, Link2, Sparkles, Search, Brain, Zap, Settings2, Cpu, Timer, Plus, X } from 'lucide-react'
import { useIPC } from '../../hooks/useIPC'
import { NumberField, SliderField } from './shared'
import { InfoTip } from '../InfoTip'
import { semantic } from '../../lib/tokens'

// ============================================================
// 按认知功能分组的内部策略管理 — Master-Detail 布局
// ============================================================

type GroupTab = 'memory' | 'think-associate' | 'think-emerge' | 'output' | 'evolution'

interface ConfigParam {
  key: string
  label: string
  tip: string
  default: number
  step?: number
  section: string
  unit?: string
}

interface StrategyParam {
  key: string
  label: string
  tip: string
  strategyName: string
  step?: number
}

interface GateParam {
  key: string
  label: string
  tip: string
  default: number
  unit?: string
  metric?: 'node_count' | 'link_count'
}

interface TriggerConfig {
  type: 'realtime' | 'interval' | 'query' | 'event'
  label: string
  intervalParam?: StrategyParam
}

interface ProcessingNode {
  id: string
  name: string
  description: string
  configParams?: ConfigParam[]
  strategyParams?: StrategyParam[]
  gates?: GateParam[]
  llmStrategy?: string
  strategy?: string
  special?: string
  locked?: boolean
  trigger: TriggerConfig
}

// ============================================================
// 参数分类规则 — 按参数名自动归入板块
// ============================================================

const TRIGGER_PARAM_KEYS = new Set([
  'interval_minutes', 'lookback_hours', 'pending_expire_days',
  'min_link_age_hours', 'decay_interval_minutes', 'tag_promote_interval_minutes',
  'contradiction_lookback_hours',
])

const LLM_PARAM_KEYS = new Set([
  'llm_tier', 'thinking', 'thinking_budget',
  'max_tokens', 'content_budget', 'max_content_per_node',
  'neighbor_preview_length',
  'max_content_length',
])

function classifyParam(key: string): 'trigger' | 'llm' | 'param' {
  if (TRIGGER_PARAM_KEYS.has(key)) return 'trigger'
  if (LLM_PARAM_KEYS.has(key)) return 'llm'
  return 'param'
}

// ============================================================
// 分组配置
// ============================================================

const GROUP_DESC_KEYS: Record<GroupTab, string> = {
  memory: 'strategy.groupDesc.memory',
  'think-associate': 'strategy.groupDesc.thinkAssociate',
  'think-emerge': 'strategy.groupDesc.thinkEmerge',
  output: 'strategy.groupDesc.output',
  evolution: 'strategy.groupDesc.evolution',
}

// ============================================================
// 节点定义 — 按认知功能分组
// ============================================================

const MEMORY_NODES: ProcessingNode[] = [
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

const THINK_ASSOCIATE_NODES: ProcessingNode[] = [
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

const THINK_EMERGE_NODES: ProcessingNode[] = [
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

const OUTPUT_NODES: ProcessingNode[] = [
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

const EVOLUTION_NODES: ProcessingNode[] = [
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

const NODES_BY_GROUP: Record<GroupTab, ProcessingNode[]> = {
  memory: MEMORY_NODES,
  'think-associate': THINK_ASSOCIATE_NODES,
  'think-emerge': THINK_EMERGE_NODES,
  output: OUTPUT_NODES,
  evolution: EVOLUTION_NODES,
}

// ============================================================
// 触发类型样式
// ============================================================

const TRIGGER_STYLES: Record<string, string> = {
  realtime: 'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
  interval: 'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
  query: 'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
  event: 'bg-indigo-400/10 border border-indigo-400/25 text-indigo-300',
}

const TRIGGER_ICONS: Record<string, React.ReactNode> = {
  realtime: <Zap size={9} />,
  interval: <Clock size={9} />,
  query: <Zap size={9} />,
  event: <Zap size={9} />,
}

const TRIGGER_LABEL_KEYS: Record<string, string> = {
  realtime: 'strategy.triggerType.realtime',
  interval: 'strategy.triggerType.interval',
  query: 'strategy.triggerType.query',
  event: 'strategy.triggerType.event',
}

// ============================================================
// 主组件
// ============================================================

export function InternalStrategy() {
  const { t } = useTranslation('settings')
  const [activeTab, setActiveTab] = useState<GroupTab>('memory')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const nodes = NODES_BY_GROUP[activeTab]

  // Tab 切换时选中第一个节点
  useEffect(() => {
    setSelectedNodeId(nodes[0]?.id ?? null)
  }, [activeTab])

  const selectedNode = nodes.find(n => n.id === selectedNodeId) ?? null

  const TABS: Array<{ key: GroupTab; labelKey: string; icon: React.ReactNode }> = [
    { key: 'memory', labelKey: 'strategy.groups.memory', icon: <Database size={12} /> },
    { key: 'think-associate', labelKey: 'strategy.groups.thinkAssociate', icon: <Link2 size={12} /> },
    { key: 'think-emerge', labelKey: 'strategy.groups.thinkEmerge', icon: <Sparkles size={12} /> },
    { key: 'output', labelKey: 'strategy.groups.output', icon: <Search size={12} /> },
    { key: 'evolution', labelKey: 'strategy.groups.evolution', icon: <Brain size={12} /> },
  ]

  return (
    <div className="space-y-4">
      {/* Tab 导航 */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {TABS.map(item => (
          <button
            key={item.key}
            onClick={() => setActiveTab(item.key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-all duration-150 whitespace-nowrap ${
              activeTab === item.key
                ? 'text-white'
                : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.05]'
            }`}
            style={activeTab === item.key ? { background: 'var(--selected-bg)', boxShadow: 'var(--selected-shadow)' } : {}}
          >
            <span style={activeTab === item.key ? {} : { opacity: 0.5 }}>{item.icon}</span>
            <span>{t(item.labelKey)}</span>
          </button>
        ))}
      </div>

      {/* Master-Detail 布局 */}
      <motion.div
        key={activeTab}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="flex gap-4"
      >
        {/* 左侧列表 */}
        <div className="w-52 flex-shrink-0">
          <div className="glass-card rounded-xl overflow-hidden">
            {nodes.map(node => (
              <button
                key={node.id}
                onClick={() => setSelectedNodeId(node.id)}
                className={`w-full text-left px-3 py-2.5 border-b border-white/5 last:border-b-0 transition-colors ${
                  selectedNodeId === node.id
                    ? 'bg-white/[0.06]'
                    : 'hover:bg-white/[0.03]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-medium ${selectedNodeId === node.id ? 'text-gray-100' : 'text-gray-400'}`}>
                    {t(node.name)}
                  </span>
                  <div className="flex items-center gap-1">
                    {node.llmStrategy && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-400/10 border border-indigo-400/25 text-indigo-300">
                        LLM
                      </span>
                    )}
                    <span className={`text-[9px] px-1 py-0.5 rounded ${TRIGGER_STYLES[node.trigger.type]}`}>
                      {t(TRIGGER_LABEL_KEYS[node.trigger.type])}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 右侧详情 */}
        <div className="flex-1 min-w-0">
          {selectedNode ? (
            <NodeDetailPanel node={selectedNode} />
          ) : (
            <div className="glass-card rounded-xl p-8 text-center text-gray-500 text-sm">
              {t('strategy.selectNodeHint')}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )
}

// ============================================================
// NodeDetailPanel — 右侧详情面板
// ============================================================

function NodeDetailPanel({ node }: { node: ProcessingNode }) {
  const { t } = useTranslation('settings')
  const { data: config } = useIPC(() => window.api.config.get())
  const { data: gateStatus } = useIPC(() => window.api.stats.gates())
  const [localConfig, setLocalConfig] = useState<Record<string, Record<string, number>>>({})
  const [saved, setSaved] = useState(false)
  const configInitialized = useRef(false)

  useEffect(() => {
    if (!config) return
    const c = config as any
    setLocalConfig({
      metabolism: { ...c.metabolism },
      search: { ...c.search },
      gates: { ...c.gates },
    })
    // 延迟标记初始化完成，避免初始赋值触发自动保存
    setTimeout(() => { configInitialized.current = true }, 100)
  }, [config])

  const getVal = (section: string, key: string, fallback: number): number =>
    localConfig[section]?.[key] ?? fallback

  const setVal = (section: string, key: string, v: number) => {
    setLocalConfig(prev => ({
      ...prev,
      [section]: { ...prev[section], [key]: v },
    }))
  }

  // debounce 自动保存 config 参数
  useEffect(() => {
    if (!configInitialized.current) return
    const timer = setTimeout(async () => {
      await window.api.config.update(localConfig)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }, 500)
    return () => clearTimeout(timer)
  }, [localConfig])

  // 分类策略参数
  const triggerStrategyParams = (node.strategyParams ?? []).filter(p => classifyParam(p.key) === 'trigger')
  const llmStrategyParams = (node.strategyParams ?? []).filter(p => classifyParam(p.key) === 'llm')
  const bizStrategyParams = (node.strategyParams ?? []).filter(p => classifyParam(p.key) === 'param')

  // 判断各板块是否有内容
  const hasTriggerSection = (node.gates && node.gates.length > 0) || node.trigger.intervalParam || triggerStrategyParams.length > 0
  const hasParamSection = (node.configParams && node.configParams.length > 0) || bizStrategyParams.length > 0
  const hasLLMSection = node.llmStrategy || node.strategy || llmStrategyParams.length > 0

  // 门控激体激活状态
  const allGatesActive = node.gates && gateStatus ? node.gates.every(g => {
    const current = (g.metric === 'link_count' ? gateStatus.link_count : gateStatus.node_count) ?? 0
    return current >= getVal('gates', g.key, g.default)
  }) : false

  const hasConfigEdits = node.configParams && node.configParams.length > 0

  return (
    <motion.div
      key={node.id}
      initial={{ opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.15 }}
      className="space-y-4"
    >
      {/* 板块 1: 标题区 */}
      <div className="glass-card rounded-xl px-5 py-4">
        <div className="flex items-center gap-2.5">
          <h2 className="text-base font-medium text-gray-100">{t(node.name)}</h2>
          <span className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5 ${TRIGGER_STYLES[node.trigger.type]}`}>
            {TRIGGER_ICONS[node.trigger.type]}
            {t(node.trigger.label)}
          </span>
          {node.locked && (
            <span className="text-[10px] text-amber-400/70 bg-amber-500/10 px-1.5 py-0.5 rounded flex items-center gap-1">
              <Lock size={9} /> {t('strategy.noAutoEvolution')}
            </span>
          )}
          {node.gates && node.gates.length > 0 && gateStatus && (
            allGatesActive ? (
              <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded flex items-center gap-1">
                <Check size={9} /> {t('strategy.activated')}
              </span>
            ) : (
              <span className="text-[10px] text-gray-500 bg-white/5 px-1.5 py-0.5 rounded flex items-center gap-1">
                <Clock size={9} /> {t('strategy.notActivated')}
              </span>
            )
          )}
        </div>
        <p className="text-[12px] text-gray-500 mt-2 leading-relaxed">{t(node.description)}</p>
      </div>

      {/* 板块 2: 触发配置 */}
      {hasTriggerSection && (
        <SectionCard icon={<Timer size={13} />} title={t('strategy.triggerConfig')}>
          {/* 门控阈值 */}
          {node.gates?.map(g => (
            <div key={g.key} className="mb-1">
              <NumberField
                label={t(g.label)}
                tip={t(g.tip)}
                value={getVal('gates', g.key, g.default)}
                onChange={v => setVal('gates', g.key, v)}
                step={10}
                unit={g.unit ? t(g.unit) : undefined}
              />
              {gateStatus && <GateProgress gateKey={g.key} gateStatus={gateStatus} getVal={getVal} fallback={g.default} metric={g.metric} />}
            </div>
          ))}

          {/* 执行间隔 */}
          {node.trigger.intervalParam && (
            <EditableStrategyParams params={[node.trigger.intervalParam]} />
          )}

          {/* 其他触发类参数 */}
          {triggerStrategyParams.length > 0 && (
            <EditableStrategyParams params={triggerStrategyParams} />
          )}
        </SectionCard>
      )}

      {/* 板块 3: 参数配置 */}
      {hasParamSection && (
        <SectionCard icon={<Settings2 size={13} />} title={t('strategy.paramConfig')}>
          {/* 搜索权重可视化 */}
          {node.special === 'weights' && <WeightVisualization getVal={getVal} />}

          {/* 画像字段配置 */}
          {node.special === 'profile-fields' && <ProfileFieldsEditor strategyName="profile-synthesize" />}

          {/* config.toml 参数 */}
          {node.configParams?.map(p =>
            node.special === 'weights' ? (
              <SliderField
                key={p.key}
                label={t(p.label)}
                tip={t(p.tip)}
                value={getVal(p.section, p.key, p.default)}
                onChange={v => setVal(p.section, p.key, v)}
                min={0}
                max={1}
                step={p.step ?? 0.05}
              />
            ) : (
              <NumberField
                key={p.key}
                label={t(p.label)}
                tip={t(p.tip)}
                value={getVal(p.section, p.key, p.default)}
                onChange={v => setVal(p.section, p.key, v)}
                step={p.step ?? 0.01}
                unit={p.unit ? t(p.unit) : undefined}
              />
            ),
          )}

          {/* 策略文件中的业务参数 */}
          {bizStrategyParams.length > 0 && (
            <EditableStrategyParams params={bizStrategyParams} />
          )}

          {/* 自动保存提示 */}
          {saved && (
            <div className="flex items-center justify-end gap-1.5 pt-2 text-xs text-green-400">
              <Check size={12} />
              {t('strategy.saved')}
            </div>
          )}
        </SectionCard>
      )}

      {/* 板块 4: LLM 配置 */}
      {hasLLMSection && (
        <SectionCard icon={<Cpu size={13} />} title={t('strategy.llmConfig')}>
          {/* 模型选择 + 思考配置 */}
          {node.llmStrategy && (
            <LLMConfigSection strategyName={node.llmStrategy} />
          )}

          {/* LLM 相关的策略参数（content_budget 等） */}
          {llmStrategyParams.length > 0 && (
            <EditableStrategyParams params={llmStrategyParams} />
          )}

          {/* System Prompt 编辑器 */}
          {node.strategy && (
            <div className="pt-2 border-t border-white/5 mt-3">
              <EmbeddedStrategyPanel name={node.strategy} type="system" locked={node.locked} />
            </div>
          )}

          {/* User Prompt 编辑器 */}
          {node.strategy && (
            <div className="pt-2 border-t border-white/5 mt-3">
              <EmbeddedStrategyPanel name={node.strategy} type="user" />
            </div>
          )}
        </SectionCard>
      )}
    </motion.div>
  )
}

// ============================================================
// SectionCard — 板块容器
// ============================================================

function SectionCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="glass-card rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-white/5">
        <span className="text-gray-500">{icon}</span>
        <span className="text-xs font-medium text-gray-300">{title}</span>
      </div>
      <div className="px-5 py-3 space-y-2">
        {children}
      </div>
    </div>
  )
}

// ============================================================
// GateProgress: 门控进度条
// ============================================================

function GateProgress({ gateKey, gateStatus, getVal, fallback, metric }: {
  gateKey: string
  gateStatus: any
  getVal: (s: string, k: string, f: number) => number
  fallback: number
  metric?: 'node_count' | 'link_count'
}) {
  const threshold = getVal('gates', gateKey, fallback)
  const current = (metric === 'link_count' ? gateStatus.link_count : gateStatus.node_count) ?? 0
  const progress = threshold > 0 ? Math.min(current / threshold, 1) : 1
  const active = progress >= 1

  return (
    <div className="w-full h-1.5 rounded-full bg-white/5 overflow-hidden mt-1.5">
      <div
        className={`h-full rounded-full transition-all duration-700 ${
          active ? 'bg-emerald-500' : progress >= 0.5 ? 'bg-amber-500/70' : 'bg-gray-600'
        }`}
        style={{ width: `${progress * 100}%` }}
      />
    </div>
  )
}

// ============================================================
// LLMConfigSection: 策略级 LLM 模型 + 思考配置
// ============================================================

const TIER_OPTION_KEYS = [
  { value: 'light', labelKey: 'strategy.tierLight' },
  { value: 'standard', labelKey: 'strategy.tierStandard' },
  { value: 'heavy', labelKey: 'strategy.tierHeavy' },
]

function LLMConfigSection({ strategyName }: { strategyName: string }) {
  const { t } = useTranslation('settings')
  const [values, setValues] = useState<Record<string, number | string | boolean>>({})
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.config.strategyParams(strategyName).then(params => {
      if (!cancelled) setValues(params)
    })
    return () => { cancelled = true }
  }, [strategyName])

  const handleChange = async (key: string, newValue: string) => {
    const parsed = newValue === 'true' ? true : newValue === 'false' ? false : isNaN(Number(newValue)) ? newValue : Number(newValue)
    setValues(prev => ({ ...prev, [key]: parsed }))
    setSaving(key)
    try {
      await window.api.config.strategyParamUpdate(strategyName, key, newValue)
    } catch (err) {
      console.error('LLM config update failed:', err)
    }
    setSaving(null)
  }

  const tier = String(values.llm_tier ?? 'standard')
  const thinkingOn = values.thinking === true
  const budget = Number(values.thinking_budget ?? 0)

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-indigo-400/5 border border-indigo-400/10 rounded-lg text-xs">
      <span className="text-indigo-400/70 text-[10px] font-medium shrink-0">LLM</span>

      {/* 模型档位 */}
      <div className="flex items-center gap-1.5">
        <span className="text-gray-500 text-[10px]">{t('strategy.modelLabel')}</span>
        <select
          value={tier}
          onChange={e => handleChange('llm_tier', e.target.value)}
          className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[11px] text-gray-200 focus:outline-none focus:border-indigo-400/50 cursor-pointer"
        >
          {TIER_OPTION_KEYS.map(o => (
            <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
          ))}
        </select>
        {saving === 'llm_tier' && <Loader2 size={9} className="animate-spin text-indigo-400" />}
      </div>

      {/* 思考开关 */}
      <div className="flex items-center gap-1.5">
        <span className="text-gray-500 text-[10px]">{t('strategy.thinkingLabel')}</span>
        <button
          onClick={() => handleChange('thinking', thinkingOn ? 'false' : 'true')}
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
            thinkingOn
              ? 'bg-indigo-400/20 text-indigo-300 border border-indigo-400/30'
              : 'bg-white/5 text-gray-500 border border-white/10'
          }`}
        >
          {thinkingOn ? t('strategy.thinkingOn') : t('strategy.thinkingOff')}
        </button>
        {saving === 'thinking' && <Loader2 size={9} className="animate-spin text-indigo-400" />}
      </div>

      {/* 思考预算 */}
      {thinkingOn && (
        <div className="flex items-center gap-1.5">
          <span className="text-gray-500 text-[10px]">{t('strategy.budgetLabel')}</span>
          <input
            type="number"
            value={budget}
            step={512}
            min={256}
            onChange={e => handleChange('thinking_budget', e.target.value)}
            className="w-16 px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[11px] text-gray-200 text-right font-mono focus:outline-none focus:border-indigo-400/50"
          />
          <span className="text-gray-600 text-[10px]">tokens</span>
          {saving === 'thinking_budget' && <Loader2 size={9} className="animate-spin text-indigo-400" />}
        </div>
      )}
    </div>
  )
}

// ============================================================
// EditableStrategyParams: 策略文件参数（可编辑）
// ============================================================

function EditableStrategyParams({ params }: { params: StrategyParam[] }) {
  const { t } = useTranslation('settings')
  const strategyNames = [...new Set(params.map(p => p.strategyName))]
  const [values, setValues] = useState<Record<string, Record<string, number | string | boolean>>>({})
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all(
      strategyNames.map(async name => {
        const p = await window.api.config.strategyParams(name)
        return [name, p] as const
      }),
    ).then(results => {
      if (cancelled) return
      const map: Record<string, Record<string, number | string | boolean>> = {}
      for (const [name, p] of results) map[name] = p
      setValues(map)
    })
    return () => { cancelled = true }
  }, [strategyNames.join(',')])

  const handleChange = async (strategyName: string, key: string, newValue: string) => {
    setValues(prev => ({
      ...prev,
      [strategyName]: { ...prev[strategyName], [key]: isNaN(Number(newValue)) ? newValue : Number(newValue) },
    }))
    setSaving(key)
    try {
      await window.api.config.strategyParamUpdate(strategyName, key, newValue)
    } catch (err) {
      console.error('Strategy param update failed:', err)
    }
    setSaving(null)
  }

  return (
    <>
      {params.map(p => {
        const val = values[p.strategyName]?.[p.key]
        return (
          <div key={`${p.strategyName}-${p.key}`} className="flex items-center gap-3">
            <div className="flex-1">
              <label className="flex items-center text-xs text-gray-300">
                {t(p.label)}
                <InfoTip content={t(p.tip)} />
                {saving === p.key && <Loader2 size={10} className="ml-1 animate-spin text-indigo-400" />}
              </label>
            </div>
            <input
              type="number"
              value={val !== undefined ? String(val) : ''}
              step={p.step ?? 1}
              onChange={e => handleChange(p.strategyName, p.key, e.target.value)}
              className="w-24 px-2 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 text-right font-mono focus:outline-none focus:border-indigo-400/50"
            />
          </div>
        )
      })}
    </>
  )
}

// ============================================================
// WeightVisualization
// ============================================================

function WeightVisualization({ getVal }: { getVal: (s: string, k: string, f: number) => number }) {
  const { t } = useTranslation('settings')
  const weights = [
    { label: 'BM25 (\u03b1)', value: getVal('search', 'alpha', 0.3), color: semantic.blue },
    { label: t('strategy.nodes.searchWeights.beta'), value: getVal('search', 'beta', 0.5), color: semantic.purple },
    { label: t('strategy.nodes.searchWeights.gamma'), value: getVal('search', 'gamma', 0.1), color: semantic.amber },
    { label: t('strategy.nodes.searchWeights.delta'), value: getVal('search', 'delta', 0.1), color: semantic.teal },
  ]
  const total = weights.reduce((s, w) => s + w.value, 0)

  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-gray-400">{t('strategy.weightDistribution')}</span>
        <span className="text-[10px] text-gray-500">({t('strategy.weightTotal', { total: total.toFixed(2) })})</span>
      </div>
      <div className="flex h-6 rounded-lg overflow-hidden border border-white/5">
        {weights.map(w => (
          <div
            key={w.label}
            style={{
              width: total > 0 ? `${(w.value / total) * 100}%` : '25%',
              backgroundColor: w.color,
              minWidth: w.value > 0 ? '2px' : 0,
            }}
            className="transition-all duration-300 flex items-center justify-center"
          >
            {w.value / total > 0.15 && (
              <span className="text-[9px] text-white font-medium truncate px-1">{w.label}</span>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-3 mt-2">
        {weights.map(w => (
          <div key={w.label} className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: w.color }} />
            <span className="text-[10px] text-gray-500">{w.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ============================================================
// ProfileFieldsEditor
// ============================================================

interface ProfileField {
  name: string
  description: string
}

function ProfileFieldsEditor({ strategyName }: { strategyName: string }) {
  const { t } = useTranslation('settings')
  const [fields, setFields] = useState<ProfileField[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestFields = useRef<ProfileField[]>([])

  useEffect(() => {
    let cancelled = false
    window.api.config.strategyParams(strategyName).then(params => {
      if (cancelled) return
      try {
        const raw = params.profile_fields
        if (typeof raw === 'string') {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            setFields(parsed)
            latestFields.current = parsed
          }
        }
      } catch { /* use empty */ }
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [strategyName])

  // 组件卸载时 flush 未保存的变更
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        // 同步触发最后一次保存（fire-and-forget）
        window.api.config.strategyParamUpdate(
          strategyName,
          'profile_fields',
          JSON.stringify(latestFields.current),
        ).catch(err => console.error('Flush save failed:', err))
      }
    }
  }, [strategyName])

  const persist = async (updated: ProfileField[]) => {
    setSaving(true)
    try {
      await window.api.config.strategyParamUpdate(strategyName, 'profile_fields', JSON.stringify(updated))
    } catch (err) {
      console.error('Failed to save profile fields:', err)
    }
    setSaving(false)
  }

  /** 延迟保存：500ms 内连续变更只写一次 */
  const scheduleSave = (updated: ProfileField[]) => {
    latestFields.current = updated
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      persist(latestFields.current)
      saveTimer.current = null
    }, 500)
  }

  const updateField = (index: number, key: keyof ProfileField, value: string) => {
    const updated = [...fields]
    updated[index] = { ...updated[index], [key]: value }
    setFields(updated)
    scheduleSave(updated)
  }

  const addField = () => {
    const updated = [...fields, { name: '', description: '' }]
    setFields(updated)
    scheduleSave(updated)
  }

  const removeField = (index: number) => {
    const updated = fields.filter((_, i) => i !== index)
    setFields(updated)
    scheduleSave(updated)
  }

  if (!loaded) return null

  return (
    <div className="mb-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400">{t('strategy.nodes.profileSynthesize.fieldsTitle')}</span>
        {saving && <Loader2 size={10} className="animate-spin text-indigo-400" />}
      </div>
      {fields.map((field, i) => (
        <div key={i} className="flex items-start gap-2">
          <input
            type="text"
            value={field.name}
            placeholder={t('strategy.nodes.profileSynthesize.fieldName')}
            onChange={e => updateField(i, 'name', e.target.value)}
            className="w-28 px-2 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 font-mono focus:outline-none focus:border-indigo-400/50"
          />
          <input
            type="text"
            value={field.description}
            placeholder={t('strategy.nodes.profileSynthesize.fieldDesc')}
            onChange={e => updateField(i, 'description', e.target.value)}
            className="flex-1 px-2 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 focus:outline-none focus:border-indigo-400/50"
          />
          <button
            onClick={() => removeField(i)}
            className="p-1.5 text-gray-500 hover:text-red-400 transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        onClick={addField}
        className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
      >
        <Plus size={12} />
        {t('strategy.nodes.profileSynthesize.addField')}
      </button>
    </div>
  )
}

// ============================================================
// EmbeddedStrategyPanel
// ============================================================

interface StrategyVersion {
  version: number
  content: string
  change_reason: string | null
  changed_by: string
  created: string
}

function extractTemplateParams(text: string): string[] {
  const matches = text.matchAll(/\{\{(\w+)\}\}/g)
  return [...new Set([...matches].map(m => m[1]))]
}

function EmbeddedStrategyPanel({ name, type = 'system', locked }: { name: string; type?: 'system' | 'user'; locked?: boolean }) {
  const { t } = useTranslation('settings')
  const { formatShortDate } = useFormatters()
  const isUser = type === 'user'
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [showReason, setShowReason] = useState(false)
  const [reason, setReason] = useState('')
  const [versions, setVersions] = useState<StrategyVersion[]>([])
  const [selectedVersion, setSelectedVersion] = useState<StrategyVersion | null>(null)
  const [showVersions, setShowVersions] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const api = window.api.config

  const loadContent = useCallback(async () => {
    const c = isUser ? await api.userPromptContent(name) : await api.strategyContent(name)
    setContent(c)
    setOriginalContent(c)
  }, [name, isUser])

  const loadVersions = useCallback(async () => {
    try {
      const v = isUser ? await api.userPromptVersions(name) : await api.strategyVersions(name)
      setVersions(v as StrategyVersion[])
    } catch { setVersions([]) }
  }, [name, isUser])

  useEffect(() => {
    setLoaded(false)
    Promise.all([loadContent(), loadVersions()]).then(() => setLoaded(true)).catch(() => setLoaded(true))
    setSelectedVersion(null)
    setPromptExpanded(false)
  }, [name, isUser])

  const hasChanges = content !== originalContent

  const handleSave = async () => {
    if (showReason) {
      setSaving(true)
      if (isUser) {
        await api.userPromptUpdate(name, content, reason || undefined)
      } else {
        await api.strategyUpdate(name, content, reason || undefined)
      }
      setSaving(false)
      setSaved(true)
      setShowReason(false)
      setReason('')
      setOriginalContent(content)
      loadVersions()
      setTimeout(() => setSaved(false), 2000)
    } else {
      setShowReason(true)
    }
  }

  const handleRollback = async (version: number) => {
    try {
      if (isUser) {
        await api.userPromptRollback(name, version)
      } else {
        await api.strategyRollback(name, version)
      }
      await loadContent()
      await loadVersions()
      setSelectedVersion(null)
    } catch (err) { console.error('Rollback failed:', err) }
  }

  // User Prompt: 文件不存在且无版本历史时隐藏面板
  if (isUser && loaded && !content && versions.length === 0) return null

  const displayText = selectedVersion
    ? (selectedVersion.content || t('strategy.contentNotRecorded'))
    : content
  const templateParams = isUser ? extractTemplateParams(displayText) : []
  const label = isUser ? 'User Prompt' : 'System Prompt'

  return (
    <div className="space-y-2">
      {/* Prompt 折叠头 */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setPromptExpanded(!promptExpanded)}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
        >
          {promptExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {label}: {name}
          {locked && !isUser && <span className="text-[10px] text-amber-400/70 ml-1">{t('strategy.autoEvolutionManaged')}</span>}
        </button>
        <button
          onClick={() => { setShowVersions(!showVersions); if (!showVersions) { loadVersions(); setPromptExpanded(true) } }}
          className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors ${
            showVersions ? 'text-indigo-400 bg-indigo-400/10' : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          <History size={11} />
          {t('strategy.versionHistory')}
        </button>
      </div>

      {promptExpanded && (
        <div className="flex gap-3">
          <div className="flex-1 min-w-0">
            <textarea
              value={displayText}
              onChange={e => { if (!selectedVersion) setContent(e.target.value) }}
              readOnly={!!selectedVersion}
              rows={12}
              placeholder={isUser ? '输入 User Prompt 模板，使用 {{变量名}} 作为动态参数占位符' : undefined}
              className={`w-full px-4 py-3 bg-white/5 border rounded-xl text-sm text-gray-200 font-mono leading-relaxed resize-y focus:outline-none ${
                selectedVersion ? 'border-amber-500/30 bg-amber-500/5' : 'border-white/10 focus:border-indigo-400/50'
              }`}
            />

            {/* User Prompt 参数标签 */}
            {isUser && templateParams.length > 0 && (
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                <span className="text-[10px] text-gray-500">{t('strategy.params')}</span>
                {templateParams.map(p => (
                  <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-400/10 text-indigo-400 font-mono">
                    {`{{${p}}}`}
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between mt-2">
              {selectedVersion ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-amber-400">{t('strategy.previewVersion', { version: selectedVersion.version })}</span>
                  <button onClick={() => setSelectedVersion(null)} className="text-[11px] text-gray-400 hover:text-white transition-colors">{t('strategy.returnToEdit')}</button>
                </div>
              ) : showReason ? (
                <div className="flex items-center gap-2 flex-1 mr-3">
                  <input value={reason} onChange={e => setReason(e.target.value)} placeholder={t('strategy.changeReason')}
                    className="flex-1 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-200 focus:outline-none focus:border-indigo-400/50"
                    autoFocus onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setShowReason(false); setReason('') } }} />
                </div>
              ) : <div />}
              <div className="flex items-center gap-2">
                {selectedVersion && (
                  <button onClick={() => handleRollback(selectedVersion.version)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg transition-colors">
                    <RotateCcw size={12} /> {t('strategy.rollbackToVersion')}
                  </button>
                )}
                {!selectedVersion && (
                  <button onClick={handleSave} disabled={saving || (!hasChanges && !showReason)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50">
                    {saving ? <Loader2 size={12} className="animate-spin" /> : saved ? <CheckCircle size={12} /> : <Save size={12} />}
                    {saved ? t('strategy.saved') : showReason ? t('strategy.confirmSave') : t('strategy.save')}
                  </button>
                )}
              </div>
            </div>
          </div>

          {showVersions && (
            <div className="w-48 flex-shrink-0 overflow-y-auto max-h-80 border-l border-white/5 pl-3">
              <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wider mb-2">{t('strategy.versionHistory')}</div>
              {versions.length === 0 ? (
                <p className="text-[11px] text-gray-600 py-2">{t('strategy.noVersions')}</p>
              ) : (
                <div className="space-y-1">
                  {versions.map(v => (
                    <button key={v.version} onClick={() => setSelectedVersion(selectedVersion?.version === v.version ? null : v)}
                      className={`w-full text-left px-2 py-2 rounded-md transition-colors ${
                        selectedVersion?.version === v.version ? 'bg-amber-500/10 border border-amber-500/20' : 'hover:bg-white/[0.03] border border-transparent'
                      }`}>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-gray-300 font-mono">v{v.version}</span>
                        <span className={`text-[9px] px-1 py-0.5 rounded ${
                          v.changed_by === 'user' ? 'text-indigo-300 bg-indigo-400/10' : v.changed_by === 'learning2' ? 'text-indigo-300 bg-indigo-400/10' : v.changed_by === 'file_edit' ? 'text-indigo-300 bg-indigo-400/10' : 'text-indigo-300 bg-indigo-400/10'
                        }`}>{t(`strategy.changedBy.${v.changed_by}`, v.changed_by)}</span>
                      </div>
                      {v.change_reason && <p className="text-[10px] text-gray-500 mt-0.5 truncate">{v.change_reason}</p>}
                      <p className="text-[9px] text-gray-600 mt-0.5">{formatShortDate(v.created)}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
