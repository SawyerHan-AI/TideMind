import { BookOpen, FileText, StickyNote } from 'lucide-react'
import type { ToolTypeDef } from './types'

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

export const TOOL_TYPES: ToolTypeDef[] = [
  { id: 'logseq', label: 'Logseq', icon: <BookOpen size={14} /> },
  { id: 'obsidian', label: 'Obsidian', icon: <FileText size={14} /> },
  { id: 'apple-notes', label: 'Apple Notes', icon: <StickyNote size={14} />, comingSoon: !IS_MAC },
  { id: 'notion', label: 'Notion', icon: <FileText size={14} /> },
]

export function getToolLabel(toolType: string): string {
  return TOOL_TYPES.find(tt => tt.id === toolType)?.label ?? toolType
}

export function getToolIcon(toolType: string): React.ReactNode {
  const def = TOOL_TYPES.find(tt => tt.id === toolType)
  if (def) {
    if (toolType === 'logseq') return <BookOpen size={14} className="text-gray-500 flex-shrink-0" />
    if (toolType === 'obsidian') return <FileText size={14} className="text-gray-500 flex-shrink-0" />
    if (toolType === 'apple-notes') return <StickyNote size={14} className="text-gray-500 flex-shrink-0" />
  }
  return <BookOpen size={14} className="text-gray-500 flex-shrink-0" />
}
