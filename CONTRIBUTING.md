# Contributing to TideMind

Thanks for your interest in TideMind! This is a young project, and contributions of all kinds are welcome — bug reports, feature ideas, documentation improvements, and code.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/SawyerHan-AI/tidemind/issues) with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, Node.js version, which AI tool you're connecting through)

## Suggesting Features

Open a GitHub Issue with the `feature` label. Describe the problem you're trying to solve, not just the solution you have in mind — it helps us understand the context and find the best approach.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/SawyerHan-AI/tidemind.git
cd tidemind

# Install dependencies (the project has TWO sets of node_modules)
npm install
cd client && npm install && cd ..

# Build the server
npm run build

# Run tests
npm test
```

After modifying files in `src/`, run `npm run build` again — the Electron client loads the compiled output from `dist/`.

## Code Style

- **TypeScript** throughout. Follow the existing ESLint configuration.
- **No `console.log`** — stdout is reserved for the MCP protocol. Use the project logger:

```typescript
import { createLogger } from './utils/logger.js';
const log = createLogger('my-module');
```

- Keep functions focused. Prefer small, testable units over large procedural blocks.

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Add or update tests if applicable
4. Run `npm test` and make sure everything passes
5. Run `npm run build` to verify the build succeeds
6. Open a PR with a clear description of what changed and why

Keep PRs focused — one logical change per PR is easier to review than a combined refactor-plus-feature.

## i18n

The desktop client supports 12 languages. If your change adds or modifies any user-facing text in the client:

- Use `t('namespace:key')` — never hardcode UI strings
- Update **all 12** translation files in `client/src/i18n/locales/`

## Tests

- Test framework: **Vitest**
- Database tests use in-memory SQLite
- Run the full suite with `npm test`

## Code of Conduct

Be kind, be constructive, be respectful. We're all here to build something useful.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

---

# 贡献指南

感谢你对 TideMind 的关注！这是一个年轻的项目，欢迎各种形式的贡献——Bug 报告、功能建议、文档改进、代码提交。

## 报告 Bug

在 [GitHub Issues](https://github.com/SawyerHan-AI/tidemind/issues) 中创建 Issue，包含：

- 你期望的行为
- 实际发生的行为
- 复现步骤
- 你的环境（操作系统、Node.js 版本、通过哪个 AI 工具连接）

## 建议新功能

创建带有 `feature` 标签的 GitHub Issue。描述你想解决的问题，而不仅仅是你想到的方案——这有助于我们理解上下文并找到最佳方案。

## 开发环境搭建

```bash
git clone https://github.com/SawyerHan-AI/tidemind.git
cd tidemind

# 项目有两套 node_modules，都要安装
npm install
cd client && npm install && cd ..

# 构建服务端
npm run build

# 运行测试
npm test
```

修改 `src/` 下的文件后需要重新 `npm run build`——Electron 客户端从 `dist/` 加载编译产物。

## 代码规范

- 全项目使用 **TypeScript**，遵循已有的 ESLint 配置
- **禁止使用 `console.log`**——stdout 保留给 MCP 协议，使用项目日志工具：

```typescript
import { createLogger } from './utils/logger.js';
const log = createLogger('my-module');
```

## Pull Request 流程

1. Fork 仓库，从 `main` 创建分支
2. 完成修改
3. 添加或更新测试
4. 运行 `npm test` 确保通过
5. 运行 `npm run build` 确保构建成功
6. 提交 PR，清楚描述改了什么、为什么改

每个 PR 只做一件事——比混合重构和新功能的大 PR 更容易 review。

## 多语言（i18n）

桌面客户端支持 12 种语言。如果你的改动涉及客户端的用户可见文本：

- 使用 `t('namespace:key')`，不要硬编码 UI 文本
- 同时更新 `client/src/i18n/locales/` 下**所有 12 个**翻译文件

## 协议

参与贡献即表示你同意你的贡献将以 [MIT 许可证](LICENSE) 发布。
