import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'
import { Check, Clock, Lock, Database, Link2, Sparkles, Search, Brain, Zap, Settings2, Cpu, Timer } from 'lucide-react'
import { useIPC } from '../../hooks/useIPC'
import { NumberField, SliderField } from './shared'
import type { GroupTab, ProcessingNode } from './internal-strategy/types'
import { classifyParam, NODES_BY_GROUP, TRIGGER_ICONS, TRIGGER_LABEL_KEYS, TRIGGER_STYLES } from './internal-strategy/catalog'
import { EmbeddedStrategyPanel } from './internal-strategy/EmbeddedStrategyPanel'
import { ProfileFieldsEditor } from './internal-strategy/ProfileFieldsEditor'
import { EditableStrategyParams, LLMConfigSection } from './internal-strategy/StrategyParamEditors'
import { WeightVisualization } from './internal-strategy/WeightVisualization'

// ============================================================
// 按认知功能分组的内部策略管理 — Master-Detail 布局
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
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000)
    }, 500)
    return () => {
      clearTimeout(timer)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    }
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
