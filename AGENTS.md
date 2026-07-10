# Repository Guidelines（仓库指南）

## 目录结构说明

- `plugins/`：宿主插件。
  - `message-bridge/`：OpenCode 消息桥接插件。
  - `message-bridge-openclaw/`：OpenClaw 适配插件。
- `packages/`：共享能力。
  - `bridge-runtime-sdk/`：消息桥接 runtime SDK。
  - `gateway-client/`：gateway 连接客户端。
  - `gateway-schema/`：gateway 协议与 schema 校验。
  - `skill-plugin-cli/`：插件安装 CLI。
  - `skill-qrcode-auth/`：二维码认证能力。
  - `test-support/`：共享测试支持。
- `docs/`：仓库级规则、架构和协作流程。
- `scripts/`：仓库级构建、验证和发布脚本。
- `integration/`：外部集成夹具；非明确任务不要修改其内容或 submodule 指针。
- `.github/`：CI 工作流及 Issue、PR 模板。

各工作区通常使用 `src/` 存放生产代码、`tests/` 存放测试、`docs/` 存放模块文档。

## 构建、测试与开发命令

使用 Node.js 24+ 和 pnpm 9.15+。

- `pnpm build`：构建所有可发布的包和插件。
- `pnpm test`：运行完整工作区测试。
- `pnpm lint`：使用 ESLint 检查 JavaScript 和 TypeScript；提交聚焦变更前运行
  `pnpm lint:changed`。
- `pnpm verify:workspace`：运行 CI 使用的主要构建、测试、bundle 和边界检查。
- `pnpm verify:integration:fixture`：验证集成夹具。
- `pnpm --dir packages/bridge-runtime-sdk test`：运行指定工作区测试；按需替换目录。

## 规则入口与执行约束

开始任务前按改动范围阅读对应事实源：

- [代码治理规则](docs/rules/engineering.md)：工作边界、依赖方向、public contract、错误处理和日志脱敏。
- [测试治理规则](docs/rules/testing.md)：测试分层、最低验证范围和证据要求。
- [文档治理规则](docs/rules/documentation.md)：文档归属、状态、命名、归档和引用规则。
- [变更治理规则](docs/rules/change-management.md)：PR、Issue、发布、兼容性和迁移要求。

更深层目录中的 `AGENTS.md` 在其作用域内优先。保留无关工作区变更；完成前记录实际验证命令和结果。
规则与仓库事实冲突、专项流程缺失，或兼容性和发布影响不清楚时，停止扩大改动并先确认。
