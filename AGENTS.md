# ExternaBrain 项目约束

本仓库是 TideMind 的闭源开发源；`pro/` 外开源、内闭源。公开同步目标是 `~/Projects/tidemind`，不能把两者当作同一工作目录。

## 核心约束

- 开源代码不得 import pro/；移除 pro/ 后必须独立编译、运行并通过测试。所有改动在本仓库进行，不直接改公开镜像；公开专属内容在 oss-release/ 编辑。
- 代码改动后的 OSS 同步走 `sync-oss.sh`，只能从主仓库运行，不能从 worktree 运行；执行同步前读下表同步指南。用户说“推送 GitHub”默认指 ExternaBrain，除非明确要求公开仓库。
- 公开 commit 必须英文且不含闭源内容，Release Notes 手写；测试用虚构数据，禁止真实个人信息。同步、发布和文档提交不得泄漏凭据或私人内容。
- MCP stdout 仅供协议，禁止 console.log，日志用 createLogger 输出 stderr。Plugin 配置不写字面量 node 或 Electron 绝对路径，使用 getShimPath/getHookScriptPath/getMcpServerScriptPath。
- 修改策略 Prompt 必须同步对应 hardcoded fallback，并按文本同步指南使 daemon 加载；客户端文本用 t() 并同步全部 12 种语言，官网文案同步 en.ts/zh.ts。
- 用户 vault/graph 笔记读写相关实现先查 safe-fs 规则：读取必须经 `src/utils/safe-fs.ts`，不得直接 fs.readFileSync；配置文件例外和扫描 API 见 runtime-data 及开发维护指南。
- Schema SQL 必须完全幂等；schema migration 与一次性数据 runbook 分开。生产依赖和非 TS 资源必须进入实际运行产物，不能用源码测试代替 dist／容器验证。
- 修改 src/ 后 npm run build 才能让 Electron 取得新代码；改动前后优先 npm run health，client build/typecheck 是阻塞项。安装或升级前执行全局依赖安全检查。
- 新 feature merge、大重构／跨子系统、安全关键路径（auth/billing/sync/签名）改动，保留 3 路 Sol（默认 GPT-6.1 Sol）并行 end-to-end 交叉审计门禁；纯文档、纯依赖升级、纯 typo 不适用。具体流程见 release-checklist。
- 发布前确认 main；签名脚本任何改动及发版后的客户端公钥验签要求保留。三种部署目标的范围与触发方式必须按 release-checklist 核对，不能只完成一步就报告发版完成。
- 2026-04-24 稳定化周期的结束状态尚未复核；涉及新增大功能或大重构前先读下方范围说明，不自动解除原限制。实质改动更新相关文档、backlog 和按日工作日志。

## 按任务读取

在首次修改或执行对应动作前读取匹配行；只读相关文档，不开场全量加载。`docs/claude-guides/` 是共用手册，Codex 可直接读取，不复制为另一套文档。

| 触发任务 | 必读文档 |
|---|---|
| 新功能归属、开闭源边界、定位模块 | `docs/claude-guides/architecture.md`、`docs/claude-guides/oss-sync.md` |
| 新功能／重构范围、backlog、日志、测试规则 | `docs/Codex-guides/agent-maintenance.md` 的对应章节 |
| clone/worktree 后安装、开发命令、构建 | `docs/claude-guides/dev-setup.md` |
| 运行目录、用户笔记、iCloud safe-fs | `docs/claude-guides/runtime-data.md`；safe-fs 例外及 API 补充见 `docs/Codex-guides/agent-maintenance.md` |
| 同步 OSS、PII 扫描、rsync exclude | `docs/claude-guides/oss-sync.md`、`docs/claude-guides/release-checklist.md` 中同步与 PII 章节 |
| Prompt、MCP description、Skill、fallback | `docs/claude-guides/text-content-sync.md` |
| Plugin 配置、外部 Agent 运行时路径 | `docs/claude-guides/plugin-runtime.md` |
| 外部 Agent 安装、配置写入、schema、Host Adapter | `docs/Codex-guides/local-agent-integration-safety.md` |
| 后台 runtime 启动／初始化 | `docs/Codex-guides/background-runtime-startup-initialization.md` |
| 本地账号 CLI LLM provider | `docs/Codex-guides/local-account-cli-llm-providers.md` |
| 客户端文案／翻译 | `docs/claude-guides/i18n.md` |
| 官网文案／样式／Cloudflare Pages | `docs/claude-guides/website.md`；部署时另读 release-checklist |
| 数据库 schema／数据迁移 | `docs/claude-guides/db-migrations.md` |
| cloud-server、Docker、生产构建／模板 | `docs/Codex-guides/agent-maintenance.md` 的生产构建章节 |
| CI runner、labels、隔离／恢复 | `docs/Codex-guides/self-hosted-ci-operations.md` |
| Feature 合并审计、部署、tag、签名／更新 | `docs/claude-guides/release-checklist.md`；敏感 timing/perf 测试另读开发维护指南 |
