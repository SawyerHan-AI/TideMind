/**
 * Obsidian 预处理器单元测试
 *
 * 覆盖 YAML frontmatter 解析、wikilink 提取、Markdown 链接、嵌入引用、
 * 行内字段、标签、callout、checkbox、HTML 清理、插件代码块、
 * 杂项清理、脚注、文件索引等全部预处理步骤。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { preprocessFile, buildFileIndex, walkMdFiles, shouldProcessFile } from '../../../src/integrations/obsidian/preprocessor.js';

let tmpDir: string;

function writeFile(relPath: string, content: string): string {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

/** 辅助：对给定内容构造一个带有足够长度的 frontmatter 文件并预处理 */
function processContent(content: string, relPath = 'test.md'): ReturnType<typeof preprocessFile> {
  const filePath = writeFile(relPath, content);
  return preprocessFile(filePath, tmpDir);
}

/** 辅助：确保内容足够长以通过 < 10 字符检查 */
function pad(content: string): string {
  if (content.length < 20) {
    return content + '\n这是填充内容确保文件不会因过短被丢弃。';
  }
  return content;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-obsidian-preprocess-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ================================================================
// 1. YAML Frontmatter 解析
// ================================================================

describe('YAML Frontmatter 解析', () => {
  it('应正确解析 title、tags、aliases', () => {
    const result = processContent(`---
title: 我的笔记
tags:
  - 读书
  - 知识管理
aliases:
  - 笔记本
---
这是正文内容，需要足够长以通过检查。`);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('我的笔记');
    expect(result!.metadata.tags).toContain('读书');
    expect(result!.metadata.tags).toContain('知识管理');
    expect(result!.metadata.aliases).toContain('笔记本');
  });

  it('应扁平化嵌套对象', () => {
    const result = processContent(`---
wellbeing:
  mood: 3
  energy: 4
---
正文内容足够长度以通过预处理器的最小长度检查。`);

    expect(result).not.toBeNull();
    expect(result!.metadata.properties['wellbeing.mood']).toBe('3');
    expect(result!.metadata.properties['wellbeing.energy']).toBe('4');
  });

  it('应从 frontmatter 值中提取 wikilinks', () => {
    const result = processContent(`---
categories:
  - "[[Movies]]"
  - "[[Books]]"
source: "[[某本书]]"
---
正文内容足够长度以通过预处理器的最小长度检查。`);

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).toContain('Movies');
    expect(result!.metadata.pageRefs).toContain('Books');
    expect(result!.metadata.pageRefs).toContain('某本书');
    // wikilink 括号应被去除
    expect(result!.metadata.properties['source']).not.toContain('[[');
  });

  it('应在 Templater 语法 <%...%> 导致解析失败时去除后重试', () => {
    const result = processContent(`---
title: 模板笔记
created: <% tp.date.now() %>
tags:
  - 日记
---
正文内容足够长度以通过预处理器的最小长度检查。`);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('模板笔记');
    expect(result!.metadata.tags).toContain('日记');
  });

  it('应在 {{date}} Mustache 语法导致解析失败时去除后重试', () => {
    const result = processContent(`---
title: 模板文件
date: "{{date}}"
tags:
  - 测试
---
正文内容足够长度以通过预处理器的最小长度检查。`);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('模板文件');
    expect(result!.metadata.tags).toContain('测试');
  });

  it('解析二次失败时应跳过 frontmatter 继续处理正文', () => {
    const result = processContent(`---
: invalid yaml [[[
  broken: {{{unbalanced
---
正文内容足够长度以通过预处理器的最小长度检查，这里必须足够长。`);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('正文内容');
  });

  it('应归一化字段名 tag→tags, alias→aliases, cssClass→cssclasses', () => {
    const result = processContent(`---
tag:
  - 归一化测试
alias:
  - 别名测试
cssClass: my-class
---
正文内容足够长度以通过预处理器的最小长度检查。`);

    expect(result).not.toBeNull();
    expect(result!.metadata.tags).toContain('归一化测试');
    expect(result!.metadata.aliases).toContain('别名测试');
    // cssclasses 是系统属性，会被过滤掉
    expect(result!.metadata.properties['cssclasses']).toBeUndefined();
  });

  it('tags 为字符串时应按空格分割，不按逗号分割', () => {
    const result = processContent(`---
tags: 读书 写作 思考
---
正文内容足够长度以通过预处理器的最小长度检查。`);

    expect(result).not.toBeNull();
    expect(result!.metadata.tags).toEqual(['读书', '写作', '思考']);
  });

  it('tags 为含逗号的字符串时不应拆分', () => {
    const result = processContent(`---
tags: "读书,写作"
---
正文内容足够长度以通过预处理器的最小长度检查。`);

    expect(result).not.toBeNull();
    // 逗号不拆分，整体作为一个 tag
    expect(result!.metadata.tags).toEqual(['读书,写作']);
  });

  it('tags 为列表时应正确处理', () => {
    const result = processContent(`---
tags:
  - "#标签一"
  - 标签二
---
正文内容足够长度以通过预处理器的最小长度检查。`);

    expect(result).not.toBeNull();
    expect(result!.metadata.tags).toContain('标签一');
    expect(result!.metadata.tags).toContain('标签二');
  });

  it('tags 为 null 或空时应返回空数组', () => {
    const result = processContent(`---
tags:
---
正文内容足够长度以通过预处理器的最小长度检查。`);

    expect(result).not.toBeNull();
    // null tags 不应导致崩溃
    expect(result!.metadata.tags).toEqual([]);
  });

  it('没有 frontmatter 的文件应正常处理', () => {
    const result = processContent('这是一个没有 frontmatter 的文件，需要足够长。');

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('没有 frontmatter');
  });
});

// ================================================================
// 2. Wikilink 提取
// ================================================================

describe('Wikilink 提取', () => {
  it('应提取基本 [[page]]', () => {
    const result = processContent(pad('讨论 [[产品设计]] 的要点'));

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).toContain('产品设计');
    expect(result!.cleanContent).toContain('产品设计');
    expect(result!.cleanContent).not.toContain('[[');
  });

  it('应处理 [[page|alias]]：ref=page, display=alias', () => {
    const result = processContent(pad('参见 [[产品设计|产品]] 的详情'));

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).toContain('产品设计');
    expect(result!.cleanContent).toContain('产品');
    expect(result!.cleanContent).not.toContain('[[');
  });

  it('应处理 [[page#heading]]：heading 保留在引用中', () => {
    const result = processContent(pad('参见 [[笔记#第一章]] 的内容'));

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).toContain('笔记');
  });

  it('应处理 [[page#^block-id]]', () => {
    const result = processContent(pad('参见 [[笔记#^abc123]] 的内容'));

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).toContain('笔记');
  });

  it('应处理 [[path/to/page]]：取最后一段 "page"', () => {
    const result = processContent(pad('参见 [[folder/subfolder/目标页面]] 的内容'));

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).toContain('目标页面');
  });

  it('应处理表格中的转义 pipe [[page\\|alias]]', () => {
    const result = processContent(pad('| 列 | [[笔记\\|别名]] |'));

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).toContain('笔记');
    expect(result!.cleanContent).toContain('别名');
  });

  it('代码块内的 [[links]] 不应被提取', () => {
    const result = processContent(`正文内容足够长度以通过检查。
\`\`\`python
data = [[1, 2], [3, 4]]
ref = [[SomePage]]
\`\`\`
这是代码块外面的内容。`);

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).not.toContain('SomePage');
  });

  it('行内代码中的 [[links]] 不应被提取', () => {
    const result = processContent(pad('使用 `[[不是链接]]` 语法来表示'));

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).not.toContain('不是链接');
  });

  it('应排除全数字的误匹配 [[1, 2, 3]]', () => {
    const result = processContent(pad('数组 [[1, 2, 3]] 的示例'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[[1, 2, 3]]');
  });

  it('应排除空的 [[]]', () => {
    const result = processContent(pad('空链接 [[]] 不应崩溃'));

    expect(result).not.toBeNull();
    // 空 [[ ]] 不匹配正则（[^\]]+ 要求至少一个字符）
  });
});

// ================================================================
// 3. Markdown 链接
// ================================================================

describe('Markdown 链接', () => {
  it('应处理 [text](page.md)：提取 pageRef', () => {
    const result = processContent(pad('查看 [详情](page.md) 了解更多'));

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).toContain('page');
    expect(result!.cleanContent).toContain('详情');
    expect(result!.cleanContent).not.toContain('page.md');
  });

  it('应处理 [text](../folder/page.md)：相对路径解析', () => {
    const result = processContent(pad('参见 [笔记](../docs/note.md) 了解'));

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).toContain('note');
  });

  it('应处理 URL 编码 [text](Page%20Name.md)', () => {
    const result = processContent(pad('参见 [页面](Page%20Name.md) 了解'));

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).toContain('Page Name');
  });

  it('应处理无 .md 后缀的 [text](page)：视为页面名', () => {
    const result = processContent(pad('参见 [详情](some-page) 了解更多'));

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).toContain('some-page');
  });

  it('应处理本地图片 ![alt](image.png)', () => {
    const result = processContent(pad('这是 ![截图](assets/screenshot.png) 示例'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[图片: screenshot.png]');
  });

  it('应处理外部图片 ![alt](https://...)', () => {
    const result = processContent(pad('图 ![示例图](https://example.com/img.jpg) 结束'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[外部图片: 示例图]');
  });

  it('外部图片 alt 为纯数字时应显示 [外部图片]', () => {
    const result = processContent(pad('图 ![250](https://example.com/img.jpg) 结束'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[外部图片]');
    expect(result!.cleanContent).not.toContain('250');
  });

  it('外部链接应保持原样', () => {
    const result = processContent(pad('参见 [Google](https://google.com) 搜索'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[Google](https://google.com)');
  });
});

// ================================================================
// 4. 嵌入引用 ![[...]]
// ================================================================

describe('嵌入引用', () => {
  it('应处理图片嵌入 ![[image.png]]', () => {
    const result = processContent(pad('展示 ![[photo.png]] 如图'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[图片: photo.png]');
  });

  it('应处理带尺寸参数的图片 ![[image.png|500]]', () => {
    const result = processContent(pad('展示 ![[photo.jpg|500]] 如图'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[图片: photo.jpg]');
    expect(result!.cleanContent).not.toContain('500');
  });

  it('应处理 PDF 嵌入 ![[doc.pdf]]', () => {
    const result = processContent(pad('参见 ![[report.pdf]] 文件'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[PDF: report.pdf]');
  });

  it('应处理带页码的 PDF ![[doc.pdf#page=3]]', () => {
    const result = processContent(pad('参见 ![[report.pdf#page=3]] 内容'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[PDF: report.pdf, 第3页]');
  });

  it('应处理媒体嵌入 ![[video.mp4]]', () => {
    const result = processContent(pad('播放 ![[lecture.mp4]] 视频'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[媒体: lecture.mp4]');
  });

  it('应处理音频嵌入 ![[audio.mp3]]', () => {
    const result = processContent(pad('播放 ![[podcast.mp3]] 音频'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[媒体: podcast.mp3]');
  });

  it('应处理笔记嵌入 ![[note]]', () => {
    const result = processContent(pad('引用 ![[我的笔记]] 内容'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[引用: 我的笔记]');
    expect(result!.metadata.pageRefs).toContain('我的笔记');
  });

  it('应处理带标题的笔记嵌入 ![[note#heading]]', () => {
    const result = processContent(pad('引用 ![[笔记#第二章]] 的内容'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[引用: 笔记 \u00A7 第二章]');
    expect(result!.metadata.pageRefs).toContain('笔记');
  });
});

// ================================================================
// 5. 行内字段 (Dataview inline fields)
// ================================================================

describe('行内字段', () => {
  it('行首 key:: value 应从内容中移除并存入 properties', () => {
    const result = processContent(`这是正文内容足够长度。
status:: 进行中
priority:: 高
其他正文内容。`);

    expect(result).not.toBeNull();
    expect(result!.metadata.properties['status']).toBe('进行中');
    expect(result!.metadata.properties['priority']).toBe('高');
    expect(result!.cleanContent).not.toContain('status::');
    expect(result!.cleanContent).not.toContain('priority::');
  });

  it('(key:: value) 应替换为 value 并存入 properties', () => {
    const result = processContent(pad('任务是 (status:: 进行中) 的状态'));

    expect(result).not.toBeNull();
    expect(result!.metadata.properties['status']).toBe('进行中');
    expect(result!.cleanContent).toContain('进行中');
    expect(result!.cleanContent).not.toContain('status::');
  });

  it('[key:: value] 应替换为 value 并存入 properties', () => {
    const result = processContent(pad('完成度 [progress:: 50%] 的任务'));

    expect(result).not.toBeNull();
    expect(result!.metadata.properties['progress']).toBe('50%');
    expect(result!.cleanContent).toContain('50%');
    expect(result!.cleanContent).not.toContain('progress::');
  });

  it('值中的 [[wikilink]] 应提取到 pageRefs', () => {
    const result = processContent(`这是正文内容足够长度。
source:: [[某本书]]
其他正文内容继续。`);

    expect(result).not.toBeNull();
    expect(result!.metadata.pageRefs).toContain('某本书');
    expect(result!.metadata.properties['source']).toContain('某本书');
  });
});

// ================================================================
// 6. 标签
// ================================================================

describe('标签', () => {
  it('应提取简单 #tag', () => {
    const result = processContent(pad('这是 #reading 的笔记'));

    expect(result).not.toBeNull();
    expect(result!.metadata.tags).toContain('reading');
  });

  it('嵌套标签 #parent/child 应同时提取 parent 和 parent/child', () => {
    const result = processContent(pad('标记为 #项目/工作 的任务'));

    expect(result).not.toBeNull();
    expect(result!.metadata.tags).toContain('项目');
    expect(result!.metadata.tags).toContain('项目/工作');
  });

  it('纯数字 #123 不应被提取', () => {
    const result = processContent(pad('问题 #123 需要处理'));

    expect(result).not.toBeNull();
    expect(result!.metadata.tags).not.toContain('123');
  });

  it('CSS 颜色 #FF0000 在代码区域内不应被提取', () => {
    const result = processContent(`正文内容足够长度以通过检查。
\`\`\`css
color: #FF0000;
\`\`\`
代码块外面的内容。`);

    expect(result).not.toBeNull();
    expect(result!.metadata.tags).not.toContain('FF0000');
  });

  it('代码块内的标签不应被提取', () => {
    const result = processContent(`正文内容足够长度以通过检查。
\`\`\`
#不是标签
\`\`\`
代码块外面的内容。`);

    expect(result).not.toBeNull();
    expect(result!.metadata.tags).not.toContain('不是标签');
  });

  it('行内代码中的标签不应被提取', () => {
    const result = processContent(pad('使用 `#不是标签` 语法'));

    expect(result).not.toBeNull();
    expect(result!.metadata.tags).not.toContain('不是标签');
  });

  it('应与 frontmatter tags 合并去重', () => {
    const result = processContent(`---
tags:
  - 读书
---
这是 #读书 的笔记，和 #写作 的心得，内容足够长。`);

    expect(result).not.toBeNull();
    // 不应重复
    const readingCount = result!.metadata.tags.filter(t => t === '读书').length;
    expect(readingCount).toBe(1);
    expect(result!.metadata.tags).toContain('写作');
  });

  it('中文标签应正确提取', () => {
    const result = processContent(pad('记录 #知识管理 的方法'));

    expect(result).not.toBeNull();
    expect(result!.metadata.tags).toContain('知识管理');
  });
});

// ================================================================
// 7. Callout
// ================================================================

describe('Callout', () => {
  it('应处理基本 callout > [!note]', () => {
    const result = processContent(`正文内容足够长度以通过检查。
> [!note] 注意事项
> 这是一段重要的内容。`);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('注意事项');
    expect(result!.cleanContent).toContain('这是一段重要的内容');
    expect(result!.cleanContent).not.toContain('[!note]');
  });

  it('应处理可折叠 callout > [!tip]-', () => {
    const result = processContent(`正文内容足够长度以通过检查。
> [!tip]- 提示标题
> 折叠的内容。`);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('提示标题');
    expect(result!.cleanContent).not.toContain('[!tip]');
    expect(result!.cleanContent).not.toContain('-');
  });

  it('应处理默认展开的可折叠 callout > [!question]+', () => {
    const result = processContent(`正文内容足够长度以通过检查。
> [!question]+ 问答标题
> 展开的内容。`);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('问答标题');
    expect(result!.cleanContent).not.toContain('[!question]');
  });

  it('应处理嵌套 callout', () => {
    const result = processContent(`正文内容足够长度以通过检查。
> [!note] 外层
> 外层内容
> > [!tip] 内层
> > 内层内容`);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain('[!note]');
    expect(result!.cleanContent).not.toContain('[!tip]');
    expect(result!.cleanContent).toContain('外层内容');
    expect(result!.cleanContent).toContain('内层内容');
  });

  it('无标题的 callout 应整行移除标记行', () => {
    const result = processContent(`正文内容足够长度以通过检查。
> [!warning]
> 警告内容在这里。`);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain('[!warning]');
    expect(result!.cleanContent).toContain('警告内容在这里');
  });
});

// ================================================================
// 8. 其他处理
// ================================================================

describe('Checkbox', () => {
  it('- [x] 应转为 [已完成]', () => {
    const result = processContent(pad('- [x] 完成的任务'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[已完成]');
    expect(result!.cleanContent).toContain('完成的任务');
  });

  it('- [>] 应转为 [推迟]', () => {
    const result = processContent(pad('- [>] 延期的任务'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[推迟]');
  });

  it('- [ ] 应转为 [待办]', () => {
    const result = processContent(pad('- [ ] 未完成的任务'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[待办]');
  });

  it('- [/] 应转为 [半完成]', () => {
    const result = processContent(pad('- [/] 做了一半的事'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[半完成]');
  });
});

describe('HTML 清理', () => {
  it('应移除 <iframe>...</iframe>', () => {
    const result = processContent(pad('内容 <iframe src="https://example.com"></iframe> 后续'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain('iframe');
    expect(result!.cleanContent).not.toContain('example.com');
  });

  it('<mark> 标签应保留文本', () => {
    const result = processContent(pad('这是 <mark>高亮文本</mark> 的示例'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('高亮文本');
    expect(result!.cleanContent).not.toContain('<mark>');
  });

  it('<br> 应转为换行', () => {
    const result = processContent(pad('第一行<br>第二行<br/>第三行'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('第一行');
    expect(result!.cleanContent).toContain('第二行');
    expect(result!.cleanContent).not.toContain('<br');
  });
});

describe('插件代码块', () => {
  it('应移除 ```dataview 代码块并提取查询到 metadata', () => {
    const result = processContent(`正文内容足够长度以通过检查。
\`\`\`dataview
TABLE file.mtime AS "修改时间"
FROM #读书
SORT file.mtime DESC
\`\`\`
其他内容继续。`);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain('dataview');
    expect(result!.cleanContent).not.toContain('TABLE');
    expect(result!.metadata.properties['dataview_queries']).toBeTruthy();
    const queries = JSON.parse(result!.metadata.properties['dataview_queries']);
    expect(queries[0]).toContain('TABLE');
  });

  it('应移除 ```tasks 代码块', () => {
    const result = processContent(`正文内容足够长度以通过检查。
\`\`\`tasks
not done
due before tomorrow
\`\`\`
其他内容继续。`);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain('tasks');
    expect(result!.cleanContent).not.toContain('not done');
  });

  it('应保留普通代码块', () => {
    const result = processContent(`正文内容足够长度以通过检查。
\`\`\`python
print("hello")
\`\`\`
其他内容。`);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('print("hello")');
  });
});

describe('%%注释%% 处理', () => {
  it('应移除单行 %%注释%%', () => {
    const result = processContent(pad('可见内容 %%这是注释%% 更多可见'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain('这是注释');
    expect(result!.cleanContent).toContain('可见内容');
  });

  it('应移除多行 %%注释%%', () => {
    const result = processContent(`可见内容足够长度以通过检查。
%%
多行注释
第二行注释
%%
更多可见内容。`);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain('多行注释');
    expect(result!.cleanContent).toContain('可见内容');
  });
});

describe('^block-id 处理', () => {
  it('应移除行尾 ^block-id', () => {
    const result = processContent(pad('这是一段内容 ^abc-123'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain('^abc-123');
    expect(result!.cleanContent).toContain('这是一段内容');
  });
});

describe('==highlight== 和 ~~strikethrough~~', () => {
  it('==text== 应去除标记保留文本', () => {
    const result = processContent(pad('这是 ==高亮内容== 的示例'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('高亮内容');
    expect(result!.cleanContent).not.toContain('==');
  });

  it('~~text~~ 应去除标记保留文本', () => {
    const result = processContent(pad('这是 ~~删除线~~ 的示例'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('删除线');
    expect(result!.cleanContent).not.toContain('~~');
  });
});

describe('脚注', () => {
  it('脚注定义 [^1]: ... 应被移除', () => {
    const result = processContent(`正文内容足够长度以通过检查。
这是引用[^1]的内容。

[^1]: 这是脚注的定义内容。`);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain('这是脚注的定义内容');
  });

  it('脚注引用 [^1] 应保留', () => {
    const result = processContent(`正文内容足够长度以通过检查。
这里有一个脚注引用[^note]。`);

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[^note]');
  });
});

describe('超长行处理', () => {
  it('超过 10000 字符的行应被跳过（不影响代码区域判断）', () => {
    const longLine = 'a'.repeat(10001);
    const result = processContent(`正文内容足够长度以通过检查。
${longLine}
这是正常行，包含 [[链接]] 和 #标签。`);

    expect(result).not.toBeNull();
    // 正常行中的链接和标签仍应被提取
    expect(result!.metadata.pageRefs).toContain('链接');
    expect(result!.metadata.tags).toContain('标签');
  });
});

describe('未闭合的代码围栏', () => {
  it('未闭合的围栏应视为非代码区域', () => {
    const result = processContent(`正文内容足够长度以通过检查。
\`\`\`
这是未闭合的围栏
[[某个链接]] 应该被提取
这里有 #标签`);

    expect(result).not.toBeNull();
    // 未闭合的围栏视为无效，里面的内容应正常处理
    expect(result!.metadata.pageRefs).toContain('某个链接');
    expect(result!.metadata.tags).toContain('标签');
  });
});

describe('Readwise 标记', () => {
  it('([View Highlight](url)) 应被移除', () => {
    const result = processContent(pad('重要内容 ([View Highlight](https://read.readwise.io/read/01h1234)) 后续'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain('View Highlight');
    expect(result!.cleanContent).not.toContain('readwise');
    expect(result!.cleanContent).toContain('重要内容');
  });
});

describe('Templater 语法清理', () => {
  it('正文中的 <% ... %> 应被移除', () => {
    const result = processContent(pad('内容 <% tp.date.now("YYYY-MM-DD") %> 后续'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).not.toContain('<%');
    expect(result!.cleanContent).not.toContain('tp.date');
  });
});

// ================================================================
// 文件索引与 NFC 归一化
// ================================================================

describe('文件索引', () => {
  it('应构建文件索引并支持 NFC 归一化', () => {
    writeFile('vault/note1.md', `---
aliases:
  - 别名一
---
内容足够长度以通过检查。`);
    writeFile('vault/note2.md', '另一个笔记的内容，需要足够长。');
    writeFile('vault/sub/deep.md', '深层目录的笔记内容足够长。');

    const vaultRoot = path.join(tmpDir, 'vault');
    const index = buildFileIndex(vaultRoot, []);

    expect(index.size).toBeGreaterThanOrEqual(3);
    // 文件名应在索引中（小写）
    expect(index.has('note1')).toBe(true);
    expect(index.has('note2')).toBe(true);
    expect(index.has('deep')).toBe(true);
    // alias 也应在索引中
    expect(index.has('别名一')).toBe(true);
  });

  it('应排除指定目录', () => {
    writeFile('vault2/normal.md', '正常文件内容足够长。');
    writeFile('vault2/.obsidian/config.md', '系统文件。');
    writeFile('vault2/templates/tmpl.md', '模板文件。');

    const vaultRoot = path.join(tmpDir, 'vault2');
    const files = walkMdFiles(vaultRoot, ['.obsidian', 'templates']);

    const relPaths = files.map(f => path.relative(vaultRoot, f).replace(/\\/g, '/'));
    expect(relPaths).toContain('normal.md');
    expect(relPaths).not.toContain('.obsidian/config.md');
    expect(relPaths).not.toContain('templates/tmpl.md');
  });
});

describe('shouldProcessFile', () => {
  it('应接受 .md 文件', () => {
    expect(shouldProcessFile('notes/test.md', [])).toBe(true);
  });

  it('应拒绝非 .md 文件', () => {
    expect(shouldProcessFile('notes/test.txt', [])).toBe(false);
    expect(shouldProcessFile('notes/test.png', [])).toBe(false);
  });

  it('应排除指定目录下的文件', () => {
    expect(shouldProcessFile('.obsidian/config.md', ['.obsidian'])).toBe(false);
    expect(shouldProcessFile('templates/daily.md', ['templates'])).toBe(false);
  });
});

// ================================================================
// 边界情况
// ================================================================

describe('边界情况', () => {
  it('极短文件应返回 null', () => {
    const result = processContent('短');
    expect(result).toBeNull();
  });

  it('空文件应返回 null', () => {
    const result = processContent('');
    expect(result).toBeNull();
  });

  it('只有 frontmatter 无正文的文件应返回 null', () => {
    const result = processContent(`---
title: 只有标题
---`);
    expect(result).toBeNull();
  });

  it('不存在的文件应返回 null', () => {
    const result = preprocessFile('/nonexistent/path/file.md', tmpDir);
    expect(result).toBeNull();
  });

  it('标题应从 frontmatter title 推断', () => {
    const result = processContent(`---
title: 自定义标题
---
正文内容足够长度以通过预处理器的最小长度检查。`);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('自定义标题');
    // title 不应残留在 properties 中
    expect(result!.metadata.properties['title']).toBeUndefined();
  });

  it('无 title 时应从文件名推断标题', () => {
    const result = processContent(
      '正文内容足够长度以通过预处理器的最小长度检查。',
      'My%20Note.md',
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe('My Note');
  });

  it('系统属性应被过滤', () => {
    const result = processContent(`---
cssclasses: wide-page
publish: true
permalink: /my-page
---
正文内容足够长度以通过预处理器的最小长度检查。`);

    expect(result).not.toBeNull();
    expect(result!.metadata.properties['cssclasses']).toBeUndefined();
    expect(result!.metadata.properties['publish']).toBeUndefined();
    expect(result!.metadata.properties['permalink']).toBeUndefined();
  });

  it('连续空行应被压缩', () => {
    const result = processContent(`正文内容足够长度。



很多空行后面的内容。`);

    expect(result).not.toBeNull();
    // 3+ 空行应被压缩为 2 行
    expect(result!.cleanContent).not.toMatch(/\n{3,}/);
  });

  it('data URI 图片应转为 [内联图片]', () => {
    const result = processContent(pad('嵌入 ![](data:image/png;base64,abc123) 图片'));

    expect(result).not.toBeNull();
    expect(result!.cleanContent).toContain('[内联图片]');
  });
});
