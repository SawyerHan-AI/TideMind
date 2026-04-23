#!/usr/bin/env node
/**
 * 版本号一致性守护:6 处版本号必须完全一致,CI 中跑,漂移立即 fail。
 *
 * 追踪的位置:
 *   1. package.json (root)
 *   2. client/package.json
 *   3. pro/cloud-server/package.json
 *   4. pro/cloud-server/src/server.ts     ("status":"ok","version":"X.Y.Z")
 *   5. pro/cloud-server/src/mcp/handler.ts (version: 'X.Y.Z')
 *   6. client/src/components/settings/AboutSection.tsx (useState('X.Y.Z'))
 *
 * 注意:lockfile 也要对齐,但 lockfile 修改依赖 npm install,CI 不在这里查
 * (npm ci 本身会校验 lockfile version)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Sanity: 脚本路径解析依赖 scripts/ 在仓库根目录下。若脚本被 symlink 到别处,
// ROOT 推断会失败——用 root package.json 存在性作为守卫。
if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
  console.error(`❌ check-version-sync: ROOT resolved to ${ROOT} but package.json not found.`);
  console.error('   脚本必须从仓库 scripts/ 目录运行,不要 symlink 到别处。');
  process.exit(1);
}

const checks = [
  {
    file: 'package.json',
    extract: (content) => JSON.parse(content).version,
  },
  {
    file: 'client/package.json',
    extract: (content) => JSON.parse(content).version,
  },
  {
    file: 'pro/cloud-server/package.json',
    extract: (content) => JSON.parse(content).version,
  },
  {
    // server.ts: 唯一的 "status":"ok","version":"X.Y.Z" 健康检查响应字面量
    file: 'pro/cloud-server/src/server.ts',
    extract: (content) => content.match(/status:\s*'ok',\s*version:\s*'([\d.]+)'/)?.[1],
  },
  {
    // handler.ts: new McpServer({ name: 'tidemind-cloud', version: '...' })
    // 用 name 做 anchor 避免被其他 SDK 的 version 字面量劫持
    file: 'pro/cloud-server/src/mcp/handler.ts',
    extract: (content) =>
      content.match(/name:\s*['"]tidemind-cloud['"],\s*version:\s*['"]([\d.]+)['"]/)?.[1],
  },
  {
    // AboutSection.tsx: const [currentVersion, setCurrentVersion] = useState('X.Y.Z')
    file: 'client/src/components/settings/AboutSection.tsx',
    extract: (content) =>
      content.match(/currentVersion[\s\S]*?useState\(['"]([\d.]+)['"]\)/)?.[1],
  },
];

const versions = new Map();
let hasMissing = false;

for (const c of checks) {
  const full = path.join(ROOT, c.file);
  if (!fs.existsSync(full)) {
    console.error(`❌ ${c.file}: missing`);
    hasMissing = true;
    continue;
  }
  const content = fs.readFileSync(full, 'utf8');
  const v = c.extract(content);
  if (!v) {
    console.error(`❌ ${c.file}: could not extract version`);
    hasMissing = true;
    continue;
  }
  versions.set(c.file, v);
}

if (hasMissing) process.exit(1);

const unique = new Set(versions.values());
if (unique.size !== 1) {
  console.error('\n❌ Version drift detected:');
  for (const [file, v] of versions) {
    console.error(`   ${v}  —  ${file}`);
  }
  console.error('\nAll 6 locations must show the same version.');
  process.exit(1);
}

console.log(`✓ Version sync OK — all 6 locations at ${[...unique][0]}`);
