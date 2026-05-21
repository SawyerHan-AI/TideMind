#!/usr/bin/env node
// 把 src/hook-session-start.ts 和 src/index.ts 打包成自包含的 CJS 单文件
// 输出到 client/out/bin/，dev 和 packaged 模式统一使用这份产物
//
// 为什么要独立脚本而不是塞进 electron.vite.config.ts：
//   - electron-vite 的 main 过 rollup 流水线，和我们这里的需求（external only native modules、CJS 输出、多入口）不完全兼容
//   - 独立脚本更易调试，也能被 electron-builder 的 beforeBuild hook 复用

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const CLIENT_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..')
const OUT_DIR = path.resolve(CLIENT_ROOT, 'out', 'bin')

// 保持 external 的只有 native 模块——它们必须在运行时由 node 从 node_modules 里加载
// Electron-as-node 下会从脚本同级目录向上解析 node_modules，
// client/node_modules（含 better-sqlite3、sqlite-vec）在 dev 和 packaged 下都能找到
const NATIVE_EXTERNALS = ['better-sqlite3', 'sqlite-vec']

const entries = [
  {
    entry: path.join(REPO_ROOT, 'src', 'hook-session-start.ts'),
    out: 'hook-session-start.cjs',
  },
  {
    entry: path.join(REPO_ROOT, 'src', 'hook-pre-compact.ts'),
    out: 'hook-pre-compact.cjs',
  },
  {
    entry: path.join(REPO_ROOT, 'src', 'hook-post-compact.ts'),
    out: 'hook-post-compact.cjs',
  },
  {
    entry: path.join(REPO_ROOT, 'src', 'index.ts'),
    out: 'mcp-server.cjs',
  },
  {
    // structure-holes 计算 worker(v0.2.74 CRITICAL #1):worker_threads 入口,
    // 主线程通过 new Worker(out/bin/structure-holes-worker.cjs) 起,避免 O(E²/V)
    // 同步 SQL 冻死 Electron 主线程。better-sqlite3 作 external 运行时加载(同 mcp-server)。
    entry: path.join(REPO_ROOT, 'src', 'graph', 'structure-holes-worker.ts'),
    out: 'structure-holes-worker.cjs',
  },
]

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  for (const { entry, out } of entries) {
    if (!fs.existsSync(entry)) {
      console.error(`[build-bin] 源文件不存在: ${entry}`)
      process.exit(1)
    }

    await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs', // 使用 CJS 避免 require/import 混用的 interop 陷阱
      outfile: path.join(OUT_DIR, out),
      external: NATIVE_EXTERNALS,
      sourcemap: false,
      minify: false,
      // 把 ESM 语法替换成 CJS 等价物：import.meta.url 在 CJS 里无效，
      // 用 __filename 生成 file:// URL 顶替。这样源码保持 ESM 风格（dev 模式 tsx 照跑），
      // bundle 之后也能正确拿到文件路径。
      // banner 在生成的 CJS 最顶端声明一个全局别名，esbuild 的 define 把所有
      // import.meta.url 替换成这个别名——这样整个 bundle 里所有 ESM helper 拿到的
      // URL 都是当前 bundle 文件的 file:// URL。
      define: {
        'import.meta.url': '__tm_bundle_url__',
      },
      banner: {
        js: '"use strict"; const __tm_bundle_url__ = require("node:url").pathToFileURL(__filename).href;',
      },
      logLevel: 'warning',
    })

    const size = (fs.statSync(path.join(OUT_DIR, out)).size / 1024).toFixed(1)
    console.log(`[build-bin] ✓ ${out} (${size} KB)`)
  }
}

main().catch((err) => {
  console.error('[build-bin] 失败:', err)
  process.exit(1)
})
