# ExternaBrain 项目规则

## 开源/闭源架构

本仓库（ExternaBrain）是闭源开发仓库，对应产品品牌 **TideMind**。`pro/` 外全开源，`pro/` 内全闭源，无例外。

**核心规则**：
1. **开源代码永远不 import `pro/` 下的任何东西**（反过来可以）
2. 删除 `pro/` 后，开源版必须能独立编译、运行、通过所有测试
3. **永远不要直接修改开源仓库**（`~/Projects/tidemind`）——所有改动在本仓库进行，通过同步流程推送
4. 代码改动：改完后执行 `./sync-oss.sh ~/Projects/tidemind` 同步
5. 开源专属文件（README、LICENSE、CONTRIBUTING、docs/）：在 `oss-release/` 下编辑，手动复制到开源仓库
6. 用户说"推送 GitHub"时，默认指闭源仓库（ExternaBrain），除非明确说"推送开源仓库"

新增功能归属、Pro 模块加载机制、同步流程、PII 安全见 `docs/Codex-guides/oss-sync.md`。目录归属表见 `docs/Codex-guides/architecture.md`。

## 开发约定

### Backlog

开发过程中发现暂时不做但以后要做的事，统一记录到 `docs/backlog.md`，完成后勾掉并标注日期。格式：`- [ ] 描述（发现日期）`，完成后改为 `- [x] 描述 ✅ 已完成（完成日期）`。

### 安装与构建

**项目有四套 node_modules**：根目录、`client/`、`pro/cloud-server/`、`pro/website/`。fresh clone / 新 worktree 后跑 `npm run setup` 一键全装；之后改完 `src/` 要 `npm run build`，Electron 客户端才能拿到新代码。

常用命令、安装细节见 `docs/Codex-guides/dev-setup.md`。运行时数据目录见 `docs/Codex-guides/runtime-data.md`。

### Self-hosted CI

私有 `ExternaBrain` 当前所有CI job都由Mac Studio承载；公开 `TideMind` 的CI与双架构发版仍使用GitHub-hosted runner。修改runner labels、workflow路由、隔离、维护或恢复流程前，必须先读 `docs/Codex-guides/self-hosted-ci-operations.md`。

### Stabilization Cycle（2026-04-24 起）

项目进入 2-4 周稳定化重构周期，当前目标是降低回归率，不做完整重写。

本周期内暂停新增大功能：新笔记源、新远程 Agent、新付费计划、新云端代谢策略、新大 UI 页面、大范围视觉重构。允许 P0/P1 bug fix、回归测试、类型修复、lint 修复、CI 增强、局部服务化重构。

改动前后优先运行 `npm run health` 查看全仓质量状态。client build 和 client typecheck 都是阻塞项。

### Feature merge → 必走的 audit subagent 流程（2026-05-20 起）

任何一次包含 ≥1 个**新 feature** 的 merge 进 main 之前，必须**并行派 ≥3 个 Opus subagent** 对改动区域做 end-to-end 审计，标出 CRITICAL/HIGH 后才能发版。理由：2026-05-19 / 2026-05-20 两轮事后审计平均每个 feature 找出 14 个潜 bug、3 个 CRITICAL/HIGH，证明"feature 着急上线 → 跳审 → 事后修"的代价比"feature 上线前花 1 小时跑 audit 流程"贵得多。

适用范围：
- 新 feature merge（即便只是 1 个 commit）
- 大重构 / 跨子系统改动
- 安全关键路径（auth / billing / sync / 签名）的任何改动

不适用：纯文档 / 纯依赖升级 / 纯 typo 修复。

执行：见 `docs/Codex-guides/release-checklist.md §audit-subagent-protocol`。

### 日志

**stdout 保留给 MCP 协议，禁止使用 `console.log`。** 所有日志通过 `createLogger` 输出到 stderr：

```typescript
import { createLogger } from './utils/logger.js';
const log = createLogger('module-name');  // 输出前缀 [eb:module-name]
```

### Plugin 运行时（外部 Agent 对接）

**严禁**在任何 plugin 配置里写字面量 `"node"` 或硬编码 Electron 路径。必须用 `getShimPath()`、`getHookScriptPath()`、`getMcpServerScriptPath()`。

原理和详细规则见 `docs/Codex-guides/plugin-runtime.md`。

## 文本内容修改流程（Prompt / MCP 描述 / Skill）

**修改策略 Prompt（最常见）**：
1. 改 `data/strategies/{name}.system.md`
2. **同步修改**`src/llm/prompts.ts`（或对应 `.ts` 文件）中的 hardcoded fallback 常量
3. 重启 daemon

完整同步机制、Hardcoded Fallback 对照表见 `docs/Codex-guides/text-content-sync.md`。

## 多语言（i18n）

客户端使用 `react-i18next` 支持 12 种语言。**禁止硬编码 UI 文本**，所有文本用 `t('namespace:key')` 获取。新增文本时**必须同时更新所有 12 个语言的翻译文件**。

翻译文件结构、操作步骤见 `docs/Codex-guides/i18n.md`。

## 官网（pro/website/）

Astro + Tailwind CSS，托管在 Cloudflare Pages，域名 `tidemind.ai`。**不会随 git push 自动部署**，必须手动：`cd pro/website && npx astro build && npx wrangler pages deploy dist/ --project-name tidemind-website --branch=main`。**必须带 `--branch=main`**，否则只部署到 preview 环境。

**核心规则**：所有文本通过 `src/i18n/en.ts` 和 `zh.ts` 管理，修改时必须同时更新中英文。

技术栈、视觉规范、部署流程见 `docs/Codex-guides/website.md`。

## 部署（Railway 云服务 + Cloudflare Pages 官网 + GitHub Release DMG）

**三个部署目标各有各的触发方式，发版不能只做其中一个**：

| 目标 | 触发方式 |
|------|---------|
| Railway 云服务（含 DB 迁移） | `git push origin main` 自动 |
| Cloudflare Pages 官网 | **手动** `wrangler pages deploy --branch=main` |
| GitHub Release DMG | `git push origin vX.Y.Z` tag（在开源仓库打） |

完整发版 checklist、版本号 6 处同步位置、常见坑见 `docs/Codex-guides/release-checklist.md`。

## 数据库迁移

- Schema 迁移放 `pro/cloud-server/src/db/migrations/00N-xxx.sql`，Railway Pre-Deploy 自动跑
- 一次性数据迁移放 `pro/cloud-server/src/db/runbooks/*.sql`，手动执行
- **所有 schema SQL 必须完全幂等**。`CREATE POLICY` / `CREATE TRIGGER` 没有 `IF NOT EXISTS`，必须 `DROP ... IF EXISTS` + `CREATE ...` 配对

规则和踩过的坑见 `docs/Codex-guides/db-migrations.md`。

## 用户笔记文件读取

**任何读用户 vault / graph 下笔记文件的代码必须走 `src/utils/safe-fs.ts`，不能直接 `fs.readFileSync`。**

原因：macOS iCloud "优化存储"会把文件驱逐到云端，`size>0 blocks=0` 的 dataless 文件被 `readFileSync` 命中时内核会**同步阻塞**触发下载，无网时永不返回，直接锁死 Electron 主进程（v0.2.41 卡死过）。

- 读文件用 `safeReadTextFileSync(path)`，返回 `{ok, content}` 或 `{ok:false, reason}`
- 扫描目录用 `walkFilesFiltered()`（或 Logseq/Obsidian 自己的 `walkMdFiles`，内部已接入）
- `stat` 不会触发下载，可以放心用 `safeStatSync`
- 应用自身配置文件（`logseq/config.edn`、`.obsidian/*.json`）不走 safe-fs，出错应抛错

## 关键防坑规则（反复踩过的）

1. **开源仓库 commit message 必须是英文，不能提 `pro/` 下任何内容**（会通过 `generate_release_notes` 泄漏到公开 Release）。发版时**手写** Release Notes，不要用自动生成。
2. **生产环境脚本用的 npm bin（如 `tsx`）必须在 `dependencies` 不是 `devDependencies`**。Dockerfile 用 `npm ci --omit=dev`。
3. **容器里的 shell 命令先看 Dockerfile 的 `WORKDIR`**。Railway Pre-Deploy Command 是 `npm run migrate`（不带 cd），因为 WORKDIR 已经是 `/app/pro/cloud-server`。
4. **schema.sql 必须完全幂等**（包括 policies）。绝不依赖"检测已有 DB 再决定跑不跑"的启发式。
5. **`sync-oss.sh` 必须从主 repo 跑，不能从 worktree 跑**（worktree 的 `.git` 是文件不是目录，rsync 会冲突报 exit 23）。
6. **不确定的建议不要给**。不要说"先点也行"然后让用户发现不行；先想清楚副作用再发话。
7. **读用户笔记文件不能用 `fs.readFileSync`**。iCloud dataless 文件会同步阻塞主进程。走 `safe-fs.ts`。
8. **发版前 `git branch --show-current` 确认在 main**。v0.2.66 / v0.2.67 各踩过一次:working tree 实际在 feature 分支(`feat/creem-integration` / `feat/llm-outage-resilience`),版本号 + sync-oss 改动 commit 进错分支后救回来很麻烦。
9. **签名脚本改动必须本地用客户端嵌入公钥自验**。`scripts/release.mjs` / `scripts/sign-existing-release.mjs` 改完跑一次本地验签(见 `release-checklist.md` §签名脚本陷阱),"签出来内容看起来对" 不等于客户端能验过——v0.2.66 没自验直接上线让全量客户端"更新被拒绝(签名异常)",两次发版才救回。三种已知陷阱:gh CLI 字段命名跟 REST API 反着 / draft vs published 的 asset.url 不同 / 改完没自验。脚本现在用 hardcoded URL 已绕开,但任何改动仍必须自验。`release.mjs` 目前**没有**自动自验,发版后必须手动跑一次(见 release-checklist §签名脚本陷阱 §陷阱 3)。
10. **新增 timing / perf / 重 I/O 敏感测试必须显式给足 timeout(≥30s),不要吃 5s 默认**。发版 `sync-oss.sh` 会在发版机器**峰值负载**下(刚跑完 electron-rebuild + 两次 electron-vite build)用 vitest 并行跑**全量 OSS 测试**作为 fail-fast。大 seeding(如 reconciler 2w 行)、大循环(如 staging 1000 次 tmpdir)、统计/perf 类测试在这种负载下 5s 默认 timeout 会偶发超时**直接卡死发版**(主 repo `npm run health` 负载低时不复现,所以骗过本地)。v0.2.74 踩过两次。放宽的是**框架 timeout**,perf/统计断言本身不放宽。
11. **改 `sync-oss.sh` 的 PII 扫描 / rsync exclude 前先看它为什么 `git clean -fdX native/`**。OSS repo 里上一轮 sync 的 `cd client && npm install` 会编译 in-tree native module(secure-store-mac)留下 gitignored 的 `.o`/`.node`/Makefile(含 build 机绝对路径),PII 扫描整树会误拦。扫描前的 `git clean -fdX -- client/electron/native/` 就是清这个(`-X` 只删 gitignored,真 PII 仍会被捕获)。别"优化"掉它(v0.2.74 踩过)。
12. **`cloud-server` 的非 `.ts` 运行时资源(`.eta` 模板等)必须靠 `npm run build` 显式复制进 `dist/`,`tsc` 绝不搬运它们**。生产以 `node dist/...` 跑编译产物,`renderer.ts` 的 `views: __dirname` 指向 dist 里的 templates 目录——那里没有 `.eta` 就 `EtaFileResolutionError` 全站 500。`build` 脚本末尾的 `node scripts/copy-templates.mjs` 负责复制 + 自校验(数量不符 exit 1 让 build fail-fast),**别删**。注意该脚本不在 `src/` 下,Dockerfile builder stage 必须单独 `COPY pro/cloud-server/scripts/ ./scripts/`(在 `npm run build` 前),否则容器里 build 报 `MODULE_NOT_FOUND` —— 本地 build 因文件在场会骗过你,只有 Docker build 才暴露(第一次发版即踩)。单测跑的是源码(tsx)路径,`__dirname` 永远命中源码旁的 `.eta`,测全绿也骗不过生产——验证模板改动必须 `npm run build` 后跑 `node dist/...` 真实渲染。`e08a7bd`(tsx→node multi-stage)引入此洞,潜伏一个月到 2026-06-22 登录全挂才暴露。

## 测试数据

测试中禁止使用真实个人信息。使用虚构数据（星海科技、DataPilot 等）。同步脚本的 PII 扫描会兜底拦截。
