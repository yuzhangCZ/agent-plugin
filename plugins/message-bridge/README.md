# Message Bridge Plugin

`message-bridge` 是一个 OpenCode 本地插件，用于通过 WebSocket 在本地 OpenCode 实例与远端 gateway 之间建立消息桥接。

当前实现采用分层边界架构：

- `contracts/`：外部边界契约
- `protocol/`：原始消息归一化与提取
- `runtime/`：编排、连接与传输
- `action/`：只负责业务执行

相关文档：

- [架构总览](./docs/architecture/overview.md)
- [源码布局](./docs/architecture/source-layout.md)
- [协议契约](./docs/design/interfaces/protocol-contract.md)
- [配置契约](./docs/design/interfaces/config-contract.md)
- [验证报告](./docs/quality/validation-report.md)
- [NPM 发布指南](./docs/operations/npm-publish-guide.md)

## 支持的下行消息

gateway 当前可以发送以下下行消息类型：

- `invoke`
- `status_query`

支持的 `invoke.action` 包括：

- `chat`
- `create_session`
- `close_session`
- `permission_reply`
- `abort_session`
- `question_reply`

### `chat`

```ts
payload: {
  toolSessionId: string;
  text: string;
}
```

### `create_session`

```ts
payload: {
  title?: string;
}
```

当前 `create_session.payload` 已收敛为 `title?: string`。这个契约来自 UI -> skill-server -> gateway 的上游链路追溯，不再把 payload 当作任意透传对象处理。

`create_session` 还要求顶层 `welinkSessionId` 为非空字符串；缺失时 runtime 会直接返回 `tool_error`，不会调用 SDK 创建会话。

### `close_session`

```ts
payload: {
  toolSessionId: string;
}
```

当前实现通过 `session.delete()` 执行 `close_session`。

### `permission_reply`

```ts
payload: {
  permissionId: string;
  toolSessionId: string;
  response: 'once' | 'always' | 'reject';
}
```

### `status_query`

独立消息形状：

```ts
{ type: 'status_query' }
```

### `abort_session`

```ts
payload: {
  toolSessionId: string;
}
```

### `question_reply`

```ts
payload: {
  toolSessionId: string;
  answer: string;
  toolCallId?: string;
}
```

该 action 会先通过 `GET /question` 查找 pending question，再通过 `POST /question/{requestID}/reply` 回复。

## 目录上下文

`BRIDGE_DIRECTORY` 已实现为 bridge 级目录上下文覆盖项：

- `workspacePath` 仅用于配置发现
- `effectiveDirectory` 只在 runtime 中统一决策一次
- 所有相关 SDK/raw API 调用都会复用同一个 `effectiveDirectory`

目录优先级为：

1. `BRIDGE_DIRECTORY`
2. `input.worktree || input.directory`
3. 不显式传递目录

## 当前 `tool_done` 行为

当前兼容层（compat）行为如下：

- `chat` 成功后主动发送 compat `tool_done`
- `session.idle` 仍会作为 `tool_event` 上行
- 如果同一次执行尚未发送 compat 完成信号，则 `session.idle` 会兜底发送 `tool_done`
- `create_session`、`close_session`、`abort_session`、`permission_reply`、`question_reply` 成功时当前不会主动发送 `tool_done`

## 支持的上行事件

默认 allowlist 是一个精确事件列表：

- `message.updated`
- `message.part.updated`
- `message.part.delta`
- `message.part.removed`
- `session.status`
- `session.idle`
- `session.updated`
- `session.error`
- `permission.updated`
- `permission.asked`
- `question.asked`

不再使用 `message.*`、`session.*` 这类 wildcard 默认值。

上行传输消息保持为：

```ts
{
  type: 'tool_event',
  toolSessionId: string,
  event: SupportedUpstreamEvent
}
```

## 传输消息

bridge 到 gateway 的上行消息当前包括：

- `register`
- `heartbeat`
- `tool_event`
- `tool_error`
- `session_created`
- `status_response`

响应形状：

- `tool_error`：`{ type, welinkSessionId?, toolSessionId?, error }`
- `session_created`：`{ type, welinkSessionId?, toolSessionId?, session }`
- `status_response`：`{ type, opencodeOnline }`

## 配置

交互式安装/配置 CLI：

- `node ./scripts/setup-message-bridge.mjs`

自包含启动示例（幂等写入 `.npmrc`，通过运行时 `OPENCODE_CONFIG_CONTENT` 注入 plugin 配置，再启动 `opencode serve`）：

- `node ./scripts/minimal-start-opencode.mjs`

CLI 当前会：

- 提示输入 `ak` 和 `sk`
- 默认在用户级写入 `message-bridge.jsonc`
- 在 OpenCode `plugin` 配置中启用 `@opencode-cui/message-bridge`
- 为 `@opencode-cui` 写入默认 `.npmrc` scope 条目

CLI 不会提示输入 `gateway.url`；已有值会保留，缺失时回退到 bridge 默认值。

用户级 `.npmrc` 路径解析顺序：

- `NPM_CONFIG_USERCONFIG`，若显式设置
- Windows：`%USERPROFILE%\\.npmrc`（回退到 `%HOMEDRIVE%%HOMEPATH%\\.npmrc`）
- macOS / Linux：`~/.npmrc`

在 Windows 上，用户级 OpenCode 配置目录与 OpenCode 本身一致：`%USERPROFILE%\\.config\\opencode`。生成的 npm scope 占位值会写入解析后的 `.npmrc` 路径，registry 当前保留为空，供后续内部仓库补全。

配置优先级从高到低：

1. `BRIDGE_*` 环境变量
2. 项目级配置：`.opencode/message-bridge.jsonc`，其次 `.opencode/message-bridge.json`
3. 用户级配置：`~/.config/opencode/message-bridge.jsonc`，其次 `.json`
4. 内置默认值

默认值定义见：

- [default-config.ts](./src/config/default-config.ts)

### 最小配置

```jsonc
{
  "auth": {
    "ak": "your-access-key",
    "sk": "your-secret-key"
  }
}
```

### 关键默认值

| Key | Default |
|---|---|
| `enabled` | `true` |
| `config_version` | `1` |
| `gateway.url` | `ws://localhost:8081/ws/agent` |
| `gateway.channel` | `opencode` |
| `gateway.heartbeatIntervalMs` | `30000` |
| `gateway.reconnect.baseMs` | `1000` |
| `gateway.reconnect.maxMs` | `30000` |
| `gateway.reconnect.exponential` | `true` |
| `gateway.ping.intervalMs` | `30000` |
| `gateway.ping.pongTimeoutMs` | `10000` |
| `sdk.timeoutMs` | `10000` |
| `events.allowlist` | `DEFAULT_EVENT_ALLOWLIST` |

`gateway.channel` 会在连接 ai-gateway 时映射到 register payload 的 `toolType` 字段。

## 日志

bridge 会在可用时通过 `client.app.log()` 输出结构化日志。

register 元数据会在运行时自动收集：

- `deviceName` 来自 `os.hostname()`
- `toolVersion` 来自 `client.global.health().version`；若注入 SDK 不暴露 `global.health()`，则回退到原始 `GET /global/health`
- 如果 `global.health` 探测失败或返回缺少非空 `version`，`runtime.start()` 会在 connect/register 前失败
- `macAddress` 来自第一个可用的本地网卡；若不可用则写 `""`
- `macAddress` 当前是为 Gateway 兼容预留的字段；服务端应将 `""` 视为缺失值

重要的归一化/提取失败会记录为：

- `event.extraction_failed`
- `downstream.normalization_failed`

`debug` 默认关闭。启用 `debug`（例如设置 `BRIDGE_DEBUG=true`）后，bridge 除了保留原有 debug 级诊断信息，还会以 `info` 级输出可读的原始 WebSocket 上下行报文，例如 `「onMessage」===>「...」`、`「sendMessage」===>「...」`，便于联调与落盘检索。即使日志投递不可用，`BRIDGE_DEBUG=true` 仍会输出本地 `console.debug` fallback 提示。

## 构建与测试

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:unit
pnpm run test:integration
pnpm run test:e2e
pnpm run test:e2e:smoke
pnpm run test:coverage
```

最低版本前置要求：

- `node >= 24.0.0`
- `pnpm >= 9.15.0`
- `opencode` 命令可用（`verify:env` / `test:e2e:smoke` / `verify:opencode-load` 需要）

一键命令对照：

- 日常开发门禁：`pnpm run verify:core`
- 发布验收：`pnpm run verify:release`
- 发布演练（dry-run）：`pnpm run verify:release:dry`
- 环境自检：`pnpm run verify:env`

测试脚本的验证范围、适用场景与前置要求见：

- [测试策略（脚本矩阵）](./docs/quality/test-strategy.md)

协议回归推荐入口：

```bash
pnpm run test:integration && pnpm run test:e2e:smoke
```

`pnpm run test:e2e:smoke` 通过统一 smoke 入口脚本维护场景集合，当前覆盖：

- `connect-register`
- `chat-stream`
- `permission-roundtrip`
- `directory-context`

适合作为需求代码修改后的主回归入口，用于验证 `message-bridge` 与 `ai-gateway` 的协议主链路仍然正确。

发布产物与加载验证：

```bash
node --import tsx/esm --test tests/integration/plugin-distribution.test.mjs
pnpm run verify:opencode-load
pnpm run verify:release
```

失败排查建议顺序：

1. 先看 `logs/verify-env-*.json`（环境缺失、版本不匹配、端口冲突）
2. 再看 `logs/e2e-smoke-*/summary.json`（协议场景失败分类）
3. 最后看 `logs/opencode-load-verify-*/summary.json`（OpenCode 加载失败分类）

OpenCode 的主要安装方式是包安装：

```json
{
  "plugin": ["@opencode-cui/message-bridge"]
}
```

在执行 `pnpm run build` 后，仍保留单文件复制到 `.opencode/plugins/` 的兼容路径。

## 发布

维护者发布流程、beta 包约定以及私仓切换方式见：

- [NPM Publish Guide](./docs/operations/npm-publish-guide.md)
