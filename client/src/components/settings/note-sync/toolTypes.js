import { jsx as _jsx } from "react/jsx-runtime";
import { BookOpen, FileText, StickyNote } from 'lucide-react';
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
export const TOOL_TYPES = [
    { id: 'logseq', label: 'Logseq', icon: _jsx(BookOpen, { size: 14 }) },
    { id: 'obsidian', label: 'Obsidian', icon: _jsx(FileText, { size: 14 }) },
    { id: 'apple-notes', label: 'Apple Notes', icon: _jsx(StickyNote, { size: 14 }), comingSoon: !IS_MAC },
    { id: 'notion', label: 'Notion', icon: _jsx(FileText, { size: 14 }) },
];
export function getToolLabel(toolType) {
    return TOOL_TYPES.find(tt => tt.id === toolType)?.label ?? toolType;
}
export function getToolIcon(toolType) {
    const def = TOOL_TYPES.find(tt => tt.id === toolType);
    if (def) {
        if (toolType === 'logseq')
            return _jsx(BookOpen, { size: 14, className: "text-gray-500 flex-shrink-0" });
        if (toolType === 'obsidian')
            return _jsx(FileText, { size: 14, className: "text-gray-500 flex-shrink-0" });
        if (toolType === 'apple-notes')
            return _jsx(StickyNote, { size: 14, className: "text-gray-500 flex-shrink-0" });
    }
    return _jsx(BookOpen, { size: 14, className: "text-gray-500 flex-shrink-0" });
}
