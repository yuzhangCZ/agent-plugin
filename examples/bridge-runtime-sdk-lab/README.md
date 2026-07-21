# Bridge Runtime SDK Lab

Bridge Runtime SDK Lab 是 `@wecode/bridge-runtime-sdk` 的本地集成验收实验台。它包含：

- `apps/runtime-host`：Node 服务，读取 `.opencode/message-bridge.jsonc`，持有 `BridgeRuntime` 实例，并实现可配置测试 Provider。
- `apps/web`：React/Vite 前端，用于触发 Runtime API、设置 Provider 场景、注入下行场景、查看 `tool_error`、事件流与 diagnostics。
- `packages/shared`：前后端共享类型。

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

## Downstream Lab

Downstream Lab 用于验证 gateway 下行原始消息经过 SDK 的完整链路：

```text
raw downstream -> normalizeDownstream -> RuntimeCommand -> UseCase -> Provider -> gateway uplink
```

使用步骤：

1. 在前端切换到 `Mock` 模式。
2. 点击“初始化”，runtime-host 会启动本地 mock gateway，并让 SDK 连接到 mock gateway。
3. 点击“启动”，等待 runtime 进入可用或可解释状态。
4. 在 `Downstream Lab` 选择场景，例如 `chat 缺少 text`。
5. 点击“发送下行场景”。
6. 在 `Tool Error` 面板查看 SDK 上行的 `tool_error`、路由 ID、阶段、uplinks 和 failures。

如果场景预期是 `failure_only`，前端会显示“无 tool_error，符合预期”，表示该下行没有可回包的 `welinkSessionId` 或 `toolSessionId`。

## 安全边界

实验台会对 `ak`、`sk`、`token`、`authorization`、`cookie`、`secret`、`password`、`content`、`text`、`answers` 等字段做展示脱敏。不要把真实密钥写入 README、截图、导出报告或提交记录。
