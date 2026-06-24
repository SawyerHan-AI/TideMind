/**
 * Logseq 预处理器单元测试
 *
 * 测试各种 Logseq 特殊格式的预处理能力。
 * 使用临时文件系统模拟 Logseq graph。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { preprocessFile, buildBlockIndex } from '../../../src/integrations/logseq/preprocessor.js';

let tmpDir: string;

function writeFile(relPath: string, content: string): string {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-preprocess-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// === hls__ PDF 标注文件 ===

describe('hls__ PDF 标注文件', () => {
  it('应正确提取文本标注，跳过区域标注', () => {
    const filePath = writeFile('pages/hls__test_paper_1681190565324_0.md', `\
file-path:: ../assets/test_paper_1681190565324_0.pdf
file:: [test_paper_1681190565324_0.pdf](../assets/test_paper_1681190565324_0.pdf)
title:: hls__test_paper_1681190565324_0
- Environmental Interaction
  ls-type:: annotation
  hl-page:: 6
  hl-color:: yellow
  id:: 64e5aba0-10f7-499a-8432-ae9ec8163430
- [:span]
  ls-type:: annotation
  hl-page:: 8
  hl-color:: yellow
  id:: 64e5adf5-4abd-4795-bad1-3de89ba85c85
  hl-type:: area
  hl-stamp:: 1692773875800
- Memory and Retrieval
  ls-type:: annotation
  hl-page:: 8
  hl-color:: yellow
  id:: 64e5afed-3b27-4cef-aebc-b48f09e10375
- Planning and Reacting
  ls-type:: annotation
  hl-page:: 11
  hl-color:: yellow
  id:: 64e5b609-f1d4-4348-b32f-a5ec23e77c0c`);

    const result = preprocessFile(filePath, tmpDir);

    expect(result).not.toBeNull();
    // 文本标注应被提取
    expect(result!.cleanContent).toContain('Environmental Interaction');
    expect(result!.cleanContent).toContain('Memory and Retrieval');
    expect(result!.cleanContent).toContain('Planning and Reacting');
    // 区域标注应被跳过
    expect(result!.cleanContent).not.toContain('[:span]');
    // 标注属性不应出现在内容中
    expect(result!.cleanContent).not.toContain('ls-type');
    expect(result!.cleanContent).not.toContain('hl-color');
    expect(result!.cleanContent).not.toContain('annotation');
  });

  it('应按页码分组输出', () => {
    const filePath = writeFile('pages/hls__grouped_1681190565324_0.md', `\
file-path:: ../assets/grouped_1681190565324_0.pdf
- 第一段高亮
  ls-type:: annotation
  hl-page:: 5
  hl-color:: yellow
  id:: aaaaaaaa-1111-2222-3333-444444444444
- 第二段高亮
  ls-type:: annotation
  hl-page:: 5
  hl-color:: yellow
  id:: bbbbbbbb-1111-2222-3333-444444444444
- 第三段高亮
  ls-type:: annotation
  hl-page:: 10
  hl-color:: yellow
  id:: cccccccc-1111-2222-3333-444444444444`);

    const result = preprocessFile(filePath, tmpDir);

    expect(result).not.toBeNull();
    // 同页的标注应在一起
    expect(result!.cleanContent).toContain('p.5:');
    expect(result!.cleanContent).toContain('p.10:');
    // 页码 5 的应该在 10 之前
    const p5Idx = result!.cleanContent.indexOf('p.5');
    const p10Idx = result!.cleanContent.indexOf('p.10');
    expect(p5Idx).toBeLessThan(p10Idx);
  });

  it('应清理文件名中的时间戳后缀', () => {
    const filePath = writeFile('pages/hls__中国历史_1667967586558_0.md', `\
file-path:: ../assets/中国历史_1667967586558_0.pdf
- 一段高亮文本
  ls-type:: annotation
  hl-page:: 1
  hl-color:: yellow
  id:: dddddddd-1111-2222-3333-444444444444`);

    const result = preprocessFile(filePath, tmpDir);

    expect(result).not.toBeNull();
    expect(result!.title).toContain('中国历史.pdf');
    expect(result!.title).not.toContain('1667967586558');
    expect(result!.metadata.properties['source_pdf']).toBe('中国历史.pdf');
  });

  it('纯区域标注（无文本）应返回 null', () => {
    const filePath = writeFile('pages/hls__area_only_1681190565324_0.md', `\
file-path:: ../assets/area_only_1681190565324_0.pdf
- [:span]
  ls-type:: annotation
  hl-page:: 1
  hl-type:: area
  hl-stamp:: 1692773875800
  id:: eeeeeeee-1111-2222-3333-444444444444`);

    const result = preprocessFile(filePath, tmpDir);
    expect(result).toBeNull();
  });
});

// === {{query}} 处理 ===

describe('{{query}} 宏处理', () => {
  it('应移除 query 宏并提取查询描述', () => {
    const filePath = writeFile('pages/Book.md', `\
icon:: 🧾
- 页面标准格式
- {{query (property 类型 Book)}}
  query-table:: true
  query-properties:: [:书名 :领域 :作者]
  query-sort-by:: 状态
  query-sort-desc:: true`);

    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);

    expect(result).not.toBeNull();
    // query 语法应被移除
    expect(result!.cleanContent).not.toContain('{{query');
    expect(result!.cleanContent).not.toContain('query-table');
    expect(result!.cleanContent).not.toContain('query-properties');
    // 查询描述应在 metadata 中
    expect(result!.metadata.properties['query_desc']).toContain('类型=Book');
    // icon 不应泄露到 metadata
    expect(result!.metadata.properties['icon']).toBeUndefined();
  });
});

// === 图片/文件引用 ===

describe('资源引用处理', () => {
  it('应将图片引用转为 [图片: filename]', () => {
    const filePath = writeFile('pages/with_images.md', `\
- 这是一张图片
  - ![image.png](../assets/image_1645091724842_0.png)
- 另一个话题`);

    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[图片: image.png]');
    expect(result!.cleanContent).not.toContain('../assets/');
  });

  it('应将 PDF 文件引用转为 [文件: filename]', () => {
    const filePath = writeFile('pages/with_pdf.md', `\
- 参考文档
  - ![report.pdf](../assets/report_1645091724842_0.pdf)`);

    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[文件: report.pdf]');
  });

  it('应处理 Logseq 链接格式的资源引用', () => {
    const filePath = writeFile('pages/with_link_ref.md', `\
- 查看报告
  - [myfile.pdf](../assets/myfile_1645091724842_0.pdf)`);

    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[文件: myfile.pdf]');
  });
});

// === Hiccup 兜底 ===

describe('Hiccup 语法兜底', () => {
  it('应移除 [:span] 等 Hiccup 标记', () => {
    const filePath = writeFile('pages/hiccup.md', `\
- 一些内容 [:span] 后面还有
- [:div {:class "test"}] 另一个`);

    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain('[:span]');
    expect(result!.cleanContent).not.toContain('[:div');
    expect(result!.cleanContent).toContain('一些内容');
    expect(result!.cleanContent).toContain('后面还有');
  });
});

// === filters:: 系统属性 ===

describe('系统属性过滤', () => {
  it('filters:: 不应泄露到 metadata.properties', () => {
    const filePath = writeFile('pages/filtered.md', `\
filters:: {"paper" true}
alias:: [[AI Agents]]
- 一些内容，这里需要足够长的文本来通过长度检查
- 另外一段内容用来确保文件不会因过短被跳过`);

    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);

    expect(result).not.toBeNull();
    expect(result!.metadata.properties['filters']).toBeUndefined();
    expect(result!.metadata.aliases).toContain('[[AI Agents]]');
  });

  it('hl-color:: 不应泄露到 metadata.properties', () => {
    const filePath = writeFile('pages/hl_color.md', `\
- 一些足够长的内容用来通过预处理器的长度检查门槛
  hl-color:: yellow
  id:: 12345678-1234-1234-1234-123456789012`);

    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);

    expect(result).not.toBeNull();
    expect(result!.metadata.properties['hl-color']).toBeUndefined();
  });
});

// === 普通页面回归 ===

describe('普通页面（回归测试）', () => {
  it('应正常处理包含 [[page ref]] 和 #tag 的页面', () => {
    const filePath = writeFile('pages/normal.md', `\
- 讨论 [[产品设计]] 的要点 #设计
  - 用户体验是核心
  - 需要考虑 [[可用性]]`);

    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('产品设计');
    expect(result!.cleanContent).toContain('用户体验是核心');
    expect(result!.metadata.pageRefs).toContain('产品设计');
    expect(result!.metadata.pageRefs).toContain('可用性');
    expect(result!.metadata.tags).toContain('设计');
  });

  it('应正常处理 journal 文件', () => {
    const filePath = writeFile('journals/2022_02_17.md', `\
- 今天讨论了 [[分享单]] 的规划 #星海科技
  collapsed:: true
  - 账号体系设计
    - 独立做一套账户体系`);

    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);

    expect(result).not.toBeNull();
    expect(result!.metadata.isJournal).toBe(true);
    expect(result!.title).toBe('2022-02-17');
    expect(result!.cleanContent).toContain('分享单');
    expect(result!.cleanContent).not.toContain('collapsed');
  });

  // F6(2026-06-24 logseq-orphan): preprocessor 的 isJournal 判定与 classifier.ts 对齐——
  // 日期命名文件即使在 pages/ 目录(非 journals/)也算 journal,否则 init(走 classifier,当 journal)
  // 与增量(走 preprocessor)对同一文件 isJournal 不一致 → segmentContent 段数 M≠N → supersede 配对错位。
  it('F6: 日期命名的 page 文件(非 journals/ 目录)也识别为 journal', () => {
    const filePath = writeFile('pages/2022_02_17.md', '- 今天讨论了 [[分享单]] 的规划 #星海科技');
    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.metadata.isJournal).toBe(true); // F6: 旧逻辑只认 journals/ 时这里会是 false
  });

  it('F6: YYYYMMDD 紧凑日期命名也识别为 journal', () => {
    const filePath = writeFile('pages/20220217.md', '- 这是一段紧凑日期命名的日记内容甲乙丙');
    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.metadata.isJournal).toBe(true);
  });

  it('F6: 普通非日期命名 page 文件仍为非 journal', () => {
    const filePath = writeFile('pages/我的笔记页.md', '- 这是一个普通页面不是日记的内容甲乙丙丁');
    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.metadata.isJournal).toBe(false);
  });

  // 无效日期范围校验(2026-06-24 第二轮审计 MEDIUM):月/日越界的纯数字 ID 不能误判 journal,
  // 否则推 created='2022-99-99' → NaN heat 僵尸节点 + 云端往返复活成热节点。
  it('无效日期 20229999.md(月/日越界)不误判 journal', () => {
    const filePath = writeFile('pages/20229999.md', '- 这是一段纯数字 ID 命名的页面内容甲乙丙丁');
    buildBlockIndex(tmpDir);
    const result = preprocessFile(filePath, tmpDir);
    expect(result).not.toBeNull();
    expect(result!.metadata.isJournal).toBe(false);
  });

  it('极短文件应返回 null', () => {
    const filePath = writeFile('pages/empty.md', '-');
    const result = preprocessFile(filePath, tmpDir);
    expect(result).toBeNull();
  });
});
