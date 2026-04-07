# AGENTS.md

## 项目概览

`agent-plugin` 是 `message-bridge` 和 `message-bridge-openclaw` 的主开发仓库。`integration/opencode-cui` 只是联调夹具 submodule，不是主开发位置。

## 仓库结构

- `plugins/message-bridge`：OpenCode 侧主插件
- `plugins/message-bridge-openclaw`：OpenClaw 侧适配插件
- `packages/test-support`：共享测试支持
- `integration/opencode-cui`：集成夹具 submodule

## 常用命令

只保留稳定的根入口命令；更细的脚本以根级和包内 `package.json` 为准。

- `pnpm build`
- `pnpm test`
- `pnpm verify:workspace`
- `pnpm verify:integration:fixture`
- `pnpm run test:openclaw:runtime`

## 工作边界

- 默认只在 `plugins/` 和 `packages/` 下做主开发
- 非专门任务不要修改 `integration/opencode-cui` 的内容或 submodule 指针
- 当前仓库默认向 `main` 提 PR；本仓库未使用 `canary` 作为日常开发基线
- 根规则只覆盖全仓库通用约束，不覆盖子目录专用规范
- 涉及 `plugins/message-bridge/docs/` 时，优先遵守该目录下的更细规则

## 测试与验证

- 纯文档改动：先校验路径、命令和作用域是否与现有仓库一致
- 代码改动：至少运行受影响包的测试
- 跨插件边界改动：优先运行 `pnpm verify:workspace`
- 仅修改集成夹具或其指针：至少运行 `pnpm verify:integration:fixture`

## 文档规则

- `plugins/message-bridge/docs/` 由该目录下的 `AGENTS.md` 统一治理
- 根文件只写仓库级通用规则，不复制子目录文档规范
- 详细背景继续放在各自 `README.md` 或子目录文档中
- 提 PR 时必须使用 `.github/PULL_REQUEST_TEMPLATE.md`，并遵循 `docs/operations/pull-request-process.md` 中的流程、字段要求与检查项
- 提 Issue 时使用 `.github/ISSUE_TEMPLATE/` 下对应表单
- PR 详细流程、字段要求、检查项统一维护在 `docs/operations/pull-request-process.md`

## 注释规则

- 关键流程接口、跨层边界入口、统一发送出口必须补充简洁中文注释，说明职责边界、输入输出语义或 fail-closed 约束
- 优先注释 `facade`、`port`、`validator`、runtime 统一发送/校验入口，不要求为简单 getter、纯数据类型字段或显而易见的实现细节补注释
- 注释应解释“为什么这里存在”或“这条链路的边界是什么”，避免重复代码字面含义

## 语言规则

- 用户可见输出、仓库文档、注释默认使用简体中文
- 代码标识符、命令、配置键、协议字段保持英文

## 规则优先级

- 更深层目录下的 `AGENTS.md` 优先于根规则
- 如果子目录规则与根规则冲突，以子目录规则为准
- 本文件是仓库默认规则入口，其他目录可在自己的作用域内进一步收紧约束
