# Changelog

changelog 条目统一使用 `feat:`、`fix:`、`docs:` 前缀；真实 public contract 破坏性变更使用 `!` 标记。

## 2026-08-12 (1.0.5)

- docs: `TextDoneFact` 新增 `extParameters` 可选字段说明；该字段用于透传 agent/provider 生成的上行业务扩展参数，SDK 上报落点为 `tool_event.event.properties.extParameters`。

## 2026-07-14（未发布）

- feat: `BridgeRuntimeOptions` 新增 `requestRunPolicy.activeRunChatPolicy`；默认使用 `reject`。SDK 集成方只有在 Provider 支持并发输入调度，并已按 `toolSessionId` 实现 run 输出队列后，才适合显式开启 `forwardToProvider`。
- fix!: `ProviderAbortSessionInput` 从可选 `runId?: string` 改为必填 `runIds: string[]`；Provider 集成方必须遍历 `input.runIds`，终止其中仍处于 active 状态的每个 run。无 active run 时仍会收到 `[]`。
- docs: 补充 abort 精确 run ID 快照的 diagnostics 查询位置。

## 2026-07-02 (1.0.4-beta)

- feat: 补充 slash command 查询/上报接口说明，明确 Provider 通过 `listSlashCommands(input)` 返回当前可用命令列表。
- feat: `QrCodeAuthSnapshot` 的 `confirmed` 事件新增 `assistantInfo` 字段，携带助理 `name`、`nameEn`、`desc`、`descEn` 基础信息；服务端字段缺失时 SDK 统一补为空字符串。

## 2026-06-16 （1.0.3-beta）

- fix!: 所有 Provider fact 类型移除 `toolSessionId` 字段；该字段由 runtime 从 run 上下文注入，不属于 Provider 构造 fact 时的输入。
- feat: 所有 Provider fact 类型新增 `subagentSessionId?` 和 `subagentName?` 可选字段（继承自 `ProviderFactBase`）。
- feat: `BridgeRuntimeStatusSnapshot` 新增 `error?: BridgeRuntimeError` 字段。
- docs: 新增 `BridgeRuntimeError` 和 `BridgeRuntimeErrorCode` 类型说明。
- fix!: `ProviderRunMessageInput.context` 移除 `imGroupId` 字段；SDK 不向 Provider 透传该字段。
- fix: 修正所有 `toolSessionId` 字段说明：明确其代表 welink 会话标识，不代表宿主 agent session ID。
- docs: 新增 `toolSessionId` 与 agent session 映射约束说明。
- docs: 补充标识符约束：`toolSessionId`、`messageId`、`partId` 格式建议（`ses_`、`msg_`、`prt_` 前缀 + UUID）。
- docs: 补充 request run 时序图，体现一轮 run 可返回多个 message，每个 message 拥有独立 `messageId`。
- fix: 修正文本流规则和示例代码：移除 fact 中多余的 `toolSessionId` 字段，示例 ID 改用前缀 + UUID 格式。
- docs: 补充 request run 时序约束：`result()` 必须在 facts 流结束后 resolve。
- docs: 新增中断时序图，体现 `abortSession` 后 Provider 必须手动 resolve `result()` 为 `aborted`。
- docs: 重写最小 Provider 示例：使用 deferred Promise 模式，体现 `result()` 收口和中止时手动 resolve。
- docs: 常见错误用法补充 `result()` 提前 resolve 和中断后未 resolve 两条。
- docs: 补充标识符语义：`messageId` 与 `partId` 的层级关系和区别说明。
- docs: 补充 `createSession` 触发时机和映射说明。

## 2026-06-15

- feat: `RuntimeOutboundEmitter` 新增方法 `emitOutboundRun(input)`，用于发送带 run 标识的主动 facts 流。
- feat: 新增 `EmitOutboundRunInput` 入参类型，字段包含 `toolSessionId`、`runId`、`trigger`、`facts`。
- docs: `RuntimeOutboundEmitter.emitOutboundMessage(input)` 标记为废弃；新接入应使用 `emitOutboundRun(input)`。
- fix!: `ToolUpdateFact.input` 从 `string` 改为 `Record<string, unknown>`；集成方必须传入 JSON 对象，不能传字符串、数组、`null`、数字或布尔值。

## 2026-06-02 （1.0.2-beta）

- fix!: `BridgeGatewayHostConfig.register.toolType` 改为 `BridgeGatewayHostConfig.register.channel`，表示接入方声明的业务渠道标识。
- fix!: 不保留 `register.toolType` 兼容入口；集成方必须改用 `register.channel`。

## 2026-06-01 （1.0.1-beta）

- fix!: `PermissionAskFact`: `permissionType?: string` -> `permType: string`
- fix!: `PermissionReplyFact`: `permissionType?: string` -> `permType?: string`
- fix!: `PermissionReplyFact`: `messageId, partId` 移除
