# message-bridge SDK runtime 测试迁移矩阵

> 本矩阵记录删除 `plugins/message-bridge/src/runtime/BridgeRuntime.ts` 前的旧测试归属。处理方式只使用：`已有覆盖`、`迁移断言`、`改写为 smoke`、`删除且说明原因`。

## 直接 legacy 依赖清单

清单命令：

```bash
rg -n "from ['\"]../../src/runtime/BridgeRuntime|BridgeRuntime\\.js|MESSAGE_BRIDGE_RUNTIME_MODE|runtimeMode.*legacy|new BridgeRuntime|class BridgeRuntime|src/runtime/BridgeRuntime" plugins/message-bridge/tests plugins/message-bridge/src
```

当前需处理的旧测试文件：

| 旧测试文件 | 行为归类 | 新归属 | 新测试文件 | 处理方式 |
|---|---|---|---|---|
| `tests/unit/runtime-protocol.test.mjs` | `status_query` -> `status_response`，包括 READY/connecting 状态映射 | SDK runtime 合同层 | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts` | 已有覆盖，执行前需用测试名确认具体 case 存在 |
| `tests/unit/runtime-protocol.test.mjs` | start/stop、probe、READY lifecycle、状态存储发布 | SDK lifecycle + message-bridge status adapter | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`, `tests/unit/bridge-runtime-status-adapter.test.mjs`, `tests/unit/sdk-runtime-register.test.mjs` | 已有覆盖，保留 `SdkBridgeRuntime` 装配 smoke |
| `tests/unit/runtime-protocol.test.mjs` | invalid invoke、unsupported action、缺失字段 -> routable `tool_error` | SDK runtime 合同层 | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`, `packages/bridge-runtime-sdk/tests/command-failure-tool-error-projector.test.ts` | 迁移断言；缺少精确错误码时先补测试再删旧测试 |
| `tests/unit/runtime-protocol.test.mjs` | unroutable invoke / 无连接发送失败诊断 | SDK observation/diagnostics | `packages/bridge-runtime-sdk/tests/runtime-observation.test.ts`, `packages/bridge-runtime-sdk/tests/runtime-logging-integration.test.ts` | 迁移断言 |
| `tests/unit/runtime-protocol.test.mjs` | `chat` 主路径、active run lock、`run_already_active` | SDK runtime 合同层 | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts` | 已有覆盖 |
| `tests/unit/runtime-protocol.test.mjs` | `create_session`、`close_session`、`abort_session` 下行语义 | SDK runtime 合同层 + provider adapter | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`, `tests/unit/sdk-provider-adapter.test.mjs` | 已有覆盖；OpenCode session API 形状只留 adapter 层 |
| `tests/unit/runtime-protocol.test.mjs` | `question_reply`、`permission_reply`、legacy `toolCallId` alias | SDK interaction + normalizer/adapter | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`, `tests/unit/downstream-message-normalizer.test.mjs`, `tests/unit/sdk-provider-adapter.test.mjs` | 迁移断言；alias 归 normalizer/adapter，SDK 只收稳定字段 |
| `tests/unit/runtime-protocol.test.mjs` | `suppressReply` deny fast path、synthetic assistant reply | message-bridge control-plane 层 | `tests/unit/sdk-chat-control-plane.test.mjs`, `tests/unit/sdk-provider-adapter.test.mjs` | 已有覆盖 |
| `tests/unit/runtime-protocol.test.mjs` | directory 传递、默认 directory、session scoped directory | message-bridge adapter/control-plane 层 | `tests/unit/sdk-provider-adapter.test.mjs`, `tests/unit/sdk-runtime-register.test.mjs`, `tests/unit/session-isolation-*.test.mjs` | 迁移断言 |
| `tests/unit/runtime-protocol.test.mjs` | OpenCode raw event -> text/thinking/tool/terminal SDK fact | message-bridge provider adapter 层 | `tests/unit/sdk-provider-adapter.test.mjs` | 迁移断言；复用 raw event fixture，不迁入 SDK |
| `tests/unit/runtime-protocol.test.mjs` | terminal completed/aborted/failed、`tool_done`、`tool_error`、`session_not_found` reason | SDK terminal 合同 + provider adapter 错误分类 | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`, `tests/unit/sdk-provider-adapter.test.mjs` | 迁移断言 |
| `tests/unit/runtime-protocol.test.mjs` | subagent 映射、pending interaction 归属、host session routing | session-isolation 层 | `tests/unit/session-isolation-*.test.mjs`, `tests/unit/sdk-provider-adapter.test.mjs` | 迁移断言 |
| `tests/unit/runtime-protocol.test.mjs` | legacy connection/reconnect 私有 wiring、gateway-wire wrapper 行为 | SDK gateway/runtime host 层 | `packages/bridge-runtime-sdk/tests/gateway-runtime-host.test.ts`, `packages/bridge-runtime-sdk/tests/runtime-logging-integration.test.ts` | 删除且说明原因：旧私有 wiring 已由 SDK host 合同替代，不保留 BridgeRuntime 私有方法断言 |
| `tests/unit/runtime-slash-control-plane.test.mjs` | `/new`、`/session`、`/sessions` | message-bridge control-plane/session-isolation 层 | `tests/unit/sdk-chat-control-plane.test.mjs`, `tests/unit/session-isolation-slash-command-executor.test.mjs` | 迁移断言 |
| `tests/unit/runtime-slash-control-plane.test.mjs` | `/models`、model override、group policy、forbidden slash fail-closed | message-bridge control-plane 层 | `tests/unit/sdk-chat-control-plane.test.mjs`, `tests/unit/session-isolation-*.test.mjs` | 迁移断言 |
| `tests/unit/runtime-slash-control-plane.test.mjs` | slash 后 question/permission reply 仍投递到原 host session | provider adapter + session-isolation interaction bridge | `tests/unit/sdk-runtime-register.test.mjs`, `tests/unit/session-isolation-interaction-lookup-bridge.test.mjs`, `tests/unit/session-isolation-reply-abort-usecases.test.mjs` | 迁移断言 |
| `tests/unit/plugin-event-relay.test.mjs` | inactive runtime ignores events、allowlist、validation fail-closed | singleton/provider adapter + SDK fact validator | `tests/integration/plugin.test.mjs`, `tests/unit/sdk-provider-adapter.test.mjs`, `packages/bridge-runtime-sdk/tests/fact-semantics-validator.test.ts` | 迁移断言 |
| `tests/unit/plugin-event-relay.test.mjs` | `session.created` 内部控制事件、raw event projection | provider adapter + session-isolation 层 | `tests/unit/sdk-provider-adapter.test.mjs`, `tests/unit/session-isolation-*.test.mjs` | 迁移断言 |
| `tests/integration/example.test.mjs` | legacy downlink/uplink examples | SDK runtime 合同层 + plugin smoke | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`, `tests/integration/plugin.test.mjs` | 删除且说明原因：直接构造 legacy runtime，不再代表 public 插件入口 |
| `tests/integration/protocol-connect.test.mjs` | mock gateway connect + `status_query -> status_response` | SDK runtime 合同层 + plugin smoke | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`, `tests/integration/plugin.test.mjs` | 删除且说明原因：legacy class integration 被 SDK contract 和 public plugin smoke 取代 |
| `tests/integration/protocol-chat-stream.test.mjs` | stream facts、`session.idle` 与 `tool_done` 去重 | provider adapter + SDK terminal 合同 | `tests/unit/sdk-provider-adapter.test.mjs`, `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts` | 删除且说明原因：直接构造 legacy runtime，不保留 integration 文件 |
| `tests/integration/protocol-directory.test.mjs` | effective directory、channel/assistant mapping、session-scoped actions directory | SDK register/adapter/control-plane 层 | `tests/unit/sdk-runtime-register.test.mjs`, `tests/unit/sdk-provider-adapter.test.mjs`, `tests/unit/sdk-chat-control-plane.test.mjs` | 删除且说明原因：拆入单测，插件 integration 只保留装配 smoke |
| `tests/integration/protocol-question.test.mjs` | `question.asked` projection、reply routing、legacy `toolCallId` alias、transport failures | SDK interaction + adapter pending interaction | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`, `tests/unit/downstream-message-normalizer.test.mjs`, `tests/unit/sdk-provider-adapter.test.mjs` | 删除且说明原因：legacy class integration 被 SDK/adapter contract 取代 |
| `tests/integration/protocol-permission.test.mjs` | `permission.asked/replied` projection、reply routing、invalid reply | SDK interaction + adapter pending interaction | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`, `tests/unit/sdk-provider-adapter.test.mjs` | 删除且说明原因：legacy class integration 被 SDK/adapter contract 取代 |
| `tests/integration/protocol-message-updated-large-payload.test.mjs` | legacy `message.updated` websocket projection size regression | adapter/fact path no longer forwards legacy raw `message.updated` as runtime transport payload | `tests/unit/sdk-provider-adapter.test.mjs`, `tests/unit/upstream-transport-projector.test.mjs` | 删除且说明原因：旧 websocket projection path 随 legacy runtime 删除 |
| `tests/integration/plugin.test.mjs` | public plugin API、singleton lifecycle、config failures、runtime initialized log | message-bridge integration smoke | `tests/integration/plugin.test.mjs` | 改写为 smoke；不得再 patch `BridgeRuntime.prototype` |

## 覆盖审计结论

| 计划关注点 | 当前覆盖 |
|---|---|
| `status_query`、`create_session`、invalid invoke、unsupported action | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`, `command-failure-tool-error-projector.test.ts` |
| `question_reply`、`permission_reply`、pending interaction | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`, `tests/unit/sdk-provider-adapter.test.mjs`, `tests/unit/session-isolation-interaction-lookup-bridge.test.mjs` |
| terminal、`tool_done`、`tool_error`、`session_not_found` | `packages/bridge-runtime-sdk/tests/runtime-sdk.test.ts`, `tests/unit/sdk-provider-adapter.test.mjs` |
| raw OpenCode event -> SDK fact | `tests/unit/sdk-provider-adapter.test.mjs` |
| slash/control-plane/session isolation | `tests/unit/sdk-chat-control-plane.test.mjs`, `tests/unit/session-isolation-*.test.mjs` |
| plugin public API and singleton lifecycle | `tests/integration/plugin.test.mjs` |

## 删除门禁

删除 legacy runtime 前必须满足：

```bash
rg -n "from ['\"]../../src/runtime/BridgeRuntime|BridgeRuntime\\.js|MESSAGE_BRIDGE_RUNTIME_MODE|runtimeMode.*legacy|new BridgeRuntime|class BridgeRuntime|src/runtime/BridgeRuntime" plugins/message-bridge/tests plugins/message-bridge/src plugins/message-bridge/package.json
```

预期无命中。`BridgeRuntimeStatusAdapter`、`SdkBridgeRuntime`、SDK 包公开类型 `BridgeRuntime` 不属于 legacy runtime，可在最终全仓搜索中显式白名单说明。
