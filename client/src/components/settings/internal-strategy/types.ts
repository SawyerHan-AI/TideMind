export type GroupTab = 'memory' | 'think-associate' | 'think-emerge' | 'output' | 'evolution'

export interface ConfigParam {
  key: string
  label: string
  tip: string
  default: number
  step?: number
  section: string
  unit?: string
}

export interface StrategyParam {
  key: string
  label: string
  tip: string
  strategyName: string
  step?: number
}

export interface GateParam {
  key: string
  label: string
  tip: string
  default: number
  unit?: string
  metric?: 'node_count' | 'link_count'
}

export interface TriggerConfig {
  type: 'realtime' | 'interval' | 'query' | 'event'
  label: string
  intervalParam?: StrategyParam
}

export interface ProcessingNode {
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
