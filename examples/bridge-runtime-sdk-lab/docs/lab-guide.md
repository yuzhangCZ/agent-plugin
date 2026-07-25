# Bridge Runtime SDK Lab 使用手册

Version: 1.0
Date: 2026-07-24
Status: Active
Owner: bridge-runtime-sdk maintainers

## 1. 实验室定位

Bridge Runtime SDK Lab 是 `@wecode/bridge-runtime-sdk` 的本地集成验收实验台，用来验证 SDK Runtime API、Provider API、gateway 下行、Provider outbound、`tool_error`、gateway downstream/uplink 和 diagnostics 的可见行为。

实验室不是“浏览器直接调用 SDK”。真实结构是：

```text
React 前端
  -> runtime-host Node 服务
  -> bridge-runtime-sdk runtime
  -> TestProvider / MockGateway / 真实 gateway
```

其中：

- `apps/web` 是浏览器控制台，只负责点按钮、发送 HTTP 请求和展示结果。
- `apps/runtime-host` 是 Node 宿主，真正持有 `BridgeRuntime` 实例。
- `TestProvider` 是实验室内置的 mock `ThirdPartyAgentProvider`。
- `LabMockGateway` 是实验室内置的本地 mock gateway。

## 2. 启动方式

在仓库根目录分别启动两个服务：

```bash
pnpm --dir examples/bridge-runtime-sdk-lab/apps/runtime-host dev
pnpm --dir examples/bridge-runtime-sdk-lab/apps/web dev
```

默认地址：

- 前端：`http://127.0.0.1:5174/`
- runtime-host：`http://127.0.0.1:4321`

## 3. 工程结构

```text
examples/bridge-runtime-sdk-lab
  apps/runtime-host
    src/server.ts                HTTP API 入口
    src/runtime-manager.ts       创建、启动、停止 SDK runtime
    src/test-provider.ts         mock ThirdPartyAgentProvider
    src/mock-gateway.ts          本地 mock gateway
    src/downstream-scenarios.ts  stage 矩阵场景定义
    src/downstream-runner.ts     场景执行与结果采集
  apps/web
    src/main.tsx                 React 控制台界面
  packages/shared
    src/index.ts                 前后端共享类型
```

## 4. 模式说明

### 4.1 真实模式

真实模式用于连接 `.opencode/message-bridge.jsonc` 里的 gateway 环境。

runtime-host 会读取：

```json
{
  "gateway": {
    "url": "ws://localhost:8081/ws/agent",
    "channel": "opencode"
  },
  "auth": {
    "ak": "...",
    "sk": "..."
  }
}
```

映射关系：

- `gateway.url` -> `BridgeGatewayHostConfig.url`
- `gateway.channel` -> `BridgeGatewayHostConfig.register.channel`
- `auth.ak` -> `BridgeGatewayHostConfig.auth.ak`
- `auth.sk` -> `BridgeGatewayHostConfig.auth.sk`

真实模式下，点击“初始化”会创建 SDK runtime 实例，但不会连接 gateway；点击“启动”才会执行 `runtime.start()` 并连接真实 gateway。

### 4.2 Mock 模式

Mock 模式用于本地验证下行协议、`tool_error`、gateway downstream/uplink 和异常矩阵。

Mock 模式下：

1. runtime-host 启动 `LabMockGateway`。
2. 初始化 runtime 时，host 自动把 SDK 的 gateway URL 改成本地 mock gateway。
3. `Stage Matrix Lab` 可以向 SDK 注入 gateway 下行消息。
4. `LabMockGateway` 会记录注入的 downstream raw，并捕获 SDK 发出的所有 uplink。

验证 `tool_error` 和异常矩阵时优先使用 Mock 模式。

## 5. Runtime API 区域

顶部按钮用于验证 SDK Runtime API：

| 按钮 | runtime-host API | SDK 行为 | 说明 |
|---|---|---|---|
| 初始化 | `POST /api/runtime/create` | `createBridgeRuntime()` | 创建 runtime 实例，不连接 gateway |
| 启动 | `POST /api/runtime/start` | `runtime.start()` | 初始化 Provider 并连接 gateway |
| 停止 | `POST /api/runtime/stop` | `runtime.stop()` | 断开 gateway 并 dispose Provider |
| 探测 | `POST /api/runtime/probe` | `runtime.probe()` | 探测 gateway 可连接性 |
| 状态 | `GET /api/runtime/status` | `runtime.getStatus()` | 查看 runtime 状态 |
| 诊断 | `GET /api/runtime/diagnostics` | `runtime.getDiagnostics()` | 查看 diagnostics |

推荐启动顺序：

```text
选择模式 -> 初始化 -> 启动 -> 查看状态
```

## 6. Provider 场景

Provider 场景用于配置 `TestProvider` 的行为。点击“应用场景”只是保存配置，不会立即触发 SDK 调用。

生效链路：

```text
选择 Command / Kind / Delay
  -> 点击 应用场景
  -> runtime-host 配置 TestProvider
  -> 后续某个下行或 runtime 操作触发 SDK
  -> SDK 调用对应 Provider API
  -> TestProvider 按配置返回 success / throw / facts / failed terminal
```

### 6.1 Command 含义

| Command | 对应 Provider API | 常见触发方式 |
|---|---|---|
| `initialize` | `provider.initialize()` | 点击“启动” |
| `health` | `provider.health()` | `status_query` 或状态相关验证 |
| `createSession` | `provider.createSession()` | `invoke/create_session` |
| `listSlashCommands` | `provider.listSlashCommands()` | `invoke/query_slash_commands` |
| `runMessage` | `provider.runMessage()` | `invoke/chat` |
| `replyQuestion` | `provider.replyQuestion()` | `invoke/question_reply` |
| `replyPermission` | `provider.replyPermission()` | `invoke/permission_reply` |
| `closeSession` | `provider.closeSession()` | `invoke/close_session` |
| `abortSession` | `provider.abortSession()` | `invoke/abort_session` |
| `dispose` | `provider.dispose()` | 点击“停止” |
| `outbound` | `context.outbound.emitOutboundRun()` | 点击 Outbound 或运行 outbound 矩阵场景 |

### 6.2 Kind 含义

界面会按 Command 过滤 Kind，只展示当前 Provider API 可触发的行为。

| Kind | 含义 | 适用场景 |
|---|---|---|
| `success` | 正常返回 | 所有 command |
| `throw` | Provider API 抛错 | command failure |
| `offline` | `health()` 返回 offline | `health` |
| `timeout` | 延迟很久不返回 | 慢调用、等待态 |
| `invalid_fact` | facts 顺序非法 | `runMessage`、`outbound` |
| `failed_run` | `ProviderRun.result()` 返回 failed | `runMessage` |
| `session_not_found` | failed terminal 带 `reason=session_not_found` | `runMessage` |
| `result_reject` | `ProviderRun.result()` reject | `runMessage` |
| `facts_throw` | facts async iterator 中途抛错 | `runMessage`、`outbound` |
| `enrich_failure` | 构造缺上下文的 `permission.reply` | `runMessage`、`outbound` |
| `aborted_run` | terminal 返回 aborted | `runMessage` |

### 6.3 Delay ms

`Delay ms` 表示 Provider API 被调用前等待多久。大多数测试填 `0`。

常见用法：

- `0`：正常快速验证。
- `3000`：模拟慢 Provider。
- `timeout` kind：模拟长时间不返回，谨慎使用。

### 6.4 典型组合

| 目标 | Command | Kind | Delay |
|---|---|---|---|
| chat 正常 | `runMessage` | `success` | `0` |
| chat Provider 抛错 | `runMessage` | `throw` | `0` |
| chat facts 生命周期非法 | `runMessage` | `invalid_fact` | `0` |
| chat terminal failed | `runMessage` | `failed_run` | `0` |
| chat session_not_found | `runMessage` | `session_not_found` | `0` |
| create_session 抛错 | `createSession` | `throw` | `0` |
| slash 查询失败降级 | `listSlashCommands` | `throw` | `0` |
| status offline | `health` | `offline` | `0` |
| initialize 失败 | `initialize` | `throw` | `0` |
| dispose 失败 | `dispose` | `throw` | `0` |

## 7. Stage Matrix Lab

Stage Matrix Lab 是推荐使用的主验证区。它把文档里的 `tool_error` stage 矩阵落成可点击场景。

运行前置条件：

1. 切换到 `Mock` 模式。
2. 点击“初始化”。
3. 点击“启动”。
4. Runtime 状态进入 `ready` 或可解释状态。
5. 选择矩阵场景并点击“运行矩阵场景”。

### 7.1 场景触发源

| Trigger | 含义 | 例子 |
|---|---|---|
| `gateway_downstream` | MockGateway 向 SDK 发送下行消息 | chat、create_session、permission_reply |
| `provider_outbound` | TestProvider 主动调用 outbound emitter | emitOutboundRun facts 非法 |
| `mock_gateway_disconnect` | MockGateway 主动断开 SDK 连接 | gateway 运行中不可用 |

### 7.2 Stage 含义

| Stage | 中文理解 | 是否期待 tool_error |
|---|---|---|
| `inbound_invalid` | gateway 下行协议非法 | 有可路由 ID 时期待 |
| `command_failure` | RuntimeCommand / Provider API apply 失败 | 期待 |
| `request_lifecycle` | request facts 中途生命周期失败 | 期待 |
| `request_terminal` | `ProviderRun.result()` 返回 failed | 期待 |
| `outbound_terminal` | Provider outbound run 失败 | 期待 |
| `diagnostics_only` | 按方案只记录 diagnostics 或继续 | 不期待 |
| `lifecycle_status` | runtime/gateway lifecycle 状态异常 | 不期待 |
| `success` | 正常成功或明确降级响应 | 不期待 tool_error |

### 7.3 推荐验证路径

按下面顺序跑，能快速覆盖主链路：

1. `chat 缺少 text`
   - 验证：`inbound_invalid`
   - 预期：`tool_error.error` 包含 `gateway_invalid_invoke`

2. `unsupported invoke action`
   - 验证：`command_failure`
   - 预期：`tool_error.error` 包含“不支持”

3. `chat Provider 抛错`
   - 验证：Provider API apply failure
   - 预期：`tool_error.stage = command_failure`

4. `chat facts 顺序非法`
   - 验证：`request_lifecycle`
   - 预期：`tool_error.error` 包含“当前请求处理失败”

5. `chat terminal failed`
   - 验证：`request_terminal`
   - 预期：`tool_error.error` 包含 failed terminal message

6. `chat terminal session_not_found`
   - 验证：`request_terminal` reason
   - 预期：`tool_error.reason = session_not_found`

7. `ProviderRun.result reject`
   - 验证：terminal Promise reject 兜底
   - 预期：`command_failure tool_error`

8. `emitOutboundRun facts 顺序非法`
   - 验证：`outbound_terminal`
   - 预期：outbound `tool_error`

9. `chat enrich failure 继续`
   - 验证：diagnostics-only
   - 预期：无 `tool_error`，failures/diagnostics 有记录

10. `mock gateway 主动断开`
    - 验证：gateway 不可用不递归发 `tool_error`
    - 预期：无 `tool_error`，通过 status/diagnostics 感知

## 8. 结果面板说明

### 8.1 Gateway Downstream

展示 SDK 从 gateway 收到的最近下行摘要。

真实模式下，面板展示 SDK observation/logger 里的安全摘要：

- `messageType`
- `action`
- `command`
- `toolSessionId`
- `welinkSessionId`
- `error`
- `code`
- 处理阶段

Mock 模式下，实验室自己注入的下行还会展示 `raw`，方便对照原始 payload。

注意：真实 gateway 下行不会展示完整 raw payload，避免把真实业务内容或敏感字段直接写入实验台快照。

### 8.2 Gateway Uplink

展示 SDK 发往 gateway 的全部上行消息，包括：

- `register`
- `heartbeat`
- `session_created`
- `status_response`
- `slash_commands_result`
- `tool_event`
- `tool_done`
- `tool_error`

这个面板用来判断“是否有符合契约的上行数据”。

### 8.3 Tool Error

只筛选展示上行中的 `tool_error`。

重点字段：

- `error`：前端可展示的错误文案。
- `stage`：实验室场景预期阶段，不是 gateway 协议字段。
- `toolSessionId`：会话级路由 ID。
- `welinkSessionId`：创建会话或兼容路由 ID。
- `reason`：结构化原因，目前重点看 `session_not_found`。

### 8.4 最近结果

展示最近一次 HTTP API 返回值。适合查看：

- Runtime API 调用是否成功。
- `/api/downstream/run` 的完整 `DownstreamRunResult`。
- `matchedExpectation` 是否为 `true`。

### 8.5 事件流

展示 runtime-host 记录的事件和 SDK logger 输出。适合排查：

- Provider API 是否被调用。
- SDK 是否连接 gateway。
- gateway 是否 ready。
- diagnostics 是否记录 failure。

## 9. 常见测试目标

### 9.1 测真实 gateway 连接

1. 切换到 `真实` 模式。
2. 点击“初始化”。
3. 点击“启动”。
4. 看事件流是否出现：
   - `gateway.connect.started`
   - `gateway.register.sent`
   - `gateway.register.accepted`
   - `gateway.ready`
5. 点击“状态”，确认 runtime state。

注意：真实模式的下行数据来自真实 gateway，`Stage Matrix Lab` 不负责向真实 gateway 注入测试消息。

### 9.2 测 Mock 下行 tool_error

1. 切换到 `Mock` 模式。
2. 点击“初始化”。
3. 点击“启动”。
4. 选择 `chat 缺少 text`。
5. 点击“运行矩阵场景”。
6. 查看 `Gateway Downstream`、`Gateway Uplink` 和 `Tool Error`。

### 9.3 自由组合 Provider 行为

示例：把原本正常 chat 改成 Provider 抛错。

1. Provider 场景选择：
   - `Command = runMessage`
   - `Kind = throw`
   - `Delay ms = 0`
2. 点击“应用场景”。
3. Stage Matrix Lab 选择 `chat 正常`。
4. 点击“运行矩阵场景”。
5. 预期：原本应 `tool_done`，现在变成 `command_failure tool_error`。

### 9.4 测 diagnostics-only

1. Mock 模式初始化并启动。
2. 选择 `chat enrich failure 继续`。
3. 点击“运行矩阵场景”。
4. 预期：
   - `Tool Error` 显示无 `tool_error` 且符合预期。
   - `Gateway Uplink` 可能仍有正常终态。
   - failures/diagnostics 里有 enrich failure 记录。

## 10. 注意事项

1. `初始化` 不会连接 gateway，`启动` 才会连接。
2. 真实模式初始化时使用 `.opencode/message-bridge.jsonc`；前端不会覆盖 `ak/sk`。
3. Mock 模式会使用本地 `LabMockGateway` URL。
4. Provider 场景只是预设行为，不会主动触发 SDK 调用。
5. Stage Matrix Lab 的部分场景内置 providerScenario，不需要先手动点“应用场景”。
6. `diagnostics_only`、`failure_only`、`lifecycle_status` 场景没有 `tool_error` 可能是正确结果。
7. 实验台会对敏感字段做展示脱敏，但不要把真实密钥写入文档、截图或提交记录。

## 11. 验证命令

修改实验台后建议运行：

```bash
pnpm --dir examples/bridge-runtime-sdk-lab/apps/runtime-host test
pnpm --dir examples/bridge-runtime-sdk-lab/apps/runtime-host build
pnpm --dir examples/bridge-runtime-sdk-lab/apps/web build
```

如改动影响 SDK 逻辑，还应补跑：

```bash
pnpm --dir packages/bridge-runtime-sdk test
pnpm lint:changed
```
