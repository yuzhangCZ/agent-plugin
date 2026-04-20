# gateway-wire-v1 模块设计（历史名，现包名为 `gateway-schema`）

**Version:** 1.0  
**Date:** 2026-03-30  
**Status:** Superseded by `@agent-plugin/gateway-schema`  
**Owner:** agent-plugin maintainers  
**Related:** [gateway-wire-v1-architecture.md](../architecture/gateway-wire-v1-architecture.md), [gateway-wire-v1-event-contract.md](./interfaces/gateway-wire-v1-event-contract.md), [bridge-refactor-migration-plan.md](../architecture/bridge-refactor-migration-plan.md)

## 目标

当前共享包 `@agent-plugin/gateway-schema` 只做一件事：把当前 `ai-gateway` 对外协议冻结成一个可直接消费的 schema 层。它不接管宿主连接，不实现业务 policy，也不把 raw event 提取逻辑搬进共享包。

## 参考版本

- `Reference Host SDK: @opencode-ai/plugin@1.2.15`
- `Reference Host SDK: @opencode-ai/sdk@1.2.15`

共享协议只参考这两个版本下当前可观察行为，不依赖宿主类型真源。

## 模块结构

当前目录如下：

```text
packages/gateway-schema/
  src/
    contract/
      literals/
      schemas/
      errors/
    application/
      ports/
      usecases/
    adapters/
      validators/
      reporters/
      facade/
    shared/
    index.ts
```

- `contract/*` 是协议唯一真源。
- 协议公开类型通过 schema 同文件导出的 `z.output<typeof schema>` 提供。
- `adapters/*` 负责边界投影和校验，不再维护独立 schema 真源。
- 旧 `domain/*` 和 `adapters/zod/schemas/*` 兼容层已删除，不再作为可引用结构存在。

## Public API

对外主入口暴露以下对象：

- 类型：`GatewayDownstreamBusinessRequest`、`GatewayToolEventPayload`、`OpencodeProviderEvent`、`GatewayUplinkBusinessMessage`、`GatewayTransportControlMessage`、`GatewayWireProtocol`、`WireViolation`、`WireErrorCode`、`Result<T, E>`
- 常量：`DOWNSTREAM_MESSAGE_TYPES`、`INVOKE_ACTIONS`、`UPSTREAM_MESSAGE_TYPES`、`TOOL_EVENT_TYPES`、`TOOL_ERROR_REASONS`、`PERMISSION_REPLY_RESPONSES`、`SESSION_STATUS_TYPES`、`MESSAGE_PART_TYPES`
- façade：`normalizeDownstream(raw, options?)`、`validateToolEvent(raw, options?)`、`validateGatewayUplinkBusinessMessage(raw, options?)`、`validateGatewayWireProtocolMessage(raw, options?)`

禁止普通消费者直接依赖内部目录。公共入口必须保持薄，只承载稳定契约。

### 入口规则

- 包外消费者使用 `@agent-plugin/gateway-schema`。
- 插件包内部通过本地 `gateway-wire/*` 包装层接入共享能力。
- 只有共享包自测和静态契约测试才允许直接读取 `src/contract/*`。

## Transport 约束

- `register.deviceName`、`register.os`、`register.toolType`、`register.toolVersion` 为必填非空字符串。
- `register.macAddress` 为可选字段。
- 当运行时能解析到可用 MAC 地址时，应发送标准化后的字符串。
- 当运行时拿不到可用 MAC 地址时，应省略 `register.macAddress`，而不是伪造一个占位 MAC。

## 端口设计

- `DownstreamNormalizerPort`：把原始下行输入归一化成正式 `GatewayDownstreamBusinessRequest`
- `ToolEventValidatorPort`：按 `event.type` 校验 `tool_event.event`
- `TransportMessageValidatorPort`：校验上行协议消息
- `ProtocolFailureReporterPort`：把协议失败报告给调用方或测试钩子

## 共享能力

### 常量模块

协议相关字面量必须集中到共享常量模块，validator、fixture、插件适配器和测试都通过常量引用，不直接散落裸字符串。

### 类型守卫模块

共享包应提供统一的 guard/read 工具，例如：

- `isPlainObject`
- `hasOwn`
- `readString`
- `readTrimmedString`
- `readNumber`
- `readBoolean`
- `readPlainObject`
- `readArray`
- `readEnumValue`

协议实现不应重复定义同类 `isRecord/asString/asNumber`。

## 协议契约模型

- `GatewayDownstreamBusinessRequest`
- `GatewayToolEventPayload`
- `OpencodeProviderEvent`
- `GatewayUplinkBusinessMessage`
- `GatewayTransportControlMessage`
- `GatewayWireProtocol`
- `WireViolation`
- `WireErrorCode`
- `Result<T, E>`

这些类型不再由独立手写 model 维护，而是由 `contract/schemas/*` 和 `shared/result.ts` 导出。
协议契约模型中不保留开放索引签名。`unknown` 仅允许出现在边界输入和错误上下文。

## 异常模型

- `WireContractViolation`：正式协议不满足，所有普通协议失败都返回它。
- `WireInvariantError`：共享包内部不变式被破坏。
- `WireUsageError`：消费者错误使用 façade 或端口。
- `WireCompatibilityViolation`：只存在于插件私有 legacy adapter。

正式协议错误统一位于 `contract/errors/*`，不再保留单独的 `domain/error/*` 层。

插件 wrapper 只能做错误语义映射，不能把共享契约放宽成更宽的对象形状。

## `tool_event` 设计

`tool_event.event` 使用显式判别联合和 validator registry。

### 设计要求

- 事件类型必须与 `TOOL_EVENT_TYPES` 完全一致
- 每个事件必须有独立 validator
- `message.updated` 的白名单投影必须可测试
- 共享 validator 只校验最终对外形状，不负责 raw event 提取

当前目录切分如下：

- `contract/schemas/tool-event/opencode-provider-event/*`：当前已落地事件 schema 真源
- `contract/schemas/tool-event/index.ts`：`GatewayToolEventPayload` 协议入口

当前 `GatewayToolEventPayload` 仅等价于 `OpencodeProviderEvent`，公共 API 不暴露任何 `SkillProviderEvent` 占位导出。

## `upstream` 入口设计

当前上行 schema 拆为三个稳定入口：

- `upstream-business.ts`：`GatewayUplinkBusinessMessage`
- `upstream-control.ts`：`GatewayTransportControlMessage`
- `upstream.ts`：`GatewayWireProtocol`

这样业务消息校验与全量协议校验不会再共用语义含糊的 `UpstreamTransportMessage` 主入口。

### 结构约束

- `message.updated`、`message.part.updated`、`session.status`、`permission.asked`、`question.asked` 等事件必须在文档中逐项说明字段
- 不允许依赖宿主 SDK 类型直接外泄
- 不允许通过 `[key: string]: unknown` 保留未冻结字段

## `create_session` 约束

正式下行契约仅保留：

```json
{
  "title": "可选标题",
  "assiantId": "可选标识"
}
```

`message-bridge-openclaw` 的旧 `sessionId` / `metadata` 只能在插件私有 legacy adapter 中兼容，不能写入共享协议层。

## Cutover 流程

### Phase A

- 两个插件先接入共享 façade、常量和类型
- 旧实现先保留为回退路径
- 通过对照测试确认行为一致

### Phase B

- 默认路径切到共享包
- 只有在 `pnpm test` 和 `pnpm verify:workspace` 通过后，才允许删除旧真源

### 回滚触发

- `tool_event.event` 投影失败
- `status_response` envelope 变化
- legacy adapter 映射失败异常不稳定
- 插件行为出现回归

## AI-First Eval Matrix

| 编号 | 维度 | 通过标准 |
|---|---|---|
| E1 | 下行契约 | `status_query` 和所有 `invoke.*` 成功与失败都可判定 |
| E2 | 事件契约 | 每个 `tool_event.event.type` 都有独立字段表和测试 |
| E3 | 白名单投影 | `message.updated` 只保留冻结字段 |
| E4 | transport 契约 | `status_response`、`tool_error`、`session_created` 形状稳定 |
| E5 | 异常映射 | `WireContractViolation` 可稳定映射到外部失败行为 |
| E6 | 兼容路径 | legacy adapter 只存在于插件私有层 |
| E7 | 消费者迁移 | 两个插件接入后外部行为不变 |
| E8 | 静态门禁 | 共享模型不含开放索引签名、无裸协议字面量、`unknown` 受控、旧路径不回流 |

## 验证门禁

实施期间必须满足：

1. `packages/gateway-schema` 包级测试通过。
2. `packages/test-support` 共享测试通过。
3. 两个插件受影响测试通过。
4. `pnpm test` 通过。
5. `pnpm verify:workspace` 通过。

## 结论

当前 `gateway-schema` 的模块设计必须把协议真源、端口、用例和适配器拆开。公开接口应尽量薄，异常模型要可区分、可映射、可回滚，并且不再让旧术语主导公共 API。
