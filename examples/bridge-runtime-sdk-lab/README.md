# Bridge Runtime SDK Lab

Bridge Runtime SDK Lab 是 `@wecode/bridge-runtime-sdk` 的本地集成验收实验台。它包含：

- `apps/runtime-host`：Node 服务，读取 `.opencode/message-bridge.jsonc`，持有 `BridgeRuntime` 实例，并实现可配置测试 Provider。
- `apps/web`：React/Vite 前端，用于触发 Runtime API、设置 Provider 场景、运行 stage 矩阵场景、查看 `tool_error`、gateway uplink、事件流与 diagnostics。
- `packages/shared`：前后端共享类型。

完整使用说明见 [docs/lab-guide.md](docs/lab-guide.md)。

## 启动

在仓库根目录执行：

```bash
pnpm --dir examples/bridge-runtime-sdk-lab/apps/runtime-host dev
pnpm --dir examples/bridge-runtime-sdk-lab/apps/web dev
```

默认前端地址为 `http://127.0.0.1:5174`，Node host 地址为 `http://127.0.0.1:4321`。

## 配置来源

runtime-host 默认读取仓库根目录下的 `.opencode/message-bridge.jsonc`：

- `gateway.url` 映射到 `BridgeGatewayHostConfig.url`
- `gateway.channel` 映射到 `BridgeGatewayHostConfig.register.channel`
- `auth.ak` 映射到 `BridgeGatewayHostConfig.auth.ak`
- `auth.sk` 映射到 `BridgeGatewayHostConfig.auth.sk`

前端可以临时覆盖 `url`、`channel`、`toolVersion` 和 `pluginVersion`，不会接收或覆盖 `ak/sk`。

## 验证

```bash
pnpm --dir examples/bridge-runtime-sdk-lab/apps/runtime-host test
pnpm --dir examples/bridge-runtime-sdk-lab/apps/runtime-host build
pnpm --dir examples/bridge-runtime-sdk-lab/apps/web build
```

## Stage Matrix Lab

Stage Matrix Lab 用于验证 gateway 下行原始消息、Provider outbound 和 mock gateway 状态经过 SDK 的完整链路：

```text
raw downstream -> normalizeDownstream -> RuntimeCommand -> UseCase -> Provider -> gateway uplink
provider outbound -> mock facts -> SDK projector/reporter -> gateway uplink
mock gateway status -> runtime status/diagnostics
```

使用步骤：

1. 在前端切换到 `Mock` 模式。
2. 点击“初始化”，runtime-host 会启动本地 mock gateway，并让 SDK 连接到 mock gateway。
3. 点击“启动”，等待 runtime 进入可用或可解释状态。
4. 在 `Stage Matrix Lab` 选择场景，例如 `chat 缺少 text`、`chat terminal session_not_found` 或 `emitOutboundRun facts 顺序非法`。
5. 点击“运行矩阵场景”。
6. 在 `Tool Error` 面板查看 SDK 上行的 `tool_error`、路由 ID、阶段、uplinks 和 failures。

如果场景预期是 `failure_only`，前端会显示“无 tool_error，符合预期”，表示该下行没有可回包的 `welinkSessionId` 或 `toolSessionId`。

矩阵覆盖重点：

- `inbound_invalid`：非法 `invoke` 下行、无路由目标时仅 diagnostics。
- `command_failure`：unsupported action、Provider API throw、pending question/permission 缺失、`ProviderRun.result()` reject。
- `request_lifecycle`：request facts 顺序非法；enrich failure 保持 diagnostics + continue。
- `request_terminal`：failed terminal 和 `session_not_found` reason。
- `outbound_terminal`：`emitOutboundRun()` 非法 facts、facts iterator throw；outbound enrich failure 保持 diagnostics + continue。
- `lifecycle_status`：mock gateway 主动断开时不递归发送 `tool_error`，通过 runtime status/diagnostics 感知。

## 安全边界

实验台会对 `ak`、`sk`、`token`、`authorization`、`cookie`、`secret`、`password`、`content`、`text`、`answers` 等字段做展示脱敏。不要把真实密钥写入 README、截图、导出报告或提交记录。
