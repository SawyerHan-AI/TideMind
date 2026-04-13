import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { getDataDir } from '../config.js';
import { today } from '../utils/time.js';

export function appendToStream(entry: {
  tool?: string;
  session?: string;
  content: string;
  files?: string[];
}): string {
  const streamDir = path.join(getDataDir(), 'stream');
  const fileName = `${today()}.md`;
  const filePath = path.join(streamDir, fileName);

  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const anchorId = `s-${time.replace(/:/g, '')}${ms}-${nanoid(4)}`;

  const header = [
    `## ${time}`,
    entry.tool ? ` · ${entry.tool}` : '',
    entry.session ? ` · ${entry.session}` : '',
  ].join('');

  const parts = [`<a id="${anchorId}"></a>`, '', header, ''];
  parts.push(entry.content);
  if (entry.files?.length) parts.push('', `files: ${entry.files.join(', ')}`);
  parts.push('', '---', '');

  const block = parts.join('\n');

  // 追加写入：文件不存在时先写入头部，然后追加内容
  let fileExists = true;
  try {
    fs.accessSync(filePath);
  } catch {
    fileExists = false;
  }
  if (!fileExists) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `# ${today()}\n\n`);
  }
  fs.appendFileSync(filePath, block);

  // 返回 stream 锚点引用（fragment-level）
  return `stream/${fileName}#${anchorId}`;
}
