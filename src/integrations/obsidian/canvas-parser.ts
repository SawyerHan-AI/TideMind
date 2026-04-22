// ============================================================
// Obsidian Canvas 文件解析器
//
// 解析 Canvas JSON 文件，提取文本节点、文件引用、外部链接和边，
// 同时计算 group 包含关系（通过几何空间判断）。
//
// Canvas 是用户手绘的知识图谱，其中的连接关系是高价值信号——
// 用户主动画出的箭头比正文中隐含的 [[wikilink]] 更明确。
// ============================================================

import { createLogger } from '../../utils/logger.js';
import { safeReadTextFileSync } from '../../utils/safe-fs.js';
import type {
  CanvasData,
  CanvasNode,
  CanvasGroupNode,
  CanvasParseResult,
} from './types.js';

const log = createLogger('obsidian:canvas');

// 有标签的边置信度更高——用户主动命名了关系
const LABELED_EDGE_CONFIDENCE = 0.95;
const UNLABELED_EDGE_CONFIDENCE = 0.85;

/**
 * 解析 Canvas JSON 文件
 *
 * @param filePath - .canvas 文件的绝对路径
 * @returns 解析结果，JSON 无效时返回 null
 */
export function parseCanvas(filePath: string): CanvasParseResult | null {
  const readRes = safeReadTextFileSync(filePath);
  if (!readRes.ok) {
    if (readRes.reason === 'error') {
      log.warn('Canvas 文件读取失败: %s — %s', filePath, readRes.err?.message ?? '');
    }
    // dataless / stub / missing → 静默跳过
    return null;
  }
  const raw = readRes.content;

  // 解析 JSON
  let data: CanvasData;
  try {
    data = JSON.parse(raw) as CanvasData;
  } catch (err) {
    log.warn('Canvas JSON 解析失败: %s — %s', filePath, (err as Error).message);
    return null;
  }

  // 基本校验
  if (!data.nodes || !Array.isArray(data.nodes)) {
    log.warn('Canvas 文件缺少 nodes 数组: %s', filePath);
    return null;
  }
  if (!data.edges) {
    data.edges = [];
  }

  // 分离 group 节点和其他节点
  const groups: CanvasGroupNode[] = [];
  const otherNodes: CanvasNode[] = [];

  for (const node of data.nodes) {
    if (node.type === 'group') {
      groups.push(node);
    } else {
      otherNodes.push(node);
    }
  }

  // 计算每个非 group 节点属于哪些 group
  // 按面积从大到小排序（外层 group 先处理），支持嵌套 group
  const sortedGroups = groups.sort((a, b) => {
    const areaA = a.width * a.height;
    const areaB = b.width * b.height;
    return areaB - areaA; // 面积大的在前
  });

  // nodeId → 所属 group 的 label 列表
  const nodeGroupLabels = new Map<string, string[]>();

  for (const group of sortedGroups) {
    const containedNodes = getNodesInGroup(group, otherNodes);
    for (const node of containedNodes) {
      if (!nodeGroupLabels.has(node.id)) {
        nodeGroupLabels.set(node.id, []);
      }
      if (group.label) {
        nodeGroupLabels.get(node.id)!.push(group.label);
      }
    }
  }

  // 构建结果
  const result: CanvasParseResult = {
    textNodes: [],
    fileRefs: [],
    linkNodes: [],
    edges: [],
  };

  // 处理各类节点
  for (const node of otherNodes) {
    const labels = nodeGroupLabels.get(node.id) ?? [];

    switch (node.type) {
      case 'text':
        result.textNodes.push({
          id: node.id,
          text: node.text,
          color: node.color,
          groupLabels: labels,
        });
        break;

      case 'file':
        result.fileRefs.push({
          id: node.id,
          file: node.file,
          subpath: node.subpath,
        });
        break;

      case 'link':
        result.linkNodes.push({
          id: node.id,
          url: node.url,
        });
        break;
    }
  }

  // 处理边
  for (const edge of data.edges) {
    result.edges.push({
      fromId: edge.fromNode,
      toId: edge.toNode,
      label: edge.label,
      confidence: edge.label ? LABELED_EDGE_CONFIDENCE : UNLABELED_EDGE_CONFIDENCE,
    });
  }

  log.debug(
    'Canvas 解析完成: %s — text:%d, file:%d, link:%d, edge:%d, group:%d',
    filePath,
    result.textNodes.length,
    result.fileRefs.length,
    result.linkNodes.length,
    result.edges.length,
    groups.length,
  );

  return result;
}

// ============================================================
// 几何空间判断
// ============================================================

/**
 * 获取被 group 完全包含的节点
 *
 * 包含条件：节点的边界框完全在 group 的边界框内部。
 * 即 node.x >= group.x && node.y >= group.y
 *    && node.x + node.width <= group.x + group.width
 *    && node.y + node.height <= group.y + group.height
 */
function getNodesInGroup(group: CanvasGroupNode, allNodes: CanvasNode[]): CanvasNode[] {
  return allNodes.filter(n =>
    n.id !== group.id &&
    n.x >= group.x &&
    n.y >= group.y &&
    n.x + n.width <= group.x + group.width &&
    n.y + n.height <= group.y + group.height,
  );
}
