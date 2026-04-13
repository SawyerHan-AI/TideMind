/**
 * canvas-parser.ts 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { parseCanvas } from '../../../src/integrations/obsidian/canvas-parser.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-canvas-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写入 .canvas 文件并返回路径 */
function writeCanvas(name: string, data: unknown): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
  return filePath;
}

// ===== 文本节点 =====

describe('text nodes', () => {
  it('解析文本节点，提取 text 和 color', () => {
    const fp = writeCanvas('text.canvas', {
      nodes: [
        { id: 'n1', type: 'text', text: 'Hello world', color: '1', x: 0, y: 0, width: 100, height: 50 },
      ],
      edges: [],
    });

    const result = parseCanvas(fp);
    expect(result).not.toBeNull();
    expect(result!.textNodes).toHaveLength(1);
    expect(result!.textNodes[0]).toEqual({
      id: 'n1',
      text: 'Hello world',
      color: '1',
      groupLabels: [],
    });
  });

  it('文本节点无 color 时 color 为 undefined', () => {
    const fp = writeCanvas('no-color.canvas', {
      nodes: [
        { id: 'n1', type: 'text', text: 'No color', x: 0, y: 0, width: 100, height: 50 },
      ],
      edges: [],
    });

    const result = parseCanvas(fp);
    expect(result!.textNodes[0].color).toBeUndefined();
  });
});

// ===== 文件节点 =====

describe('file nodes', () => {
  it('解析文件节点，提取 file 和 subpath', () => {
    const fp = writeCanvas('file.canvas', {
      nodes: [
        { id: 'f1', type: 'file', file: 'notes/page.md', subpath: '#heading', x: 0, y: 0, width: 100, height: 50 },
      ],
      edges: [],
    });

    const result = parseCanvas(fp);
    expect(result!.fileRefs).toHaveLength(1);
    expect(result!.fileRefs[0]).toEqual({
      id: 'f1',
      file: 'notes/page.md',
      subpath: '#heading',
    });
  });

  it('文件节点无 subpath', () => {
    const fp = writeCanvas('file-no-sub.canvas', {
      nodes: [
        { id: 'f1', type: 'file', file: 'readme.md', x: 0, y: 0, width: 100, height: 50 },
      ],
      edges: [],
    });

    const result = parseCanvas(fp);
    expect(result!.fileRefs[0].subpath).toBeUndefined();
  });
});

// ===== 链接节点 =====

describe('link nodes', () => {
  it('解析链接节点，提取 URL', () => {
    const fp = writeCanvas('link.canvas', {
      nodes: [
        { id: 'l1', type: 'link', url: 'https://example.com', x: 0, y: 0, width: 200, height: 100 },
      ],
      edges: [],
    });

    const result = parseCanvas(fp);
    expect(result!.linkNodes).toHaveLength(1);
    expect(result!.linkNodes[0]).toEqual({ id: 'l1', url: 'https://example.com' });
  });
});

// ===== Group 包含关系 =====

describe('group containment', () => {
  it('节点完全在 group 内 → 分配 group label', () => {
    const fp = writeCanvas('group.canvas', {
      nodes: [
        { id: 'g1', type: 'group', label: 'My Group', x: 0, y: 0, width: 500, height: 500 },
        { id: 'n1', type: 'text', text: 'Inside', x: 10, y: 10, width: 100, height: 50 },
        { id: 'n2', type: 'text', text: 'Outside', x: 600, y: 600, width: 100, height: 50 },
      ],
      edges: [],
    });

    const result = parseCanvas(fp);
    const inside = result!.textNodes.find(n => n.id === 'n1');
    const outside = result!.textNodes.find(n => n.id === 'n2');

    expect(inside!.groupLabels).toEqual(['My Group']);
    expect(outside!.groupLabels).toEqual([]);
  });

  it('嵌套 group：内层 group 的 label 也被分配', () => {
    const fp = writeCanvas('nested.canvas', {
      nodes: [
        { id: 'outer', type: 'group', label: 'Outer', x: 0, y: 0, width: 1000, height: 1000 },
        { id: 'inner', type: 'group', label: 'Inner', x: 100, y: 100, width: 300, height: 300 },
        { id: 'n1', type: 'text', text: 'Deep inside', x: 150, y: 150, width: 50, height: 50 },
      ],
      edges: [],
    });

    const result = parseCanvas(fp);
    const node = result!.textNodes.find(n => n.id === 'n1');
    // 外层 group 面积更大，先处理，因此 Outer 在前
    expect(node!.groupLabels).toContain('Outer');
    expect(node!.groupLabels).toContain('Inner');
    expect(node!.groupLabels).toHaveLength(2);
  });

  it('group 无 label 时不添加空字符串', () => {
    const fp = writeCanvas('no-label-group.canvas', {
      nodes: [
        { id: 'g1', type: 'group', x: 0, y: 0, width: 500, height: 500 },
        { id: 'n1', type: 'text', text: 'Inside unlabeled', x: 10, y: 10, width: 100, height: 50 },
      ],
      edges: [],
    });

    const result = parseCanvas(fp);
    expect(result!.textNodes[0].groupLabels).toEqual([]);
  });
});

// ===== 边 =====

describe('edges', () => {
  it('有标签的边 → confidence 0.95', () => {
    const fp = writeCanvas('labeled-edge.canvas', {
      nodes: [
        { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 50 },
        { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 50 },
      ],
      edges: [
        { id: 'e1', fromNode: 'a', toNode: 'b', label: 'relates to' },
      ],
    });

    const result = parseCanvas(fp);
    expect(result!.edges).toHaveLength(1);
    expect(result!.edges[0]).toEqual({
      fromId: 'a',
      toId: 'b',
      label: 'relates to',
      confidence: 0.95,
    });
  });

  it('无标签的边 → confidence 0.85', () => {
    const fp = writeCanvas('unlabeled-edge.canvas', {
      nodes: [
        { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 100, height: 50 },
        { id: 'b', type: 'text', text: 'B', x: 200, y: 0, width: 100, height: 50 },
      ],
      edges: [
        { id: 'e1', fromNode: 'a', toNode: 'b' },
      ],
    });

    const result = parseCanvas(fp);
    expect(result!.edges[0].confidence).toBe(0.85);
    expect(result!.edges[0].label).toBeUndefined();
  });

  it('边的 fromId/toId 对应节点 id', () => {
    const fp = writeCanvas('edge-refs.canvas', {
      nodes: [
        { id: 'node-x', type: 'text', text: 'X', x: 0, y: 0, width: 100, height: 50 },
        { id: 'node-y', type: 'file', file: 'y.md', x: 200, y: 0, width: 100, height: 50 },
      ],
      edges: [
        { id: 'e1', fromNode: 'node-x', toNode: 'node-y' },
      ],
    });

    const result = parseCanvas(fp);
    expect(result!.edges[0].fromId).toBe('node-x');
    expect(result!.edges[0].toId).toBe('node-y');
  });
});

// ===== 异常情况 =====

describe('error handling', () => {
  it('无效 JSON → 返回 null', () => {
    const fp = path.join(tmpDir, 'bad.canvas');
    fs.writeFileSync(fp, '{ not valid json !!!', 'utf-8');

    expect(parseCanvas(fp)).toBeNull();
  });

  it('文件不存在 → 返回 null', () => {
    expect(parseCanvas(path.join(tmpDir, 'ghost.canvas'))).toBeNull();
  });

  it('缺少 nodes 数组 → 返回 null', () => {
    const fp = writeCanvas('no-nodes.canvas', { edges: [] });
    expect(parseCanvas(fp)).toBeNull();
  });
});

// ===== 空和混合 =====

describe('empty and mixed', () => {
  it('空 canvas → 返回空数组', () => {
    const fp = writeCanvas('empty.canvas', { nodes: [], edges: [] });

    const result = parseCanvas(fp);
    expect(result).not.toBeNull();
    expect(result!.textNodes).toEqual([]);
    expect(result!.fileRefs).toEqual([]);
    expect(result!.linkNodes).toEqual([]);
    expect(result!.edges).toEqual([]);
  });

  it('混合节点类型同时解析', () => {
    const fp = writeCanvas('mixed.canvas', {
      nodes: [
        { id: 't1', type: 'text', text: 'Note', x: 0, y: 0, width: 100, height: 50 },
        { id: 'f1', type: 'file', file: 'page.md', x: 200, y: 0, width: 100, height: 50 },
        { id: 'l1', type: 'link', url: 'https://x.com', x: 400, y: 0, width: 100, height: 50 },
        { id: 'g1', type: 'group', label: 'All', x: -10, y: -10, width: 600, height: 200 },
      ],
      edges: [
        { id: 'e1', fromNode: 't1', toNode: 'f1', label: 'ref' },
        { id: 'e2', fromNode: 'f1', toNode: 'l1' },
      ],
    });

    const result = parseCanvas(fp);
    expect(result!.textNodes).toHaveLength(1);
    expect(result!.fileRefs).toHaveLength(1);
    expect(result!.linkNodes).toHaveLength(1);
    expect(result!.edges).toHaveLength(2);

    // 所有非 group 节点都在 group 内
    expect(result!.textNodes[0].groupLabels).toEqual(['All']);
  });
});
